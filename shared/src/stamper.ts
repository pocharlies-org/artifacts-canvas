import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as binary from 'lib0/binary';
import { CONTENT_ROOTS, MAX_POINTS, MAX_TEXT_LENGTH, ROOT, keyOk } from './model.js';
import { assetValueOk, metaValueOk, pointNumberOk, shapeFieldProblem, shapeRecordProblem, SHAPE_TYPES } from './model.js';
import type { Attribution, GeoKind, HistoryEntry, HistoryVerb, ShapeFieldKind, ShapeType, UserInfo } from './model.js';

/**
 * Attribution stamper.
 *
 * Watches the transactions of the CONTENT document and, for every transaction whose origin
 * belongs to a known user, writes into the LEDGER document (a separate Y.Doc, see
 * model.ts) — roots `attribution`, `users` and `history`:
 *   - a new shape            -> attribution {createdBy, createdAt, updatedBy, updatedAt} + history "create"
 *   - a changed shape        -> attribution.updatedBy/updatedAt + history "move"/"resize"/... (rate-limited)
 *   - a deleted shape        -> history "delete" (the attribution entry is kept for an undo)
 *
 * The shape ids and verbs come only from the content transaction itself (`tr.changed`, the
 * deletions it made) and the author only from its origin (the connection that sent it), so
 * nothing a client writes can name an author: clients never write the ledger at all.
 *
 * It runs on the SERVER (the reference dev room in client/dev too) so attribution cannot be
 * forged: the server knows which connection sent each update. When the server announces
 * `attribution: 'client'` (e.g. a plain y-websocket relay in development) the client runs it
 * itself for its own transactions, into a ledger local to that tab.
 *
 * Writes use the origin STAMP_ORIGIN, which is never tracked by any UndoManager.
 */
export const STAMP_ORIGIN = 'artifacts-canvas:stamper';

export interface StamperOptions {
  /** Map a transaction origin to the user who caused it, or null to ignore the transaction. */
  userOf: (origin: unknown, tr: Y.Transaction) => { id: string; info: UserInfo } | null;
  now?: () => number;
  /** Max entries kept in `history`. */
  historyLimit?: number;
  /** A repeated (user, shape, verb) history line is suppressed for this long (ms). */
  historyCoalesceMs?: number;
  /** updatedAt is refreshed at most this often for the same user (ms). */
  touchThrottleMs?: number;
  /** Changes by the author closer together than this continue the same gesture (ms). */
  gesturePauseMs?: number;
}

const GEOMETRY_VERBS: Record<string, HistoryVerb> = {
  x: 'move', y: 'move', start: 'move', end: 'move',
  w: 'resize', h: 'resize', bend: 'resize',
  rotation: 'rotate',
  text: 'edit', name: 'edit', points: 'edit',
  color: 'style', fill: 'style', dash: 'style', size: 'style', font: 'style', arrowheads: 'style', opacity: 'style',
  index: 'order', groupId: 'group', locked: 'lock',
};

/** Precedence when one transaction changes several things. */
const VERB_RANK: HistoryVerb[] = ['create', 'delete', 'edit', 'resize', 'rotate', 'move', 'style', 'group', 'lock', 'order'];

export function stampTransaction(content: Y.Doc, ledger: Y.Doc, tr: Y.Transaction, opts: StamperOptions, memo: StamperMemo) {
  if (tr.origin === STAMP_ORIGIN) return;
  const who = opts.userOf(tr.origin, tr);
  if (!who) return;
  const now = (opts.now ?? Date.now)();
  const shapes = content.getMap<Y.Map<unknown>>(ROOT.shapes);
  const attribution = ledger.getMap<Attribution>(ROOT.attribution);
  const users = ledger.getMap<UserInfo>(ROOT.users);
  const history = ledger.getArray<HistoryEntry>(ROOT.history);

  // shape id -> verbs touched in this transaction
  const touched = new Map<string, Set<HistoryVerb>>();
  const add = (id: string, v: HistoryVerb) => {
    let s = touched.get(id);
    if (!s) touched.set(id, (s = new Set()));
    s.add(v);
  };
  const deletedInfo = new Map<string, { type: ShapeType; geo?: GeoKind; highlight?: boolean }>();

  for (const [rawType, keys] of tr.changed) {
    const type = rawType as unknown as Y.AbstractType<unknown>;
    if (type === (shapes as unknown)) {
      for (const k of keys) {
        if (k === null) continue;
        if (shapes.has(k)) add(k, 'create');
        else {
          add(k, 'delete');
          deletedInfo.set(k, { type: 'geo' });
        }
      }
      continue;
    }
    // A shape's own Y.Map, or a nested Y.Text / Y.Array inside it.
    const shapeMap = findShapeMap(type, shapes);
    if (!shapeMap) continue;
    const id = shapeMap._item!.parentSub as string;
    if (type === (shapeMap as unknown)) {
      for (const k of keys) {
        if (k === null) continue;
        add(id, GEOMETRY_VERBS[k] ?? 'edit');
      }
    } else {
      const field = type._item?.parentSub;
      add(id, (field && GEOMETRY_VERBS[field]) || 'edit');
    }
  }
  if (!touched.size) return;

  // Recover type info of deleted shapes from the deleted items.
  for (const id of deletedInfo.keys()) {
    const info = deletedShapeInfo(tr, shapes, id);
    if (info) deletedInfo.set(id, info);
  }

  ledger.transact(() => {
    // history lines of this transaction, appended in ONE push at the end: every push walks
    // the history array from its start (tombstones included), so one push per shape made a
    // bulk create O(shapes x history ever written)
    const lines: HistoryEntry[] = [];
    const cur = users.get(who.id);
    if (!cur || cur.name !== who.info.name || cur.anonymous !== who.info.anonymous || cur.color !== who.info.color) {
      users.set(who.id, { ...who.info });
    }
    for (const [id, verbs] of touched) {
      const verb = VERB_RANK.find((v) => verbs.has(v)) ?? 'edit';
      if (verb === 'create' && verbs.has('delete')) continue;
      const prev = attribution.get(id);
      if (verb === 'delete') {
        const info = deletedInfo.get(id) ?? { type: 'geo' as ShapeType };
        pushHistory(lines, opts, memo, { t: now, by: who.id, verb, shapeId: id, shapeType: info.type, geo: info.geo, highlight: info.highlight, owner: ownerOf(prev, who.id) });
        // The attribution entry is kept so that an undo of the delete restores the original
        // author; `deletedAt` lets the server prune it once the delete is old (pruneAttribution).
        if (prev && prev.deletedAt === undefined) attribution.set(id, { ...prev, deletedAt: now });
        continue;
      }
      const m = shapes.get(id) as unknown;
      // defensive: a malformed value (not a Y.Map, no valid type) is never stamped
      if (!(m instanceof Y.Map)) continue;
      const shapeType = m.get('type') as ShapeType;
      if (typeof shapeType !== 'string' || !SHAPE_TYPES.includes(shapeType)) continue;
      const geo = m.get('geo') as GeoKind | undefined;
      const highlight = m.get('highlight') === true ? true : undefined;
      if (!prev) {
        attribution.set(id, { createdBy: who.id, createdAt: now, updatedBy: who.id, updatedAt: now });
        memo.touch.set(`${who.id}|${id}`, now);
        pushHistory(lines, opts, memo, { t: now, by: who.id, verb: 'create', shapeId: id, shapeType, geo, highlight });
        continue;
      }
      if (verb === 'create') {
        // re-inserted (undo of a delete): keep the original author
        const { deletedAt: _gone, ...kept } = prev;
        void _gone;
        attribution.set(id, { ...kept, updatedBy: who.id, updatedAt: now });
        pushHistory(lines, opts, memo, { t: now, by: who.id, verb: 'create', shapeId: id, shapeType, geo, highlight, owner: ownerOf(prev, who.id) });
        continue;
      }
      const throttle = opts.touchThrottleMs ?? 5000;
      if (prev.deletedAt !== undefined) {
        const { deletedAt: _gone, ...kept } = prev;
        void _gone;
        attribution.set(id, { ...kept, updatedBy: who.id, updatedAt: now });
      } else if (prev.updatedBy !== who.id || now - prev.updatedAt >= throttle) {
        attribution.set(id, { ...prev, updatedBy: who.id, updatedAt: now });
      }
      // A gesture that continues the creation (live points, dragging the box out, finishing the
      // stroke) is part of "created", not a separate edit: the author touched it moments ago.
      const touchKey = `${who.id}|${id}`;
      const lastTouch = memo.touch.get(touchKey) ?? 0;
      memo.touch.set(touchKey, now);
      if (prev.createdBy === who.id && now - lastTouch < (opts.gesturePauseMs ?? 2000)) continue;
      pushHistory(lines, opts, memo, { t: now, by: who.id, verb, shapeId: id, shapeType, geo, highlight, owner: ownerOf(prev, who.id) });
    }
    if (lines.length) {
      const limit = opts.historyLimit ?? 300;
      history.push(lines.length > limit ? lines.slice(-limit) : lines);
      if (history.length > limit) history.delete(0, history.length - limit);
    }
  }, STAMP_ORIGIN);
}

function ownerOf(prev: Attribution | undefined, by: string): string | undefined {
  return prev && prev.createdBy !== by ? prev.createdBy : undefined;
}

export interface StamperMemo {
  /** last history line per (user, shape, verb) */
  last: Map<string, number>;
  /** last change per (user, shape) */
  touch: Map<string, number>;
}

