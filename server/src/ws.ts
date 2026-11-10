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
import { Room, limitBuffered, sendWs, underBufferCap, type Conn } from './room.js';
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
import { applyGuarded, checkClientUpdate, type UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';

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

/** Request property carrying the Set-Cookie of the upgrade response (see the 'headers' hook). */
const SET_COOKIE = Symbol('canvas-set-cookie');
type UpgradeReq = IncomingMessage & { [SET_COOKIE]?: string };

export class WsServer {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  readonly anon: AnonIssuer;
  /** join buckets per principal (`u:<id>`, `a:<visitor>`) and per room for anonymous visitors (`r:<key>`) */
  private readonly joins = new Map<string, TokenBucket>();

  constructor(private readonly deps: WsDeps) {
    this.anon = deps.anon ?? new AnonIssuer(deps.cfg.anonCookieSecret);
    // The anonymous-visitor cookie rides on the 101 response of the upgrade.
    this.wss.on('headers', (headers: string[], req: UpgradeReq) => {
      const c = req[SET_COOKIE];
      if (c) headers.push(`Set-Cookie: ${c}`);
    });
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
        // Anonymous pseudonym: assigned by the server (anon.ts); ?anon= is only a hint.
        const anonymous = !res.identity || res.identity.anonymous;
        const visitor = anonymous ? this.anon.visitor(cookie, anonParam) : null;
        const num = visitor ? assignNum(visitor.num, visitor.nonce, existing ? existing.anonHolders() : new Map()) : '';
        const identity = composeIdentity(res, num, visitor ? this.anon.visitorId(visitor.nonce) : '');
        // Joins per principal (fv4 H1): every join is answered with the whole content and
        // ledger, so reconnecting in a loop is an amplifier too. Anonymous visitors (who can
        // drop their cookie and come back as a new one) also share one bucket per room.
        if (!this.joinAllowed(visitor ? null : identity.id, visitor?.nonce ?? null, key.key)) {
          this.deps.metrics.wsRejected.inc({ reason: 'join_rate' });
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            sendWs(ws, encodeNotice({ kind: 'rate-limited' }));
            ws.close(CLOSE.rateLimited, 'too many joins');
          });
          return;
        }
        // Capacity (protocol §7): per room (anon stricter) and per anonymous visitor. Every
        // penalty is per connection: nothing a visitor sends can lock other people out.
        if (existing) {
          if (existing.conns.size >= this.deps.cfg.maxConnsPerRoom) {
            this.rejectCapacity(socket, req, head, 'room full');
            return;
          }
          if (visitor) {
            if (existing.countAnon() >= this.deps.cfg.maxConnsPerRoomAnon) {
              this.rejectCapacity(socket, req, head, 'room anon capacity');
              return;
            }
            if (existing.countVisitor(visitor.nonce) >= this.deps.cfg.maxConnsPerAnonVisitor) {
              this.rejectCapacity(socket, req, head, 'anon visitor capacity');
              return;
            }
          }
        }
        if (visitor && (visitor.fresh || num !== visitor.num)) {
          (req as UpgradeReq)[SET_COOKIE] = this.anon.setCookie(visitor.nonce, num, isHttps(req));
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          void this.join(ws, key.key, cookie, authorization, identity, visitor ? { nonce: visitor.nonce, num } : null, res.artifact?.ttl ?? null);
        });
      })
      .catch((err) => {
        this.deps.log.error({ err: String(err) }, 'upgrade authz unexpected error');
        socket.destroy();
      });
  };

  /** Take one join from the principal's bucket (and the room's anonymous bucket). */
  private joinAllowed(userId: string | null, visitorNonce: string | null, room: string): boolean {
    const { cfg } = this.deps;
    if (this.joins.size > 10_000) for (const [k, b] of this.joins) if (b.full()) this.joins.delete(k);
    const bucket = (k: string, perMin: number, burst: number) => {
      let b = this.joins.get(k);
      if (!b) this.joins.set(k, (b = new TokenBucket(perMin / 60, burst)));
      return b;
    };
    if (userId !== null) return bucket(`u:${userId}`, cfg.joinRatePerMin, cfg.joinBurst).take();
    const roomBucket = bucket(`r:${room}`, cfg.anonRoomJoinRatePerMin, cfg.anonRoomJoinBurst);
    const own = bucket(`a:${visitorNonce}`, cfg.anonJoinRatePerMin, cfg.anonJoinBurst);
    return own.take() && roomBucket.take();
  }

  private rejectCapacity(socket: Duplex, req: IncomingMessage, head: Buffer, why: string): void {
    this.deps.metrics.wsRejected.inc({ reason: 'capacity' });
    this.deps.log.debug({ why }, 'ws refused: capacity');
    this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(1013, why));
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
  ): Promise<void> {
    const { cfg, manager, metrics, log } = this.deps;
    let room: Room;
    try {
      room = await manager.getOrCreate(artifactKey, ttl);
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
    let identity = identityIn;
    let anonNum: string | undefined;
    if (anonVisitor) {
      // Two upgrades may have raced for the same free pseudonym before the room existed:
      // re-check against the live connections now that the room is loaded. Only the label
      // changes; the attribution id stays bound to the visitor cookie.
      anonNum = assignNum(anonVisitor.num, anonVisitor.nonce, room.anonHolders());
      if (anonNum !== anonVisitor.num) identity = { ...identity, name: `Anónimo ${anonNum}` };
    }
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
      cpu: identity.anonymous
        ? new TokenBucket(cfg.anonCpuMsPerSec, cfg.anonCpuBurstMs)
        : new TokenBucket(cfg.cpuMsPerSec, cfg.cpuBurstMs),
      step1Answers: 0,
      joinSv: Y.decodeStateVector(Y.encodeStateVector(room.doc)),
      closing: false,
    };
    const full = room.fullState();
    // A peer that stops reading is dropped once the server holds more than the cap for it
    // beyond the join burst below (fv4 H1: 200 tiny requests from a paused socket buffered
    // 661 MB in the server); a tab still downloading a big room is not cut off.
    limitBuffered(ws, cfg.wsMaxBufferedBytes + full.content.byteLength + full.ledger.byteLength, () => {
      metrics.wsRejected.inc({ reason: 'slow_consumer' });
      log.warn({ room: artifactKey, user: identity.id, buffered: ws.bufferedAmount }, 'ws dropped: outgoing buffer over the cap');
    });
    room.conns.set(ws, conn);
    metrics.wsAccepted.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    metrics.connections.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    log.info({ room: artifactKey, user: identity.id, anon: identity.anonymous }, 'ws joined');

    // IDENTITY MUST be the first message (protocol §4.1).
    sendWs(ws, encodeIdentity(identity));
    // The ledger (read-only for clients) before the content, so shapes arrive with authors.
    sendWs(ws, encodeLedger(full.ledger));
    // The content: the full state (step 2), then the server's state vector (step 1) so the
    // client answers with a step 2 holding what the room lacks — the edits it made while
    // disconnected. That answer is a plain client update and goes through the guard; the
    // content document holds no server-only root a client could echo back.
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(e, full.content);
    sendWs(ws, encoding.toUint8Array(e));
    const e1 = encoding.createEncoder();
    encoding.writeVarUint(e1, MSG_SYNC);
    syncProtocol.writeSyncStep1(e1, room.doc);
    sendWs(ws, encoding.toUint8Array(e1));
    const states = room.awareness.getStates();
    if (states.size) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())),
      );
      sendWs(ws, encoding.toUint8Array(a));
    }

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      if (conn.closing) return;
      const t0 = performance.now();
      try {
        this.onMessage(conn, room, new Uint8Array(data as ArrayBuffer));
      } catch (err) {
        log.warn({ err: String(err), room: artifactKey }, 'bad message');
        this.closeConn(conn, 1003, 'bad message');
      }
      // CPU budget (fv4 H2): the time the server spent on this connection's messages is
      // charged to it; a sender that keeps the event loop busy is closed, whatever it sends.
      const spent = performance.now() - t0;
      if (!conn.closing && !conn.cpu.charge(spent)) {
        log.warn({ room: artifactKey, user: identity.id, ms: Math.round(spent) }, 'ws closed: cpu budget used up');
        sendWs(ws, encodeNotice({ kind: 'rate-limited' }));
        this.closeConn(conn, CLOSE.rateLimited, 'cpu budget');
        metrics.wsRejected.inc({ reason: 'cpu_budget' });
      }
    });

    // Re-check authorization periodically (protocol §4): revoked drops the connection;
    // expired/gone drop the whole room and delete the canvas object.
    conn.recheckTimer = setInterval(() => {
      void this.recheck(conn, room);
    }, Math.max(1, cfg.recheckSeconds) * 1000);

    ws.on('close', () => {
      conn.closing = true;
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
      if (conn.identity.readOnly) return;
      // Protocol §5.3: a write the content guard refuses closes the connection and the
      // update is NOT applied.
      const check = checkClientUpdateSafe(room, conn, update);
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
      const limit = conn.identity.anonymous ? cfg.anonMaxDocBytes : cfg.maxDocBytes;
      if (check.grows && room.approxBytes + room.ledgerApproxBytes + update.byteLength > limit) {
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
        room.approxBytes += update.byteLength;
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
      const fixed = sanitizeAwarenessUpdate(update, conn.clientIds, room.awareness, conn.identity, (id) =>
        room.mayClaimAwareness(id, conn.identity.id),
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
    return { bad: 'forbidden', writers: [], grows: false };
  }
}

function isHttps(req: IncomingMessage): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const v = (Array.isArray(xf) ? xf[0] : xf ?? '').split(',')[0].trim().toLowerCase();
  return v === 'https';
}
