import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { writeUpdate } from 'y-protocols/sync';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { canvasLedgerKey, canvasObjectKey } from './paths.js';
import type { CanvasObjectStore } from './store.js';
import type { Identity } from './types.js';
import { attachStamper, dropPending, encodeIntegratedState, hasPending } from '@pocharlies/artifacts-canvas-shared/stamper';
import { bindWriters, materializeContent, materializeLedger, migrateLegacyRoots, pruneAttribution, writerOf } from '@pocharlies/artifacts-canvas-shared/ledger';
import { MSG_SYNC, encodeLedger } from '@pocharlies/artifacts-canvas-shared/protocol';
import type { TokenBucket } from './limits.js';

/** A live WebSocket connection in a room. Used as the Yjs transaction origin. */
export interface Conn {
  ws: WebSocket;
  artifactKey: string;
  cookie: string;
  /** Raw `Authorization` header (if any), forwarded to the gate on every re-check. */
  authorization: string;
  identity: Identity;
  /** anonymous visitor nonce from the server-signed cookie (anon.ts); undefined if logged in */
  anonVisitor?: string;
  /** the pseudonym number shown for an anonymous visitor ("Anónimo NNNN") */
  anonNum?: string;
  /** awareness clientIds this connection has claimed (protocol §5.4 hardening) */
  clientIds: Set<number>;
  rate: TokenBucket;
  /** bytes of sync step-2 answers after the first one (fv4 H1) */
  syncBytes: TokenBucket;
  /** server CPU time (ms) spent on the messages of this connection's PRINCIPAL (shared, fv5 M-5) */
  cpu: TokenBucket;
  /** `u:<user id>` or `a:<visitor nonce>`: the key of the per-principal limits */
  principal: string;
  /** server step-1 requests answering a `pending` update (fv5 M-2), per connection */
  resync: TokenBucket;
  /** a step-1 request is outstanding (cleared by the client's next step 2) */
  resyncAsked?: boolean;
  /**
   * Join in progress (fv5 H-1): the payload goes out piece by piece, each once the previous
   * one drained; room broadcasts meanwhile wait in `backlog` (sent after the payload, in order).
   */
  joining: boolean;
  backlog: Uint8Array[];
  backlogBytes: number;
  /** a sync step 1 the client sent while joining (answered once its join state vector is known) */
  deferredStep1?: Uint8Array;
  /** size of the join payload and when it started; `joinFrames` = the shared frames still in flight */
  joinBytes: number;
  joinStarted: number;
  joinFrames: Uint8Array[] | null;
  /** since when the outgoing buffer has been over the cap (0 = it is not) */
  overSince: number;
  /**
   * Drain tracking (fv6 L-A), sampled every second: bytes sent and buffered at the last sample,
   * and the last time the peer drained at least WS_JOIN_MIN_BYTES_PER_SEC (or held little).
   * A peer that made no such progress for WS_STALL_MS is stalled: under outgoing-budget pressure
   * it is dropped before anyone else is refused.
   */
  lastSent: number;
  lastBuffered: number;
  progressAt: number;
  sampledAt?: number;
  /** ping/pong liveness: a ping is outstanding, how much was buffered then, missed rounds */
  awaitingPong: boolean;
  pingBuffered: number;
  missedPongs: number;
  /** sync step 1 messages answered so far (the first answer is free, whatever it costs) */
  step1Answers: number;
  /**
   * The content state vector this connection was sent in full at join. Every later change
   * is broadcast to it, so a step 1 is answered against this merged with the client's own
   * vector: no state vector, however forged, gets the whole room again (fv4 H1).
   */
  joinSv: Map<number, number>;
  recheckTimer?: ReturnType<typeof setInterval>;
  closing: boolean;
}

export interface RoomDeps {
  cfg: Config;
  store: CanvasObjectStore;
  log: Logger;
  metrics: Metrics;
  /** called after the last connection left and the room was flushed */
  onEmpty: (name: string) => void;
  /**
   * Server CPU for debounced saves, shared by every room (fv6 M-A): a save encodes the whole
   * room, so a client making tiny edits in several big rooms made the server encode each of
   * them every SAVE_DEBOUNCE_MS. A debounced save waits while the budget is in debt; flushes
   * (last leave, shutdown) never wait.
   */
  saveBudget?: TokenBucket;
}