function pushHistory(lines: HistoryEntry[], opts: StamperOptions, memo: StamperMemo, e: HistoryEntry) {
  const key = `${e.by}|${e.shapeId}|${e.verb}`;
  const coalesce = opts.historyCoalesceMs ?? 10000;
  const last = memo.last.get(key);
  if (e.verb !== 'create' && e.verb !== 'delete' && last !== undefined && e.t - last < coalesce) return;
  memo.last.set(key, e.t);
  if (memo.last.size > 5000) memo.last.clear();
  if (memo.touch.size > 5000) memo.touch.clear();
  const clean: HistoryEntry = { t: e.t, by: e.by, verb: e.verb, shapeId: e.shapeId, shapeType: e.shapeType };
  if (e.geo) clean.geo = e.geo;
  if (e.highlight) clean.highlight = true;
  if (e.owner) clean.owner = e.owner;
  lines.push(clean);
}

function findShapeMap(type: Y.AbstractType<unknown>, shapes: Y.Map<Y.Map<unknown>>): Y.Map<unknown> | null {
  let t: Y.AbstractType<unknown> | null = type;
  while (t) {
    const parent = t._item?.parent as Y.AbstractType<unknown> | null | undefined;
    if (parent === (shapes as unknown)) return t as Y.Map<unknown>;
    t = parent ?? null;
  }
  return null;
}

function deletedShapeInfo(tr: Y.Transaction, shapes: Y.Map<Y.Map<unknown>>, id: string) {
  void tr;
  // The deleted Y.Map item is still referenced from the parent map; its content is kept until GC.
  const items = (shapes as unknown as { _map: Map<string, Y.Item> })._map;
  const item = items.get(id);
  const content = item?.content as unknown as { type?: Y.Map<unknown> } | undefined;
  const m = content?.type;
  if (!m) return null;
  try {
    // Deleted maps keep their _map entries until garbage collection runs after the transaction.
    const read = (k: string) => {
      const it = (m as unknown as { _map: Map<string, Y.Item> })._map.get(k);
      const c = it?.content as unknown as { arr?: unknown[] } | undefined;
      return c?.arr?.[c.arr.length - 1];
    };
    const type = read('type') as ShapeType | undefined;
    if (!type) return null;
    return { type, geo: read('geo') as GeoKind | undefined, highlight: read('highlight') === true ? true : undefined };
  } catch {
    return null;
  }
}

/**
 * Attach the stamper: observe `content`, write `ledger`. Returns a detach function. The two
 * documents must be different (a ledger inside the content document is exactly the shared
 * trust domain this design removes).
 */
export function attachStamper(content: Y.Doc, ledger: Y.Doc, opts: StamperOptions): () => void {
  if (content === ledger) throw new Error('attachStamper: the ledger must be a separate Y.Doc');
  const memo: StamperMemo = { last: new Map(), touch: new Map() };
  const handler = (tr: Y.Transaction) => stampTransaction(content, ledger, tr, opts, memo);
  content.on('afterTransaction', handler);
  return () => content.off('afterTransaction', handler);
}

/**
 * Root types a client may write in the content document. Anything else (a legacy ledger
 * root left in an old document, any root the schema does not define) is refused: an
 * allow-list.
 */
export const CLIENT_WRITABLE_ROOTS: ReadonlySet<string> = new Set<string>(CONTENT_ROOTS);

export interface GuardOptions {
  /**
   * Client id the server writes the content document with (it never does today: the
   * stamper writes the ledger). A client may never send a struct as this client. Defaults
   * to `doc.clientID`.
   */
  serverClient?: number;
  /**
   * Called for every client id the update adds new clocks to; return false when that id is
   * someone else's (another principal writes with it). Omitted = every id is allowed.
   */
  mayWriteClient?: (client: number) => boolean;
  /**
   * Caps of UpdateCheck.splits and UpdateCheck.splitWork (fv8 P1/P2): an update over either is
   * refused as `splits` as soon as the count passes it (the server closes the sender 4413).
   * Omitted = no cap (the counts are still returned).
   */
  maxSplits?: number;
  maxSplitWork?: number;
  /** Cap of UpdateCheck.scanWork (fv8 P2): over it, refused as `splits` too. */
  maxScanWork?: number;
  /**
   * Client blocks one update may carry (fv9 E): an honest update carries its sender's client
   * id, and a resync the few ids the room lacks; over it, refused as `blocks` (the server closes
   * the sender 4413). Omitted = no cap.
   */
  maxClients?: number;
}

export interface UpdateCheck {
  /** null when the update is acceptable, else the offending root or a reason (see forbiddenRootWrite) */
  bad: string | null;
  /** client ids the update adds new clocks to (to be bound to the sender once applied) */
  writers: number[];
  /**
   * the update can grow the encoded document: it adds new structs, or its deletes split live
   * items (each split becomes structs of its own: fv5 L-2, deleting every other character of
   * a text grew the room ~8x with "deletes only"); false = it only removes whole items
   */
  grows: boolean;
  /**
   * item boundaries the update creates (see SPLIT_COST_BYTES, fv8 P1): wherever one of its
   * structs names a clock inside an item as its origin or right origin, and wherever a delete
   * range starts or ends inside a live item — room items and the update's own new items alike
   */
  splits: number;
  /**
   * Upper bound of the work Yjs does to make those cuts (fv8 P2), in elements: for every cut,
   * the elements of the item's content it copies (a points list is copied whole on every cut)
   * plus the structs of that client it moves to make room for the new one, plus
   * SPLIT_BASE_WORK. The server refuses an update over its cap and pre-charges its CPU time.
   */
  splitWork: number;
  /**
   * Upper bound of the items Yjs scans to place the update's new items (fv8 P2): for each, the
   * room items between its origin and its right origin, plus the update's own new items in the
   * same list or key unless it continues a run. The server refuses an update over its cap and
   * pre-charges its CPU time.
   */
  scanWork: number;
  /**
   * Struct merges Yjs makes when it cleans up after the update (fv9 A/B/C): runs of the update's
   * own structs that continue each other, the room's structs its deletes leave next to each
   * other. Their work (the copies of a merged list, the splices of the client's struct array) is
   * part of `splitWork`; this is how many merges there are (diagnostics).
   */
  merges: number;
  /**
   * shapes the update writes or deletes (distinct ids), and the UTF-8 bytes of those ids: the
   * stamper writes one attribution entry and one history line per shape touched, so they bound
   * what the update adds to the ledger (the server's memory budget counts it ahead)
   */
  shapes: number;
  shapeKeyBytes: number;
}

/**
 * Upper bound of what one cut of an item adds to the encoded room (a struct header with its
 * origin ids, plus its delete-set range). The server charges `splits x SPLIT_COST_BYTES` on top
 * of the update's own size against the document size cap and the memory budget. Measured
 * (server/test/fv8/split-growth.ts, every kind of cut): 6-9 B with short ids, 22 B with 5-byte
 * client ids and clocks past 2^28 (inserts with a right origin), 20.8 B for delete ranges; the
 * worst plus ~45% (fv5 L-2 had 24 for delete cuts only).
 */
export const SPLIT_COST_BYTES = 32;

/**
 * UpdateCheck.splitWork, in units of one element of content copied (fv8 P2, measured on x86-64
 * with server/test/fv8/split-cpu-cal.ts): a cut costs Yjs a fixed part (the new struct, the
 * lookups, the transaction's bookkeeping: 7-9 us, as much as copying ~1 500 elements), one
 * pointer move per SPLIT_MOVE_DIVISOR structs of that client after it, and the item's content
 * copied (4.0-4.5 ns per element for a long points list): once for a cut that stays, about
 * SPLIT_REMERGE_COPIES times for one Yjs merges back at the end of the update (a known struct's
 * origin: 2.3-2.5 ns per unit counted so). The server turns units into time with SPLIT_WORK_NS.
 */
export const SPLIT_BASE_WORK = 1536;
export const SPLIT_MOVE_DIVISOR = 4;
export const SPLIT_REMERGE_COPIES = 4;

/**
 * Struct merges (fv9 A/B/C, UpdateCheck.merges), in UpdateCheck.splitWork units: a merge costs
 * MERGE_BASE_WORK (Item.mergeWith and its bookkeeping), the elements of a list content it copies
 * (ContentAny/JSON concatenate their arrays into a new one: two units per element), and every
 * run merged splices the client's struct array: one unit per MERGE_MOVE_DIVISOR structs after it.
 * Measured on x86-64 (server/test/fv9/merge-cal.ts): 3.3-4.8 ns per unit for bulk deletes,
 * 3.1-3.2 for runs, 2.2-9.7 for separate pairs (SPLIT_WORK_NS counts 6).
 */
export const MERGE_BASE_WORK = 128;
export const MERGE_MOVE_DIVISOR = 4;
/**
 * A live struct of the room the update deletes (fv9), in splitWork units: Yjs marks it deleted,
 * drops its content (a deleted type's items become GC structs) and tries to merge it: 1.2-1.3 us
 * each when one transaction deletes 2 000-12 000 shapes (204 000 structs), the merges apart
 * (server/test/fv9/merge-cal.ts). An honest delete-only update is a few bytes for any number of
 * shapes, so this is what bounds its apply time.
 */
export const DELETE_WORK = 256;

