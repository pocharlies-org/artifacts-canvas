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
  /** bumped on every change of either document (cache key of the encodings below) */
  private version = 0;
  private stateCache: { version: number; content: Uint8Array; ledger: Uint8Array } | null = null;
  private ledgerFrameCache: { version: number; frame: Uint8Array } | null = null;
  private contentFramesCache: { version: number; step2: Uint8Array; step1: Uint8Array; sv: Map<number, number> } | null = null;
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
      this.version++;
      for (const c of this.conns.values()) if (c !== origin) sendConn(c, msg);
      if (origin !== 'load') this.markDirty();
    });
    // The ledger goes to everyone, the sender included (it learns its own attribution here).
    this.ledger.on('update', (update: Uint8Array, origin: unknown) => {
      const msg = encodeLedger(update);
      this.version++;
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
   * The integrated state of both documents, encoded once per version: every join sends both
   * in full, so N joins of an unchanged room cost one encoding, not N.
   */
  fullState(): { content: Uint8Array; ledger: Uint8Array } {
    if (!this.stateCache || this.stateCache.version !== this.version) {
      this.stateCache = { version: this.version, content: encodeIntegratedState(this.doc), ledger: encodeIntegratedState(this.ledger) };
    }
    return this.stateCache;
  }

  /**
   * The join frames, each encoded ONCE per room version and shared by every join of that
   * version (fv5 H-1: every join encoded its own copy of the whole room into its socket's
   * buffer, so N slow readers held N copies). The ledger frame (MSG_LEDGER + full ledger):
   */
  ledgerFrame(): Uint8Array {
    if (!this.ledgerFrameCache || this.ledgerFrameCache.version !== this.version) {
      this.ledgerFrameCache = { version: this.version, frame: encodeLedger(encodeIntegratedState(this.ledger)) };
    }
    return this.ledgerFrameCache.frame;
  }

  /** The content frames: full state (sync step 2), the room's sync step 1, and its state vector. */
  contentFrames(): { step2: Uint8Array; step1: Uint8Array; sv: Map<number, number> } {
    if (!this.contentFramesCache || this.contentFramesCache.version !== this.version) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(e, encodeIntegratedState(this.doc));
      const e1 = encoding.createEncoder();
      encoding.writeVarUint(e1, MSG_SYNC);
      syncProtocol.writeSyncStep1(e1, this.doc);
      this.contentFramesCache = {
        version: this.version,
        step2: encoding.toUint8Array(e),
        step1: encoding.toUint8Array(e1),
        sv: Y.decodeStateVector(Y.encodeStateVector(this.doc)),
      };
    }
    return this.contentFramesCache;
  }

  /** True when the CURRENT version's join frames are among `frames` (a join in flight holds them). */
  framesInFlight(frames: Set<Uint8Array>): boolean {
    const l = this.ledgerFrameCache;
    return !!l && l.version === this.version && frames.has(l.frame);
  }

  /** A sync step 1 with the room's current state vector (asks a client for what the room lacks). */
  step1Frame(): Uint8Array {
    return this.contentFrames().step1;
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

  async load(): Promise<void> {
    const { store, metrics, log } = this.deps;
    try {
      const [ledgerBytes, data] = await Promise.all([store.get(this.ledgerKey), store.get(this.objectKey)]);
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
      metrics.loads.inc({ outcome: 'ok' });
    } catch (err) {
      metrics.loads.inc({ outcome: 'error' });
      throw err;
    }
  }

  /** Something changed (or may have, after an apply that threw): save soon. */
  markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.save();
      }, this.deps.cfg.saveDebounceMs);
    }
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
    this.stateCache = null;
    this.ledgerFrameCache = null;
    this.contentFramesCache = null;
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
  ws.send(msg);
}
