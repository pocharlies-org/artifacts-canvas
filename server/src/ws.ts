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
import { Room, sendWs, type Conn } from './room.js';
import {
  CLOSE,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  encodeIdentity,
  encodeNotice,
} from '@pocharlies/artifacts-canvas-shared/protocol';
import { checkClientUpdate, type UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';

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
      closing: false,
    };
    room.conns.set(ws, conn);
    metrics.wsAccepted.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    metrics.connections.inc({ anonymous: identity.anonymous ? 'true' : 'false' });
    log.info({ room: artifactKey, user: identity.id, anon: identity.anonymous }, 'ws joined');

    // IDENTITY MUST be the first message (protocol §4).
    sendWs(ws, encodeIdentity(identity));
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    // Push the room state directly (step2). The server is the source of truth (it just
    // loaded the doc from the object store), so there is nothing to request from the
    // client — and a step1 here would make clients answer with a step2 that echoes the
    // stamper roots back, which the §5.3 guard must (and now does) reject.
    syncProtocol.writeSyncStep2(e, room.doc);
    sendWs(ws, encoding.toUint8Array(e));
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
      try {
        this.onMessage(conn, room, new Uint8Array(data as ArrayBuffer));
      } catch (err) {
        log.warn({ err: String(err), room: artifactKey }, 'bad message');
        try {
          ws.close(1003, 'bad message');
        } catch {
          /* ignore */
        }
      }
    });

    // Re-check authorization periodically (protocol §4): revoked drops the connection;
    // expired/gone drop the whole room and delete the canvas object.
    conn.recheckTimer = setInterval(() => {
      void this.recheck(conn, room);
    }, Math.max(1, cfg.recheckSeconds) * 1000);

    ws.on('close', () => {
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

  private onMessage(conn: Conn, room: Room, buf: Uint8Array): void {
    const { cfg } = this.deps;
    if (!conn.rate.take()) {
      sendWs(conn.ws, encodeNotice({ kind: 'rate-limited' }));
      conn.ws.close(CLOSE.rateLimited, 'rate limited');
      this.deps.metrics.wsRejected.inc({ reason: 'rate_limited' });
      return;
    }
    const maxMsg = conn.identity.anonymous ? cfg.anonMaxMessageBytes : cfg.maxMessageBytes;
    if (buf.byteLength > maxMsg) {
      sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
      conn.ws.close(CLOSE.tooLarge, 'message too large');
      this.deps.metrics.wsRejected.inc({ reason: 'message_too_large' });
      return;
    }
    const dec = decoding.createDecoder(buf);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const syncType = decoding.readVarUint(dec);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.writeSyncStep2(e, room.doc, decoding.readVarUint8Array(dec));
        sendWs(conn.ws, encoding.toUint8Array(e));
        return;
      }
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        // A step2 payload is [state vector][update]. The state vector is
        // varUint(count) + count×(varUint clientId, varUint clock); skip it so the
        // guard and the apply below see the plain update (a step2 must not be able to
        // smuggle a stamper-root write past forbiddenRootWriteSafe).
        const n = decoding.readVarUint(dec);
        for (let i = 0; i < n; i++) {
          decoding.readVarUint(dec);
          decoding.readVarUint(dec);
        }
      } else if (syncType !== syncProtocol.messageYjsUpdate) {
        conn.ws.close(1003, 'unknown sync type');
        return;
      }
      const update = decoding.readVarUint8Array(dec);
      if (conn.identity.readOnly) return;
      // Protocol §5.3: a client write to attribution/users/history closes the connection
      // and the update is NOT applied.
      const check = checkClientUpdateSafe(room, conn, update);
      const bad = check.bad;
      if (bad) {
        this.deps.log.warn({ room: room.name, user: conn.identity.id, root: bad }, 'forged stamper-root write');
        conn.ws.close(CLOSE.forbidden, `write to ${bad} not allowed`);
        this.deps.metrics.wsRejected.inc({ reason: 'forbidden_write' });
        return;
      }
      // Document size cap (protocol §7), per connection: an update that would grow the room
      // past THIS connection's cap is refused and only this connection is closed. The room
      // stays open for everyone else (an anonymous visitor cannot lock the room).
      const limit = conn.identity.anonymous ? cfg.anonMaxDocBytes : cfg.maxDocBytes;
      if (room.approxBytes + update.byteLength > limit) {
        const current = Y.encodeStateAsUpdate(room.doc).byteLength;
        room.approxBytes = current;
        if (current + update.byteLength > limit) {
          const after = sizeAfter(room.doc, update);
          if (after > limit && after > current) {
            sendWs(conn.ws, encodeNotice({ kind: 'too-large' }));
            conn.ws.close(CLOSE.tooLarge, 'document too large');
            this.deps.metrics.wsRejected.inc({ reason: 'doc_too_large' });
            return;
          }
        }
      }
      Y.applyUpdate(room.doc, update, conn);
      room.approxBytes += update.byteLength;
      // The room must never hold pending state (a parked struct can later be released into
      // a server-only root). The guard refuses every update that would leave some; if one
      // still did, close the sender and drop what was parked (never persisted, never sent).
      if (room.hasPending()) {
        this.deps.log.error({ room: room.name, user: conn.identity.id }, 'update left pending state: sender closed, pending dropped');
        conn.ws.close(CLOSE.forbidden, 'write not allowed');
        this.deps.metrics.wsRejected.inc({ reason: 'pending_after_apply' });
        void room.recoverFromPending();
        return;
      }
      room.claimWriters(check.writers, conn.identity.id);
      return;
    }
    if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec);
      // Protocol §5.4: the `user` field is forced to the verified identity; states for
      // clientIds owned by other connections are dropped.
      const fixed = sanitizeAwarenessUpdate(update, conn.clientIds, room.awareness, conn.identity);
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
    conn.ws.close(1003, 'unknown message type');
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
    return { bad: 'forbidden', writers: [] };
  }
}

/** Size of the room state after `update`, measured on a scratch copy (the room is untouched). */
function sizeAfter(doc: Y.Doc, update: Uint8Array): number {
  const scratch = new Y.Doc({ gc: doc.gc });
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(scratch, update);
    return Y.encodeStateAsUpdate(scratch).byteLength;
  } finally {
    scratch.destroy();
  }
}

function isHttps(req: IncomingMessage): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const v = (Array.isArray(xf) ? xf[0] : xf ?? '').split(',')[0].trim().toLowerCase();
  return v === 'https';
}