/** Contents Yjs copies element by element when it cuts an item (ContentAny/JSON slice their array). */
function copiesOnSplit(content: ItemContent): boolean {
  return content instanceof Y.ContentAny || content instanceof Y.ContentJSON || content instanceof Y.ContentString;
}

/**
 * Server-side guard of the CONTENT document (protocol §5.3). Returns null when a client may
 * apply `update` to the room's content `doc`, else the offending root or a reason.
 *
 * It no longer protects attribution: the ledger (attribution/users/history) is a different
 * Y.Doc that no client update ever reaches, so nothing this guard misses can forge or erase
 * it. Its job is schema/size safety of the content and pending-state hygiene:
 *   - any root other than `shapes`, `assets`, `meta`: a write outside the allow-list;
 *   - `pending`: the update would not integrate completely (a clock gap, a dependency the
 *     room does not have — for a known struct too, Yjs resolves its origins before it skips
 *     it —, a delete of clocks nobody wrote yet). The room never holds pending state;
 *   - `malformed`: a zero-length struct or delete range (Yjs integrates a zero-length item
 *     over a live map entry and then cannot encode the document), an impossible same-client
 *     dependency;
 *   - `server-client`: a struct carrying the server's own client id;
 *   - `foreign-client`: new clocks for a client id another principal writes with;
 *   - `overlap`: a struct that only partly overlaps the room state;
 *   - `shapes-schema` / `assets-schema` / `meta-schema`: a value the document schema does not
 *     allow (docs/protocol.md §6: Y.Map shapes with a valid `type` that never goes away,
 *     style enums from the allow-lists, numeric geometry, capped point lists, no forbidden
 *     keys, string assets, plain JSON meta, ...);
 *   - `room-pending`: the room itself holds pending state (it must be cleaned first);
 *   - `splits`: the update would make Yjs work too long (fv8 P2): more cuts of items, or more
 *     copying or placement scanning for them, than GuardOptions.maxSplits / maxSplitWork /
 *     maxScanWork allow (see UpdateCheck.splitWork / scanWork).
 * `doc` is never modified.
 *
 * One pass, O(update) plus O(log room) per lookup: every struct is checked for length and
 * dependencies; every NEW struct is resolved to its parent type. Yjs encodes `parent` only
 * for items without neighbours; an item with a left/right origin travels with
 * `parent === null` and inherits parent and key from that origin, so origins are followed
 * through the room (for clocks it already has) and the update itself — iteratively and
 * memoised, so a chain of any length costs one visit per item. There is no slow path any
 * more (it re-encoded and re-applied the whole room for every update it saw, O(room) per
 * message — fv4 H2): what this pass cannot resolve is refused. An honest Yjs encoder never
 * produces any of it:
 *   - an origin cycle (an origin always names an item that existed before): `malformed`;
 *   - an item with neither parent nor origin, a room item that is not under a root, nesting
 *     deeper than the schema allows: `malformed`;
 *   - a shape's `type` overwritten twice in one update (the winner would depend on the
 *     integration order; clients never change a shape's type): `shapes-schema`.
 */
export function forbiddenRootWrite(doc: Y.Doc, update: Uint8Array, opts: GuardOptions = {}): string | null {
  return checkClientUpdate(doc, update, opts).bad;
}

/** forbiddenRootWrite plus the client ids the update writes with. */
export function checkClientUpdate(doc: Y.Doc, update: Uint8Array, opts: GuardOptions = {}): UpdateCheck {
  if (hasPending(doc)) return { bad: 'room-pending', writers: [], grows: false, splits: 0, splitWork: 0, scanWork: 0, merges: 0, shapes: 0, shapeKeyBytes: 0 };
  return fastCheck(doc, update, opts);
}

/** UTF-8 length of a string (what Yjs writes for it). */
export function utf8Length(str: string): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** True when Yjs parked structs or deletes in `doc` that wait for missing clocks. */
export function hasPending(doc: Y.Doc): boolean {
  return !!(doc.store.pendingStructs || doc.store.pendingDs);
}

/**
 * Discard parked structs/deletes: they are not part of the document (no observer saw them,
 * no client received them) and could only be released later into a root nobody checked.
 * Returns true when there was something to drop.
 */
export function dropPending(doc: Y.Doc): boolean {
  const had = hasPending(doc);
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  return had;
}

/** What happened when an accepted update was applied (see applyGuarded). */
export interface ApplyOutcome {
  /** Yjs threw while integrating (whatever it integrated before the throw stays). */
  threw: string | null;
  /** pending structs/deletes were left and have been dropped */
  droppedPending: boolean;
}

/**
 * Apply an update the guard accepted, with the connection as transaction origin, and
 * ALWAYS restore the "no pending state" invariant afterwards — also when Yjs throws in the
 * middle of the integration (a throw used to skip the safety net and leave the room pending
 * for good, refusing every later writer as `room-pending`). The caller closes the sender
 * when `threw` or `droppedPending` and marks the room dirty in any case.
 */
export function applyGuarded(doc: Y.Doc, update: Uint8Array, origin: unknown): ApplyOutcome {
  const out: ApplyOutcome = { threw: null, droppedPending: false };
  try {
    Y.applyUpdate(doc, update, origin);
  } catch (err) {
    out.threw = String(err);
  } finally {
    out.droppedPending = dropPending(doc);
  }
  return out;
}

/** The document state as an update WITHOUT the pending structs/deletes Yjs would merge in. */
export function encodeIntegratedState(doc: Y.Doc): Uint8Array {
  const ps = doc.store.pendingStructs;
  const pd = doc.store.pendingDs;
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.store.pendingStructs = ps;
    doc.store.pendingDs = pd;
  }
}

/** Not resolvable in one pass (a cycle, nesting the schema does not allow): refused. */
const UNRESOLVED = Symbol('unresolved');
/** A dependency that neither the room nor the update has: the struct would wait as pending. */
const MISSING = Symbol('missing');
/** A struct that Yjs integrates as garbage (a neighbour or the parent is GC): it writes nothing. */
const GC_ROOT = Symbol('gc');

/** Where an item lives: its root, the map keys from the root down to it, and its parent type. */
interface Loc {
  root: string;
  /** parentSub of every ancestor item from the root down, then the item's own parentSub */
  keys: (string | null)[];
  /** identity of the parent type: `root:<name>` or the id of the item that created it */
  parent: string;
  /** id of the item that created the parent type (absent for a root) */
  parentId?: Y.ID;
  /** the list or map key it is in (cached by the placement check) */
  region?: string;
}
type LocOf = Loc | typeof GC_ROOT | typeof UNRESOLVED | typeof MISSING;

/** Deepest key path a client value may have: shapes/<id>/<field>/<element>. */
const MAX_KEYS = 3;

/** Content of an Item (Yjs does not export the AbstractContent type). */
type ItemContent = Y.Item['content'];

const idKey = (id: Y.ID) => `${id.client}:${id.clock}`;

