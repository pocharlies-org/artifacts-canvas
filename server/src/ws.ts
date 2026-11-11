import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as Y from 'yjs';
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
import { TokenBucket } from './limits.js';
import { composeIdentity, sanitizeAwarenessUpdate } from './identity.js';
import { AnonIssuer, assignNum } from './anon.js';
import { normalizeOrigin } from './config.js';
import { stripBucketSegment, validateArtifactKey } from './paths.js';
import type { RoomManager } from './rooms.js';
import { Room, bufferCap, limitBuffered, sendWs, underBufferCap, type Conn } from './room.js';
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
import { SPLIT_COST_BYTES, applyGuarded, checkClientUpdate, type UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';

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
    this.anon = deps.anon ?? new AnonIssuer(cfg.anonCookieSecret);
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
        if (!this.joinAllowed(visitor ? null : identity.id, visitor, key.key, clientIp(req, cfg.clientIpHops))) {
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
        // what this join adds: nothing if a join of the same room version holds the frames
        // already (they are shared), else the room's size; refused only while something is held
        // (a room bigger than the budget can still be joined by one peer at a time)
        const held = this.outgoing().total;
        const joinEstimate = existing && !existing.framesInFlight(this.inFlightFrames()) ? existing.approxBytes + existing.ledgerApproxBytes : 0;
        if (held > 0 && held + joinEstimate > cfg.wsOutgoingBudgetBytes) {
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
          void this.join(ws, key.key, cookie, authorization, identity, visitor ? { nonce: visitor.nonce, num } : null, res.artifact?.ttl ?? null, principal);
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
   * flight (shared by every join of a room version) counted once.
   */
  private outgoing(): { total: number; conns: { conn: Conn; bytes: number }[] } {
    let total = 0;
    const frames = new Set<Uint8Array>();
    const conns: { conn: Conn; bytes: number }[] = [];
    for (const room of this.deps.manager.rooms.values()) {
      for (const conn of room.conns.values()) {
        const b = conn.ws.bufferedAmount + conn.backlogBytes;
        let own = b;
        if (conn.joinFrames && b > 0) {
          let shared = 0;
          for (const f of conn.joinFrames) {
            frames.add(f);
            shared += f.byteLength;
          }
          own = Math.max(0, b - shared);
        }
        total += own;
        conns.push({ conn, bytes: b });
      }
    }
    for (const f of frames) total += f.byteLength;
    return { total, conns };
  }

  /** Every join frame some connection still has in flight. */
  private inFlightFrames(): Set<Uint8Array> {
    const out = new Set<Uint8Array>();
    for (const room of this.deps.manager.rooms.values()) for (const c of room.conns.values()) if (c.joinFrames) for (const f of c.joinFrames) out.add(f);
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
    const out = this.outgoing();
    if (out.total > cfg.wsOutgoingBudgetBytes) {
      let total = out.total;
      for (const { conn, bytes } of out.conns.sort((a, b) => b.bytes - a.bytes)) {
        if (total <= cfg.wsOutgoingBudgetBytes || bytes < 1024 * 1024) break;
        this.drop(conn, 'outgoing_budget');
        total -= bytes;
      }
    }
    metrics.outgoingBytes.set(out.total);
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
  ): Promise<void> {
    const { cfg, manager, metrics, log } = this.deps;
    let room: Room;
    try {
      room = await manager.getOrCreate(artifactKey, ttl);
      // evicted (last leave) while this join waited for it: join the room that replaces it
      if (room.disposed || manager.get(artifactKey) !== room) room = await manager.getOrCreate(artifactKey, ttl);
    } catch (err) {
      if (manager.closing) {
        // restarting: the client reconnects (4503) to the next process
        sendWs(ws, encodeNotice({ kind: 'shutdown' }));
        ws.close(CLOSE.serverRestart, 'server restart');
        return;
      }
      log.error({ err: String(err), room: artifactKey }, 'room load failed');
      ws.close(1011, 'storage error');
      return;
    }
    if (ws.readyState !== ws.OPEN) return; // gone while the room loaded
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
    const ledgerFrame = room.ledgerFrame();
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
      resync: new TokenBucket(0.5, 20),
      step1Answers: 0,
      joinSv: new Map(),
      closing: false,
      joining: true,
      backlog: [],
      backlogBytes: 0,
      // until the content frame is encoded, the room's last known size stands for it
      joinBytes: ledgerFrame.byteLength + room.approxBytes,
      joinStarted: Date.now(),
      joinFrames: [ledgerFrame],
      overSince: 0,
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
    room.conns.set(ws, conn);
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
      this.chargeCpu(conn, room, performance.now() - t1);
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
      room.conns.delete(ws);
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
    sendWs(ws, ledgerFrame);
    this.chargeCpu(conn, room, performance.now() - t0, false);
    await this.drained(conn);
    if (conn.closing || ws.readyState !== ws.OPEN) return;
    // The content: the full state (step 2), then the server's state vector (step 1) so the
    // client answers with a step 2 holding what the room lacks — the edits it made while
    // disconnected. That answer is a plain client update and goes through the guard; the
    // content document holds no server-only root a client could echo back.
    const t2 = performance.now();
    const content = room.contentFrames();
    conn.joinSv = content.sv;
    conn.joinFrames = [ledgerFrame, content.step2];
    conn.joinBytes = ledgerFrame.byteLength + content.step2.byteLength;
    limitBuffered(ws, cfg.wsMaxBufferedBytes + conn.joinBytes, onOver);
    sendWs(ws, content.step2);
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
    this.chargeCpu(conn, room, performance.now() - t2, false);
    if (conn.deferredStep1 && !conn.closing) {
      const sv = conn.deferredStep1;
      conn.deferredStep1 = undefined;
      const t3 = performance.now();
      this.answerStep1(conn, room, sv);
      this.chargeCpu(conn, room, performance.now() - t3, false);
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
        this.answerStep1(conn, room, decoding.readVarUint8Array(dec));
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
      // Protocol §5.3: a write the content guard refuses closes the connection and the
      // update is NOT applied.
      const check = checkClientUpdateSafe(room, conn, update);
      if (check.bad === 'pending') {
        // fv5 M-2: an honest tab that reconnects with offline edits can send a fresh edit
        // before its step-2 answer (y-websocket sends local updates as soon as the socket is
        // open); that edit depends on structs the room does not have yet. It is not applied
        // (the room never holds pending state) and the connection stays open: the server
        // asks with a step 1 for what it lacks, and the client's step-2 answer carries the
        // edit too. A connection that keeps sending updates that never integrate is closed.
        this.askResync(conn, room);
        return;
      }
      const bad = check.bad;
      if (bad) {
        this.deps.log.warn({ room: room.name, user: conn.identity.id, root: bad }, 'forbidden content write');
        this.closeConn(conn, CLOSE.forbidden, `write to ${bad} not allowed`);
        this.deps.metrics.wsRejected.inc({ reason: 'forbidden_write' });
        return;
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
      const limit = conn.identity.anonymous ? cfg.anonMaxDocBytes : cfg.maxDocBytes;
      const growth = update.byteLength + check.splits * SPLIT_COST_BYTES;
      if (check.grows && room.approxBytes + room.ledgerApproxBytes + growth > limit) {
        sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
        this.closeConn(conn, CLOSE.tooLarge, 'document too large');
        this.deps.metrics.wsRejected.inc({ reason: 'doc_too_large' });
        return;
      }
      // Apply with the connection as origin (the stamper attributes it to this identity).
      // applyGuarded ALWAYS drops whatever Yjs could not integrate, also when it throws
      // mid-way. A clean apply marks the room dirty through the document's update event;
      // anything else marks it here (what did integrate before a throw was broadcast).
      let outcome: ReturnType<typeof applyGuarded> | null = null;
      try {
        outcome = applyGuarded(room.doc, update, conn);
      } finally {
        room.approxBytes += growth;
        if (!outcome || outcome.threw || outcome.droppedPending) room.markDirty();
      }
      if (outcome.threw || outcome.droppedPending) {
        this.deps.log.error(
          { room: room.name, user: conn.identity.id, threw: outcome.threw, droppedPending: outcome.droppedPending },
          'accepted update did not integrate cleanly: sender closed, pending dropped',
        );
        if (outcome.droppedPending) this.deps.metrics.pendingDropped.inc({ where: 'apply' });
        this.closeConn(conn, CLOSE.forbidden, 'write not allowed');
        this.deps.metrics.wsRejected.inc({ reason: outcome.threw ? 'apply_threw' : 'pending_after_apply' });
        return;
      }
      room.claimWriters(check.writers, conn.identity.id);
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
  private answerStep1(conn: Conn, room: Room, sv: Uint8Array): void {
    if (conn.joining) {
      // its join state vector is not known yet: answered right after the content frame
      Y.decodeStateVector(sv); // malformed = bad message, now
      conn.deferredStep1 = sv;
      return;
    }
    const clientSv = Y.decodeStateVector(sv);
    const emptySv = clientSv.size === 0;
    if (conn.step1Answers > 0 && emptySv) {
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
    const merged = new Map(conn.joinSv);
    for (const [client, clock] of clientSv) if (clock > (merged.get(client) ?? 0)) merged.set(client, clock);
    const diff = Y.encodeStateAsUpdate(room.doc, Y.encodeStateVector(merged));
    if (conn.step1Answers > 0 && !conn.syncBytes.take(diff.byteLength)) {
      this.deps.metrics.wsRejected.inc({ reason: 'sync_bytes' });
      sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
      this.closeConn(conn, CLOSE.rateLimited, 'sync budget');
      return;
    }
    conn.step1Answers++;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(e, diff);
    sendWs(conn.ws, encoding.toUint8Array(e));
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
    sendWs(conn.ws, room.step1Frame());
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
      sendWs(conn.ws, encodeNotice({ kind: 'revoked' }));
      conn.ws.close(CLOSE.forbidden, 'authorization revoked');
      this.deps.metrics.wsRejected.inc({ reason: 'revoked' });
    }
  }
}

/**
 * The §5.3 guard with this connection's client-id ownership; it can throw on malformed
 * updates, and any throw counts as forbidden.
 */
function checkClientUpdateSafe(room: Room, conn: Conn, update: Uint8Array): UpdateCheck {
  try {
    return checkClientUpdate(room.doc, update, {
      serverClient: room.doc.clientID,
      mayWriteClient: (client) => room.mayWrite(client, conn.identity.id, conn),
    });
  } catch {
    return { bad: 'forbidden', writers: [], grows: false, splits: 0 };
  }
}

/** Join deadline: the payload at WS_JOIN_MIN_BYTES_PER_SEC, never less than 30 s. */
function joinDeadlineMs(bytes: number, minBytesPerSec: number): number {
  return Math.max(JOIN_MIN_MS, (bytes / minBytesPerSec) * 1000);
}

/**
 * The client IP when the deployment says where it comes from (CLIENT_IP_HOPS): 0 = the TCP
 * peer, n = the n-th address from the right of X-Forwarded-For; -1 = unknown (null).
 */
export function clientIp(req: IncomingMessage, hops: number): string | null {
  if (hops < 0) return null;
  if (hops === 0) return req.socket?.remoteAddress ?? null;
  const xf = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xf) ? xf.join(',') : xf ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.length >= hops ? list[list.length - hops] : req.socket?.remoteAddress ?? null;
}

function isHttps(req: IncomingMessage): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const v = (Array.isArray(xf) ? xf[0] : xf ?? '').split(',')[0].trim().toLowerCase();
  return v === 'https';
}
