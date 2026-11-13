import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { writeUpdate } from 'y-protocols/sync';
import type { WebSocket } from 'ws';
import { MESSAGE_COST_FACTOR, SCAN_WORK_NS, SPLIT_WORK_NS, applyEstimateMs, roomCost, type Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { canvasLedgerKey, canvasObjectKey } from './paths.js';
import type { CanvasObjectStore } from './store.js';
import type { Identity } from './types.js';
import type { UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger } from '@pocharlies/artifacts-canvas-shared/ledger';
import { CLOSE, MSG_SYNC, encodeLedger, encodeNotice } from '@pocharlies/artifacts-canvas-shared/protocol';
import type { TokenBucket } from './limits.js';
import type { Emitted } from './room-core.js';
import type { ApplyResult, CheckResult, DiffResult, FramesResult, InspectResult, LoadResult, SaveResult, StampIdentity, WorkerRequest } from './room-protocol.js';
import { WorkerFault, WorkerHost, type Answer, type FaultKind, type Semaphore } from './worker-host.js';

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
  /** bytes of its messages received and not processed yet (review M-1, ws.ts admitInflight) */
  inflight: number;
  /** the server stopped reading it until its messages in flight are processed (review M-1) */
  paused?: boolean;
  /** CPU (ms) charged ahead for the apply of the message being processed (fv8 P2) */
  precharged?: number;
  /** `u:<user id>` or `a:<visitor nonce>`: the key of the per-principal limits */
  principal: string;
  /** the client IP when the deployment says where it comes from (CLIENT_IP_HOPS), else null (strikes) */
  ip?: string | null;
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
  /** a save reached storage (an idle room kept for its unsaved changes can go now, review F-6) */
  onSaved?: (room: Room) => void;
  /**
   * Server CPU for debounced saves, shared by every room (fv6 M-A): a save encodes the whole
   * room, so a client making tiny edits in several big rooms made the server encode each of
   * them every SAVE_DEBOUNCE_MS. A debounced save waits while the budget is in debt; flushes
   * (last leave, shutdown) never wait.
   */
  saveBudget?: TokenBucket;
  /**
   * The most one principal may be charged for (RoomManager.share): a room's charge to one
   * principal never goes past it (fv8 P1: a stored room that costs more than a share loads,
   * charged one share at most).
   */
  shareOf?: (anonymous: boolean) => number;
  /** client messages processed at once over all rooms (Config.workerApplyConcurrency) */
  applySlots?: Semaphore;
  /** a client message made the room's worker fault: its principal gets a strike (fv9) */
  onStrike?: (conn: Conn, kind: FaultKind) => void;
  /** the room could not be rebuilt after a fault: every connection was closed, the manager drops it */
  onBroken?: (room: Room) => void;
}

/** The room is gone (evicted, expired, or dropped after a fault): nothing more runs on it. */
export class RoomGone extends Error {
  constructor() {
    super('room gone');
  }
}

/** What the main thread decides about a client update once the guard answered (see Room.update). */
export interface UpdateHooks {
  /** main-thread checks (size cap, memory budget, CPU): true = apply it; false = the caller refused it */
  decide: (check: UpdateCheck) => boolean;
  /** the update was applied (or threw / left pending state, both dropped): bookkeeping */
  applied: (check: UpdateCheck, outcome: ApplyResult, before: { cost: number; changed: number }) => void;
}

const MiB = 1024 * 1024;
/**
 * The write-ahead log of a room may hold this many rooms at the size cap (MAX_DOC_BYTES) before its
 * writes are refused (review F-6: while saves fail, nothing else bounded it).
 */
export const WAL_MAX_DOCS = 4;
/** A failed save is retried after SAVE_DEBOUNCE_MS x 2^failures, at most this (ms). */
const SAVE_RETRY_MAX_MS = 30_000;
/** Young generation of a room's worker (MiB). */
export const WORKER_YOUNG_MB = 16;

/**
 * One room per artifact key (design §6.2), made of TWO documents (protocol §5-§6):
 *   content  the CONTENT document (shapes, assets, meta): the only one clients write, through
 *            the guard, each update applied with its connection as transaction origin;
 *   ledger   the LEDGER document (attribution, users, history, writers): written only by the
 *            shared stamper, which observes the content; clients receive it on MSG_LEDGER and
 *            the server never applies a client byte to it.
 *
 * Isolation (fv9): both documents live in a worker thread of the room's own (room-worker.ts,
 * RoomCore), with a heap limit derived from the room's cost; this object, on the main thread,
 * holds the connections, the memory charges, the join frames and the write-ahead log, and never
 * decodes or applies a client byte. Everything that touches the documents is a job on the room's
 * queue (one at a time, in arrival order), and every request to the worker has a watchdog. A
 * worker that misses it, runs out of heap or crashes is terminated, the sender of the message
 * that caused it is closed (4413) and struck, and the room is rebuilt in a fresh worker from its
 * saved objects plus the log of every change since (never the offending message): the same
 * document it was (the same content and state vector; the encoding can differ where Yjs merged
 * structs in another order, the ledger's never did); the connected clients are asked (sync step 1)
 * for anything they hold that the room does not.
 *
 * Both documents are persisted to object storage (two objects) with a debounce plus on
 * last-leave (protocol §8); a successful save truncates the log.
 */