function fastCheck(doc: Y.Doc, update: Uint8Array, opts: GuardOptions): UpdateCheck {
  const serverClient = opts.serverClient ?? doc.clientID;
  const decoded = Y.decodeUpdate(update);
  const writers: number[] = [];
  const no = (bad: string): UpdateCheck => ({ bad, writers, grows: false, splits: 0, splitWork: 0, scanWork: 0, merges: 0, shapes: 0, shapeKeyBytes: 0 });
  /** shape ids written or deleted (see UpdateCheck.shapes) */
  const touchedShapes = new Set<string>();
  const touchShape = (loc: Loc) => {
    if (loc.root === ROOT.shapes && typeof loc.keys[0] === 'string') touchedShapes.add(loc.keys[0]);
  };
  // One struct block per client. Yjs keeps only the LAST block of a client that appears in
  // several (and an empty block wipes the earlier ones), while decodeUpdate lists all of
  // them: what this check sees would not be what Yjs integrates.
  const blocks = decoding.readVarUint(decoding.createDecoder(update));
  if (blocks !== new Set((decoded.structs as Y.Item[]).map((s) => s.id.client)).size) return no('malformed');
  // fv9 E: the work of the dependency check below grows with the client blocks; an honest update
  // carries a handful
  if (blocks > (opts.maxClients ?? Infinity)) return no('blocks');
  // The delete set as it is on the wire (fv5 M-4): Yjs applies every range as listed, but
  // decodeUpdate neither sorts nor merges the ranges, and Y.isDeleted() binary-searches them.
  // Unsorted ranges hid "this update also deletes its own new `type`" (a shape left with no
  // type); one 1-character range repeated 60 000 times subtracted 60 000 characters from the
  // text-length count while deleting one. Honest encoders write every client once, its
  // ranges sorted and disjoint: anything else is refused.
  if (!deleteSetCanonical(update)) return no('malformed');

  // NEW structs (Item / GC) per client, in clock order; fully known ones are skipped by Yjs
  // after it resolved their dependencies (kept apart for the dependency check).
  const fresh = new Map<number, (Y.Item | Y.GC)[]>();
  const items: Y.Item[] = [];
  const known: Y.Item[] = [];
  const next = new Map<number, number>(); // expected next clock per client
  let pending = false;
  for (const s of decoded.structs as (Y.Item | Y.GC | Y.Skip)[]) {
    const client = s.id.client;
    if (client === serverClient) return no('server-client');
    // a zero-length struct: Yjs integrates it even "at" a known clock (offset 0) — over a
    // live map entry it deletes that entry, and the document then fails to encode
    if (!(s.length > 0)) return no('malformed');
    const roomClock = Y.getState(doc.store, client);
    const end = s.id.clock + s.length;
    const expected = next.get(client);
    if (expected !== undefined && s.id.clock !== expected) pending = true; // not contiguous
    next.set(client, end);
    if (s instanceof Y.Skip) {
      if (end > roomClock) pending = true; // a hole in the new clocks
      continue;
    }
    if (end <= roomClock) {
      // the room has it: Yjs skips it, but only after resolving its origins/parent
      if (s instanceof Y.Item) known.push(s);
      continue;
    }
    // the first new clock must be exactly the room's next clock for this client
    if (s.id.clock < roomClock) return no('overlap');
    if (s.id.clock > roomClock && expected === undefined) pending = true; // a gap before it
    let arr = fresh.get(client);
    if (!arr) {
      fresh.set(client, (arr = []));
      writers.push(client);
      if (opts.mayWriteClient && !opts.mayWriteClient(client)) return no('foreign-client');
    }
    arr.push(s);
    if (s instanceof Y.Item) items.push(s);
  }

  const findFresh = (id: Y.ID): Y.Item | Y.GC | null => {
    const arr = fresh.get(id.client);
    if (!arr) return null;
    // most structs of a crafted update are one clock long: try the index that clock would have
    const guess = id.clock - arr[0].id.clock;
    if (guess >= 0 && guess < arr.length) {
      const g = arr[guess];
      if (id.clock >= g.id.clock && id.clock < g.id.clock + g.length) return g;
    }
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const it = arr[mid];
      if (id.clock < it.id.clock) hi = mid - 1;
      else if (id.clock >= it.id.clock + it.length) lo = mid + 1;
      else return it;
    }
    return null;
  };

  // Cuts (fv8 P1, P2). Yjs cuts an item in two wherever a struct of the update names a clock
  // inside it as its origin (cut after that clock) or right origin (cut before it) — the new
  // structs and the ones the room has alike: Yjs resolves the origins of a known struct before
  // it skips it — and wherever a delete range starts or ends inside a live item, the room's or
  // the update's own new ones. Every cut is a struct of its own in the encoded room (fv8: an
  // insert between every two points of two 100 000-point strokes, 3.97 MB, grew the stored room
  // by 7.5 MB, uncounted), and Yjs copies the item's content to make it (the same update froze
  // the server for 53-65 s). One count per boundary, however many structs name it.
  const cuts = new Map<number, Set<number>>();
  let splits = 0;
  let splitWork = 0;
  /** the struct holding `clock` of `client`: the room's when it has that clock, else the update's */
  const structAt = (client: number, clock: number): Y.Item | Y.GC | null => {
    if (clock < Y.getState(doc.store, client)) {
      const structs = doc.store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
      if (!structs) return null;
      try {
        return structs[Y.findIndexSS(structs, clock)] ?? null;
      } catch {
        return null;
      }
    }
    return findFresh(Y.createID(client, clock));
  };
  const maxSplits = opts.maxSplits ?? Infinity;
  const maxSplitWork = opts.maxSplitWork ?? Infinity;
  const overCap = () => splits > maxSplits || splitWork > maxSplitWork;
  /** a cut right before `clock` of `client`, when that is inside an item (not its first clock, never a GC) */
  const cutBefore = (client: number, clock: number, st: Y.Item | Y.GC | null, copies = 1) => {
    if (!(st instanceof Y.Item) || clock <= st.id.clock || clock >= st.id.clock + st.length) return;
    let set = cuts.get(client);
    if (!set) cuts.set(client, (set = new Set()));
    if (set.has(clock)) return;
    set.add(clock);
    splits++;
    // Yjs copies the item's content (both halves) and splices the new struct into the client's
    // struct array (a pointer move per struct after it: SPLIT_MOVE_DIVISOR of them per unit)
    const structs = (doc.store.clients.get(client)?.length ?? 0) + (fresh.get(client)?.length ?? 0);
    splitWork += SPLIT_BASE_WORK + Math.ceil(structs / SPLIT_MOVE_DIVISOR) + (copiesOnSplit(st.content) ? copies * st.length : 0);
  };
  // counted before anything else is resolved (an origin nobody has cuts nothing), so that an
  // update over the caps is refused early
  for (const list of [items, known]) {
    // a known struct is skipped once its origins are resolved: nothing goes between the two
    // halves and Yjs merges them back at the end of the update, copying the item again
    const copies = list === known ? SPLIT_REMERGE_COPIES : 1;
    for (const s of list) {
      if (s.origin) cutBefore(s.origin.client, s.origin.clock + 1, structAt(s.origin.client, s.origin.clock + 1), copies);
      if (s.rightOrigin) cutBefore(s.rightOrigin.client, s.rightOrigin.clock, structAt(s.rightOrigin.client, s.rightOrigin.clock), copies);
      if (overCap()) return no('splits');
    }
  }

  // Merges (fv9 A/B/C). Once the update is in, Yjs merges structs of one client that continue
  // each other (Item.mergeWith, GC.mergeWith): the update's own new structs, the room's last
  // struct of that client with the first new one, and the deleted structs a delete leaves next to
  // each other. Merging list contents (ContentAny/JSON) concatenates their arrays, right to left,
  // so a run of k items copies its tail k times (20 000 one-number items, 143 KB, made 2 x 10^8
  // copies and ran the server out of heap); every run merged splices the client's struct array and
  // moves the structs after it (100 000 separate pairs, or 80 000 delete ranges in a fragmented
  // room: seconds each). An honest encoder never sends structs that continue each other (its own
  // Yjs merged them before encoding), and an honest delete merges a few runs: next to nothing.
  // The work is counted into splitWork (refused over MAX_APPLY_MS, pre-charged otherwise).
  let merges = 0;
  {
    const mergeable = (c: ItemContent): 'list' | 'string' | 'deleted' | null =>
      c instanceof Y.ContentAny || c instanceof Y.ContentJSON ? 'list' : c instanceof Y.ContentString ? 'string' : c instanceof Y.ContentDeleted ? 'deleted' : null;
    const sameId = (a: Y.ID | null, b: Y.ID | null) => (a === null || b === null ? a === b : a.client === b.client && a.clock === b.clock);
    /** what a struct is once the update is in: GC or not, deleted (null: the update deletes part of it), its content class */
    interface After {
      s: Y.Item | Y.GC;
      gc: boolean;
      del: boolean | null;
      cls: 'list' | 'string' | 'deleted' | null;
    }
    const deletedBy = (s: Y.Item | Y.GC): number => deletedIn(decoded.ds, s.id.client, s.id.clock, s.length);
    const after = (s: Y.Item | Y.GC, room: boolean): After => {
      if (!(s instanceof Y.Item)) return { s, gc: true, del: true, cls: null };
      const covered = room && s.deleted ? s.length : deletedBy(s);
      const del = s.deleted || s.content instanceof Y.ContentDeleted || covered >= s.length ? true : covered === 0 ? false : null;
      // a deleted item's content is dropped at the end of the transaction (ContentDeleted); the
      // items of a deleted type are replaced by GC structs
      const parent = (s.parent && typeof s.parent === 'object' && '_item' in (s.parent as object) ? (s.parent as Y.AbstractType<unknown>)._item : null) as Y.Item | null;
      const parentGone = !!parent && (parent.deleted || deletedBy(parent) >= parent.length);
      if (del === true && room && !s.deleted && parentGone && !s.keep) return { s, gc: true, del: true, cls: null };
      return { s, gc: false, del, cls: del === true && !s.keep ? 'deleted' : mergeable(s.content) };
    };
    /** would Yjs merge `r` into `l` (its left neighbour in the client's struct array)? */
    const follows = (l: After, r: After): boolean => {
      if (l.gc || r.gc) return l.gc && r.gc;
      const li = l.s as Y.Item;
      const ri = r.s as Y.Item;
      if (l.del !== null && r.del !== null && l.del !== r.del) return false;
      if (l.cls === null || r.cls === null) return false;
      // a part the update deletes (it is cut) may become either
      if (l.del !== null && r.del !== null && l.cls !== r.cls) return false;
      if (li.redone !== null || ri.redone !== null) return false;
      if (!ri.origin || ri.origin.client !== li.id.client || ri.origin.clock !== li.id.clock + li.length - 1) return false;
      return sameId(li.rightOrigin, ri.rightOrigin);
    };
    /** a run of `k` structs (lengths `lens`, right to left) merged: its copies, one splice moving `tail` structs */
    const run = (items: After[], tail: number) => {
      const k = items.length;
      merges += k - 1;
      let copies = 0;
      if (items.every((a) => a.cls === 'list' && a.del === false)) {
        // right to left: each merge copies the left item and everything merged into it so far
        // (into a new array: two units per element, measured 6.2-6.4 ns on x86)
        let suffix = items[k - 1].s.length;
        for (let i = k - 2; i >= 0; i--) {
          suffix += items[i].s.length;
          copies += 2 * suffix;
        }
      } else if (items.some((a) => a.cls === 'string')) {
        for (const a of items) copies += a.s.length;
      }
      splitWork += copies + (k - 1) * MERGE_BASE_WORK + Math.ceil(tail / MERGE_MOVE_DIVISOR);
    };
    // the update's new structs (and the room's last struct of their client)
    for (const [client, arr] of fresh) {
      const roomStructs = doc.store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
      const chain: After[] = [];
      if (roomStructs?.length && arr[0].id.clock === Y.getState(doc.store, client)) chain.push(after(roomStructs[roomStructs.length - 1], true));
      for (const s of arr) chain.push(after(s, false));
      // runs right to left, the way the cleanup goes: a splice moves the structs after the run
      // that earlier merges (right of it) left in place
      let removed = 0;
      let cur: After[] = [chain[chain.length - 1]];
      for (let i = chain.length - 2; i >= -1; i--) {
        if (i >= 0 && follows(chain[i], chain[i + 1])) {
          cur.push(chain[i]);
          continue;
        }
        if (cur.length > 1) {
          run(cur.reverse(), Math.max(0, chain.length - (i + 1) - cur.length - removed));
          removed += cur.length - 1;
        }
        if (i >= 0) cur = [chain[i]];
      }
      if (overCap()) return no('splits');
    }
    // the room's structs the update deletes: per range it deleted (right to left, the way
    // tryMergeDeleteSet goes), Yjs merges every run that ends between the range's first struct
    // and the struct after its last one, then goes on left of that run
    for (const [client, ranges] of decoded.ds.clients) {
      const structs = doc.store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
      const roomClock = Y.getState(doc.store, client);
      if (!structs?.length) continue;
      const n = structs.length + (fresh.get(client)?.length ?? 0);
      let limit = structs.length; // structs from here on are counted already
      let removed = 0; // structs merged away right of where we are (they no longer move)
      for (let ri = ranges.length - 1; ri >= 0; ri--) {
        const r = ranges[ri];
        if (r.clock >= roomClock) continue;
        const end = Math.min(r.clock + r.len, roomClock);
        const first = Y.findIndexSS(structs, r.clock);
        const last = Math.min(structs.length - 1, Y.findIndexSS(structs, end - 1) + 1);
        // only a range that deletes something: an already deleted struct is not in the
        // transaction's delete set (a full-state step 2 repeats every delete of the room)
        let deletes = false;
        for (let j = first; j <= last && !deletes; j++) {
          const st = structs[j];
          if (st instanceof Y.Item && !st.deleted && st.id.clock < end) deletes = true;
        }
        if (!deletes) continue;
        for (let j = Math.min(last, limit - 1); j >= Math.max(first, 1); ) {
          const items: After[] = [after(structs[j], true)];
          let k = j;
          while (k > 0 && follows(after(structs[k - 1], true), items[items.length - 1])) items.push(after(structs[--k], true));
          if (items.length > 1) {
            run(items.reverse(), Math.max(0, n - j - 1 - removed));
            removed += items.length - 1;
          }
          limit = k;
          j = k - 1;
        }
        if (overCap()) return no('splits');
      }
    }
  }

  // Dependencies: Yjs only integrates (or skips) a struct once its origins/parent exist;
  // a same-client dependency it does not even check, and resolving a missing one throws.
  const depsOf = (s: Y.Item) => [s.origin, s.rightOrigin, s.parent && typeof s.parent === 'object' && 'client' in s.parent ? (s.parent as Y.ID) : null];
  for (const s of items) {
    for (const dep of depsOf(s)) {
      if (!dep) continue;
      if (dep.client === s.id.client) {
        if (dep.clock >= s.id.clock) return no('malformed');
        continue; // earlier clock of the same client: the room or this update has it (contiguity)
      }
      if (dep.clock < Y.getState(doc.store, dep.client)) continue;
      if (!findFresh(dep)) pending = true;
    }
  }
  for (const s of known) {
    for (const dep of depsOf(s)) {
      if (!dep) continue;
      // same client: Yjs does not wait for it and resolving a later clock throws
      if (dep.client === s.id.client && dep.clock >= s.id.clock) return no('malformed');
      if (dep.clock < Y.getState(doc.store, dep.client) || findFresh(dep)) continue;
      if (dep.client === s.id.client) return no('malformed');
      pending = true;
    }
  }
  // Integration order: Yjs integrates each client's structs in clock order, every one once
  // its cross-client dependencies are in. Dependencies that all exist can still form a
  // cycle across clients (A:0 after B:1, B:0 after A:0) that never integrates: simulate it.
  if (!pending && !integrates(doc, decoded.structs as (Y.Item | Y.GC | Y.Skip)[], depsOf)) pending = true;
  if (pending) return no('pending');

  const roomMemo = new Map<Y.Item, Loc | typeof UNRESOLVED>();
  const locOfRoomItem = (item: Y.Item): Loc | typeof UNRESOLVED => {
    const hit = roomMemo.get(item);
    if (hit) return hit;
    const keys: (string | null)[] = [];
    let it: Y.Item = item;
    let r: Loc | typeof UNRESOLVED = UNRESOLVED;
    for (let d = 0; d < 64; d++) {
      keys.unshift(it.parentSub);
      const parent = it.parent as Y.AbstractType<unknown> | null;
      if (!parent) break;
      if (parent._item) {
        it = parent._item;
        continue;
      }
      const name = rootNameOfType(parent, doc);
      if (name !== null) {
        const own = item.parent as Y.AbstractType<unknown>;
        r = own._item
          ? { root: name, keys, parent: idKey(own._item.id), parentId: own._item.id }
          : { root: name, keys, parent: `root:${name}` };
      }
      break;
    }
    roomMemo.set(item, r);
    return r;
  };

  /** location of every resolved NEW item (UNRESOLVED for a cycle) */
  const updMemo = new Map<Y.Item, LocOf>();
  const isRoomClock = (id: Y.ID) => id.clock < Y.getState(doc.store, id.client);
  /** Location of whatever lives at `id`: the room for clocks it has, else the update. */
  const locOfId = (id: Y.ID): LocOf => {
    if (isRoomClock(id)) {
      let st: Y.Item | Y.GC;
      try {
        st = Y.getItem(doc.store, id) as Y.Item | Y.GC;
      } catch {
        return UNRESOLVED;
      }
      if (!(st instanceof Y.Item)) return GC_ROOT;
      return locOfRoomItem(st);
    }
    const s = findFresh(id);
    if (!s) return MISSING;
    if (!(s instanceof Y.Item)) return GC_ROOT;
    return updMemo.get(s) ?? UNRESOLVED; // resolved before its dependants (see locOfItem)
  };
  /** Location of the type created by the item at `id` (the parent of its children). */
  const typeLocOfId = (id: Y.ID): LocOf => {
    let content: ItemContent | null = null;
    if (isRoomClock(id)) {
      try {
        const st = Y.getItem(doc.store, id) as Y.Item | Y.GC;
        content = st instanceof Y.Item ? st.content : null;
      } catch {
        return UNRESOLVED;
      }
    } else {
      const s = findFresh(id);
      if (!s) return MISSING;
      content = s instanceof Y.Item ? s.content : null;
    }
    // Yjs takes `parentItem.content.type`: anything but a type (or a GC) integrates as GC
    if (!(content instanceof Y.ContentType)) return GC_ROOT;
    return locOfId(id);
  };
  const parentIdOf = (s: Y.Item): Y.ID | null => {
    const p = s.parent as unknown;
    return p && typeof p === 'object' && 'client' in (p as object) ? (p as Y.ID) : null;
  };
  /** One item's location from its dependencies' (all of them resolved already). */
  const computeLoc = (s: Y.Item): LocOf => {
    const p = s.parent as unknown;
    const left = s.origin ? locOfId(s.origin) : null;
    const right = s.rightOrigin ? locOfId(s.rightOrigin) : null;
    if (left === MISSING || right === MISSING) return MISSING;
    if (left === UNRESOLVED || right === UNRESOLVED) return UNRESOLVED;
    if (left === GC_ROOT || right === GC_ROOT) return GC_ROOT;
    if (typeof p === 'string') return { root: p, keys: [s.parentSub], parent: `root:${p}` };
    const pid = parentIdOf(s);
    if (pid) {
      const pl = typeLocOfId(pid);
      if (typeof pl === 'symbol') return pl;
      // deeper than any value the schema allows: refused (and no O(depth^2) key copies)
      if (pl.keys.length >= MAX_KEYS + 1) return UNRESOLVED;
      return { root: pl.root, keys: [...pl.keys, s.parentSub], parent: idKey(pid), parentId: pid };
    }
    if (left) return left; // parent omitted: parent and key of the left origin...
    if (right) return right; // ...else of the right origin
    return UNRESOLVED; // no parent and no origin: malformed
  };
  /**
   * Location of a NEW item. Its dependencies (origin, right origin, parent item) that are
   * new too are resolved first with an explicit stack — no recursion, so an origin chain of
   * any length neither overflows the stack nor is cut off — and every item is computed
   * once. A dependency met again while it is still being resolved is an origin cycle.
   */
  const locOfItem = (start: Y.Item): LocOf => {
    const hit = updMemo.get(start);
    if (hit !== undefined) return hit;
    const stack: Y.Item[] = [start];
    const open = new Set<Y.Item>();
    while (stack.length) {
      const s = stack[stack.length - 1];
      if (updMemo.has(s)) {
        stack.pop();
        continue;
      }
      if (!open.has(s)) {
        open.add(s);
        let cycle = false;
        for (const dep of [s.origin, s.rightOrigin, parentIdOf(s)]) {
          if (!dep || isRoomClock(dep)) continue;
          const f = findFresh(dep);
          if (!(f instanceof Y.Item) || updMemo.has(f)) continue;
          if (open.has(f)) cycle = true;
          else stack.push(f);
        }
        if (cycle) {
          updMemo.set(s, UNRESOLVED);
          open.delete(s);
          stack.pop();
        }
        continue;
      }
      updMemo.set(s, computeLoc(s));
      open.delete(s);
      stack.pop();
    }
    return updMemo.get(start) ?? UNRESOLVED;
  };

  /** Current length of a room Y.Array created by the item at `id` (0 when it is new). */
  const roomArrayLength = (id: Y.ID | undefined): number => {
    if (!id || id.clock >= Y.getState(doc.store, id.client)) return 0;
    try {
      const st = Y.getItem(doc.store, id) as Y.Item | Y.GC;
      const t = st instanceof Y.Item && st.content instanceof Y.ContentType ? st.content.type : null;
      return t instanceof Y.Array ? t.length : 0;
    } catch {
      return 0;
    }
  };

  /** current length of a room Y.Text created by the item at `id` (0 when it is new) */
  const roomTextLength = (id: Y.ID | undefined): number => {
    if (!id || !isRoomClock(id)) return 0;
    try {
      const st = Y.getItem(doc.store, id) as Y.Item | Y.GC;
      const t = st instanceof Y.Item && st.content instanceof Y.ContentType ? st.content.type : null;
      return t instanceof Y.Text ? t.length : 0;
    } catch {
      return 0;
    }
  };

  const newShapeMaps: Y.Item[] = [];
  const typeParents = new Set<string>();
  /** shape maps (parent key) whose `type` a ContentDeleted item at that key overwrites */
  const typeErased = new Map<string, Y.ID | undefined>();
  /**
   * Resulting length per `points` Y.Array / `text` Y.Text (parent key), as a delta to the
   * room's: + the new elements the update leaves alive (an element it inserts and deletes
   * again — an offline paste the UndoManager undid, a backspaced keystroke — adds nothing:
   * fv5 M-1), - the live room elements it deletes (below).
   */
  const pointsDelta = new Map<string, { id: Y.ID | undefined; n: number }>();
  const textDelta = new Map<string, { id: Y.ID | undefined; n: number }>();
  const liveLength = (s: Y.Item) => s.length - deletedIn(decoded.ds, s.id.client, s.id.clock, s.length);
  for (const s of items) {
    const loc = locOfItem(s);
    if (loc === MISSING) {
      pending = true;
      continue;
    }
    if (loc === UNRESOLVED) return no('malformed');
    if (loc === GC_ROOT) continue;
    if (!CLIENT_WRITABLE_ROOTS.has(loc.root)) return no(loc.root);
    touchShape(loc);
    if (s.content instanceof Y.ContentDeleted) {
      // a deleted item at a map key replaces (= deletes) the value there: same rules as a
      // delete — the key must be one a client may use, and a live shape keeps its `type`
      if (loc.keys.some((k) => k !== null && !keyOk(k))) return no(`${loc.root}-schema`);
      if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') typeErased.set(loc.parent, loc.parentId);
      continue;
    }
    const problem = schemaProblem(loc, s.content);
    if (problem) return no(problem);
    if (loc.root === ROOT.shapes && loc.keys.length === 1) newShapeMaps.push(s);
    if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') {
      // a new `type` value replaces the old one; deleted in the same update, it leaves none
      if (Y.isDeleted(decoded.ds, s.id)) typeErased.set(loc.parent, loc.parentId);
      else typeParents.add(loc.parent);
    }
    if (loc.root === ROOT.shapes && loc.keys.length === 3 && loc.keys[1] === 'points') {
      const cur = pointsDelta.get(loc.parent) ?? { id: loc.parentId, n: 0 };
      cur.n += liveLength(s);
      pointsDelta.set(loc.parent, cur);
    }
    if (loc.root === ROOT.shapes && loc.keys.length === 3 && loc.keys[1] === 'text' && s.content instanceof Y.ContentString) {
      const cur = textDelta.get(loc.parent) ?? { id: loc.parentId, n: 0 };
      cur.n += liveLength(s);
      textDelta.set(loc.parent, cur);
    }
  }
  if (pending) return no('pending');

  // Placement (fv8 P2). Yjs places a new item by scanning what lies between its left (origin)
  // and its right (right origin) — the inserts others made at that spot meanwhile —, and a map
  // value with no origin first walks back through the whole history of its key. An honest client
  // names neighbours that were adjacent when it wrote, so the scan walks only what others
  // inserted since. A forged item whose right origin is far away (or none, at the end of a long
  // list) makes Yjs walk the whole list for every such item: 4 000 of them, 28 KB, held the
  // server for 40 s with no cut at all. Bounded here, per new item, by what lies between its
  // anchors (its origin and right origin, followed through the update's own new items down to
  // the room's): the room items there, plus the update's own new items anchored there (they may
  // be placed in between first) — except for an item that only continues a run (its origin is a
  // new item with the same right origin and no other new item names that origin: Yjs puts it
  // right after it). Each pair of anchors is walked once, never past the cap.
  let scanWork = 0;
  const maxScanWork = opts.maxScanWork ?? Infinity;
  if (items.length) {
    const sameId = (a: Y.ID | null, b: Y.ID | null) => (a === null || b === null ? a === b : a.client === b.client && a.clock === b.clock);
    const anchorMemo = { origin: new Map<Y.Item, Y.ID | null>(), rightOrigin: new Map<Y.Item, Y.ID | null>() };
    /** the room clock a new item's left (`origin`) or right (`rightOrigin`) anchor comes down to; null = the list's start / end */
    const anchor = (s: Y.Item, side: 'origin' | 'rightOrigin'): Y.ID | null => {
      const memo = anchorMemo[side];
      const path: Y.Item[] = [];
      let cur = s;
      let res: Y.ID | null = null;
      for (;;) {
        const hit = memo.get(cur);
        if (hit !== undefined) {
          res = hit;
          break;
        }
        path.push(cur);
        const id = cur[side];
        if (!id) break;
        if (isRoomClock(id)) {
          res = id;
          break;
        }
        const f = findFresh(id);
        if (!(f instanceof Y.Item) || path.length > items.length) break;
        cur = f;
      }
      for (const p of path) memo.set(p, res);
      return res;
    };
    /** the room type a new item goes into (null: a type this update creates: nothing of the room in it) */
    const roomType = (loc: Loc): Y.AbstractType<unknown> | null => {
      if (!loc.parentId) return (doc.share.get(loc.root) as Y.AbstractType<unknown> | undefined) ?? null;
      if (!isRoomClock(loc.parentId)) return null;
      const st = structAt(loc.parentId.client, loc.parentId.clock);
      return st instanceof Y.Item && st.content instanceof Y.ContentType ? (st.content.type as Y.AbstractType<unknown>) : null;
    };
    /** a list, or one key of a map */
    const regionOf = (loc: Loc) => (loc.region ??= `${loc.parent}\u0000${loc.keys[loc.keys.length - 1] ?? ''}`);
    // where the new items are anchored: clocks per room struct (sorted), and counts at list starts
    const anchoredIn = new Map<Y.Item, number[]>();
    const anchoredAtStart = new Map<string, number>();
    /** new items naming a new item's clock as origin, per client and clock (a run continues only with one) */
    const children = new Map<number, Map<number, number>>();
    const childrenOf = (id: Y.ID) => children.get(id.client)?.get(id.clock) ?? 0;
    const placed: { s: Y.Item; loc: Loc; region: string; left: Y.ID | null; right: Y.ID | null }[] = [];
    const resolve = (s: Y.Item, side: 'origin' | 'rightOrigin'): Y.ID | null => {
      const id = s[side];
      return !id ? null : isRoomClock(id) ? id : anchor(s, side);
    };
    /** keys written with no neighbours into each map this update creates (see below) */
    const newMapKeys = new Map<string, string[] | Map<string, number>>();
    for (const s of items) {
      const loc = updMemo.get(s);
      if (!loc || typeof loc !== 'object') continue; // integrated as GC (no placement)
      const sub = loc.keys[loc.keys.length - 1];
      if (!s.origin && !s.rightOrigin && typeof sub === 'string' && loc.parentId && !isRoomClock(loc.parentId)) {
        // a value of a map this update creates, with no neighbours (every field of a new shape):
        // Yjs walks back over the values this update wrote to that key before it
        const seen = newMapKeys.get(loc.parent);
        if (!seen) newMapKeys.set(loc.parent, [sub]);
        else if (Array.isArray(seen)) {
          for (const k of seen) if (k === sub) scanWork++;
          if (seen.length < 32) seen.push(sub);
          else {
            const m = new Map<string, number>();
            for (const k of [...seen, sub]) m.set(k, (m.get(k) ?? 0) + 1);
            newMapKeys.set(loc.parent, m);
          }
        } else {
          scanWork += seen.get(sub) ?? 0;
          seen.set(sub, (seen.get(sub) ?? 0) + 1);
        }
        if (scanWork > maxScanWork) return no('splits');
        continue;
      }
      const region = regionOf(loc);
      const left = resolve(s, 'origin');
      const right = resolve(s, 'rightOrigin');
      placed.push({ s, loc, region, left, right });
      if (s.origin && !isRoomClock(s.origin)) {
        let m = children.get(s.origin.client);
        if (!m) children.set(s.origin.client, (m = new Map()));
        m.set(s.origin.clock, (m.get(s.origin.clock) ?? 0) + 1);
      }
      const l = left ? structAt(left.client, left.clock) : null;
      if (l instanceof Y.Item) {
        let arr = anchoredIn.get(l);
        if (!arr) anchoredIn.set(l, (arr = []));
        arr.push(left!.clock);
      } else if (!left) anchoredAtStart.set(region, (anchoredAtStart.get(region) ?? 0) + 1);
    }
    for (const arr of anchoredIn.values()) arr.sort((a, b) => a - b);
    /** new items anchored in room struct `it` at clocks in [from, to) */
    const anchoredBetween = (it: Y.Item, from: number, to: number): number => {
      const arr = anchoredIn.get(it);
      if (!arr) return 0;
      const lower = (x: number) => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid] < x) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      return lower(to) - lower(from);
    };
    const limit = Number.isFinite(maxScanWork) ? maxScanWork + 1 : Infinity;
    const walked = new Map<string, number>();
    /**
     * What Yjs may scan between `left` and `right` in `type` (a list, or key `sub` of a map): the
     * room items, and the new items anchored there. Memoised per pair; never walks past the cap.
     */
    const between = (region: string, type: Y.AbstractType<unknown> | null, sub: string | null, left: Y.ID | null, right: Y.ID | null): number => {
      const key = `${left ? idKey(left) : '^'}>${right ? idKey(right) : '$'}>${region}`;
      const hit = walked.get(key);
      if (hit !== undefined) return hit;
      const l = left ? structAt(left.client, left.clock) : null;
      const r = right ? structAt(right.client, right.clock) : null;
      let n = 0;
      if ((left && !(l instanceof Y.Item)) || (right && !(r instanceof Y.Item))) {
        n = 0; // a GC neighbour: Yjs integrates the item as GC, no scan
      } else if (l instanceof Y.Item && l === r) {
        n = (right!.clock > left!.clock + 1 ? 1 : 0) + anchoredBetween(l, left!.clock, right!.clock);
      } else {
        let o: Y.Item | null = null;
        if (l instanceof Y.Item) {
          if (left!.clock < l.id.clock + l.length - 1) n++; // the rest of the left item
          n += anchoredBetween(l, left!.clock, Infinity);
          o = l.right;
        } else {
          n += anchoredAtStart.get(region) ?? 0;
          if (type && sub !== null) {
            // a map value with no origin: Yjs first walks back through the key's history
            o = (type as unknown as { _map: Map<string, Y.Item> })._map.get(sub) ?? null;
            while (o && o.left && n < limit) {
              o = o.left;
              n++;
            }
          } else if (type) o = type._start;
        }
        while (o && o !== r && n < limit) {
          n += 1 + anchoredBetween(o, -Infinity, Infinity);
          o = o.right;
        }
        if (r instanceof Y.Item) n += (right!.clock > r.id.clock ? 1 : 0) + anchoredBetween(r, -Infinity, right!.clock);
      }
      walked.set(key, n);
      return n;
    };
    for (const { s, loc, region, left, right } of placed) {
      const prev = s.origin && !isRoomClock(s.origin) ? findFresh(s.origin) : null;
      // continues a run: right after its origin, nothing to scan
      if (prev instanceof Y.Item && sameId(prev.rightOrigin, s.rightOrigin) && childrenOf(s.origin!) === 1) continue;
      // minus the item itself (it is anchored there too)
      scanWork += Math.max(0, between(region, roomType(loc), loc.keys[loc.keys.length - 1] ?? null, left, right) - 1);
      if (scanWork > maxScanWork) return no('splits');
    }
  }

  const dsHas = (id: Y.ID) => Y.isDeleted(decoded.ds, id);
  for (const [client, ranges] of decoded.ds.clients) {
    const roomClock = Y.getState(doc.store, client);
    const structs = doc.store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
    for (const r of ranges) {
      // a zero-length range deletes nothing but makes Yjs throw while it re-encodes it
      if (!(r.len > 0)) return no('malformed');
      // walk the room's struct array of this client from the first struct of the range (one
      // binary search per range, then O(1) per struct, the way Yjs applies a delete set)
      let idx = structs && r.clock < roomClock ? Y.findIndexSS(structs, r.clock) : -1;
      for (let clock = r.clock; clock < r.clock + r.len; ) {
        if (clock >= roomClock) {
          // a delete of something the room does not have yet: only fine if the update
          // itself inserts it (checked above); otherwise it would wait as a pending delete
          const it = findFresh(Y.createID(client, clock));
          if (!it) return no('pending');
          // a range that starts or ends inside one of the update's own new items cuts it too
          // (the delete set is applied once the structs are in; fv8 P1)
          if (!(it instanceof Y.Item && it.content instanceof Y.ContentDeleted)) {
            cutBefore(client, clock, it);
            cutBefore(client, Math.min(r.clock + r.len, it.id.clock + it.length), it);
          }
          clock = it.id.clock + it.length;
          continue;
        }
        const item = structs && idx >= 0 ? structs[idx++] : undefined;
        if (!item || item.id.clock > clock || clock >= item.id.clock + item.length) return no('malformed');
        // already-deleted items are a no-op (a full-state update repeats the whole delete set)
        if (item instanceof Y.Item && !item.deleted) {
          splitWork += DELETE_WORK;
          const loc = locOfRoomItem(item);
          if (loc === UNRESOLVED) return no('malformed');
          if (!CLIENT_WRITABLE_ROOTS.has(loc.root)) return no(loc.root);
          touchShape(loc);
          const from = Math.max(clock, item.id.clock);
          const to = Math.min(r.clock + r.len, item.id.clock + item.length);
          // a range that starts or ends inside a live item splits it (fv5 L-2)
          cutBefore(client, from, item);
          cutBefore(client, to, item);
          if (loc.root === ROOT.shapes && loc.keys.length === 3 && (loc.keys[1] === 'text' || loc.keys[1] === 'points')) {
            // a delete of room text / points: the part of the item inside the range leaves it
            const delta = loc.keys[1] === 'text' ? (item.content instanceof Y.ContentString ? textDelta : null) : pointsDelta;
            if (delta) {
              const cur = delta.get(loc.parent) ?? { id: loc.parentId, n: 0 };
              cur.n -= to - from;
              delta.set(loc.parent, cur);
            }
          }
          // deleting the current `type` of a live shape needs a replacement in the same update
          if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') {
            const map = (item.parent as Y.AbstractType<unknown>)._item;
            const current = (item.parent as unknown as { _map: Map<string, Y.Item> })._map.get('type') === item;
            if (map && current && !map.deleted && !dsHas(map.id) && !typeParents.has(loc.parent)) {
              return no('shapes-schema');
            }
          }
        }
        clock = item.id.clock + item.length;
      }
    }
  }
  if (overCap()) return no('splits');
  for (const { id, n } of textDelta.values()) {
    if (n > 0 && roomTextLength(id) + n > MAX_TEXT_LENGTH) return no('shapes-schema');
  }
  for (const { id, n } of pointsDelta.values()) {
    if (n > 0 && roomArrayLength(id) + n > MAX_POINTS) return no('shapes-schema');
  }
  // a `type` overwritten by a deleted item: refused unless the shape itself goes away in this
  // update. With a live replacement in the same update too, the winner would depend on the
  // order the items integrate in: refused as well (clients never change a shape's type).
  for (const [, mapId] of typeErased) {
    if (mapId && dsHas(mapId)) continue;
    const freshMap = mapId ? findFresh(mapId) : null;
    if (freshMap instanceof Y.Item && freshMap.content instanceof Y.ContentDeleted) continue;
    return no('shapes-schema');
  }
  // a new shape is a Y.Map with a valid `type` from its first update
  for (const m of newShapeMaps) {
    if (!dsHas(m.id) && !typeParents.has(idKey(m.id))) return no('shapes-schema');
  }
  let shapeKeyBytes = 0;
  for (const k of touchedShapes) shapeKeyBytes += utf8Length(k);
  return { bad: null, writers, grows: fresh.size > 0 || splits > 0, splits, splitWork, scanWork, merges, shapes: touchedShapes.size, shapeKeyBytes };
}