/**
 * One room per artifact key (design §6.2), made of TWO documents (protocol §5-§6):
 *   doc     the CONTENT document (shapes, assets, meta): the only one clients write, through
 *           the guard, each update applied with its connection as transaction origin;
 *   ledger  the LEDGER document (attribution, users, history, writers): written only by the
 *           shared stamper, which observes `doc`; clients receive it on MSG_LEDGER and the
 *           server never applies a client byte to it.
 * Both live in memory while anyone is connected and are persisted to object storage (two
 * objects) with a debounce plus on last-leave (protocol §8).
 */
export class Room {
  readonly doc = materializeContent(new Y.Doc());
  readonly ledger = materializeLedger(new Y.Doc());
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Conn>();
  /** content size: exact at load and at every save, plus the accepted updates since */
  approxBytes = 0;
  /** rough ledger size estimate (it counts against the size cap too, fv4 M4) */
  ledgerApproxBytes = 0;
  /** bumped on every change of the content / the ledger document (cache keys below) */
  private contentVersion = 0;
  private ledgerVersion = 0;
  /**
   * Join payload caches (fv6 M-A). Each document is encoded in full once (a snapshot frame) and
   * shared by every join; the updates broadcast since are kept as they went out (the tail) and
   * a join gets snapshot + tail, which Yjs integrates into exactly the current document. The
   * snapshot is encoded again only once its tail outgrew it (TAIL_MAX_MESSAGES, or a quarter of
   * the snapshot): a client that bumps the room before every join no longer makes every join
   * re-encode the whole room (fv6 Q2: 82 ms per join of a 3.3 MiB room).
   */
  private contentSnap: Snapshot | null = null;
  private ledgerSnap: Snapshot | null = null;
  /** the room's sync step 1 (state vector), per content version (fv6 L-C: not the full step 2) */
  private step1Cache: { version: number; frame: Uint8Array; sv: Map<number, number> } | null = null;
  /** full encodings of a document for joins (tests, metric canvas_join_encodes_total) */
  encodes = 0;
  /** CPU time the load took, not charged to anyone yet (see takeLoadMs) */
  private loadMs = 0;
  /** joins that are waiting for this room (its load, or attaching): never evicted meanwhile */
  pendingJoins = 0;
  /** live connections per principal (`u:<id>` / `a:<visitor>`): who keeps the room loaded */
  readonly principals = new Map<string, number>();
  private lastPrune = 0;
  ttlTag: string | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    private readonly deps: RoomDeps,
  ) {
    this.awareness.setLocalState(null);

    // Protocol §5.2: stamp attribution/users/history into the LEDGER for every client
    // transaction on the CONTENT document.
    attachStamper(this.doc, this.ledger, {
      userOf: (origin: unknown) => {
        const c = origin as Conn | undefined;
        if (!c || !c.identity) return null;
        return {
          id: c.identity.id,
          info: {
            name: c.identity.name,
            anonymous: c.identity.anonymous,
            color: c.identity.color,
          },
        };
      },
    });

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      writeUpdate(e, update);
      const msg = encoding.toUint8Array(e);
      // Everyone but the sender (it has the update already).
      this.contentVersion++;
      this.contentSnap = extendTail(this.contentSnap, msg);
      for (const c of this.conns.values()) if (c !== origin) sendConn(c, msg);
      if (origin !== 'load') this.markDirty();
    });
    // The ledger goes to everyone, the sender included (it learns its own attribution here).
    this.ledger.on('update', (update: Uint8Array, origin: unknown) => {
      const msg = encodeLedger(update);
      this.ledgerVersion++;
      this.ledgerSnap = extendTail(this.ledgerSnap, msg);
      this.ledgerApproxBytes += update.byteLength;
      for (const c of this.conns.values()) sendConn(c, msg);
      if (origin !== 'load') this.markDirty();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const c = origin as Conn | undefined;
        if (c?.clientIds) {
          for (const id of added) c.clientIds.add(id);
          for (const id of removed) c.clientIds.delete(id);
        }
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1 /* MSG_AWARENESS */);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        const msg = encoding.toUint8Array(e);
        for (const conn of this.conns.values()) sendConn(conn, msg);
      },
    );
  }

  /**
   * The ledger part of a join: its snapshot frame (MSG_LEDGER + the full ledger) and the ledger
   * messages broadcast since. The frames are shared by every join (fv5 H-1: N slow readers must
   * not hold N copies of the room).
   */
  ledgerFrames(): Uint8Array[] {
    if (!this.ledgerSnap) {
      this.ledgerSnap = newSnapshot(encodeLedger(encodeIntegratedState(this.ledger)));
      this.countEncode('ledger');
    }
    return [this.ledgerSnap.frame, ...this.ledgerSnap.tail];
  }

  /**
   * The content part of a join: the snapshot (sync step 2 with the full state) and the content
   * updates broadcast since, the room's sync step 1, and the state vector all of them add up to
   * (what the joiner has once they arrived).
   */
  contentFrames(): { frames: Uint8Array[]; step1: Uint8Array; sv: Map<number, number> } {
    if (!this.contentSnap) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(e, encodeIntegratedState(this.doc));
      this.contentSnap = newSnapshot(encoding.toUint8Array(e));
      this.countEncode('content');
    }
    const s1 = this.step1();
    return { frames: [this.contentSnap.frame, ...this.contentSnap.tail], step1: s1.frame, sv: s1.sv };
  }

  /** True when a join now needs no full encoding (both snapshots are cached). */
  framesCached(): boolean {
    return this.contentSnap !== null && this.ledgerSnap !== null;
  }

  /**
   * What a join adds to the bytes held for peers: each document's size, unless a join in flight
   * holds its current snapshot already (`frames`: the frames in flight; they are shared).
   */
  joinEstimate(frames: Set<Uint8Array>): number {
    const ledger = this.ledgerSnap && frames.has(this.ledgerSnap.frame) ? 0 : this.ledgerApproxBytes;
    const content = this.contentSnap && frames.has(this.contentSnap.frame) ? 0 : this.approxBytes;
    return ledger + content;
  }

  /** A sync step 1 with the room's current state vector (asks a client for what the room lacks). */
  step1Frame(): Uint8Array {
    return this.step1().frame;
  }

  /** Sync step 1 and state vector, once per content version: O(clients), never the full state. */
  private step1(): { frame: Uint8Array; sv: Map<number, number> } {
    if (!this.step1Cache || this.step1Cache.version !== this.contentVersion) {
      const e1 = encoding.createEncoder();
      encoding.writeVarUint(e1, MSG_SYNC);
      syncProtocol.writeSyncStep1(e1, this.doc);
      this.step1Cache = { version: this.contentVersion, frame: encoding.toUint8Array(e1), sv: Y.decodeStateVector(Y.encodeStateVector(this.doc)) };
    }
    return this.step1Cache;
  }

  /** The load's CPU time, once (the first join charges it to its principal). */
  takeLoadMs(): number {
    const ms = this.loadMs;
    this.loadMs = 0;
    return ms;
  }

  private countEncode(doc: 'content' | 'ledger'): void {
    this.encodes++;
    this.deps.metrics.joinEncodes.inc({ doc });
  }

  /** Content + ledger bytes (the size cap's and the memory budget's measure). */
  get bytes(): number {
    return this.approxBytes + this.ledgerApproxBytes;
  }

  /** A joined connection: it counts for its principal (who keeps the room loaded). */
  attach(conn: Conn): void {
    this.conns.set(conn.ws, conn);
    if (conn.identity.anonymous) this.anonConns++;
    this.principals.set(conn.principal, (this.principals.get(conn.principal) ?? 0) + 1);
  }

  /** The connection left. */
  detach(conn: Conn): void {
    if (this.conns.get(conn.ws) !== conn) return;
    this.conns.delete(conn.ws);
    if (conn.identity.anonymous) this.anonConns--;
    const n = (this.principals.get(conn.principal) ?? 1) - 1;
    if (n > 0) this.principals.set(conn.principal, n);
    else this.principals.delete(conn.principal);
  }

  /** Every live connection is anonymous (the room is held by anonymous visitors only). */
  anonOnly(): boolean {
    return this.conns.size > 0 && this.anonConns === this.conns.size;
  }
  private anonConns = 0;

  /** Nobody is connected nor about to: the room can be evicted. */
  get idle(): boolean {
    return this.conns.size === 0 && this.pendingJoins === 0;
  }

  get objectKey(): string {
    return canvasObjectKey(this.deps.cfg.canvasPrefix, this.name);
  }

  get ledgerKey(): string {
    return canvasLedgerKey(this.deps.cfg.canvasPrefix, this.name);
  }

  /** Copy the artifact's ttl tag (design §6.3): first valid one wins. The core's gate returns
   *  ttl as an integer number of days (or null). */
  touchTtl(ttl: number | null | undefined): void {
    if (!this.ttlTag && typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 0 && ttl <= 999) {
      this.ttlTag = `ttl=${ttl}`;
    }
  }

  /**
   * Load both documents from storage. `admit` sees the encoded size before anything is decoded
   * (fv6 H-1: the memory budget); it throws to refuse the load, else returns a release that
   * runs once the documents are in.
   */
  async load(admit?: (encodedBytes: number) => Promise<() => void>): Promise<void> {
    const { store, metrics } = this.deps;
    try {
      const [ledgerBytes, data] = await Promise.all([store.get(this.ledgerKey), store.get(this.objectKey)]);
      const release = admit ? await admit((ledgerBytes?.byteLength ?? 0) + (data?.byteLength ?? 0)) : () => undefined;
      const t0 = performance.now();
      try {
        this.apply(ledgerBytes, data);
      } finally {
        release();
        this.loadMs = performance.now() - t0;
      }
      metrics.loads.inc({ outcome: 'ok' });
    } catch (err) {
      metrics.loads.inc({ outcome: err instanceof BusyError ? 'refused' : 'error' });
      throw err;
    }
  }

  private apply(ledgerBytes: Uint8Array | null, data: Uint8Array | null): void {
    const { metrics, log } = this.deps;
    // ledger first, so a migration below sees what the ledger already holds
    if (ledgerBytes && ledgerBytes.byteLength > 0) {
      Y.applyUpdate(this.ledger, ledgerBytes, 'load');
      this.ledgerApproxBytes = ledgerBytes.byteLength;
      if (dropPending(this.ledger)) {
        log.warn({ room: this.name }, 'stored ledger had pending structs: dropped');
        metrics.pendingDropped.inc({ where: 'load' });
        this.markDirty();
      }
    }
    if (data && data.byteLength > 0) {
      Y.applyUpdate(this.doc, data, 'load');
      this.approxBytes = data.byteLength;
      // A stored document must integrate completely. Parked structs/deletes (an object
      // written before the guard refused them) are dropped and the clean state is saved.
      if (dropPending(this.doc)) {
        log.warn({ room: this.name }, 'stored canvas had pending structs: dropped');
        metrics.pendingDropped.inc({ where: 'load' });
        this.markDirty();
      }
      // A document from before the content/ledger split: its attribution/users/history
      // move to the ledger and leave the content document (both saved back).
      if (migrateLegacyRoots(this.doc, this.ledger, 'migrate')) {
        log.info({ room: this.name }, 'legacy canvas split into content + ledger');
        metrics.migrations.inc();
        this.markDirty();
      }
    }
    this.prune();
  }

  /** Something changed (or may have, after an apply that threw): save soon. */
  markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) this.scheduleSave(this.deps.cfg.saveDebounceMs);
  }

  private scheduleSave(ms: number): void {
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      // the server-wide save budget is used up: save once it refilled (still at most this late)
      const wait = this.deps.saveBudget?.msUntilPositive() ?? 0;
      if (wait > 0 && !this.disposed) this.scheduleSave(Math.max(wait, this.deps.cfg.saveDebounceMs));
      else void this.save();
    }, ms);
  }

  /**
   * Serialize saves; persist the two documents as two objects with the copied ttl tag.
   * The ledger goes first: a content object is never newer than its ledger.
   */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      // a disposed room is gone (evicted after its last save, or expired and deleted): never
      // written back
      if (!this.dirty || this.disposed) return;
      const { store, metrics, log } = this.deps;
      const t0 = performance.now();
      this.dirty = false;
      try {
        // never persist parked structs/deletes (encodeStateAsUpdate would merge them in)
        const droppedContent = dropPending(this.doc);
        const droppedLedger = dropPending(this.ledger);
        if (droppedContent || droppedLedger) {
          log.error({ room: this.name }, 'room had pending structs at save: dropped');
          metrics.pendingDropped.inc({ where: 'save' });
        }
        if (Date.now() - this.lastPrune > 3600_000) this.prune();
        const ledgerBytes = encodeIntegratedState(this.ledger);
        const bytes = encodeIntegratedState(this.doc);
        this.approxBytes = bytes.byteLength;
        this.ledgerApproxBytes = ledgerBytes.byteLength;
        this.deps.saveBudget?.charge(performance.now() - t0);
        await store.put(this.ledgerKey, ledgerBytes, this.ttlTag ?? undefined);
        await store.put(this.objectKey, bytes, this.ttlTag ?? undefined);
        metrics.saves.inc({ outcome: 'ok' });
      } catch (err) {
        this.dirty = true;
        metrics.saves.inc({ outcome: 'error' });
        log.error({ err: String(err), room: this.name }, 'canvas save failed');
      } finally {
        metrics.saveDuration.observe((performance.now() - t0) / 1000);
      }
    });
    return this.saving;
  }

  /** Drop attribution entries of shapes deleted longer ago than the retention (fv4 M4). */
  prune(): void {
    this.lastPrune = Date.now();
    const days = this.deps.cfg.attributionRetentionDays;
    const n = pruneAttribution(this.doc, this.ledger, this.lastPrune, days * 86400_000);
    if (n) this.deps.log.info({ room: this.name, pruned: n }, 'attribution of long-deleted shapes pruned');
  }

  /** Cancel the debounce and persist now (last leave / shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }

  /** True when the room holds structs/deletes Yjs could not integrate. */
  hasPending(): boolean {
    return hasPending(this.doc);
  }

  /**
   * May `principal` add clocks to Yjs client id `client` of the content document? A client
   * id is bound (in the ledger, so the binding survives a reload and a restart) to the first
   * principal that adds clocks to it, and nobody else may extend it: a forged struct at
   * someone else's next clock would make Yjs drop that person's real edit as "already
   * known". An id nobody wrote yet is refused when another principal's live connection
   * announced it in awareness; an id that already has clocks is never decided by awareness.
   */
  mayWrite(client: number, principal: string, conn: Conn): boolean {
    if (client === this.doc.clientID || client === this.ledger.clientID) return false;
    const owner = writerOf(this.ledger, client);
    if (owner !== undefined) return owner === principal;
    // clocks from before the bindings were persisted (legacy object): first writer binds it
    if (Y.getState(this.doc.store, client) > 0) return true;
    for (const c of this.conns.values()) if (c !== conn && c.identity.id !== principal && c.clientIds.has(client)) return false;
    return true;
  }

  /** May `principal` announce awareness state for `clientId`? Not for someone else's writer id. */
  mayClaimAwareness(clientId: number, principal: string): boolean {
    const owner = writerOf(this.ledger, clientId);
    return owner === undefined || owner === principal;
  }

  /** Bind the client ids of an accepted update to its principal (persisted in the ledger). */
  claimWriters(clients: number[], principal: string): void {
    bindWriters(this.ledger, clients, principal);
  }

  /** Live connections of one anonymous visitor (server-issued nonce). */
  countVisitor(nonce: string): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.anonVisitor === nonce) n++;
    return n;
  }

  /** Live anonymous pseudonyms (the NNNN of "Anónimo NNNN") -> the visitor holding them. */
  anonHolders(): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of this.conns.values()) {
      if (c.identity.anonymous && c.anonVisitor && c.anonNum) m.set(c.anonNum, c.anonVisitor);
    }
    return m;
  }

  countAnon(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.identity.anonymous) n++;
    return n;
  }

  /**
   * Release the room once it is evicted: the awareness instance runs a 3 s interval that
   * referenced the room's documents forever (every evicted room stayed in memory: found while
   * sizing the memory limit for fv5 H-1). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.awareness.destroy();
    this.contentSnap = null;
    this.ledgerSnap = null;
    this.step1Cache = null;
  }

  disposed = false;

  closeAll(code: number, reason: string): void {
    for (const c of this.conns.values()) {
      try {
        c.ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }
}

/** A refused join or load: the client is told `busy` and closed with 1013 (it retries). */
export class BusyError extends Error {
  constructor(readonly reason: string) {
    super(`busy: ${reason}`);
  }
}