export class Room {
  /** presence: relayed by the main thread, never part of the documents (its doc is a placeholder) */
  readonly awareness = new awarenessProtocol.Awareness(new Y.Doc());
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
  private step1Cache: { version: number; frame: Uint8Array; sv: Map<number, number>; raw: Uint8Array } | null = null;
  /** full encodings of a document for joins (tests, metric canvas_join_encodes_total) */
  encodes = 0;
  /** CPU time the load took, not charged to anyone yet (see takeLoadMs) */
  private loadMs = 0;
  /** joins that are waiting for this room (its load, or attaching): never evicted meanwhile */
  pendingJoins = 0;
  /** live connections per principal (`u:<id>` / `a:<visitor>`): who keeps the room loaded */
  readonly principals = new Map<string, number>();
  /**
   * The room's memory, charged to the principals that brought it in (fv7 F1, RoomManager): the
   * room's cost at load to the principal that loaded it, and what every accepted update added to
   * the room's size estimate to the principal that sent it, in full. Nobody else is charged for
   * them (a principal that only reads in the room pays nothing), and what it wrote stays charged
   * to it while the room is loaded, whoever keeps it loaded (a writer that leaves still pays). The
   * load charge of a principal that leaves moves to the principals still connected, as far as
   * their shares hold it (fv8 U2: the loader kept paying for a room its colleagues kept open).
   * Together they are the room's cost (settleCharges), never more than a share each. Cleared when
   * the room is evicted.
   */
  private readonly charges = new Map<string, Charge>();
  /** content bytes of the updates the document emitted (Yjs' own encoding of what changed) */
  contentChangedBytes = 0;
  /**
   * UTF-8 bytes of the longest user id in the ledger's `users` (everyone who ever wrote here):
   * the attribution and history the stamper writes for a shape name its creator (fv7 F1, the
   * ledger an update adds is counted ahead with it)
   */
  maxUserIdBytes = 0;
  ttlTag: string | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  /** the writer bound to each client id in the ledger (mirrored for awareness claims, §5.4) */
  private readonly writers = new Map<number, string>();
  /** the room's worker (null before the load, and while a recovery replaces it) */
  private host: WorkerHost | null = null;
  /** the documents are loaded: a fault from now on is recovered */
  private live = false;
  /** a recovery failed: the room is being dropped */
  broken = false;
  /** jobs on the documents, one at a time in arrival order (see job()) */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Write-ahead log (fv9): every change the documents emitted since the last save that reached
   * storage, in order. A fresh worker that loads the saved objects and replays it is the room.
   */
  private wal: { seq: number; entries: Emitted[] }[] = [];
  private walSeq = 0;
  walBytes = 0;
  /** saves that failed in a row (a failed save is retried with a backoff, review F-6) */
  private saveFailures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** the object puts of a save in flight (a recovery reads storage once they are done) */
  private putting: Promise<void> = Promise.resolve();
  /** workers that faulted and were replaced (tests, logs) */
  restarts = 0;
  /** the old-generation limit (MiB) of the current worker */
  heapLimitMb = 0;