/** Clocks of [clock, clock + len) of `client` that the (canonical: sorted, disjoint) delete set deletes. */
function deletedIn(ds: ReturnType<typeof Y.decodeUpdate>["ds"], client: number, clock: number, len: number): number {
  const ranges = ds.clients.get(client);
  if (!ranges || !ranges.length) return 0;
  // first range that ends after `clock`
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].clock + ranges[mid].len <= clock) lo = mid + 1;
    else hi = mid;
  }
  let n = 0;
  const end = clock + len;
  for (let i = lo; i < ranges.length && ranges[i].clock < end; i++) {
    n += Math.min(end, ranges[i].clock + ranges[i].len) - Math.max(clock, ranges[i].clock);
  }
  return n;
}

/**
 * Is the delete set of `update` (Yjs update format v1) canonical: every client listed once,
 * its ranges non-empty, sorted by clock and disjoint, and nothing after it? The struct
 * section is skipped exactly the way Yjs' decodeUpdate reads it (lazyStructReaderGenerator:
 * info 10 = Skip, BITS5 != 0 = Item, else GC), so the delete set read here is the one Yjs
 * applies. Any parse failure counts as not canonical.
 */
export function deleteSetCanonical(update: Uint8Array): boolean {
  try {
    const dec = new Y.UpdateDecoderV1(decoding.createDecoder(update));
    const rest = dec.restDecoder;
    const blocks = decoding.readVarUint(rest);
    for (let b = 0; b < blocks; b++) {
      const n = decoding.readVarUint(rest);
      dec.readClient();
      decoding.readVarUint(rest); // first clock
      for (let i = 0; i < n; i++) {
        const info = dec.readInfo();
        if (info === 10) {
          decoding.readVarUint(rest);
          continue;
        }
        if ((binary.BITS5 & info) === 0) {
          dec.readLen(); // GC
          continue;
        }
        if ((info & binary.BIT8) === binary.BIT8) dec.readLeftID();
        if ((info & binary.BIT7) === binary.BIT7) dec.readRightID();
        const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0;
        if (cantCopyParentInfo) {
          if (dec.readParentInfo()) dec.readString();
          else dec.readLeftID();
          if ((info & binary.BIT6) === binary.BIT6) dec.readString();
        }
        skipContent(dec, info & binary.BITS5);
      }
    }
    const clients = decoding.readVarUint(rest);
    const seen = new Set<number>();
    for (let c = 0; c < clients; c++) {
      dec.resetDsCurVal();
      const client = decoding.readVarUint(rest);
      if (seen.has(client)) return false;
      seen.add(client);
      const n = decoding.readVarUint(rest);
      let end = -1;
      for (let i = 0; i < n; i++) {
        const clock = dec.readDsClock();
        const len = dec.readDsLen();
        if (!(len > 0) || clock < end) return false;
        end = clock + len;
      }
    }
    return !decoding.hasContent(rest);
  } catch {
    return false;
  }
}