/** A document encoded in full for joins, and the messages broadcast since (see Room). */
interface Snapshot {
  frame: Uint8Array;
  tail: Uint8Array[];
  tailBytes: number;
}
/** The tail is dropped (the next join encodes the document again) past this many messages... */
export const TAIL_MAX_MESSAGES = 256;
/** ...or past this many bytes, or a quarter of the snapshot if that is more. */
const TAIL_MIN_BYTES = 64 * 1024;

function newSnapshot(frame: Uint8Array): Snapshot {
  return { frame, tail: [], tailBytes: 0 };
}

/** Add a broadcast message to a snapshot's tail; null once the tail outgrew the snapshot. */
function extendTail(snap: Snapshot | null, msg: Uint8Array): Snapshot | null {
  if (!snap) return null;
  if (snap.tail.length >= TAIL_MAX_MESSAGES || snap.tailBytes + msg.byteLength > Math.max(TAIL_MIN_BYTES, snap.frame.byteLength / 4)) return null;
  snap.tail.push(msg);
  snap.tailBytes += msg.byteLength;
  return snap;
}

/** Outgoing-buffer cap of a connection and what to do when it is passed (see limitBuffered). */
const bufferLimits = new WeakMap<WebSocket, { cap: number; onOver: () => void }>();

/**
 * Cap what the server queues for `ws` (fv4 H1): once its unsent bytes pass `cap`, the next
 * send drops the connection (terminate: a close frame would only queue behind the backlog)
 * instead of buffering without bound for a peer that stopped reading.
 */
