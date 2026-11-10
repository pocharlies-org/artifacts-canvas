import * as Y from 'yjs';
import { ROOT } from './model.js';
import { assetValueOk, metaValueOk, pointsOk, shapeFieldProblem, shapeRecordProblem, SHAPE_TYPES } from './model.js';
import type { Attribution, GeoKind, HistoryEntry, HistoryVerb, ShapeFieldKind, ShapeType, UserInfo } from './model.js';

/**
 * Attribution stamper.
 *
 * Watches transactions on a document and, for every transaction whose origin belongs to a
 * known user, writes into the root types `attribution`, `users` and `history`:
 *   - a new shape            -> attribution {createdBy, createdAt, updatedBy, updatedAt} + history "create"
 *   - a changed shape        -> attribution.updatedBy/updatedAt + history "move"/"resize"/... (rate-limited)
 *   - a deleted shape        -> history "delete" (attribution entry removed)
 *
 * It runs on the SERVER (the reference dev server in client/dev uses it) so attribution cannot be
 * forged: the server knows which connection sent each update. When the server announces
 * `attribution: 'client'` (e.g. a plain y-websocket relay in development) the client runs it
 * itself for its own transactions.
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

export function stampTransaction(doc: Y.Doc, tr: Y.Transaction, opts: StamperOptions, memo: StamperMemo) {
  if (tr.origin === STAMP_ORIGIN) return;
  const who = opts.userOf(tr.origin, tr);
  if (!who) return;
  const now = (opts.now ?? Date.now)();
  const shapes = doc.getMap<Y.Map<unknown>>(ROOT.shapes);
  const attribution = doc.getMap<Attribution>(ROOT.attribution);
  const users = doc.getMap<UserInfo>(ROOT.users);
  const history = doc.getArray<HistoryEntry>(ROOT.history);

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

  doc.transact(() => {
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

/** Attach the stamper to a document. Returns a detach function. */
export function attachStamper(doc: Y.Doc, opts: StamperOptions): () => void {
  const memo: StamperMemo = { last: new Map(), touch: new Map() };
  const handler = (tr: Y.Transaction) => stampTransaction(doc, tr, opts, memo);
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}

/**
 * Root types a client may write. Everything else — the stamper-owned roots `attribution`,
 * `users` and `history`, and any root name the schema does not define — is server-only.
 * An allow-list, so a future server-only root is protected without touching the guard.
 */
export const CLIENT_WRITABLE_ROOTS: ReadonlySet<string> = new Set<string>([ROOT.shapes, ROOT.assets, ROOT.meta]);

