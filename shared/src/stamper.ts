import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { CONTENT_ROOTS, MAX_POINTS, ROOT, keyOk } from './model.js';
import { assetValueOk, metaValueOk, pointsOk, shapeFieldProblem, shapeRecordProblem, SHAPE_TYPES } from './model.js';
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
        pushHistory(history, opts, memo, { t: now, by: who.id, verb, shapeId: id, shapeType: info.type, geo: info.geo, highlight: info.highlight, owner: ownerOf(prev, who.id) });
        // The attribution entry is kept so that an undo of the delete restores the original author.
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
        pushHistory(history, opts, memo, { t: now, by: who.id, verb: 'create', shapeId: id, shapeType, geo, highlight });
        continue;
      }
      if (verb === 'create') {
        // re-inserted (undo of a delete): keep the original author
        attribution.set(id, { ...prev, updatedBy: who.id, updatedAt: now });
        pushHistory(history, opts, memo, { t: now, by: who.id, verb: 'create', shapeId: id, shapeType, geo, highlight, owner: ownerOf(prev, who.id) });
        continue;
      }
      const throttle = opts.touchThrottleMs ?? 5000;
      if (prev.updatedBy !== who.id || now - prev.updatedAt >= throttle) {
        attribution.set(id, { ...prev, updatedBy: who.id, updatedAt: now });
      }
      // A gesture that continues the creation (live points, dragging the box out, finishing the
      // stroke) is part of "created", not a separate edit: the author touched it moments ago.
      const touchKey = `${who.id}|${id}`;
      const lastTouch = memo.touch.get(touchKey) ?? 0;
      memo.touch.set(touchKey, now);
      if (prev.createdBy === who.id && now - lastTouch < (opts.gesturePauseMs ?? 2000)) continue;
      pushHistory(history, opts, memo, { t: now, by: who.id, verb, shapeId: id, shapeType, geo, highlight, owner: ownerOf(prev, who.id) });
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

function pushHistory(history: Y.Array<HistoryEntry>, opts: StamperOptions, memo: StamperMemo, e: HistoryEntry) {
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
  history.push([clean]);
  const limit = opts.historyLimit ?? 300;
  if (history.length > limit) history.delete(0, history.length - limit);
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
}