export function limitBuffered(ws: WebSocket, cap: number, onOver: () => void): void {
  bufferLimits.set(ws, { cap, onOver });
}

/** True while `ws` is under its outgoing-buffer cap (always for an unlimited socket). */
export function underBufferCap(ws: WebSocket): boolean {
  const l = bufferLimits.get(ws);
  return !l || ws.bufferedAmount <= l.cap;
}

/**
 * Send to a joined connection; while its join payload is still going out the message waits
 * in its backlog (counted against its cap: a backlog over the cap drops the connection).
 */
export function sendConn(c: Conn, msg: Uint8Array): void {
  if (c.closing) return;
  if (c.joining) {
    c.backlog.push(msg);
    c.backlogBytes += msg.byteLength;
    const l = bufferLimits.get(c.ws);
    if (l && c.backlogBytes > l.cap) {
      bufferLimits.delete(c.ws);
      l.onOver();
      c.closing = true;
      c.backlog = [];
      c.backlogBytes = 0;
      try {
        c.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  sendWs(c.ws, msg);
}

/** The outgoing-buffer cap set by limitBuffered (Infinity when none). */
export function bufferCap(ws: WebSocket): number {
  return bufferLimits.get(ws)?.cap ?? Infinity;
}

/** Bytes handed to each socket so far (with bufferedAmount: how fast a peer drains, fv6 L-A). */
const sentCounts = new WeakMap<WebSocket, number>();

export function sentBytes(ws: WebSocket): number {
  return sentCounts.get(ws) ?? 0;
}

export function sendWs(ws: WebSocket, msg: Uint8Array): void {
  if (ws.readyState !== ws.OPEN) return;
  const l = bufferLimits.get(ws);
  if (l && ws.bufferedAmount > l.cap) {
    bufferLimits.delete(ws);
    l.onOver();
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
    return;
  }
  sentCounts.set(ws, (sentCounts.get(ws) ?? 0) + msg.byteLength);
  ws.send(msg);
}
