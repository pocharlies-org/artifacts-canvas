import * as Y from 'yjs';
import { ROOT } from '@pocharlies/artifacts-canvas-shared/model';
import {
  applyGuarded,
  attachStamper,
  checkClientUpdate,
  dropPending,
  encodeIntegratedState,
  hasPending,
  utf8Length,
  type UpdateCheck,
} from '@pocharlies/artifacts-canvas-shared/stamper';
import { bindWriters, materializeContent, materializeLedger, migrateLegacyRoots, pruneAttribution, writerOf } from '@pocharlies/artifacts-canvas-shared/ledger';
import type { Identity } from './types.js';

/**
 * The documents of one room and everything that touches them: the CONTENT document (guarded
 * client writes), the LEDGER document (written by the stamper only), the guard, the apply, the
 * encodings for joins, resyncs and saves (protocol §5-§8). It runs inside the room's worker
 * thread (room-worker.ts, fv9 isolation): the main thread never decodes or applies a client
 * update. It is synchronous and does no I/O; tests and probes use it directly.
 *
 * Every change it makes to either document is collected (`take()`): the main thread broadcasts
 * those updates, keeps them in the room's write-ahead log until the next save, and a fresh core
 * rebuilt from the saved state plus that log is the same room (recovery after a worker fault).
 */
export interface CoreOptions {
  /** attribution entries of shapes deleted longer ago than this are pruned (fv4 M4) */
  attributionRetentionDays: number;
  /** guard caps (fv8 P1/P2, fv9): see GuardOptions */
  maxSplits: number;
  maxSplitWork: number;
  maxScanWork: number;
  maxClients: number;
  now?: () => number;
}

/** A change one of the documents emitted: what the main thread broadcasts and logs. */
export interface Emitted {
  doc: 'content' | 'ledger';
  u: Uint8Array;
}

/** Origin of the log replayed into a fresh core: never stamped, never collected again. */
export const REPLAY = 'artifacts-canvas:replay';
const LOAD = 'load';

/** A client update the guard accepted, waiting for the main thread's decision. */
interface Held {
  update: Uint8Array;
  check: UpdateCheck;
  writer: string;
}

export class RoomCore {
  readonly doc = materializeContent(new Y.Doc());
  readonly ledger = materializeLedger(new Y.Doc());
  /** UTF-8 bytes of the longest user id in the ledger's `users` (fv7 F1) */
  maxUserIdBytes = 0;
  private out: Emitted[] = [];
  /** writer bindings added since the last take() */
  private bound: [number, string][] = [];
  private held: Held | null = null;
  private lastPrune = 0;