/** Read past one item content of ref `ref` (Yjs contentRefs, update format v1). */
function skipContent(dec: Y.UpdateDecoderV1, ref: number): void {
  switch (ref) {
    case 1: // ContentDeleted
      dec.readLen();
      return;
    case 2: { // ContentJSON
      const n = dec.readLen();
      for (let i = 0; i < n; i++) dec.readString();
      return;
    }
    case 3: // ContentBinary
      dec.readBuf();
      return;
    case 4: // ContentString
      dec.readString();
      return;
    case 5: // ContentEmbed
      dec.readJSON();
      return;
    case 6: // ContentFormat
      dec.readKey();
      dec.readJSON();
      return;
    case 7: { // ContentType: YXmlElement (3) and YXmlHook (5) carry a key
      const t = dec.readTypeRef();
      if (t === 3 || t === 5) dec.readKey();
      else if (t > 6) throw new Error('type ref');
      return;
    }
    case 8: { // ContentAny
      const n = dec.readLen();
      for (let i = 0; i < n; i++) dec.readAny();
      return;
    }
    case 9: // ContentDoc
      dec.readString();
      dec.readAny();
      return;
    default:
      throw new Error('content ref');
  }
}

/**
 * Would every struct of the update integrate? Per client in clock order (known structs
 * first: Yjs resolves their dependencies too before it skips them), each once its
 * cross-client dependencies exist in the room or were integrated earlier in this pass.
 *
 * A worklist (fv9 E): a client whose next struct lacks a dependency waits on that one clock of
 * that one client, and is woken when that client's integration passes it. Every struct is
 * looked at once per dependency it waits on (at most three), so the check is O(n log n) in the
 * update's structs, whatever the number of client blocks. (It made one pass over every block per
 * struct integrated: 20 000 items chained backwards over 20 000 blocks held the server 27 s.)
 */