export interface UpdateCheck {
  /** null when the update is acceptable, else the offending root or a reason (see forbiddenRootWrite) */
  bad: string | null;
  /** client ids the update adds new clocks to (to be bound to the sender once applied) */
  writers: number[];
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
 *   - `room-pending`: the room itself holds pending state (it must be cleaned first).
 * `doc` is never modified.
 *
 * Fast path: every struct is checked for length and dependencies; every NEW struct is
 * resolved to its parent type. Yjs encodes `parent` only for items without neighbours; an
 * item with a left/right origin travels with `parent === null` and inherits parent and key
 * from that origin, so origins are followed through the room (for clocks it already has)
 * and the update itself. Anything the fast path cannot resolve (origin cycles, very long
 * chains, an ambiguous `type` replacement) goes to the slow path: the update is applied to a
 * scratch copy of the room, which must integrate completely, change only client roots, and
 * leave every touched value valid.
 */
export function forbiddenRootWrite(doc: Y.Doc, update: Uint8Array, opts: GuardOptions = {}): string | null {
  return checkClientUpdate(doc, update, opts).bad;
}

/** forbiddenRootWrite plus the client ids the update writes with. */
export function checkClientUpdate(doc: Y.Doc, update: Uint8Array, opts: GuardOptions = {}): UpdateCheck {
  if (hasPending(doc)) return { bad: 'room-pending', writers: [] };
  const fast = fastCheck(doc, update, opts);
  if (fast.bad !== UNRESOLVED) return fast as UpdateCheck;
  return { bad: scratchCheck(doc, update), writers: fast.writers };
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

const UNRESOLVED = Symbol('unresolved');
/** A dependency that neither the room nor the update has: the struct would wait as pending. */
const MISSING = Symbol('missing');
/** A struct that Yjs integrates as garbage (a neighbour or the parent is GC): it writes nothing. */
const GC_ROOT = Symbol('gc');
const IN_PROGRESS = Symbol('in-progress');

/** Where an item lives: its root, the map keys from the root down to it, and its parent type. */
interface Loc {
  root: string;
  /** parentSub of every ancestor item from the root down, then the item's own parentSub */
  keys: (string | null)[];
  /** identity of the parent type: `root:<name>` or the id of the item that created it */
  parent: string;
  /** id of the item that created the parent type (absent for a root) */
  parentId?: Y.ID;
}
type LocOf = Loc | typeof GC_ROOT | typeof UNRESOLVED | typeof MISSING;

/** Content of an Item (Yjs does not export the AbstractContent type). */
type ItemContent = Y.Item['content'];

const idKey = (id: Y.ID) => `${id.client}:${id.clock}`;

function fastCheck(doc: Y.Doc, update: Uint8Array, opts: GuardOptions): { bad: string | null | typeof UNRESOLVED; writers: number[] } {
  const serverClient = opts.serverClient ?? doc.clientID;
  const decoded = Y.decodeUpdate(update);
  const writers: number[] = [];
  // One struct block per client. Yjs keeps only the LAST block of a client that appears in
  // several (and an empty block wipes the earlier ones), while decodeUpdate lists all of
  // them: what this check sees would not be what Yjs integrates.
  const blocks = decoding.readVarUint(decoding.createDecoder(update));
  if (blocks !== new Set((decoded.structs as Y.Item[]).map((s) => s.id.client)).size) return { bad: 'malformed', writers };

  // NEW structs (Item / GC) per client, in clock order; fully known ones are skipped by Yjs
  // after it resolved their dependencies (kept apart for the dependency check).
  const fresh = new Map<number, (Y.Item | Y.GC)[]>();
  const items: Y.Item[] = [];
  const known: Y.Item[] = [];
  const next = new Map<number, number>(); // expected next clock per client
  let pending = false;
  for (const s of decoded.structs as (Y.Item | Y.GC | Y.Skip)[]) {
    const client = s.id.client;
    if (client === serverClient) return { bad: 'server-client', writers };
    // a zero-length struct: Yjs integrates it even "at" a known clock (offset 0) — over a
    // live map entry it deletes that entry, and the document then fails to encode
    if (!(s.length > 0)) return { bad: 'malformed', writers };
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
    if (s.id.clock < roomClock) return { bad: 'overlap', writers };
    if (s.id.clock > roomClock && expected === undefined) pending = true; // a gap before it
    let arr = fresh.get(client);
    if (!arr) {
      fresh.set(client, (arr = []));
      writers.push(client);
      if (opts.mayWriteClient && !opts.mayWriteClient(client)) return { bad: 'foreign-client', writers };
    }
    arr.push(s);
    if (s instanceof Y.Item) items.push(s);
  }

  const findFresh = (id: Y.ID): Y.Item | Y.GC | null => {
    const arr = fresh.get(id.client);
    if (!arr) return null;
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

  // Dependencies: Yjs only integrates (or skips) a struct once its origins/parent exist;
  // a same-client dependency it does not even check, and resolving a missing one throws.
  const depsOf = (s: Y.Item) => [s.origin, s.rightOrigin, s.parent && typeof s.parent === 'object' && 'client' in s.parent ? (s.parent as Y.ID) : null];
  for (const s of items) {
    for (const dep of depsOf(s)) {
      if (!dep) continue;
      if (dep.client === s.id.client) {
        if (dep.clock >= s.id.clock) return { bad: 'malformed', writers };
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
      if (dep.client === s.id.client && dep.clock >= s.id.clock) return { bad: 'malformed', writers };
      if (dep.clock < Y.getState(doc.store, dep.client) || findFresh(dep)) continue;
      if (dep.client === s.id.client) return { bad: 'malformed', writers };
      pending = true;
    }
  }
  // Integration order: Yjs integrates each client's structs in clock order, every one once
  // its cross-client dependencies are in. Dependencies that all exist can still form a
  // cycle across clients (A:0 after B:1, B:0 after A:0) that never integrates: simulate it.
  if (!pending && !integrates(doc, decoded.structs as (Y.Item | Y.GC | Y.Skip)[], depsOf)) pending = true;
  if (pending) return { bad: 'pending', writers };

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

  /** memo of every resolved item; IN_PROGRESS while resolving it (an origin cycle) */
  const updMemo = new Map<Y.Item, LocOf | typeof IN_PROGRESS>();
  /** Location of whatever lives at `id`: the room for clocks it has, else the update. */
  const locOfId = (id: Y.ID, depth: number): LocOf => {
    if (id.clock < Y.getState(doc.store, id.client)) {
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
    return locOfItem(s, depth + 1);
  };
  /** Location of the type created by the item at `id` (the parent of its children). */
  const typeLocOfId = (id: Y.ID, depth: number): LocOf => {
    let content: ItemContent | null = null;
    if (id.clock < Y.getState(doc.store, id.client)) {
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
    return locOfId(id, depth);
  };
  const locOfItem = (s: Y.Item, depth: number): LocOf => {
    const hit = updMemo.get(s);
    if (hit === IN_PROGRESS) return UNRESOLVED; // an origin cycle: let the slow path decide
    if (hit !== undefined) return hit;
    if (depth > 64) return UNRESOLVED; // deep origin chains: let the slow path decide
    updMemo.set(s, IN_PROGRESS);
    let r: LocOf;
    const p = s.parent as unknown;
    const left = s.origin ? locOfId(s.origin, depth) : null;
    const right = s.rightOrigin ? locOfId(s.rightOrigin, depth) : null;
    if (left === MISSING || right === MISSING) r = MISSING;
    else if (left === UNRESOLVED || right === UNRESOLVED) r = UNRESOLVED;
    else if (left === GC_ROOT || right === GC_ROOT) r = GC_ROOT;
    else if (typeof p === 'string') r = { root: p, keys: [s.parentSub], parent: `root:${p}` };
    else if (p && typeof p === 'object' && 'client' in (p as object)) {
      const pid = p as Y.ID;
      const pl = typeLocOfId(pid, depth);
      r = typeof pl === 'symbol' ? pl : { root: pl.root, keys: [...pl.keys, s.parentSub], parent: idKey(pid), parentId: pid };
    } else if (left) r = left; // parent omitted: parent and key of the left origin...
    else if (right) r = right; // ...else of the right origin
    else r = UNRESOLVED; // no parent and no origin: malformed
    // memoised either way (an UNRESOLVED left uncached made origin/rightOrigin cycles
    // exponential: 2^depth calls)
    updMemo.set(s, r);
    return r;
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

  let unresolved = false;
  const newShapeMaps: Y.Item[] = [];
  const typeParents = new Set<string>();
  /** shape maps (parent key) whose `type` a ContentDeleted item at that key overwrites */
  const typeErased = new Map<string, Y.ID | undefined>();
  /** new numbers per `points` Y.Array (parent key) */
  const pointsAdded = new Map<string, { id: Y.ID | undefined; n: number }>();
  for (const s of items) {
    const loc = locOfItem(s, 0);
    if (loc === MISSING) {
      pending = true;
      continue;
    }
    if (loc === UNRESOLVED) {
      unresolved = true;
      continue;
    }
    if (loc === GC_ROOT) continue;
    if (!CLIENT_WRITABLE_ROOTS.has(loc.root)) return { bad: loc.root, writers };
    if (s.content instanceof Y.ContentDeleted) {
      // a deleted item at a map key replaces (= deletes) the value there: same rules as a
      // delete — the key must be one a client may use, and a live shape keeps its `type`
      if (loc.keys.some((k) => k !== null && !keyOk(k))) return { bad: `${loc.root}-schema`, writers };
      if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') typeErased.set(loc.parent, loc.parentId);
      continue;
    }
    const problem = schemaProblem(loc, s.content);
    if (problem) return { bad: problem, writers };
    if (loc.root === ROOT.shapes && loc.keys.length === 1) newShapeMaps.push(s);
    if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') {
      // a new `type` value replaces the old one; deleted in the same update, it leaves none
      if (Y.isDeleted(decoded.ds, s.id)) typeErased.set(loc.parent, loc.parentId);
      else typeParents.add(loc.parent);
    }
    if (loc.root === ROOT.shapes && loc.keys.length === 3 && loc.keys[1] === 'points') {
      const cur = pointsAdded.get(loc.parent) ?? { id: loc.parentId, n: 0 };
      cur.n += s.length;
      pointsAdded.set(loc.parent, cur);
    }
  }
  if (pending) return { bad: 'pending', writers };
  for (const { id, n } of pointsAdded.values()) {
    if (roomArrayLength(id) + n > MAX_POINTS) return { bad: 'shapes-schema', writers };
  }

  const dsHas = (id: Y.ID) => Y.isDeleted(decoded.ds, id);
  for (const [client, ranges] of decoded.ds.clients) {
    const roomClock = Y.getState(doc.store, client);
    for (const r of ranges) {
      // a zero-length range deletes nothing but makes Yjs throw while it re-encodes it
      if (!(r.len > 0)) return { bad: 'malformed', writers };
      for (let clock = r.clock; clock < r.clock + r.len; ) {
        if (clock >= roomClock) {
          // a delete of something the room does not have yet: only fine if the update
          // itself inserts it (checked above); otherwise it would wait as a pending delete
          const it = findFresh(Y.createID(client, clock));
          if (!it) return { bad: 'pending', writers };
          clock = it.id.clock + it.length;
          continue;
        }
        let item: Y.Item | Y.GC;
        try {
          item = Y.getItem(doc.store, Y.createID(client, clock)) as Y.Item | Y.GC;
        } catch {
          return { bad: UNRESOLVED, writers };
        }
        // already-deleted items are a no-op (a full-state update repeats the whole delete set)
        if (item instanceof Y.Item && !item.deleted) {
          const loc = locOfRoomItem(item);
          if (loc === UNRESOLVED) return { bad: UNRESOLVED, writers };
          if (!CLIENT_WRITABLE_ROOTS.has(loc.root)) return { bad: loc.root, writers };
          // deleting the current `type` of a live shape needs a replacement in the same update
          if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') {
            const map = (item.parent as Y.AbstractType<unknown>)._item;
            const current = (item.parent as unknown as { _map: Map<string, Y.Item> })._map.get('type') === item;
            if (map && current && !map.deleted && !dsHas(map.id) && !typeParents.has(loc.parent)) {
              return { bad: 'shapes-schema', writers };
            }
          }
        }
        clock = item.id.clock + item.length;
      }
    }
  }
  // a `type` overwritten by a deleted item: refused unless the shape itself goes away in this
  // update; with a live replacement in the same update the winner depends on the order the
  // items integrate in, so the slow path looks at the result
  for (const [parent, mapId] of typeErased) {
    if (mapId && dsHas(mapId)) continue;
    const freshMap = mapId ? findFresh(mapId) : null;
    if (freshMap instanceof Y.Item && freshMap.content instanceof Y.ContentDeleted) continue;
    if (typeParents.has(parent)) {
      unresolved = true;
      continue;
    }
    return { bad: 'shapes-schema', writers };
  }
  // a new shape is a Y.Map with a valid `type` from its first update
  for (const m of newShapeMaps) {
    if (!dsHas(m.id) && !typeParents.has(idKey(m.id))) return { bad: 'shapes-schema', writers };
  }
  return { bad: unresolved ? UNRESOLVED : null, writers };
}

/**
 * Would every struct of the update integrate? Per client in clock order (known structs
 * first: Yjs resolves their dependencies too before it skips them), each once its
 * cross-client dependencies exist in the room or were integrated earlier in this pass.
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
  const ready = (s: Y.Item | Y.GC) => {
    if (!(s instanceof Y.Item)) return true;
    for (const dep of depsOf(s)) {
      if (!dep || dep.client === s.id.client) continue;
      if (dep.clock < Y.getState(doc.store, dep.client)) continue;
      if (dep.clock < (reached.get(dep.client) ?? 0)) continue;
      return false;
    }
    return true;
  };
  let progress = true;
  while (progress) {
    progress = false;
    for (const [client, a] of seq) {
      let i = idx.get(client)!;
      while (i < a.length && ready(a[i])) {
        reached.set(client, Math.max(reached.get(client)!, a[i].id.clock + a[i].length));
        i++;
        progress = true;
      }
      idx.set(client, i);
    }
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
      if (keys[1] === 'text') return content instanceof Y.ContentString || content instanceof Y.ContentFormat ? null : bad;
      if (keys[1] === 'points') return vals && pointsOk(vals) ? null : bad;
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
    fields.set(k, [kind === 'array' ? (fv as Y.Array<unknown>).toArray() : fv, kind]);
  }
  return shapeRecordProblem(fields, requireTerminals) ? 'shapes-schema' : null;
}

/**
 * Slow path: apply the update to a scratch copy of the room and inspect what actually
 * changed. The room holds no pending state (checked by the caller), so the copy is exactly
 * the integrated room; the update must integrate completely on it.
 */
function scratchCheck(doc: Y.Doc, update: Uint8Array): string | null {
  const scratch = new Y.Doc({ gc: doc.gc });
  // materialise the roots first so `tr.changed` keys are these very objects
  const shapes = scratch.getMap<unknown>(ROOT.shapes);
  const assets = scratch.getMap<unknown>(ROOT.assets);
  const meta = scratch.getMap<unknown>(ROOT.meta);
  Y.applyUpdate(scratch, encodeIntegratedState(doc));
  let bad: string | null = null;
  const touchedShapes = new Set<string>();
  const onTr = (tr: Y.Transaction) => {
    for (const [rawType, keys] of tr.changed) {
      const t = rawType as unknown as Y.AbstractType<unknown>;
      const root = rootNameOfType(t, scratch);
      if (root === null || !CLIENT_WRITABLE_ROOTS.has(root)) {
        bad = bad ?? root ?? 'unknown';
        continue;
      }
      if (t === (shapes as unknown)) {
        for (const k of keys) {
          if (k === null) bad = bad ?? 'shapes-schema';
          else touchedShapes.add(k);
        }
      } else if (t === (assets as unknown) || t === (meta as unknown)) {
        const m = t as unknown as Y.Map<unknown>;
        for (const k of keys) {
          if (k === null || !keyOk(k)) {
            bad = bad ?? `${root}-schema`;
            continue;
          }
          const v = m.get(k);
          if (v === undefined) continue;
          const ok = v instanceof Y.AbstractType ? false : root === ROOT.assets ? assetValueOk(v) : metaValueOk(v);
          if (!ok) bad = bad ?? `${root}-schema`;
        }
      } else if (root === ROOT.shapes) {
        const m = findShapeMap(t, shapes as unknown as Y.Map<Y.Map<unknown>>);
        const sid = m?._item?.parentSub;
        if (typeof sid === 'string') touchedShapes.add(sid);
        else bad = bad ?? 'shapes-schema';
      } else {
        bad = bad ?? `${root}-schema`; // nested types under assets/meta
      }
    }
  };
  scratch.on('afterTransaction', onTr);
  let threw = false;
  try {
    Y.applyUpdate(scratch, update);
  } catch {
    threw = true;
  } finally {
    scratch.off('afterTransaction', onTr);
  }
  if (!bad && threw) bad = 'malformed';
  if (!bad) {
    for (const id of touchedShapes) {
      const p = shapeValueProblem(shapes, id);
      if (p) {
        bad = p;
        break;
      }
    }
  }
  const pending = hasPending(scratch);
  scratch.destroy();
  if (bad) return bad;
  if (pending) return 'pending';
  return null;
}

function rootNameOfType(t: Y.AbstractType<unknown> | null, doc: Y.Doc): string | null {
  let cur: Y.AbstractType<unknown> | null = t;
  while (cur && cur._item) cur = cur._item.parent as Y.AbstractType<unknown>;
  if (!cur) return null;
  for (const [name, type] of doc.share) if (type === cur) return name;
  return null;
}