  constructor(
    readonly name: string,
    private readonly deps: RoomDeps,
  ) {
    this.awareness.setLocalState(null);
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

  // ---------- the worker ----------

  /**
   * The worker's old-generation limit (MiB): the room at its largest (one share: a room at the
   * size cap fits it, or the stored room when it is bigger) plus one message of MAX_MESSAGE_BYTES
   * being guarded and applied (MESSAGE_COST_FACTOR). Whatever an update makes Yjs allocate past
   * that ends the worker (ERR_WORKER_OUT_OF_MEMORY), never the process.
   */
  heapLimitFor(storedBytes: number): number {
    const { cfg } = this.deps;
    const room = Math.max(this.deps.shareOf?.(false) ?? roomCost(cfg, cfg.maxDocBytes), roomCost(cfg, storedBytes));
    return Math.ceil((room + MESSAGE_COST_FACTOR * cfg.maxMessageBytes) / MiB);
  }

  private spawn(storedBytes: number): WorkerHost {
    const { cfg } = this.deps;
    this.heapLimitMb = this.heapLimitFor(storedBytes);
    const host = new WorkerHost(
      {
        name: this.name,
        core: {
          attributionRetentionDays: cfg.attributionRetentionDays,
          maxSplits: cfg.maxSplitsPerMessage,
          maxSplitWork: (cfg.maxApplyMs * 1e6) / SPLIT_WORK_NS,
          maxScanWork: (cfg.maxApplyMs * 1e6) / SCAN_WORK_NS,
          maxClients: cfg.maxClientsPerUpdate,
        },
        testHooks: cfg.workerTestHooks,
      },
      { oldMb: this.heapLimitMb, youngMb: WORKER_YOUNG_MB },
    );
    this.deps.metrics.workers.inc();
    void host.exited.then(() => this.deps.metrics.workers.dec());
    return host;
  }

  /** The worker started (its modules loaded), within the operation timeout. */
  private async started(host: WorkerHost): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.ready,
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new WorkerFault('timeout', 'worker start')), this.deps.cfg.workerOpTimeoutMs))),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (host.fault) throw host.fault;
  }

  /** Timeout of an operation on the whole room (load, encodings, replay). */
  private opTimeout(bytes: number): number {
    return this.deps.cfg.workerOpTimeoutMs + (bytes * this.deps.cfg.workerOpNsPerByte) / 1e6;
  }

  /** Timeout of a client message (its guard and apply together). */
  messageTimeout(bytes: number): number {
    return this.deps.cfg.workerMessageTimeoutMs + (bytes * this.deps.cfg.workerTimeoutNsPerByte) / 1e6;
  }

  /** One request to the worker; what the documents emitted is taken in (broadcast, logged). */
  private async call<T>(req: WorkerRequest, timeoutMs: number, sender: Conn | null = null, transfer: ArrayBuffer[] = []): Promise<Answer<T>> {
    const host = this.host;
    if (!host) throw new RoomGone();
    const a = await host.call<T>(req, timeoutMs, transfer);
    if (this.host === host) this.absorb(a, sender);
    return a;
  }

  /** Changes a worker answer carries: the mirrors, the log, the broadcasts. */
  private absorb(a: Answer<unknown>, sender: Conn | null): void {
    if (a.maxUserIdBytes > this.maxUserIdBytes) this.maxUserIdBytes = a.maxUserIdBytes;
    for (const [client, writer] of a.writers) if (!this.writers.has(client)) this.writers.set(client, writer);
    if (!a.emitted.length) return;
    let bytes = 0;
    for (const e of a.emitted) bytes += e.u.byteLength;
    this.wal.push({ seq: ++this.walSeq, entries: a.emitted });
    this.walBytes += bytes;
    for (const e of a.emitted) {
      if (e.doc === 'content') {
        this.contentChangedBytes += e.u.byteLength;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        writeUpdate(enc, e.u);
        const msg = encoding.toUint8Array(enc);
        this.contentVersion++;
        this.contentSnap = extendTail(this.contentSnap, msg);
        // everyone but the sender (it has the update already)
        for (const c of this.conns.values()) if (c !== sender) sendConn(c, msg);
      } else {
        // the ledger goes to everyone, the sender included (it learns its own attribution here)
        const msg = encodeLedger(e.u);
        this.ledgerVersion++;
        this.ledgerSnap = extendTail(this.ledgerSnap, msg);
        this.ledgerApproxBytes += e.u.byteLength;
        for (const c of this.conns.values()) sendConn(c, msg);
      }
    }
    this.markDirty();
    // a log much bigger than the room's cap (saves failing, or held back by the save budget):
    // save now, a recovery replays all of it
    if (this.walBytes > 2 * this.deps.cfg.maxDocBytes && !this.saveForced) {
      this.saveForced = true;
      void this.flush().finally(() => (this.saveForced = false));
    }
  }
  private saveForced = false;

  /**
   * Run `fn` on the documents once every earlier job is done. A worker fault inside it is
   * recovered before the next job starts (the sender of a client message is closed and struck),
   * then rethrown to the caller.
   */
  private job<T>(sender: Conn | null, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.disposed || this.broken) throw new RoomGone();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof WorkerFault && this.live && !this.disposed) await this.recover(err, sender);
        throw err;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /**
   * The worker faulted: close and strike the sender of the message that caused it, rebuild the
   * room in a fresh worker from the saved objects and the log, and ask every client for what it
   * holds that the room may lack. If that fails too, every connection is closed (1013: they
   * reconnect and resync) and the room is dropped.
   */
  private async recover(fault: WorkerFault, sender: Conn | null): Promise<void> {
    const { metrics, log, store } = this.deps;
    this.restarts++;
    metrics.workerFaults.inc({ kind: fault.kind });
    log.warn({ room: this.name, kind: fault.kind, err: fault.message, user: sender?.identity.id, walEntries: this.wal.length, walBytes: this.walBytes }, 'room worker fault: rebuilding the room');
    // the strike counts also when the sender already went away (sending and disconnecting at once
    // would otherwise evade it)
    if (sender) this.deps.onStrike?.(sender, fault.kind);
    if (sender && !sender.closing) {
      sendWs(sender.ws, encodeNotice({ kind: 'too-large' }));
      sender.closing = true;
      try {
        sender.ws.close(CLOSE.tooLarge, 'update too costly');
      } catch {
        /* gone */
      }
      metrics.wsRejected.inc({ reason: `worker_${fault.kind}` });
    }
    const old = this.host;
    this.host = null;
    await old?.terminate();
    try {
      // a save's puts finish first: the log starts where storage is
      await this.putting;
      const [ledgerBytes, data] = await Promise.all([store.get(this.ledgerKey), store.get(this.objectKey)]);
      const stored = (ledgerBytes?.byteLength ?? 0) + (data?.byteLength ?? 0);
      const host = this.spawn(Math.max(stored, this.bytes));
      try {
        await this.started(host);
        const l = ledgerBytes ? ledgerBytes.slice() : null;
        const c = data ? data.slice() : null;
        await host.call({ op: 'load', ledger: l, content: c, recovery: true }, this.opTimeout(stored), [l?.buffer, c?.buffer].filter((b): b is ArrayBuffer => !!b));
        const entries = this.wal.flatMap((w) => w.entries);
        if (entries.length) await host.call({ op: 'replay', entries }, this.opTimeout(stored + this.walBytes));
        const f = await host.call<FramesResult>({ op: 'frames', content: false, ledger: false, sv: true }, this.opTimeout(stored));
        const sv = f.result.sv!;
        if (this.step1Cache && this.step1Cache.version === this.contentVersion && !bytesEqual(this.step1Cache.raw, sv)) {
          // never seen; the join caches are dropped so that no join gets frames of another state
          log.error({ room: this.name }, 'rebuilt room differs from the one it replaces');
          metrics.workerRecoveries.inc({ outcome: 'differs' });
          this.contentSnap = null;
          this.ledgerSnap = null;
        }
        this.setStep1(sv);
      } catch (err) {
        await host.terminate();
        throw err;
      }
      this.host = host;
      metrics.workerRecoveries.inc({ outcome: 'ok' });
      log.info({ room: this.name, replayed: this.wal.length }, 'room rebuilt in a fresh worker');
      const step1 = this.step1Cache!.frame;
      for (const c of this.conns.values()) {
        if (c.closing || c === sender || c.joining) continue;
        sendConn(c, step1);
        c.resyncAsked = true;
        // review F-4: the rebuild asked, not the client: its resync budget (the step 1s the server
        // may send it for updates that do not integrate) starts full again
        c.resync.fill();
      }
    } catch (err) {
      metrics.workerRecoveries.inc({ outcome: 'failed' });
      log.error({ room: this.name, err: String(err) }, 'room could not be rebuilt: closed for everyone');
      this.broken = true;
      for (const c of this.conns.values()) {
        sendWs(c.ws, encodeNotice({ kind: 'busy' }));
        c.closing = true;
        try {
          c.ws.close(CLOSE.tryAgain, 'server busy');
        } catch {
          /* gone */
        }
      }
      this.deps.onBroken?.(this);
    }
  }

  /** Writers' client ids announced in awareness by live connections of OTHER writers than `conn`'s. */
  private claimedBy(conn: Conn): number[] {
    const out: number[] = [];
    for (const c of this.conns.values()) if (c !== conn && c.identity.id !== conn.identity.id) for (const id of c.clientIds) out.push(id);
    return out;
  }

  /**
   * A client update (protocol §5.3), as a job: the guard runs in the worker; `hooks.decide` makes
   * the main thread's checks on its verdict; the worker applies it (stamped, its client ids bound to
   * the writer) or drops it. The whole of it holds one apply slot and has one deadline
   * (messageTimeout). Resolves with the worker's time; rejects with WorkerFault after the room was
   * rebuilt (the sender is closed and struck), or RoomGone.
   */
  update(conn: Conn, update: Uint8Array, hooks: UpdateHooks): Promise<{ ms: number } | null> {
    return this.job(conn, async () => {
      if (conn.closing) return null;
      const release = (await this.deps.applySlots?.acquire()) ?? (() => undefined);
      try {
        if (conn.closing || this.disposed) return null;
        const t0 = performance.now();
        const deadline = t0 + this.messageTimeout(update.byteLength);
        const left = () => Math.max(1, deadline - performance.now());
        const buf = update.slice();
        const c = await this.call<CheckResult>({ op: 'check', update: buf, writer: conn.identity.id, claimed: this.claimedBy(conn) }, left(), conn, [buf.buffer as ArrayBuffer]);
        let ms = c.ms;
        const check = c.result.check;
        if (!hooks.decide(check)) {
          if (!check.bad) await this.call({ op: 'drop' }, left(), conn);
          this.deps.metrics.workerReply.observe((performance.now() - t0) / 1000);
          return { ms };
        }
        const before = { cost: this.cost, changed: this.contentChangedBytes };
        // the apply may take what the guard estimated (an upper bound of every path Yjs is known
        // to take, MAX_APPLY_MS at most), twice over; past that it is a path nobody counted
        const estimate = applyEstimateMs(update.byteLength, check.splitWork, check.scanWork);
        const applyTimeout = Math.max(left(), this.deps.cfg.workerMessageTimeoutMs + 2 * estimate);
        const a = await this.call<ApplyResult>({ op: 'apply', identity: stampIdentity(conn.identity) }, applyTimeout, conn);
        ms += a.ms;
        hooks.applied(check, a.result, before);
        this.deps.metrics.workerReply.observe((performance.now() - t0) / 1000);
        return { ms };
      } finally {
        release();
      }
    });
  }

  /**
   * A client's sync step 1, as a job: what the room has beyond its state vector merged with the
   * one the connection was sent in full at join (fv4 H1). `refuseEmpty` is asked when the job
   * runs (a later step 1 asking for everything again gets nothing), and `answered` gets the
   * answer inside the job, so that the step 1s of one connection are answered strictly in order.
   */
  diff(conn: Conn, sv: Uint8Array, hooks: { refuseEmpty: () => boolean; answered: (r: DiffResult & { ms: number }) => void }): Promise<void> {
    return this.job(conn, async () => {
      if (conn.closing) return;
      const buf = sv.slice();
      const joinSv = Y.encodeStateVector(conn.joinSv);
      const timeout = this.messageTimeout(sv.byteLength) + (this.bytes * this.deps.cfg.workerOpNsPerByte) / 1e6;
      const a = await this.call<DiffResult>({ op: 'diff', sv: buf, joinSv, refuseEmpty: hooks.refuseEmpty() }, timeout, conn, [buf.buffer as ArrayBuffer]);
      hooks.answered({ ...a.result, ms: a.ms });
    });
  }

  // ---------- join frames ----------

  /**
   * The ledger part of a join: its snapshot frame (MSG_LEDGER + the full ledger) and the ledger
   * messages broadcast since. The frames are shared by every join (fv5 H-1: N slow readers must
   * not hold N copies of the room).
   */
  async ledgerFrames(): Promise<Uint8Array[]> {
    if (this.ledgerSnap) return [this.ledgerSnap.frame, ...this.ledgerSnap.tail];
    return this.job(null, async () => {
      if (!this.ledgerSnap) {
        const a = await this.call<FramesResult>({ op: 'frames', content: false, ledger: true, sv: false }, this.opTimeout(this.bytes));
        this.ledgerSnap = newSnapshot(encodeLedger(a.result.ledger!));
        this.loadMs += a.ms;
        this.countEncode('ledger');
      }
      return [this.ledgerSnap.frame, ...this.ledgerSnap.tail];
    });
  }

  /**
   * The content part of a join: the snapshot (sync step 2 with the full state) and the content
   * updates broadcast since, the room's sync step 1, and the state vector all of them add up to
   * (what the joiner has once they arrived).
   */
  async contentFrames(): Promise<{ frames: Uint8Array[]; step1: Uint8Array; sv: Map<number, number> }> {
    const cached = () => {
      if (!this.contentSnap || !this.step1Cache || this.step1Cache.version !== this.contentVersion) return null;
      return { frames: [this.contentSnap.frame, ...this.contentSnap.tail], step1: this.step1Cache.frame, sv: this.step1Cache.sv };
    };
    return (
      cached() ??
      this.job(null, async () => {
        const hit = cached();
        if (hit) return hit;
        const content = !this.contentSnap;
        const a = await this.call<FramesResult>({ op: 'frames', content, ledger: false, sv: true }, this.opTimeout(this.bytes));
        if (content) {
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, MSG_SYNC);
          encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
          encoding.writeVarUint8Array(e, a.result.content!);
          this.contentSnap = newSnapshot(encoding.toUint8Array(e));
          this.loadMs += a.ms;
          this.countEncode('content');
        }
        this.setStep1(a.result.sv!);
        return cached()!;
      })
    );
  }

  /** The step 1 frame and state vector of the current content version, from the worker's encoding. */
  private setStep1(raw: Uint8Array): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep1);
    encoding.writeVarUint8Array(e, raw);
    this.step1Cache = { version: this.contentVersion, frame: encoding.toUint8Array(e), sv: Y.decodeStateVector(raw), raw };
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
  async step1Frame(): Promise<Uint8Array> {
    if (this.step1Cache && this.step1Cache.version === this.contentVersion) return this.step1Cache.frame;
    return this.job(null, async () => {
      if (!this.step1Cache || this.step1Cache.version !== this.contentVersion) {
        const a = await this.call<FramesResult>({ op: 'frames', content: false, ledger: false, sv: true }, this.opTimeout(this.bytes));
        this.setStep1(a.result.sv!);
      }
      return this.step1Cache!.frame;
    });
  }

  /** The load's and the join encodings' worker time, once (the next join charges it to its principal). */
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

  /**
   * The write-ahead log is full (review F-6): saves have kept failing and it holds more than
   * WAL_MAX_DOCS rooms' worth of changes. Writes are refused (1013, the clients keep their edits and
   * send them again once they reconnected) until a save reaches storage; nothing accepted is lost.
   */
  get walFull(): boolean {
    return this.walBytes > WAL_MAX_DOCS * this.deps.cfg.maxDocBytes;
  }

  /**
   * The last save failed and the room holds changes storage does not (review F-6): it is not evicted
   * while so, idle or not (its retries go on), and does not count as free memory.
   */
  get unsaved(): boolean {
    return this.saveFailures > 0 && this.dirty;
  }

  /** What the log holds beyond the room's own size (counted in the memory budget, RoomManager.memory). */
  get walExcess(): number {
    return Math.max(0, this.walBytes - this.bytes);
  }

  /** A joined connection: it counts for its principal (who keeps the room loaded). */
  attach(conn: Conn): void {
    this.conns.set(conn.ws, conn);
    this.principals.set(conn.principal, (this.principals.get(conn.principal) ?? 0) + 1);
  }

  /** The connection left. */
  detach(conn: Conn): void {
    if (this.conns.get(conn.ws) !== conn) return;
    this.conns.delete(conn.ws);
    const n = (this.principals.get(conn.principal) ?? 1) - 1;
    if (n > 0) this.principals.set(conn.principal, n);
    else this.principals.delete(conn.principal);
  }

  /** Estimated resident cost of the room as it is now (the memory budget's measure). */
  get cost(): number {
    return roomCost(this.deps.cfg, this.bytes);
  }

  /**
   * Charge `bytes` of the memory budget to `principal` (see `charges`). `written`: it comes from
   * an update the principal sent (settled against the room's size at the next save).
   */
  charge(principal: string, anonymous: boolean, bytes: number, written = true): void {
    if (!(bytes > 0)) return;
    let c = this.charges.get(principal);
    if (!c) this.charges.set(principal, (c = { anonymous, bytes: 0, written: 0, load: 0 }));
    c.bytes += bytes;
    if (written) c.written += bytes;
    else c.load += bytes;
  }

  /** What `principal` is charged for this room. */
  chargeOf(principal: string): number {
    return this.charges.get(principal)?.bytes ?? 0;
  }

  /** The part of `principal`'s charge that is the room's cost at load (fv8 U2: handed over when it leaves). */
  loadChargeOf(principal: string): number {
    return this.charges.get(principal)?.load ?? 0;
  }

  /** Move `bytes` of `from`'s load charge to `to`, as a load charge of its own (fv8 U2, RoomManager.handOver). */
  handOverLoad(from: string, to: string, anonymous: boolean, bytes: number): number {
    const c = this.charges.get(from);
    if (!c) return 0;
    const b = Math.min(bytes, c.load, c.bytes);
    if (!(b > 0)) return 0;
    c.load -= b;
    c.bytes -= b;
    if (c.bytes <= 0 && c.written <= 0) this.charges.delete(from);
    this.charge(to, anonymous, b, false);
    return b;
  }

  /**
   * What the anonymous pool pays for this room (fv9 F): what anonymous visitors are charged, plus
   * the part of the room's cost nobody is charged for (fv8 P1: a load is charged one share at most)
   * in the proportion anonymous visitors hold the room's load. Three visitors who each loaded a
   * 5 MiB pub/ room were charged 72.67 MiB each while the rooms cost 651 MiB: the pool now pays
   * the full cost of the rooms its visitors brought in.
   */
  anonCharged(): number {
    let anon = 0;
    let all = 0;
    let anonLoad = 0;
    let load = 0;
    for (const c of this.charges.values()) {
      all += c.bytes;
      load += c.load;
      if (c.anonymous) {
        anon += c.bytes;
        anonLoad += c.load;
      }
    }
    const uncharged = Math.max(0, this.cost - all);
    return anon + (load > 0 ? (uncharged * anonLoad) / load : 0);
  }

  /** Every charge of the room, by principal (the largest first is not guaranteed). */
  chargeEntries(): IterableIterator<[string, Readonly<Charge>]> {
    return this.charges.entries();
  }

  /**
   * Bring the charges to the room's measured cost (fv7 F1), after a save or a load measured the
   * room. Between two measures each accepted update was charged its estimate in full; the
   * principals that wrote since the previous measure now share, in proportion to those estimates,
   * what the room really changed by since then (when it shrank, deletes, the shrink comes off
   * them the same way, never below zero). Nobody else's charge moves, so a principal that wrote
   * nothing since is never charged for others nor relieved by them. When nobody wrote since: a
   * shrink (pruned attribution) comes off every charge in proportion, a growth (a load that
   * migrated or repaired the stored room) goes to `fallback`, else to the largest charge.
   */
  settleCharges(fallback?: { principal: string; anonymous: boolean }): void {
    if (this.charges.size === 0 && !fallback) return;
    const target = this.cost;
    let total = 0;
    let written = 0;
    for (const c of this.charges.values()) {
      total += c.bytes;
      written += c.written;
    }
    const changed = target - (total - written);
    if (written > 0) {
      for (const c of this.charges.values()) if (c.written > 0) c.bytes = Math.max(0, c.bytes - c.written + (changed * c.written) / written);
    } else if (changed < 0 && total > 0) {
      for (const c of this.charges.values()) {
        c.bytes = (c.bytes * target) / total;
        c.load = (c.load * target) / total;
      }
    } else if (changed > 0) {
      let to = fallback ? { principal: fallback.principal, anonymous: fallback.anonymous } : null;
      if (!to) {
        let max = -1;
        for (const [p, c] of this.charges) if (c.bytes > max) (max = c.bytes), (to = { principal: p, anonymous: c.anonymous });
      }
      if (to) this.charge(to.principal, to.anonymous, changed, false);
    }
    // fv8 P1: nobody is charged more than a share for one room (a stored room bigger than that
    // loads, the rest of its cost charged to nobody — the anonymous pool pays its part of that
    // rest, see anonCharged; the size cap refuses it any growth)
    const shareOf = this.deps.shareOf;
    for (const c of this.charges.values()) {
      c.written = 0;
      if (shareOf) c.bytes = Math.min(c.bytes, shareOf(c.anonymous));
      c.load = Math.min(c.load, c.bytes);
    }
  }

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
   * Load both documents from storage into the room's new worker. `admit` sees the encoded size
   * before anything is decoded (fv6 H-1: the memory budget); it throws to refuse the load, else
   * returns a release that runs once the documents are in.
   */
  async load(admit?: (encodedBytes: number) => Promise<() => void>): Promise<void> {
    const { store, metrics, log } = this.deps;
    try {
      const [ledgerBytes, data] = await Promise.all([store.get(this.ledgerKey), store.get(this.objectKey)]);
      const stored = (ledgerBytes?.byteLength ?? 0) + (data?.byteLength ?? 0);
      const release = admit ? await admit(stored) : () => undefined;
      try {
        await this.job(null, async () => {
          const host = this.spawn(stored);
          try {
            await this.started(host);
          } catch (err) {
            await host.terminate();
            throw err;
          }
          this.host = host;
          this.approxBytes = data?.byteLength ?? 0;
          this.ledgerApproxBytes = ledgerBytes?.byteLength ?? 0;
          // copies: the store keeps its own (the copies are handed over to the worker, not copied again)
          const l = ledgerBytes ? ledgerBytes.slice() : null;
          const c = data ? data.slice() : null;
          const a = await this.call<LoadResult>({ op: 'load', ledger: l, content: c, recovery: false }, this.opTimeout(stored), null, [l?.buffer, c?.buffer].filter((b): b is ArrayBuffer => !!b));
          const r = a.result;
          for (const [client, writer] of r.writers) this.writers.set(client, writer);
          if (r.droppedPending) {
            log.warn({ room: this.name }, 'stored canvas had pending structs: dropped');
            metrics.pendingDropped.inc({ where: 'load' });
          }
          if (r.migrated) {
            log.info({ room: this.name }, 'legacy canvas split into content + ledger');
            metrics.migrations.inc();
          }
          if (r.pruned) log.info({ room: this.name, pruned: r.pruned }, 'attribution of long-deleted shapes pruned');
          if (r.dirty) this.markDirty();
          this.loadMs = a.ms;
          this.live = true;
        });
      } catch (err) {
        if (this.host) {
          const h = this.host;
          this.host = null;
          await h.terminate();
        }
        throw err;
      } finally {
        release();
      }
      metrics.loads.inc({ outcome: 'ok' });
    } catch (err) {
      metrics.loads.inc({ outcome: err instanceof BusyError ? 'refused' : 'error' });
      throw err;
    }
  }

  /** Something changed (or may have, after an apply that threw): save soon. */
  markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer && !this.disposed) this.scheduleSave(this.deps.cfg.saveDebounceMs);
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
   * The ledger goes first: a content object is never newer than its ledger. The worker encodes
   * them (a job); the puts run outside the queue, and once both are in storage the log is
   * truncated up to the encoding.
   */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      // a disposed room is gone (evicted after its last save, or expired and deleted): never
      // written back
      if (!this.dirty || this.disposed || !this.live || this.broken) return;
      const { store, metrics, log } = this.deps;
      const t0 = performance.now();
      let enc: { content: Uint8Array; ledger: Uint8Array; seq: number } | null = null;
      try {
        enc = await this.job(null, async () => {
          this.dirty = false;
          const a = await this.call<SaveResult>({ op: 'save' }, this.opTimeout(this.bytes));
          const r = a.result;
          if (r.droppedPending) {
            log.error({ room: this.name }, 'room had pending structs at save: dropped');
            metrics.pendingDropped.inc({ where: 'save' });
          }
          if (r.pruned) log.info({ room: this.name, pruned: r.pruned }, 'attribution of long-deleted shapes pruned');
          this.approxBytes = r.content.byteLength;
          this.ledgerApproxBytes = r.ledger.byteLength;
          // the room is measured: its charges follow (fv7 F1)
          this.settleCharges();
          this.deps.saveBudget?.charge(a.ms);
          return { content: r.content, ledger: r.ledger, seq: this.walSeq };
        });
        const put = (async () => {
          await store.put(this.ledgerKey, enc!.ledger, this.ttlTag ?? undefined);
          await store.put(this.objectKey, enc!.content, this.ttlTag ?? undefined);
        })();
        this.putting = put.catch(() => undefined);
        await put;
        // storage holds everything up to the encoding: the log starts after it
        const seq = enc.seq;
        let i = 0;
        while (i < this.wal.length && this.wal[i].seq <= seq) {
          for (const e of this.wal[i].entries) this.walBytes -= e.u.byteLength;
          i++;
        }
        if (i) this.wal.splice(0, i);
        if (this.saveFailures) log.info({ room: this.name, failures: this.saveFailures }, 'canvas saved again');
        this.saveFailures = 0;
        metrics.saves.inc({ outcome: 'ok' });
        this.deps.onSaved?.(this);
      } catch (err) {
        if (this.disposed) return;
        this.dirty = true;
        this.saveFailures++;
        metrics.saves.inc({ outcome: 'error' });
        log.error({ err: String(err), room: this.name, failures: this.saveFailures, walBytes: this.walBytes }, 'canvas save failed');
        // review F-6: retried by itself, with a backoff (before, only the next change scheduled one,
        // and a room whose writes are refused for a full log, or an idle one, has none); a change
        // meanwhile still saves after the debounce
        if (!this.retryTimer && !this.broken) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.save();
          }, Math.min(SAVE_RETRY_MAX_MS, this.deps.cfg.saveDebounceMs * 2 ** Math.min(this.saveFailures, 6)));
        }
      } finally {
        metrics.saveDuration.observe((performance.now() - t0) / 1000);
      }
    });
    return this.saving;
  }

  /** Cancel the debounce and persist now (last leave / shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }

  /**
   * Replace the room's worker as a fault would (tests and the honest fuzzer: a forced restart
   * between messages): the room is rebuilt from storage and its log, and every client is asked
   * for what the room may lack. Nobody is struck.
   */
  restart(): Promise<void> {
    return this.job(null, async () => {
      if (!this.live) return;
      await this.recover(new WorkerFault('crash', 'forced restart'), null);
    });
  }

  /** Every queued job is done (tests). */
  async settled(): Promise<void> {
    for (let q = this.queue; ; q = this.queue) {
      await q;
      if (q === this.queue) return;
    }
  }

  /**
   * Copies of the room's two documents as the worker holds them now, and whether it holds pending
   * state (tests and probes: decoded on the caller's thread from the worker's own encoding).
   */
  async inspect(): Promise<{ doc: Y.Doc; ledger: Y.Doc; pending: boolean; contentBytes: Uint8Array; ledgerBytes: Uint8Array }> {
    const docs = (content: Uint8Array | null, ledgerBytes: Uint8Array | null, pending: boolean) => {
      const doc = materializeContent(new Y.Doc());
      const ledger = materializeLedger(new Y.Doc());
      if (content?.byteLength) Y.applyUpdate(doc, content);
      if (ledgerBytes?.byteLength) Y.applyUpdate(ledger, ledgerBytes);
      return { doc, ledger, pending, contentBytes: content ?? new Uint8Array(), ledgerBytes: ledgerBytes ?? new Uint8Array() };
    };
    try {
      return await this.job(null, async () => {
        const a = await this.call<InspectResult>({ op: 'inspect' }, this.opTimeout(this.bytes));
        return docs(a.result.content, a.result.ledger, a.result.pending);
      });
    } catch (err) {
      // evicted (its last leave saved it) or expired (deleted): what storage holds
      if (!this.disposed) throw err;
      await this.saving;
      const [ledgerBytes, data] = await Promise.all([this.deps.store.get(this.ledgerKey), this.deps.store.get(this.objectKey)]);
      return docs(data, ledgerBytes, false);
    }
  }

  /** True when the room holds structs/deletes Yjs could not integrate (tests). */
  async hasPending(): Promise<boolean> {
    return (await this.inspect()).pending;
  }

  /** May `principal` announce awareness state for `clientId`? Not for someone else's writer id. */
  mayClaimAwareness(clientId: number, principal: string): boolean {
    const owner = this.writers.get(clientId);
    return owner === undefined || owner === principal;
  }

  /** The writer bound to a client id (tests). */
  writerOf(clientId: number): string | undefined {
    return this.writers.get(clientId);
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
   * Release the room once it is evicted: its worker is terminated, and the awareness instance
   * runs a 3 s interval that referenced the room forever (every evicted room stayed in memory:
   * found while sizing the memory limit for fv5 H-1). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.awareness.destroy();
    this.contentSnap = null;
    this.ledgerSnap = null;
    this.step1Cache = null;
    this.charges.clear();
    this.wal = [];
    this.walBytes = 0;
    const host = this.host;
    this.host = null;
    this.stopped = host?.terminate() ?? Promise.resolve();
  }

  disposed = false;
  /** resolves once the room's worker is down (after dispose) */
  stopped: Promise<void> = Promise.resolve();

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

function stampIdentity(id: Identity): StampIdentity {
  return { id: id.id, name: id.name, anonymous: id.anonymous, color: id.color };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A refused join or load: the client is told `busy` and closed with 1013 (it retries); a room too
 * large to ever load for this principal (`room_too_large`) is closed 4413 `too-large` instead.
 */
export class BusyError extends Error {
  constructor(readonly reason: string) {
    super(`busy: ${reason}`);
  }

  get terminal(): boolean {
    return this.reason === 'room_too_large';
  }
}

/** One principal's charge for a room (see Room.charges). */
export interface Charge {
  anonymous: boolean;
  bytes: number;
  /** charged for its updates since the room was last measured (see settleCharges) */
  written: number;
  /**
   * the part charged for the room's cost at load (its own load, or one handed over to it): it
   * moves to the principals still connected when this one leaves (fv8 U2, RoomManager.handOver)
   */
  load: number;
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
