import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import type { AuthzClient } from './authz.js';
import { artifactState } from './expiry.js';
import { TokenBucket, clientIp } from './limits.js';
import { composeIdentity, sanitizeAwarenessUpdate } from './identity.js';
import { AnonIssuer, assignNum } from './anon.js';
import { applyEstimateMs, normalizeOrigin } from './config.js';
import { stripBucketSegment, validateArtifactKey } from './paths.js';
import { ledgerBound, type RoomManager } from './rooms.js';
import { BusyError, Room, RoomGone, bufferCap, limitBuffered, sendConn, sendWs, sentBytes, underBufferCap, type Conn } from './room.js';
import { WorkerFault } from './worker-host.js';
import {
  CLOSE,
  MSG_AWARENESS,
  MSG_LEDGER,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  encodeIdentity,
  encodeLedger,
  encodeNotice,
} from '@pocharlies/artifacts-canvas-shared/protocol';
import { SPLIT_COST_BYTES, utf8Length, type UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';

export const WS_ROUTE = '/_canvas/_/ws/';
/** Same route when the ingress controller strips the plugin prefix. */
export const WS_ROUTE_STRIPPED = '/ws/';

export interface WsDeps {
  cfg: Config;
  authz: AuthzClient;
  manager: RoomManager;
  log: Logger;
  metrics: Metrics;
  /** Shared with the HTTP app so the wrapper page and the socket issue the same cookie. */
  anon?: AnonIssuer;
}

/** The next piece of the join payload goes out once the socket buffers less than this. */
const JOIN_LOW_WATER = 256 * 1024;
/** How often the slow-consumer / join-deadline / budget sweep runs. */
const SWEEP_MS = 1000;
/** Floor of the join deadline (see WS_JOIN_MIN_BYTES_PER_SEC). */
const JOIN_MIN_MS = 30_000;
/**
 * A peer holding more than this that drained less than WS_JOIN_MIN_BYTES_PER_SEC for WS_STALL_MS
 * is stalled (fv6 L-A): under outgoing-budget pressure it is dropped before a join is refused.
 */
const STALL_MIN_BYTES = 256 * 1024;
/** Joins of principals that hold nothing may take the outgoing budget this much over (fv6 L-A). */
const OUTGOING_SLACK = 0.25;

export { clientIp };

/** Request property carrying the Set-Cookie of the upgrade response (see the 'headers' hook). */
const SET_COOKIE = Symbol('canvas-set-cookie');
type UpgradeReq = IncomingMessage & { [SET_COOKIE]?: string };

export class WsServer {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  readonly anon: AnonIssuer;
  /**
   * join buckets per principal (`u:<id>`, `a:<visitor>`), per room for anonymous joins without
   * a visitor cookie (`r:<key>`) and per client IP for anonymous joins (`i:<ip>`)
   */
  private readonly joins = new Map<string, TokenBucket>();
  /** per principal (`u:<id>` / `a:<visitor>`): live connections and the CPU bucket they share */
  private readonly principals = new Map<string, { conns: number; cpu: TokenBucket }>();
  /** server CPU of all connections, and of all anonymous ones (fv5 M-5) */
  private readonly cpuAll: TokenBucket;
  private readonly cpuAnon: TokenBucket;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private lastPing = Date.now();

  constructor(private readonly deps: WsDeps) {
    const { cfg } = deps;
    this.anon = deps.anon ?? new AnonIssuer(cfg.anonCookieSecret, cfg);
    this.cpuAll = new TokenBucket(cfg.cpuTotalMsPerSec, cfg.cpuTotalBurstMs);
    this.cpuAnon = new TokenBucket(cfg.anonCpuTotalMsPerSec, cfg.anonCpuTotalBurstMs);
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(SWEEP_MS, cfg.wsPingIntervalMs));
    this.sweepTimer.unref?.();
    // The anonymous-visitor cookie rides on the 101 response of the upgrade.
    this.wss.on('headers', (headers: string[], req: UpgradeReq) => {
      const c = req[SET_COOKIE];
      if (c) headers.push(`Set-Cookie: ${c}`);
    });
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  /** Exact match against ALLOWED_ORIGINS; a missing or `null` Origin never matches. */
  originAllowed(origin: string | undefined): boolean {
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
    try {
      return this.deps.cfg.allowedOrigins.has(normalizeOrigin(origin));
    } catch {
      return false;
    }
  }

  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://internal');
    let rest: string | null = null;
    if (url.pathname.startsWith(WS_ROUTE)) rest = url.pathname.slice(WS_ROUTE.length);
    else if (url.pathname.startsWith(WS_ROUTE_STRIPPED)) rest = url.pathname.slice(WS_ROUTE_STRIPPED.length);
    if (rest === null) {
      // Not our route: fail the upgrade, leave the socket to nothing.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Cross-site WebSocket hijacking guard: the browser attaches the visitor's session
    // cookie to any cross-site upgrade, so only the configured origins may open a room.
    if (!this.originAllowed(req.headers.origin)) {
      this.deps.metrics.wsRejected.inc({ reason: 'origin' });
      this.deps.log.warn({ origin: req.headers.origin ?? null }, 'ws refused: origin not allowed');
      this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE.forbidden, 'origin not allowed'));
      return;
    }
    // Accept both the core link shape `/_canvas/_/ws/<bucket>/<key>` and the client shape
    // `/_canvas/_/ws/<key>` (see paths.stripBucketSegment).
    const key = validateArtifactKey(stripBucketSegment(rest, this.deps.cfg.s3Bucket), this.deps.cfg.artifactPrefixes);
    if (!key.ok) {
      this.deps.metrics.wsRejected.inc({ reason: `path_${key.reason}` });
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookie = req.headers.cookie ?? '';
    const authorization = req.headers.authorization ?? '';
    const anonParam = url.searchParams.get('anon');
    // fv6 M-A: a visitor cookie whose join budget is used up, or whose principal is in CPU debt,
    // is refused before the core is asked (each refused attempt cost an authz round trip: q2's
    // attackers made 670 a second). Only anonymous joins spend a visitor's join budget, so a
    // browser that logged in meanwhile is refused only while that budget refills (seconds).
    if (!authorization) {
      const v = this.anon.parse(cookie);
      if (v) {
        const p = `a:${v.nonce}`;
        if ((this.joins.get(p)?.level() ?? 1) < 1) {
          this.refuseBusy(req, socket, head, 'join_rate', 'too many joins');
          return;
        }
        if ((this.principals.get(p)?.cpu.level() ?? 0) < 0) {
          this.refuseBusy(req, socket, head, 'cpu_debt', 'cpu budget');
          return;
        }
      }
    }

    this.deps.authz
      .authorize(cookie, key.key, authorization)
      .then((res) => {
        const state = artifactState(res, this.deps.cfg);
        if (state === 'gone') {
          this.finishDenied(req, socket, head, CLOSE.notFound, key.key, 'gone');
          return;
        }
        if (state === 'expired') {
          this.finishDenied(req, socket, head, CLOSE.expired, key.key, 'expired');
          return;
        }
        if (!res.allowed) {
          if (coreError(res.reason)) {
            // fv7 F6: the core could not answer (timeout, 5xx, garbage): still refused (fail
            // closed), but with 1013 so the client tries again instead of giving up for good
            this.refuseBusy(req, socket, head, `authz_${res.reason}`, 'authorization unavailable');
            return;
          }
          this.deps.metrics.wsRejected.inc({ reason: `authz_${res.reason}` });
          // Complete the upgrade and close with the protocol close code so the client
          // sees 4403 (no reconnect) instead of a bare connection failure.
          this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE.forbidden, 'not allowed'));
          return;
        }
        const existing = this.deps.manager.get(key.key);
        const { cfg } = this.deps;
        // Anonymous pseudonym: assigned by the server (anon.ts); ?anon= is only a hint.
        const anonymous = !res.identity || res.identity.anonymous;
        const visitor = anonymous ? this.anon.visitor(cookie, anonParam) : null;
        const num = visitor ? assignNum(visitor.num, visitor.nonce, existing ? existing.anonHolders() : new Map()) : '';
        const identity = composeIdentity(res, num, visitor ? this.anon.visitorId(visitor.nonce) : '');
        const principal = visitor ? `a:${visitor.nonce}` : `u:${identity.id}`;
        const ip = clientIp(req, cfg.clientIpHops);
        // fv9: a principal (or, anonymous, its IP or every anonymous visitor) whose messages made
        // room workers fault too often waits out its cooldown
        const cool = this.deps.manager.strikes.coolingDown({ principal, anonymous: !!visitor, ip });
        if (cool) {
          this.refuseBusy(req, socket, head, cool, 'cooldown');
          return;
        }
        // fv6 M-A: a new visitor is a new principal (budgets of its own): minted within the
        // mint rate only, else refused with 1013 and no cookie (the client retries).
        if (visitor?.fresh && !this.anon.mint(ip, 'ws')) {
          this.deps.metrics.anonMinted.inc({ outcome: 'refused' });
          this.refuseBusy(req, socket, head, 'anon_mint', 'too many new visitors');
          return;
        }
        if (visitor?.fresh) this.deps.metrics.anonMinted.inc({ outcome: 'minted' });
        // A visitor without a cookie gets one with ANY answer (also a refusal), so the retry
        // of an honest browser comes back as a returning visitor with a bucket of its own.
        if (visitor && (visitor.fresh || num !== visitor.num)) {
          (req as UpgradeReq)[SET_COOKIE] = this.anon.setCookie(visitor.nonce, num, isHttps(req));
        }
        // Joins per principal (fv4 H1): every join is answered with the whole content and
        // ledger, so reconnecting in a loop is an amplifier too. fv5 M-6: anonymous joins
        // WITHOUT a visitor cookie (a fresh visitor each time) share one bucket per room, so
        // a cookieless client draining it no longer locks out returning visitors (who have
        // their own bucket); with a known client IP, every anonymous join also takes from a
        // bucket per IP. A refused join closes with 1013: the client retries (never 4429).
        if (!this.joinAllowed(visitor ? null : identity.id, visitor, key.key, ip)) {
          this.refuseBusy(req, socket, head, 'join_rate', 'too many joins');
          return;
        }
        // Capacity (protocol §7): per room (anon stricter), per principal over the whole
        // process (fv5 H-1: one user held 49 paused sockets), and the process-wide outgoing
        // budget. Every refusal is retryable (1013) and per connection: nothing a visitor
        // sends can lock other people out for good.
        if ((this.principals.get(principal)?.conns ?? 0) >= (visitor ? cfg.maxConnsPerAnonVisitor : cfg.maxConnsPerUser)) {
          this.refuseBusy(req, socket, head, 'principal_conns', 'too many connections');
          return;
        }
        if (existing) {
          if (existing.conns.size >= cfg.maxConnsPerRoom) {
            this.refuseBusy(req, socket, head, 'capacity', 'room full');
            return;
          }
          if (visitor) {
            if (existing.countAnon() >= cfg.maxConnsPerRoomAnon) {
              this.refuseBusy(req, socket, head, 'capacity', 'room anon capacity');
              return;
            }
            if (existing.countVisitor(visitor.nonce) >= cfg.maxConnsPerAnonVisitor) {
              this.refuseBusy(req, socket, head, 'capacity', 'anon visitor capacity');
              return;
            }
          }
        }
        // fv6 M-A: a principal whose CPU budget is used up joins nobody until it refilled (every
        // join costs CPU: authz, the payload, possibly an encoding or a load)
        const own = this.principals.get(principal);
        if (own && own.cpu.level() < 0) {
          this.refuseBusy(req, socket, head, 'cpu_debt', 'cpu budget');
          return;
        }
        // ...and while the server-wide budget (or the anonymous share) is used up, a join that
        // would encode the room or load it waits (1013): those are the expensive ones
        const cpuShed = this.cpuAll.level() < 0 || (!!visitor && this.cpuAnon.level() < 0);
        if (cpuShed && (!existing || !existing.framesCached())) {
          this.refuseBusy(req, socket, head, 'cpu_shed', 'server busy');
          return;
        }
        // fv6 H-1: a join that would LOAD the room is refused while the loaded rooms use the
        // memory budget (joins to loaded rooms are never refused for memory)
        if (!existing) {
          const why = this.deps.manager.mayLoad({ principal, anonymous: !!visitor });
          if (why) {
            this.refuseBusy(req, socket, head, why, 'server memory busy');
            return;
          }
        }
        if (!this.admitOutgoing(existing, principal)) {
          this.refuseBusy(req, socket, head, 'outgoing_budget', 'server busy');
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          // the connection counts against its principal from the upgrade until it closes
          const p = this.principalOf(principal, !!visitor);
          p.conns++;
          ws.once('close', () => this.releasePrincipal(principal));
          // nothing the client sends is read before join() listens (the room may still load)
          ws.pause();
          void this.join(ws, key.key, cookie, authorization, identity, visitor ? { nonce: visitor.nonce, num } : null, res.artifact?.ttl ?? null, principal, !!visitor, ip);
        });
      })
      .catch((err) => {
        this.deps.log.error({ err: String(err) }, 'upgrade authz unexpected error');
        socket.destroy();
      });
  };

  /** Take one join from every bucket that applies (all or nothing). */
  private joinAllowed(userId: string | null, visitor: { nonce: string; fresh: boolean } | null, room: string, ip: string | null): boolean {
    const { cfg } = this.deps;
    if (this.joins.size > 10_000) for (const [k, b] of this.joins) if (b.full()) this.joins.delete(k);
    const bucket = (k: string, perMin: number, burst: number) => {
      let b = this.joins.get(k);
      if (!b) this.joins.set(k, (b = new TokenBucket(perMin / 60, burst)));
      return b;
    };
    if (userId !== null) return bucket(`u:${userId}`, cfg.joinRatePerMin, cfg.joinBurst).take();
    const take: TokenBucket[] = [];
    if (ip !== null) take.push(bucket(`i:${ip}`, cfg.anonIpJoinRatePerMin, cfg.anonIpJoinBurst));
    if (!visitor || visitor.fresh) take.push(bucket(`r:${room}`, cfg.anonRoomJoinRatePerMin, cfg.anonRoomJoinBurst));
    else take.push(bucket(`a:${visitor.nonce}`, cfg.anonJoinRatePerMin, cfg.anonJoinBurst));
    if (!take.every((b) => b.level() >= 1)) return false;
    for (const b of take) b.take();
    return true;
  }

  /** Refuse an upgrade for capacity or rate: notice `busy`, close 1013 (the client retries). */
  private refuseBusy(req: IncomingMessage, socket: Duplex, head: Buffer, reason: string, why: string): void {
    this.deps.metrics.wsRejected.inc({ reason });
    this.deps.log.debug({ why }, 'ws refused: busy');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      sendWs(ws, encodeNotice({ kind: 'busy' }));
      ws.close(CLOSE.tryAgain, why);
      // a peer that does not read the close frame is not kept for the 30 s close handshake
      setTimeout(() => ws.terminate(), 1000).unref?.();
    });
  }

  private principalOf(key: string, anonymous: boolean): { conns: number; cpu: TokenBucket } {
    const { cfg } = this.deps;
    let p = this.principals.get(key);
    if (!p) {
      p = {
        conns: 0,
        cpu: anonymous ? new TokenBucket(cfg.anonCpuMsPerSec, cfg.anonCpuBurstMs) : new TokenBucket(cfg.cpuMsPerSec, cfg.cpuBurstMs),
      };
      this.principals.set(key, p);
    }
    return p;
  }

  private releasePrincipal(key: string): void {
    const p = this.principals.get(key);
    if (!p) return;
    p.conns = Math.max(0, p.conns - 1);
    // the CPU bucket outlives the connections until it refilled: reconnecting does not reset it
    if (p.conns === 0 && p.cpu.full()) this.principals.delete(key);
  }

  /**
   * Bytes held for every peer: outgoing buffers and backlogs, with the join frames still in
   * flight (shared by every join of a room snapshot) counted once; per connection (its own
   * view: shared frames included) and per principal.
   */
  private outgoing(): { total: number; conns: { conn: Conn; bytes: number }[]; byPrincipal: Map<string, number> } {
    let total = 0;
    const frames = new Set<Uint8Array>();
    const conns: { conn: Conn; bytes: number }[] = [];
    // per principal: its own bytes, plus the shared frames its connections hold (each once)
    const byPrincipal = new Map<string, number>();
    const principalFrames = new Map<string, Set<Uint8Array>>();
    for (const room of this.deps.manager.rooms.values()) {
      for (const conn of room.conns.values()) {
        if (conn.closing) continue; // terminated: its buffers are gone
        const b = conn.ws.bufferedAmount + conn.backlogBytes;
        let own = b;
        if (conn.joinFrames && b > 0) {
          let shared = 0;
          let pf = principalFrames.get(conn.principal);
          if (!pf) principalFrames.set(conn.principal, (pf = new Set()));
          for (const f of conn.joinFrames) {
            frames.add(f);
            pf.add(f);
            shared += f.byteLength;
          }
          own = Math.max(0, b - shared);
        }
        total += own;
        conns.push({ conn, bytes: b });
        if (own > 0) byPrincipal.set(conn.principal, (byPrincipal.get(conn.principal) ?? 0) + own);
      }
    }
    for (const f of frames) total += f.byteLength;
    for (const [p, fs] of principalFrames) {
      let n = byPrincipal.get(p) ?? 0;
      for (const f of fs) n += f.byteLength;
      byPrincipal.set(p, n);
    }
    return { total, conns, byPrincipal };
  }

  /** What one principal may have held for its connections together (fv6 L-A). */
  private outgoingShare(): number {
    const { cfg } = this.deps;
    return Math.max(cfg.wsOutgoingBudgetBytes / 8, cfg.maxDocBytes + cfg.wsMaxBufferedBytes);
  }

  /** A peer that holds more than STALL_MIN_BYTES and drained (almost) nothing for WS_STALL_MS. */
  private stalled(conn: Conn, bytes: number, now: number): boolean {
    return bytes > STALL_MIN_BYTES && now - conn.progressAt >= this.deps.cfg.wsStallMs;
  }

  /**
   * Room in the outgoing budget for a join (fv6 L-A). What the join adds: nothing if a join of
   * the same snapshot holds the frames already (they are shared), else the room's size. A
   * principal holding more than its share is refused (its own peers are not reading); else, if
   * the budget would be passed, stalled peers (not reading, whoever they are) are dropped first,
   * and the join is refused only if the bytes still held are all draining. A room bigger than
   * the budget can still be joined by one peer at a time.
   */
  private admitOutgoing(existing: Room | undefined, principal: string): boolean {
    const { cfg } = this.deps;
    let out = this.outgoing();
    const own = out.byPrincipal.get(principal) ?? 0;
    if (own > this.outgoingShare()) return false;
    // a principal that holds nothing may use OUTGOING_SLACK above the budget: a peer that just
    // stopped reading is only known as stalled after WS_STALL_MS, and the honest join must not
    // wait for that; the sweep brings the total back under the budget (stalled peers first)
    const limit = cfg.wsOutgoingBudgetBytes * (own === 0 ? 1 + OUTGOING_SLACK : 1);
    const estimate = existing ? existing.joinEstimate(this.inFlightFrames()) : 0;
    if (out.total === 0 || out.total + estimate <= limit) return true;
    const now = Date.now();
    const victims = out.conns.filter((c) => this.stalled(c.conn, c.bytes, now)).sort((a, b) => b.bytes - a.bytes);
    for (const v of victims) {
      this.drop(v.conn, 'outgoing_reclaim');
      out = this.outgoing();
      if (out.total === 0 || out.total + estimate <= limit) return true;
    }
    return false;
  }

  /** Every join frame some connection still has in flight. */
  private inFlightFrames(): Set<Uint8Array> {
    const out = new Set<Uint8Array>();
    for (const room of this.deps.manager.rooms.values()) for (const c of room.conns.values()) if (c.joinFrames && !c.closing) for (const f of c.joinFrames) out.add(f);
    return out;
  }

  /** Terminate a connection now (a close frame would only queue behind its backlog). */
  private drop(conn: Conn, reason: string): void {
    if (conn.closing) return;
    this.deps.metrics.wsRejected.inc({ reason });
    this.deps.log.warn(
      { room: conn.artifactKey, user: conn.identity.id, buffered: conn.ws.bufferedAmount + conn.backlogBytes, reason },
      'ws dropped',
    );
    conn.closing = true;
    conn.backlog = [];
    conn.backlogBytes = 0;
    try {
      conn.ws.terminate();
    } catch {
      /* already gone */
    }
  }

  /**
   * Timer-driven limits (fv5 H-1), every second: a connection over its outgoing cap for
   * longer than WS_SLOW_CONSUMER_MS, or whose join payload has not drained by its deadline,
   * is dropped; every WS_PING_INTERVAL_MS each peer is pinged, and one that answered no ping
   * for two rounds while draining nothing is dropped; while all peers together hold more than
   * WS_OUTGOING_BUDGET_BYTES, the ones holding most are dropped.
   */
  private sweep(): void {
    const { cfg, metrics } = this.deps;
    const now = Date.now();
    const ping = now - this.lastPing >= cfg.wsPingIntervalMs;
    if (ping) this.lastPing = now;
    for (const room of this.deps.manager.rooms.values()) {
      for (const conn of room.conns.values()) {
        if (conn.closing) continue;
        const ws = conn.ws;
        const buffered = ws.bufferedAmount + conn.backlogBytes;
        if (conn.joinFrames && !conn.joining && buffered <= JOIN_LOW_WATER) conn.joinFrames = null;
        // drain progress (fv6 L-A): what the socket wrote out since the last sample
        const sent = sentBytes(ws);
        const drainedOut = sent - conn.lastSent - (ws.bufferedAmount - conn.lastBuffered);
        const dt = Math.max(1, now - (conn.sampledAt ?? now - SWEEP_MS));
        if (buffered <= STALL_MIN_BYTES || drainedOut >= (cfg.wsJoinMinBytesPerSec * dt) / 1000) conn.progressAt = now;
        conn.lastSent = sent;
        conn.lastBuffered = ws.bufferedAmount;
        conn.sampledAt = now;
        if (buffered > bufferCap(ws)) {
          if (!conn.overSince) conn.overSince = now;
          else if (now - conn.overSince >= cfg.wsSlowConsumerMs) {
            this.drop(conn, 'slow_consumer');
            continue;
          }
        } else conn.overSince = 0;
        if ((conn.joining || conn.joinFrames) && now - conn.joinStarted > joinDeadlineMs(conn.joinBytes, cfg.wsJoinMinBytesPerSec)) {
          this.drop(conn, 'join_timeout');
          continue;
        }
        if (ping) {
          if (conn.awaitingPong) {
            // no pong since the last round: alive only if it drained something meanwhile
            if (ws.bufferedAmount < conn.pingBuffered) conn.missedPongs = 0;
            else if (++conn.missedPongs >= 2) {
              this.drop(conn, 'idle');
              continue;
            }
          }
          conn.awaitingPong = true;
          conn.pingBuffered = ws.bufferedAmount;
          try {
            ws.ping();
          } catch {
            /* closing */
          }
        }
      }
    }
    for (const [k, p] of this.principals) if (p.conns === 0 && p.cpu.full()) this.principals.delete(k);
    let out = this.outgoing();
    if (out.total > cfg.wsOutgoingBudgetBytes) {
      // over the budget: stalled peers first, then principals over their share, then the
      // biggest holders (fv6 L-A: a peer that reads is the last one dropped)
      const share = this.outgoingShare();
      const rank = (c: { conn: Conn; bytes: number }) =>
        (this.stalled(c.conn, c.bytes, now) ? 2 : 0) + ((out.byPrincipal.get(c.conn.principal) ?? 0) > share ? 1 : 0);
      const order = out.conns.filter((c) => c.bytes >= 1024 * 1024).sort((a, b) => rank(b) - rank(a) || b.bytes - a.bytes);
      for (const c of order) {
        this.drop(c.conn, 'outgoing_budget');
        out = this.outgoing();
        if (out.total <= cfg.wsOutgoingBudgetBytes) break;
      }
    }
    metrics.outgoingBytes.set(out.total);
    metrics.roomMemory.set(this.deps.manager.memory().total);
  }

  /** Resolves once the connection buffers less than JOIN_LOW_WATER (or is gone). */
  private drained(conn: Conn): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => {
        if (conn.closing || conn.ws.readyState !== conn.ws.OPEN || conn.ws.bufferedAmount <= JOIN_LOW_WATER) resolve();
        else setTimeout(tick, 20);
      };
      tick();
    });
  }

  /**
   * Artifact gone/expired on connect: delete the canvas object (and drop any loaded
   * room), then complete the upgrade and close with the protocol close code so the
   * client sees 4404/4410 and does not reconnect.
   */
  private finishDenied(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    artifactKey: string,
    kind: 'gone' | 'expired',
  ): void {
    this.deps.metrics.wsRejected.inc({ reason: kind });
    void this.deps.manager.expireRoom(artifactKey, kind);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (kind === 'expired') sendWs(ws, encodeNotice({ kind: 'expired' }));
      ws.close(code, kind === 'expired' ? 'artifact expired' : 'artifact gone');
    });
  }

  private async join(
    ws: WebSocket,
    artifactKey: string,
    cookie: string,
    authorization: string,
    identityIn: Parameters<typeof encodeIdentity>[0],
    anonVisitor: { nonce: string; num: string } | null,
    ttl: number | null,
    principal: string,
    anonymous: boolean,
    ip: string | null = null,
  ): Promise<void> {
    const { cfg, manager, metrics, log } = this.deps;
    let room: Room;
    const loader = { principal, anonymous };
    try {
      room = await manager.getOrCreate(artifactKey, ttl, loader);
      // evicted (last leave) while this join waited for it: join the room that replaces it
      if (room.disposed || manager.get(artifactKey) !== room) {
        const old = room;
        room = await manager.getOrCreate(artifactKey, ttl, loader);
        manager.abandon(artifactKey, old);
      }
    } catch (err) {
      if (manager.closing) {
        // restarting: the client reconnects (4503) to the next process
        sendWs(ws, encodeNotice({ kind: 'shutdown' }));
        ws.close(CLOSE.serverRestart, 'server restart');
        return;
      }
      if (err instanceof BusyError) {
        // fv6 H-1: loading this room would pass the memory budget (1013: the client retries);
        // fv7 F1: a room whose cost alone passes the loader's share never loads for it (4413)
        metrics.wsRejected.inc({ reason: err.reason });
        sendWs(ws, encodeNotice({ kind: err.terminal ? 'too-large' : 'busy' }));
        ws.close(err.terminal ? CLOSE.tooLarge : CLOSE.tryAgain, err.terminal ? 'document too large for this server' : 'server memory busy');
        setTimeout(() => ws.terminate(), 1000).unref?.();
        return;
      }
      if (err instanceof WorkerFault) {
        // fv9: the stored room could not be loaded within its worker's limits (1013: retried)
        log.error({ err: String(err), room: artifactKey }, 'room load failed in its worker');
        metrics.wsRejected.inc({ reason: `load_${err.kind}` });
        sendWs(ws, encodeNotice({ kind: 'busy' }));
        ws.close(CLOSE.tryAgain, 'server busy');
        return;
      }
      log.error({ err: String(err), room: artifactKey }, 'room load failed');
      ws.close(1011, 'storage error');
      return;
    }
    if (ws.readyState !== ws.OPEN) {
      // gone while the room loaded: the room must not stay loaded for nobody (fv6 H-1: a
      // socket closed during the load left the room in memory forever)
      manager.abandon(artifactKey, room);
      return;
    }
    let identity = identityIn;
    let anonNum: string | undefined;
    if (anonVisitor) {
      // Two upgrades may have raced for the same free pseudonym before the room existed:
      // re-check against the live connections now that the room is loaded. Only the label
      // changes; the attribution id stays bound to the visitor cookie.
      anonNum = assignNum(anonVisitor.num, anonVisitor.nonce, room.anonHolders());
      if (anonNum !== anonVisitor.num) identity = { ...identity, name: `Anónimo ${anonNum}` };
    }
    const t0 = performance.now();
    const conn: Conn = {
      ws,
      artifactKey,
      cookie,
      authorization,
      identity,
      anonVisitor: anonVisitor?.nonce,
      anonNum,
      clientIds: new Set(),
      rate: identity.anonymous
        ? new TokenBucket(cfg.anonMsgRatePerSec, cfg.anonMsgBurst)
        : new TokenBucket(cfg.msgRatePerSec, cfg.msgBurst),
      syncBytes: identity.anonymous
        ? new TokenBucket(cfg.anonSyncBytesPerSec, cfg.anonSyncBurstBytes)
        : new TokenBucket(cfg.syncBytesPerSec, cfg.syncBurstBytes),
      cpu: this.principalOf(principal, identity.anonymous).cpu,
      principal,
      ip,
      resync: new TokenBucket(0.5, 20),
      step1Answers: 0,
      joinSv: new Map(),
      closing: false,
      joining: true,
      backlog: [],
      backlogBytes: 0,
      // until the frames are encoded, the room's last known size stands for them
      joinBytes: room.ledgerApproxBytes + room.approxBytes,
      joinStarted: Date.now(),
      joinFrames: null,
      overSince: 0,
      lastSent: 0,
      lastBuffered: 0,
      progressAt: Date.now(),
      awaitingPong: false,
      pingBuffered: 0,
      missedPongs: 0,
    };
    // A peer that stops reading is dropped once the server holds more than the cap for it
    // beyond the join payload: on its next send, and by the sweep once it stays over the cap
    // (fv4 H1, fv5 H-1); a tab still downloading a big room is not cut off.
    const onOver = () => {
      metrics.wsRejected.inc({ reason: 'slow_consumer' });
      log.warn({ room: artifactKey, user: identity.id, buffered: ws.bufferedAmount }, 'ws dropped: outgoing buffer over the cap');
    };
    limitBuffered(ws, cfg.wsMaxBufferedBytes + conn.joinBytes, onOver);
    // attached before its frames are taken (fv9: they come from the worker, a job of the room):
    // whatever the room broadcasts meanwhile waits in the backlog and follows the frames
    room.attach(conn);
    room.pendingJoins = Math.max(0, room.pendingJoins - 1);
    metrics.wsAccepted.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    metrics.connections.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    log.info({ room: artifactKey, user: identity.id, anon: identity.anonymous }, 'ws joined');

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      if (conn.closing) return;
      const buf = new Uint8Array(data as ArrayBuffer);
      // fv5 M-5: while the server-wide CPU budget (or the anonymous share of it) is used up,
      // only small messages are processed; a big one is refused with 1013 and resent by the
      // client after it reconnected (y-websocket syncs what the room lacks).
      if (buf.byteLength > cfg.cpuShedMinBytes && (this.cpuAll.level() < 0 || (identity.anonymous && this.cpuAnon.level() < 0))) {
        metrics.wsRejected.inc({ reason: 'cpu_shed' });
        sendWs(ws, encodeNotice({ kind: 'busy' }));
        this.closeConn(conn, CLOSE.tryAgain, 'server busy');
        return;
      }
      const t1 = performance.now();
      try {
        this.onMessage(conn, room, buf);
      } catch (err) {
        log.warn({ err: String(err), room: artifactKey }, 'bad message');
        this.closeConn(conn, 1003, 'bad message');
      }
      // the main thread's own share (decoding the frame, awareness); the worker's time is
      // charged when its answer comes (onUpdate, answerStep1)
      this.chargeCpu(conn, room, performance.now() - t1);
      if (buf.byteLength > 256 * 1024) metrics.sampleHeap();
    });
    ws.on('pong', () => {
      conn.awaitingPong = false;
      conn.missedPongs = 0;
    });
    ws.resume();

    // Re-check authorization periodically (protocol §4): revoked drops the connection;
    // expired/gone drop the whole room and delete the canvas object.
    conn.recheckTimer = setInterval(() => {
      void this.recheck(conn, room);
    }, Math.max(1, cfg.recheckSeconds) * 1000);

    ws.on('close', () => {
      conn.closing = true;
      conn.backlog = [];
      conn.backlogBytes = 0;
      if (conn.recheckTimer) clearInterval(conn.recheckTimer);
      room.detach(conn);
      // fv8 U2: a loader that left no longer pays for what the others keep open
      if (!room.principals.has(conn.principal)) manager.handOver(room);
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(conn.clientIds), null);
      metrics.connections.dec({ anonymous: identity.anonymous ? 'true' : 'false' });
      void manager.leave(artifactKey, room);
    });
    ws.on('error', () => {
      try {
        ws.close(1011);
      } catch {
        /* ignore */
      }
    });

    // The join payload, one piece at a time (fv5 H-1): each big frame is shared by every join
    // of the same room version and goes out only once the previous one drained, so a peer
    // that does not read never gets the next one queued (nor encoded).
    // IDENTITY MUST be the first message (protocol §4.1). The ledger (read-only for clients)
    // before the content, so shapes arrive with authors.
    sendWs(ws, encodeIdentity(identity));
    const mainMs = performance.now() - t0;
    const gone = (err: unknown) => {
      if (conn.closing) return;
      // the room was dropped (a fault it could not recover from) or evicted: retry
      if (!(err instanceof RoomGone)) log.warn({ err: String(err), room: artifactKey }, 'join frames failed');
      sendWs(ws, encodeNotice({ kind: 'busy' }));
      this.closeConn(conn, CLOSE.tryAgain, 'server busy');
    };
    let ledgerFrames: Uint8Array[];
    try {
      ledgerFrames = await room.ledgerFrames();
    } catch (err) {
      gone(err);
      return;
    }
    if (conn.closing || ws.readyState !== ws.OPEN) return;
    const t1 = performance.now();
    const ledgerBytes = ledgerFrames.reduce((a, f) => a + f.byteLength, 0);
    conn.joinFrames = ledgerFrames;
    conn.joinBytes = ledgerBytes + room.approxBytes;
    limitBuffered(ws, cfg.wsMaxBufferedBytes + conn.joinBytes, onOver);
    for (const f of ledgerFrames) sendWs(ws, f);
    // the main thread's own work (not the waits for the room's worker: their time is the worker's)
    this.chargeCpu(conn, room, performance.now() - t1 + mainMs, false);
    // the CPU the load and the join encodings took in the room's worker (decoding the stored
    // documents, encoding the ledger) counts against the server-wide budgets (fv6 M-A): while they
    // are used up, joins that would load or encode wait
    const loadMs = room.takeLoadMs();
    this.cpuAll.charge(loadMs);
    if (identity.anonymous) this.cpuAnon.charge(loadMs);
    await this.drained(conn);
    if (conn.closing || ws.readyState !== ws.OPEN) return;
    // The content: the full state (step 2), then the server's state vector (step 1) so the
    // client answers with a step 2 holding what the room lacks — the edits it made while
    // disconnected. That answer is a plain client update and goes through the guard; the
    // content document holds no server-only root a client could echo back.
    let content: Awaited<ReturnType<Room['contentFrames']>>;
    try {
      content = await room.contentFrames();
    } catch (err) {
      gone(err);
      return;
    }
    if (conn.closing || ws.readyState !== ws.OPEN) return;
    const t3 = performance.now();
    conn.joinSv = content.sv;
    conn.joinFrames = [...ledgerFrames, ...content.frames];
    conn.joinBytes = ledgerBytes + content.frames.reduce((a, f) => a + f.byteLength, 0);
    limitBuffered(ws, cfg.wsMaxBufferedBytes + conn.joinBytes, onOver);
    for (const f of content.frames) sendWs(ws, f);
    sendWs(ws, content.step1);
    const states = room.awareness.getStates();
    if (states.size) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())));
      sendWs(ws, encoding.toUint8Array(a));
    }
    // what the room broadcast meanwhile, in order (older than the frames above: Yjs skips it)
    conn.joining = false;
    const backlog = conn.backlog;
    conn.backlog = [];
    conn.backlogBytes = 0;
    for (const m of backlog) sendWs(ws, m);
    this.chargeCpu(conn, room, performance.now() - t3 + room.takeLoadMs(), false);
    if (conn.deferredStep1 && !conn.closing) {
      const sv = conn.deferredStep1;
      conn.deferredStep1 = undefined;
      void this.answerStep1(conn, room, sv, false);
    }
  }

  /**
   * CPU budget (fv4 H2, fv5 M-5): the time the server spent for a connection is charged to its
   * principal (shared by all its connections) and to the server-wide budgets; a principal in
   * debt has its connection closed, whatever it sends.
   */
  private chargeCpu(conn: Conn, room: Room, spent: number, closeInDebt = true): void {
    this.cpuAll.charge(spent);
    if (conn.identity.anonymous) this.cpuAnon.charge(spent);
    // the join's own work (encoding a room version) is charged but never cuts the join short:
    // a principal in debt is closed on its next message
    if (!conn.cpu.charge(spent) && closeInDebt && !conn.closing) {
      this.deps.log.warn({ room: room.name, user: conn.identity.id, ms: Math.round(spent) }, 'ws closed: cpu budget used up');
      sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
      this.closeConn(conn, CLOSE.rateLimited, 'cpu budget');
      this.deps.metrics.wsRejected.inc({ reason: 'cpu_budget' });
    }
  }

  /** Close once (later messages of a closing connection are ignored). */
  private closeConn(conn: Conn, code: number, reason: string): void {
    conn.closing = true;
    try {
      conn.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  private onMessage(conn: Conn, room: Room, buf: Uint8Array): void {
    const { cfg } = this.deps;
    if (!conn.rate.take()) {
      sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
      this.closeConn(conn, CLOSE.rateLimited, 'rate limited');
      this.deps.metrics.wsRejected.inc({ reason: 'rate_limited' });
      return;
    }
    const maxMsg = conn.identity.anonymous ? cfg.anonMaxMessageBytes : cfg.maxMessageBytes;
    if (buf.byteLength > maxMsg) {
      sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
      this.closeConn(conn, CLOSE.tooLarge, 'message too large');
      this.deps.metrics.wsRejected.inc({ reason: 'message_too_large' });
      return;
    }
    const dec = decoding.createDecoder(buf);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const syncType = decoding.readVarUint(dec);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        void this.answerStep1(conn, room, decoding.readVarUint8Array(dec));
        return;
      }
      // step 2 and update carry the same payload: varUint8Array(update) (y-protocols/sync:
      // writeSyncStep2 = varUint8Array(encodeStateAsUpdate(doc, sv)), no state vector)
      if (syncType !== syncProtocol.messageYjsSyncStep2 && syncType !== syncProtocol.messageYjsUpdate) {
        this.closeConn(conn, 1003, 'unknown sync type');
        return;
      }
      const update = decoding.readVarUint8Array(dec);
      if (syncType === syncProtocol.messageYjsSyncStep2) conn.resyncAsked = false;
      if (conn.identity.readOnly) return;
      // fv9: a principal cooling down after strikes writes nothing (1013: it retries later)
      const cool = this.deps.manager.strikes.coolingDown({ principal: conn.principal, anonymous: conn.identity.anonymous, ip: conn.ip });
      if (cool) {
        sendWs(conn.ws, encodeNotice({ kind: 'busy' }));
        this.closeConn(conn, CLOSE.tryAgain, 'cooldown');
        this.deps.metrics.wsRejected.inc({ reason: `write_${cool}` });
        return;
      }
      void this.onUpdate(conn, room, update);
      return;
    }
    if (type === MSG_LEDGER) {
      // The ledger is server-only: a client never writes it, in any form.
      this.deps.log.warn({ room: room.name, user: conn.identity.id }, 'client message on the ledger channel');
      this.closeConn(conn, CLOSE.forbidden, 'ledger is read-only');
      this.deps.metrics.wsRejected.inc({ reason: 'ledger_write' });
      return;
    }
    if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec);
      // Protocol §5.4: the `user` field is forced to the verified identity; states for
      // clientIds owned by other connections are dropped.
      // fv5 M-7: one state per connection (its own client id), at most MAX_AWARENESS_PER_ROOM per room.
      const fixed = sanitizeAwarenessUpdate(
        update,
        conn.clientIds,
        room.awareness,
        conn.identity,
        (id) => room.mayClaimAwareness(id, conn.identity.id),
        { maxClaims: 1, roomMax: cfg.maxAwarenessPerRoom },
      );
      if (fixed) awarenessProtocol.applyAwarenessUpdate(room.awareness, fixed, conn);
      return;
    }
    if (type === MSG_QUERY_AWARENESS) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        e,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(room.awareness.getStates().keys())),
      );
      sendWs(conn.ws, encoding.toUint8Array(e));
      return;
    }
    this.closeConn(conn, 1003, 'unknown message type');
  }

  /**
   * A client update (protocol §5.3), processed by the room's worker (fv9): the guard runs there,
   * the checks below run here on its verdict, and the worker applies it or drops it. A write the
   * guard refuses closes the connection and the update is NOT applied. A worker that takes too
   * long or runs out of heap on it is terminated and the room rebuilt (Room.recover): the sender
   * is closed 4413 and struck.
   */
  private async onUpdate(conn: Conn, room: Room, update: Uint8Array): Promise<void> {
    const { cfg } = this.deps;
    let precharged = 0;
    let growth = 0;
    try {
      const r = await room.update(conn, update, {
        decide: (check) => {
          if (check.bad === 'pending') {
            // fv5 M-2: an honest tab that reconnects with offline edits can send a fresh edit
            // before its step-2 answer (y-websocket sends local updates as soon as the socket is
            // open); that edit depends on structs the room does not have yet. It is not applied
            // (the room never holds pending state) and the connection stays open: the server
            // asks with a step 1 for what it lacks, and the client's step-2 answer carries the
            // edit too. A connection that keeps sending updates that never integrate is closed.
            this.askResync(conn, room);
            return false;
          }
          if (check.bad === 'splits' || check.bad === 'blocks' || (!check.bad && applyEstimateMs(0, check.splitWork, check.scanWork) > cfg.maxApplyMs)) {
            // fv8 P1/P2, fv9: more cuts of items, merges, or more work to make and place them, or
            // more client blocks, than one update may carry: Yjs would copy, splice and scan for
            // seconds. Refused like an update too large: only the sender closes.
            this.deps.log.warn({ room: room.name, user: conn.identity.id, bytes: update.byteLength, why: check.bad ?? 'work', merges: check.merges }, 'update refused: too much work');
            // fv9: an honest client practically never sends one (only a delete of thousands of
            // shapes written in one session can be over MAX_APPLY_MS): a strike, like a worker fault,
            // so that retrying costly messages ends in a cooldown
            this.deps.manager.strikes.strike({ principal: conn.principal, anonymous: conn.identity.anonymous, ip: conn.ip }, check.bad ?? 'work');
            sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
            this.closeConn(conn, CLOSE.tooLarge, check.bad === 'blocks' ? 'update carries too many clients' : 'update cuts too many items');
            this.deps.metrics.wsRejected.inc({ reason: check.bad === 'blocks' ? 'too_many_clients' : 'too_many_splits' });
            return false;
          }
          const bad = check.bad;
          if (bad) {
            this.deps.log.warn({ room: room.name, user: conn.identity.id, root: bad }, 'forbidden content write');
            this.closeConn(conn, CLOSE.forbidden, `write to ${bad} not allowed`);
            this.deps.metrics.wsRejected.inc({ reason: 'forbidden_write' });
            return false;
          }
          // Document size cap (protocol §10), per connection: an update that would grow the room
          // past THIS connection's cap is refused and only this connection is closed. The room
          // stays open for everyone else (an anonymous visitor cannot lock the room).
          // The ledger counts too (fv4 M4: create/delete cycles grew it ~7x the content). The
          // sizes are the exact ones of the last save plus every accepted update since (an upper
          // bound; every save — at most SAVE_DEBOUNCE_MS after a change — makes them exact again,
          // deletes included). Nothing O(room) runs here: no scratch copy, no re-encoding per
          // message (fv4 H2). An update that adds nothing (deletes only) always passes.
          // fv5 L-2: deletes that split live items grow the encoded room too (every split becomes
          // structs of its own), so they count against the cap with SPLIT_COST_BYTES per split.
          // fv7 F1: and the ledger the stamper writes with it, counted ahead (its shapes, their ids
          // and the room's longest user id: each line names the writer and the shape's creator), so a
          // room never passes its cap by the attribution of its last update (a room at the cap must
          // fit one share of the memory budget, and load for anyone).
          const limit = conn.identity.anonymous ? cfg.anonMaxDocBytes : cfg.maxDocBytes;
          growth = update.byteLength + check.splits * SPLIT_COST_BYTES;
          const ledger = check.grows ? ledgerBound(check.shapes, check.shapeKeyBytes, Math.max(utf8Length(conn.identity.id), room.maxUserIdBytes)) : 0;
          if (check.grows && room.approxBytes + room.ledgerApproxBytes + growth + ledger > limit) {
            sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
            this.closeConn(conn, CLOSE.tooLarge, 'document too large');
            this.deps.metrics.wsRejected.inc({ reason: 'doc_too_large' });
            return false;
          }
          // fv6 H-1, fv7 F1: the loaded rooms together may not grow past GROWTH_FRACTION of the
          // memory budget, the sender past its share of it (it is charged what it writes, in full),
          // the anonymous visitors past theirs. Refused with 1013 (busy, the client retries); nothing
          // is applied.
          if (check.grows) {
            const why = this.deps.manager.growthRefusal(room, conn.principal, conn.identity.anonymous, growth, ledger);
            if (why) {
              this.deps.log.warn({ room: room.name, user: conn.identity.id, growth, why }, 'update refused: memory budget');
              sendWs(conn.ws, encodeNotice({ kind: 'busy' }));
              this.closeConn(conn, CLOSE.tryAgain, 'server memory busy');
              this.deps.metrics.wsRejected.inc({ reason: why });
              return false;
            }
          }
          // fv8 P2: the CPU the apply will take is charged BEFORE it runs: an update whose
          // estimate the sender's budget or the server's cannot cover is refused 1013 (busy: the
          // client reconnects and sends it again once the budget refilled). One that costs more
          // than half a burst needs half a burst (a bucket never holds more than its burst); a
          // cheap one (under PRECHARGE_MIN_MS, the small edits fv5 M-5 lets through while the
          // server is busy) is charged after, as before.
          const estimate = applyEstimateMs(update.byteLength, check.splitWork, check.scanWork);
          const covers = (b: TokenBucket) => b.level() >= Math.min(estimate, b.burst / 2);
          if (estimate >= PRECHARGE_MIN_MS && (!covers(conn.cpu) || !covers(this.cpuAll) || (conn.identity.anonymous && !covers(this.cpuAnon)))) {
            this.deps.log.warn({ room: room.name, user: conn.identity.id, estimateMs: Math.round(estimate) }, 'update refused: cpu budget');
            sendWs(conn.ws, encodeNotice({ kind: 'busy' }));
            this.closeConn(conn, CLOSE.tryAgain, 'server busy');
            this.deps.metrics.wsRejected.inc({ reason: 'cpu_precharge' });
            return false;
          }
          conn.cpu.charge(estimate);
          this.cpuAll.charge(estimate);
          if (conn.identity.anonymous) this.cpuAnon.charge(estimate);
          precharged = estimate;
          return true;
        },
        applied: (check, outcome, before) => {
          // An update that only removes whole items counts what it really deleted (Yjs' own
          // encoding of the change), not its size: a delete set that repeats deletions the room
          // has (a full-state step 2 does) changes nothing, and counted at its size it grew the
          // estimate with nothing behind it until a save, which no change triggers (fv7 F1).
          room.approxBytes += check.grows ? growth : room.contentChangedBytes - before.changed;
          if (outcome.threw || outcome.droppedPending) room.markDirty();
          // fv7 F1: what the update added (content, and the ledger the stamper wrote for it and
          // for the client ids it bound) is charged to its sender, in full
          this.deps.manager.chargeUpdate(room, conn.principal, conn.identity.anonymous, before.cost);
          if (outcome.threw || outcome.droppedPending) {
            this.deps.log.error(
              { room: room.name, user: conn.identity.id, threw: outcome.threw, droppedPending: outcome.droppedPending },
              'accepted update did not integrate cleanly: sender closed, pending dropped',
            );
            if (outcome.droppedPending) this.deps.metrics.pendingDropped.inc({ where: 'apply' });
            this.closeConn(conn, CLOSE.forbidden, 'write not allowed');
            this.deps.metrics.wsRejected.inc({ reason: outcome.threw ? 'apply_threw' : 'pending_after_apply' });
          }
        },
      });
      // what the worker took, minus what was charged ahead for its apply (fv8 P2)
      if (r) this.chargeCpu(conn, room, r.ms - precharged);
    } catch (err) {
      if (err instanceof WorkerFault) {
        // the room was rebuilt and the sender closed and struck (Room.recover): the worker time
        // the message burned is charged to its principal and the server-wide budgets (not when the
        // room just went away under it: evicted or expired)
        if (!room.disposed) this.chargeCpu(conn, room, room.messageTimeout(update.byteLength) - precharged, false);
        return;
      }
      if (err instanceof RoomGone) return;
      this.deps.log.warn({ err: String(err), room: room.name }, 'bad message');
      this.closeConn(conn, 1003, 'bad message');
    }
  }

  /**
   * Sync step 1 from a client (fv4 H1: every 4-byte step 1 with an empty state vector was
   * answered with the whole room, buffered without bound for a peer that never read).
   *   - The answer is a diff against the client's state vector merged with the one the
   *     connection was sent in full at join (joinSv): the join already delivered the room
   *     and every later change was broadcast, so no vector gets the full state again.
   *   - The first answer of a connection is free; every later one is charged by its size to
   *     the connection's sync budget, and a later step 1 with an empty state vector (asking
   *     for the whole room again) closes the connection with 4429.
   *   - Nothing is computed for a peer whose outgoing buffer is over the cap.
   */
  private async answerStep1(conn: Conn, room: Room, sv: Uint8Array, closeInDebt = true): Promise<void> {
    if (conn.joining) {
      // its join state vector is not known yet: answered right after the content frame
      conn.deferredStep1 = sv;
      return;
    }
    if (!underBufferCap(conn.ws)) {
      this.deps.metrics.wsRejected.inc({ reason: 'slow_consumer' });
      conn.closing = true;
      conn.ws.terminate();
      return;
    }
    try {
      await room.diff(conn, sv, {
        refuseEmpty: () => conn.step1Answers > 0,
        answered: (r) => {
          // what the answer took in the worker; a principal in debt is closed (fv5 M-5), except
          // for the answer a join owes its client
          this.chargeCpu(conn, room, r.ms, closeInDebt);
          if (conn.closing) return;
          if (r.malformed) {
            this.closeConn(conn, 1003, 'bad message');
            return;
          }
          if (!r.diff) {
            this.deps.metrics.wsRejected.inc({ reason: 'sync_repeat' });
            sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
            this.closeConn(conn, CLOSE.rateLimited, 'full sync repeated');
            return;
          }
          if (!underBufferCap(conn.ws)) {
            this.deps.metrics.wsRejected.inc({ reason: 'slow_consumer' });
            conn.closing = true;
            conn.ws.terminate();
            return;
          }
          if (conn.step1Answers > 0 && !conn.syncBytes.take(r.diff.byteLength)) {
            this.deps.metrics.wsRejected.inc({ reason: 'sync_bytes' });
            sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
            this.closeConn(conn, CLOSE.rateLimited, 'sync budget');
            return;
          }
          conn.step1Answers++;
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, MSG_SYNC);
          encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
          encoding.writeVarUint8Array(e, r.diff);
          sendWs(conn.ws, encoding.toUint8Array(e));
        },
      });
    } catch (err) {
      if (err instanceof WorkerFault) {
        if (!room.disposed) this.chargeCpu(conn, room, room.messageTimeout(sv.byteLength), false);
        return;
      }
      if (err instanceof RoomGone) return;
      this.closeConn(conn, 1003, 'bad message');
    }
  }

  /** Ask the client for what the room lacks (sync step 1), at most one request outstanding. */
  private askResync(conn: Conn, room: Room): void {
    this.deps.metrics.pendingResync.inc();
    if (conn.resyncAsked) return; // the answer to the outstanding request carries this edit too
    if (!conn.resync.take()) {
      this.deps.log.warn({ room: room.name, user: conn.identity.id }, 'updates that never integrate: closed');
      this.closeConn(conn, CLOSE.forbidden, 'write to pending not allowed');
      this.deps.metrics.wsRejected.inc({ reason: 'forbidden_write' });
      return;
    }
    conn.resyncAsked = true;
    void room.step1Frame().then(
      (f) => sendConn(conn, f),
      () => undefined,
    );
  }

  private async recheck(conn: Conn, room: Room): Promise<void> {
    if (conn.closing || conn.ws.readyState !== conn.ws.OPEN) return;
    const res = await this.deps.authz.authorize(conn.cookie, conn.artifactKey, conn.authorization);
    const state = artifactState(res, this.deps.cfg);
    if (state === 'gone') {
      await this.deps.manager.expireRoom(room.name, 'gone');
      return;
    }
    if (state === 'expired') {
      await this.deps.manager.expireRoom(room.name, 'expired');
      return;
    }
    if (!res.allowed) {
      if (coreError(res.reason)) {
        // fv7 F6: the core could not answer the re-check (timeout, 5xx): the connection is not
        // kept unverified (fail closed), but nothing was revoked either: 1013, the client
        // reconnects and is checked again (4403 made every tab give up during a core blip)
        sendWs(conn.ws, encodeNotice({ kind: 'busy' }));
        this.closeConn(conn, CLOSE.tryAgain, 'authorization unavailable');
        this.deps.metrics.wsRejected.inc({ reason: `recheck_${res.reason}` });
        return;
      }
      sendWs(conn.ws, encodeNotice({ kind: 'revoked' }));
      conn.ws.close(CLOSE.forbidden, 'authorization revoked');
      this.deps.metrics.wsRejected.inc({ reason: 'revoked' });
    }
  }
}

/** An update whose apply is estimated under this (ms) is not checked against the CPU budgets first (fv8 P2). */
const PRECHARGE_MIN_MS = 1;

/** An authz answer that says the core failed (not a decision): `core_error`, `malformed` (authz.ts). */
function coreError(reason: string): boolean {
  return reason === 'core_error' || reason === 'malformed';
}

/** Join deadline: the payload at WS_JOIN_MIN_BYTES_PER_SEC, never less than 30 s. */
function joinDeadlineMs(bytes: number, minBytesPerSec: number): number {
  return Math.max(JOIN_MIN_MS, (bytes / minBytesPerSec) * 1000);
}

function isHttps(req: IncomingMessage): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const v = (Array.isArray(xf) ? xf[0] : xf ?? '').split(',')[0].trim().toLowerCase();
  return v === 'https';
}