function integrates(
  doc: Y.Doc,
  structs: (Y.Item | Y.GC | Y.Skip)[],
  depsOf: (s: Y.Item) => (Y.ID | null)[],
): boolean {
  const seq = new Map<number, (Y.Item | Y.GC)[]>();
  for (const s of structs) {
    if (s instanceof Y.Skip) continue;
    let a = seq.get(s.id.client);
    if (!a) seq.set(s.id.client, (a = []));
    a.push(s);
  }
  const reached = new Map<number, number>(); // client -> end clock integrated so far
  const idx = new Map<number, number>();
  for (const [client, a] of seq) {
    idx.set(client, 0);
    reached.set(client, Math.min(a[0].id.clock, Y.getState(doc.store, client)));
  }
  /** the first cross-client dependency of `s` that is neither in the room nor integrated yet */
  const blocker = (s: Y.Item | Y.GC): Y.ID | null => {
    if (!(s instanceof Y.Item)) return null;
    for (const dep of depsOf(s)) {
      if (!dep || dep.client === s.id.client) continue;
      if (dep.clock < Y.getState(doc.store, dep.client)) continue;
      if (dep.clock < (reached.get(dep.client) ?? 0)) continue;
      return dep;
    }
    return null;
  };
  /** per client: the clients waiting for one of its clocks (a binary min-heap by clock) */
  const waiting = new Map<number, [number, number][]>();
  const wait = (dep: Y.ID, client: number) => {
    let h = waiting.get(dep.client);
    if (!h) waiting.set(dep.client, (h = []));
    h.push([dep.clock, client]);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  };
  const ready: number[] = [...seq.keys()];
  /** `client` integrated up to `end`: everyone waiting for a clock below it may go on */
  const wake = (client: number, end: number) => {
    const h = waiting.get(client);
    while (h && h.length && h[0][0] < end) {
      ready.push(h[0][1]);
      const last = h.pop()!;
      if (h.length) {
        h[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && h[l][0] < h[m][0]) m = l;
          if (r < h.length && h[r][0] < h[m][0]) m = r;
          if (m === i) break;
          [h[m], h[i]] = [h[i], h[m]];
          i = m;
        }
      }
    }
  };
  while (ready.length) {
    const client = ready.pop()!;
    const a = seq.get(client)!;
    let i = idx.get(client)!;
    while (i < a.length) {
      const dep = blocker(a[i]);
      if (dep) {
        wait(dep, client);
        break;
      }
      const end = Math.max(reached.get(client)!, a[i].id.clock + a[i].length);
      reached.set(client, end);
      i++;
      wake(client, end);
    }
    idx.set(client, i);
  }
  for (const [client, a] of seq) if (idx.get(client)! < a.length) return false;
  return true;
}