  constructor(private readonly opts: CoreOptions) {
    // protocol §5.2: every client transaction on the content document is stamped into the ledger
    attachStamper(this.doc, this.ledger, {
      userOf: (origin: unknown) => {
        const id = (origin as { identity?: Pick<Identity, 'id' | 'name' | 'anonymous' | 'color'> } | null)?.identity;
        if (!id || typeof id.id !== 'string') return null;
        return { id: id.id, info: { name: id.name, anonymous: id.anonymous, color: id.color } };
      },
      now: opts.now,
    });
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== LOAD && origin !== REPLAY) this.out.push({ doc: 'content', u });
    });
    this.ledger.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== LOAD && origin !== REPLAY) this.out.push({ doc: 'ledger', u });
    });
    this.ledger.getMap(ROOT.users).observe((e) => {
      for (const k of e.keysChanged) this.maxUserIdBytes = Math.max(this.maxUserIdBytes, utf8Length(k));
    });
    this.ledger.getMap<string>(ROOT.writers).observe((e) => {
      const w = this.ledger.getMap<string>(ROOT.writers);
      for (const k of e.keysChanged) {
        const v = w.get(k);
        if (typeof v === 'string') this.bound.push([Number(k), v]);
      }
    });
  }

  /** The changes since the last call, in the order the documents emitted them. */
  take(): { emitted: Emitted[]; writers: [number, string][] } {
    const r = { emitted: this.out, writers: this.bound };
    this.out = [];
    this.bound = [];
    return r;
  }

  /**
   * Load the stored documents (ledger first, so a migration sees what it holds). Parked
   * structs are dropped; a document from before the content/ledger split is migrated; old
   * attribution is pruned. `recovery`: the documents of a room that was live (its log replays
   * the migration and the prunes it made then): nothing but the stored state.
   */
  load(ledgerBytes: Uint8Array | null, data: Uint8Array | null, recovery: boolean): { dirty: boolean; droppedPending: boolean; migrated: boolean; pruned: number } {
    let dirty = false;
    let droppedPending = false;
    let migrated = false;
    let pruned = 0;
    if (ledgerBytes && ledgerBytes.byteLength > 0) {
      Y.applyUpdate(this.ledger, ledgerBytes, LOAD);
      if (dropPending(this.ledger)) dirty = droppedPending = true;
    }
    if (data && data.byteLength > 0) {
      Y.applyUpdate(this.doc, data, LOAD);
      // a stored document must integrate completely: parked structs are dropped and saved clean
      if (dropPending(this.doc)) dirty = droppedPending = true;
      if (!recovery && migrateLegacyRoots(this.doc, this.ledger, 'migrate')) dirty = migrated = true;
    }
    if (!recovery) pruned = this.prune();
    return { dirty, droppedPending, migrated, pruned };
  }

  /** Apply the room's log on top of the stored state (recovery): nothing is stamped or collected. */
  replay(entries: Emitted[]): void {
    for (const e of entries) Y.applyUpdate(e.doc === 'content' ? this.doc : this.ledger, e.u, REPLAY);
    dropPending(this.doc);
    dropPending(this.ledger);
  }

  /** Drop attribution of shapes deleted longer ago than the retention (fv4 M4). */
  prune(): number {
    this.lastPrune = (this.opts.now ?? Date.now)();
    return pruneAttribution(this.doc, this.ledger, this.lastPrune, this.opts.attributionRetentionDays * 86400_000);
  }

  /** All writer bindings (client id -> writer) the ledger holds. */
  writers(): [number, string][] {
    const out: [number, string][] = [];
    for (const [k, v] of this.ledger.getMap<string>(ROOT.writers).entries()) if (typeof v === 'string') out.push([Number(k), v]);
    return out;
  }

  /**
   * May `writer` add clocks to Yjs client id `client`? A client id is bound (in the ledger) to the
   * first writer that adds clocks to it, and nobody else may extend it; an id nobody wrote yet is
   * refused when another writer's live connection announced it in awareness (`claimed`).
   */
  mayWrite(client: number, writer: string, claimed: ReadonlySet<number>): boolean {
    if (client === this.doc.clientID || client === this.ledger.clientID) return false;
    const owner = writerOf(this.ledger, client);
    if (owner !== undefined) return owner === writer;
    // clocks from before the bindings were persisted (legacy object): first writer binds it
    if (Y.getState(this.doc.store, client) > 0) return true;
    return !claimed.has(client);
  }

  /** The §5.3 guard; the update is held for apply()/drop(). A throw counts as forbidden. */
  check(update: Uint8Array, writer: string, claimed: ReadonlySet<number>): UpdateCheck {
    this.held = null;
    let check: UpdateCheck;
    try {
      check = checkClientUpdate(this.doc, update, {
        serverClient: this.doc.clientID,
        mayWriteClient: (client) => this.mayWrite(client, writer, claimed),
        maxSplits: this.opts.maxSplits,
        maxSplitWork: this.opts.maxSplitWork,
        maxScanWork: this.opts.maxScanWork,
        maxClients: this.opts.maxClients,
      });
    } catch {
      check = { bad: 'forbidden', writers: [], grows: false, splits: 0, splitWork: 0, scanWork: 0, merges: 0, shapes: 0, shapeKeyBytes: 0, deletesOnly: false };
    }
    if (!check.bad) this.held = { update, check, writer };
    return check;
  }

  /**
   * Apply the held update with `identity` as transaction origin (the stamper attributes it), and
   * bind its client ids to the writer. Pending state never stays (applyGuarded).
   */
  apply(identity: Pick<Identity, 'id' | 'name' | 'anonymous' | 'color'>): { threw: string | null; droppedPending: boolean } {
    const held = this.held;
    this.held = null;
    if (!held) throw new Error('apply without an accepted update');
    const outcome = applyGuarded(this.doc, held.update, { identity });
    if (!outcome.threw && !outcome.droppedPending) bindWriters(this.ledger, held.check.writers, held.writer);
    return outcome;
  }

  /** The main thread refused the held update. */
  drop(): void {
    this.held = null;
  }

  /**
   * Answer a client's sync step 1: what the room has beyond the client's state vector merged with
   * the one the connection was sent in full at join (fv4 H1). `refuseEmpty`: a later step 1 with
   * an empty state vector is answered with nothing (the caller closes the connection).
   */
  diff(clientSv: Uint8Array, joinSv: Uint8Array, refuseEmpty: boolean): { empty: boolean; diff: Uint8Array | null; malformed?: boolean } {
    let sv: Map<number, number>;
    try {
      sv = Y.decodeStateVector(clientSv);
    } catch {
      return { empty: false, diff: null, malformed: true };
    }
    if (refuseEmpty && sv.size === 0) return { empty: true, diff: null };
    const merged = Y.decodeStateVector(joinSv);
    for (const [client, clock] of sv) if (clock > (merged.get(client) ?? 0)) merged.set(client, clock);
    return { empty: sv.size === 0, diff: Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(merged)) };
  }

  /** The full documents (without pending state) and the content state vector, for joins. */
  frames(content: boolean, ledger: boolean, sv: boolean): { content?: Uint8Array; ledger?: Uint8Array; sv?: Uint8Array } {
    return {
      content: content ? encodeIntegratedState(this.doc) : undefined,
      ledger: ledger ? encodeIntegratedState(this.ledger) : undefined,
      sv: sv ? Y.encodeStateVector(this.doc) : undefined,
    };
  }

  /** Both documents encoded for storage (parked state dropped, old attribution pruned hourly). */
  save(): { content: Uint8Array; ledger: Uint8Array; droppedPending: boolean; pruned: number } {
    const droppedContent = dropPending(this.doc);
    const droppedPending = dropPending(this.ledger) || droppedContent;
    const pruned = (this.opts.now ?? Date.now)() - this.lastPrune > 3600_000 ? this.prune() : 0;
    return { ledger: encodeIntegratedState(this.ledger), content: encodeIntegratedState(this.doc), droppedPending, pruned };
  }

  hasPending(): boolean {
    return hasPending(this.doc) || hasPending(this.ledger);
  }
}