export interface GuardOptions {
  /**
   * Client id the server's stamper writes with. A client may never send a struct as this
   * client. Defaults to `doc.clientID` (the room document is the stamper's document).
   */
  serverClient?: number;
  /**
   * Called for every client id the update adds new clocks to; return false when that id is
   * someone else's (another connection writes with it). Omitted = every id is allowed.
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
 * Server-side guard (protocol §5.3). Returns null when a client may apply `update` to the
 * room `doc`, else the name of the offending root or a reason:
 *   - `attribution` / `users` / `history` / any unknown root: a write outside the allow-list;
 *   - `pending`: the update would not integrate completely (a clock gap, a dependency the
 *     room does not have, a delete of clocks nobody wrote yet). Yjs would park the rest as
 *     pending state and release it later into whatever root its dependencies resolve to —
 *     e.g. right after a future stamper item — so the room must NEVER hold pending state;
 *   - `server-client`: a struct carrying the server stamper's client id;
 *   - `foreign-client`: new clocks for a client id another connection writes with;
 *   - `overlap` / `malformed`: a struct that only partly overlaps the room state, or an
 *     impossible same-client dependency;
 *   - `shapes-schema` / `assets-schema` / `meta-schema`: a value the document schema does not
 *     allow (only Y.Map shapes with a valid `type`, numeric geometry, string assets, ...);
 *   - `room-pending`: the room itself holds pending state (it must be cleaned first).
 * `doc` is never modified.
 *
 * Fast path: every NEW struct (the room already has the rest; Yjs skips it) is resolved to
 * its parent type. Yjs encodes `parent` only for items without neighbours; an item with a
 * left/right origin travels with `parent === null` and inherits parent and key from that
 * origin, so origins are followed through the room (for clocks it already has) and the
 * update itself. Anything the fast path cannot resolve (origin cycles, very long chains)
 * goes to the slow path: the update is applied to a scratch copy of the room, which must
 * integrate completely, change only client roots, and leave every touched value valid.
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

/** Where an item lives: its root, the map keys from the root down to it, and its parent type. */
interface Loc {
  root: string;
  /** parentSub of every ancestor item from the root down, then the item's own parentSub */
  keys: (string | null)[];
  /** identity of the parent type: `root:<name>` or the id of the item that created it */
  parent: string;
}
type LocOf = Loc | typeof GC_ROOT | typeof UNRESOLVED | typeof MISSING;

/** Content of an Item (Yjs does not export the AbstractContent type). */
type ItemContent = Y.Item['content'];

const idKey = (id: Y.ID) => `${id.client}:${id.clock}`;

function fastCheck(doc: Y.Doc, update: Uint8Array, opts: GuardOptions): { bad: string | null | typeof UNRESOLVED; writers: number[] } {
  const serverClient = opts.serverClient ?? doc.clientID;
  const decoded = Y.decodeUpdate(update);
  const writers: number[] = [];

  // NEW structs (Item / GC) per client, in clock order; fully known ones are skipped by Yjs.
  const fresh = new Map<number, (Y.Item | Y.GC)[]>();
  const items: Y.Item[] = [];
  const next = new Map<number, number>(); // expected next clock per client
  let pending = false;
  for (const s of decoded.structs as (Y.Item | Y.GC | Y.Skip)[]) {
    const client = s.id.client;
    if (client === serverClient) return { bad: 'server-client', writers };
    const known = Y.getState(doc.store, client);
    const end = s.id.clock + s.length;
    const expected = next.get(client);
    if (expected !== undefined && s.id.clock !== expected) pending = true; // not contiguous
    next.set(client, end);
    if (s instanceof Y.Skip) {
      if (end > known) pending = true; // a hole in the new clocks
      continue;
    }
    if (end <= known) continue; // the room has it: Yjs skips it
    // the first new clock must be exactly the room's next clock for this client
    if (s.id.clock < known) return { bad: 'overlap', writers };
    if (s.id.clock > known && expected === undefined) pending = true; // a gap before it
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
        r = { root: name, keys, parent: own._item ? idKey(own._item.id) : `root:${name}` };
      }
      break;
    }
    roomMemo.set(item, r);
    return r;
  };

  const updMemo = new Map<Y.Item, LocOf>();
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
    if (hit !== undefined) return hit;
    if (depth > 64) return UNRESOLVED; // deep origin chains or cycles: let the slow path decide
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
      r = typeof pl === 'symbol' ? pl : { root: pl.root, keys: [...pl.keys, s.parentSub], parent: idKey(pid) };
    } else if (left) r = left; // parent omitted: parent and key of the left origin...
    else if (right) r = right; // ...else of the right origin
    else r = UNRESOLVED; // no parent and no origin: malformed
    if (r !== UNRESOLVED) updMemo.set(s, r);
    return r;
  };

  // Dependencies: Yjs only integrates a struct once its origins/parent exist.
  for (const s of items) {
    for (const dep of [s.origin, s.rightOrigin, (s.parent && typeof s.parent === 'object' && 'client' in s.parent ? (s.parent as Y.ID) : null)]) {
      if (!dep) continue;
      if (dep.client === s.id.client) {
        if (dep.clock >= s.id.clock) return { bad: 'malformed', writers };
        continue; // earlier clock of the same client: the room or this update has it (contiguity)
      }
      if (dep.clock < Y.getState(doc.store, dep.client)) continue;
      if (!findFresh(dep)) pending = true;
    }
  }

  let unresolved = false;
  const newShapeMaps: Y.Item[] = [];
  const typeParents = new Set<string>();
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
    if (s.content instanceof Y.ContentDeleted) continue;
    const problem = schemaProblem(loc, s.content);
    if (problem) return { bad: problem, writers };
    if (loc.root === ROOT.shapes && loc.keys.length === 1) newShapeMaps.push(s);
    if (loc.root === ROOT.shapes && loc.keys.length === 2 && loc.keys[1] === 'type') typeParents.add(loc.parent);
  }
  if (pending) return { bad: 'pending', writers };

  const dsHas = (id: Y.ID) => Y.isDeleted(decoded.ds, id);
  for (const [client, ranges] of decoded.ds.clients) {
    const known = Y.getState(doc.store, client);
    for (const r of ranges) {
      for (let clock = r.clock; clock < r.clock + r.len; ) {
        if (clock >= known) {
          // a delete of something the room does not have yet: only fine if the update
          // itself inserts it (checked above); otherwise it would wait as a pending
          // delete for a future (stamper) item
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
  // a new shape is a Y.Map with a valid `type` from its first update
  for (const m of newShapeMaps) {
    if (!dsHas(m.id) && !typeParents.has(idKey(m.id))) return { bad: 'shapes-schema', writers };
  }
  return { bad: unresolved ? UNRESOLVED : null, writers };
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
      return keys[0] !== null && content instanceof Y.ContentType && content.type instanceof Y.Map ? null : bad;
    }
    if (keys.length === 2) {
      const field = keys[1];
      if (field === null) return bad;
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
    return keys.length === 1 && keys[0] !== null && vals && vals.every(assetValueOk) ? null : 'assets-schema';
  }
  if (root === ROOT.meta) {
    return keys.length === 1 && keys[0] !== null && vals && vals.every(metaValueOk) ? null : 'meta-schema';
  }
  return null;
}

/** Problem with the current value of shape `id` in `shapes`, or null (absent = deleted = fine). */
export function shapeValueProblem(shapes: Y.Map<unknown>, id: string, requireTerminals = false): string | null {
  const v = shapes.get(id);
  if (v === undefined) return null;
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
  scratch.getMap(ROOT.attribution);
  scratch.getMap(ROOT.users);
  scratch.getArray(ROOT.history);
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
          if (k === null) {
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
  try {
    Y.applyUpdate(scratch, update);
  } finally {
    scratch.off('afterTransaction', onTr);
  }
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