function fieldKindOf(v: unknown): ShapeFieldKind {
  if (v instanceof Y.Text) return 'text';
  if (v instanceof Y.Array) return 'array';
  if (v instanceof Y.Map) return 'map';
  if (v instanceof Y.AbstractType) return 'other';
  return 'value';
}

/** Schema check of one new item at `loc` (see GuardOptions / docs/protocol.md §6). */
function schemaProblem(loc: Loc, content: ItemContent): string | null {
  const { root, keys } = loc;
  const vals =
    content instanceof Y.ContentAny || content instanceof Y.ContentJSON
      ? ((content as unknown as { arr: unknown[] }).arr ?? [])
      : null;
  if (root === ROOT.shapes) {
    const bad = 'shapes-schema';
    if (keys.length === 1) {
      return keyOk(keys[0]) && content instanceof Y.ContentType && content.type instanceof Y.Map ? null : bad;
    }
    if (keys.length === 2) {
      const field = keys[1];
      if (field === null || !keyOk(keys[0])) return bad;
      if (content instanceof Y.ContentType) {
        const kind = fieldKindOf(content.type);
        // a new nested type is empty: its elements arrive as items of their own (checked below)
        return shapeFieldProblem(field, kind === 'array' ? [] : undefined, kind) ? bad : null;
      }
      if (vals) return vals.length > 0 && vals.every((v) => !shapeFieldProblem(field, v)) ? null : bad;
      return bad;
    }
    if (keys.length === 3) {
      if (keys[2] !== null) return bad;
      // characters only (fv9 D): the client never formats text, and formatting items make Yjs copy
      // the attribute map of every character after the update (60 000 of them froze the server 60 s)
      if (keys[1] === 'text') return content instanceof Y.ContentString ? null : bad;
      // the elements of one item; how many the array ends up with is checked on the whole
      // update (an item Yjs merged from inserts the update also deletes can be longer: fv5 M-1)
      if (keys[1] === 'points') return vals && vals.every(pointNumberOk) ? null : bad;
      return bad;
    }
    return bad;
  }
  if (root === ROOT.assets) {
    return keys.length === 1 && keyOk(keys[0]) && vals && vals.length > 0 && vals.every(assetValueOk) ? null : 'assets-schema';
  }
  if (root === ROOT.meta) {
    return keys.length === 1 && keyOk(keys[0]) && vals && vals.length > 0 && vals.every(metaValueOk) ? null : 'meta-schema';
  }
  return null;
}

/** Problem with the current value of shape `id` in `shapes`, or null (absent = deleted = fine). */
export function shapeValueProblem(shapes: Y.Map<unknown>, id: string, requireTerminals = false): string | null {
  const v = shapes.get(id);
  if (v === undefined) return null;
  if (!keyOk(id)) return 'shapes-schema';
  if (!(v instanceof Y.Map)) return 'shapes-schema';
  const fields = new Map<string, [unknown, ShapeFieldKind]>();
  for (const [k, fv] of (v as Y.Map<unknown>).entries()) {
    const kind = fieldKindOf(fv);
    fields.set(k, [kind === 'array' ? (fv as Y.Array<unknown>).toArray() : kind === 'text' ? (fv as Y.Text).toString() : fv, kind]);
  }
  return shapeRecordProblem(fields, requireTerminals) ? 'shapes-schema' : null;
}

function rootNameOfType(t: Y.AbstractType<unknown> | null, doc: Y.Doc): string | null {
  let cur: Y.AbstractType<unknown> | null = t;
  while (cur && cur._item) cur = cur._item.parent as Y.AbstractType<unknown>;
  if (!cur) return null;
  for (const [name, type] of doc.share) if (type === cur) return name;
  return null;
}
