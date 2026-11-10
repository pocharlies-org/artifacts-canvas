import * as Y from 'yjs';
import { ROOT } from './model.js';
import type { Attribution, GeoKind, HistoryEntry, HistoryVerb, ShapeType, UserInfo } from './model.js';

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
      const m = shapes.get(id);
      if (!m) continue;
      const shapeType = m.get('type') as ShapeType;
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

/**
 * Server-side guard (protocol §5.3): a client may only write the client-writable roots.
 * Returns the name of the offending root (or a reason such as `pending`), or null when the
 * update is acceptable. `doc` is the room document the update would be applied to; it is
 * never modified.
 *
 * Fast path: every inserted struct is resolved to its root type. Yjs encodes `parent` only
 * for items without neighbours; an item with a left/right origin travels with
 * `parent === null` and inherits the parent of that origin, so the origin chain is followed
 * through the update itself and the room document. Deletions are resolved through the
 * room document. Anything the fast path cannot resolve (missing dependencies, cycles, a
 * room with pending structs) goes to the slow path: the update is applied to a scratch
 * copy of the room and every root changed by that transaction is checked — plus the update
 * must integrate completely (no pending structs/deletes left behind that a later update
 * could release into a forbidden root).
 */
export function forbiddenRootWrite(doc: Y.Doc, update: Uint8Array): string | null {
  const fast = fastRootCheck(doc, update);
  if (fast !== UNRESOLVED) return fast;
  return scratchRootCheck(doc, update);
}

const UNRESOLVED = Symbol('unresolved');
/** A struct that Yjs integrates as garbage (a neighbour is GC): it writes nothing. */
const GC_ROOT = Symbol('gc');
type RootOf = string | typeof GC_ROOT;

function fastRootCheck(doc: Y.Doc, update: Uint8Array): string | null | typeof UNRESOLVED {
  if (doc.store.pendingStructs || doc.store.pendingDs) return UNRESOLVED;
  const decoded = Y.decodeUpdate(update);
  // structs of the update, per client, sorted by clock (decodeUpdate keeps that order)
  const own = new Map<number, Y.Item[]>();
  for (const s of decoded.structs) {
    if (!(s instanceof Y.Item)) continue;
    let arr = own.get(s.id.client);
    if (!arr) own.set(s.id.client, (arr = []));
    arr.push(s);
  }
  const findOwn = (id: Y.ID): Y.Item | null => {
    const arr = own.get(id.client);
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
  const memo = new Map<Y.Item, RootOf>();

  /** Root of the type that the item/GC at `id` lives in, or UNRESOLVED. */
  const rootOfId = (id: Y.ID, depth: number): RootOf | typeof UNRESOLVED => {
    const inUpdate = findOwn(id);
    if (inUpdate) return rootOfStruct(inUpdate, depth + 1);
    if (id.clock >= Y.getState(doc.store, id.client)) return UNRESOLVED;
    let item: Y.Item | Y.GC;
    try {
      item = Y.getItem(doc.store, id) as Y.Item | Y.GC;
    } catch {
      return UNRESOLVED;
    }
    if (!(item instanceof Y.Item)) return GC_ROOT;
    return rootNameOfType(item.parent as Y.AbstractType<unknown>, doc) ?? UNRESOLVED;
  };

  /** Root of the type the item `s` of the update is inserted into. */
  const rootOfStruct = (s: Y.Item, depth: number): RootOf | typeof UNRESOLVED => {
    const hit = memo.get(s);
    if (hit !== undefined) return hit;
    if (depth > 64) return UNRESOLVED; // deep origin chains or cycles: let the slow path decide
    let r: RootOf | typeof UNRESOLVED;
    const p = s.parent as unknown;
    if (typeof p === 'string') r = p;
    else if (p && typeof p === 'object' && 'client' in (p as object)) {
      // parent = the type created by the item with this id: it lives where that item lives
      const parentItem = findOwn(p as Y.ID);
      if (parentItem) r = rootOfStruct(parentItem, depth + 1);
      else {
        const pid = p as Y.ID;
        if (pid.clock >= Y.getState(doc.store, pid.client)) r = UNRESOLVED;
        else {
          let it: Y.Item | Y.GC;
          try {
            it = Y.getItem(doc.store, pid) as Y.Item | Y.GC;
          } catch {
            it = null as unknown as Y.GC;
          }
          if (!it) r = UNRESOLVED;
          else if (!(it instanceof Y.Item)) r = GC_ROOT;
          else r = rootNameOfType(it.parent as Y.AbstractType<unknown>, doc) ?? UNRESOLVED;
        }
      }
    } else {
      // parent omitted: Yjs takes the parent of the left origin, else of the right origin;
      // if either neighbour is GC the item is integrated as GC.
      const left = s.origin ? rootOfId(s.origin, depth) : null;
      const right = s.rightOrigin ? rootOfId(s.rightOrigin, depth) : null;
      if (left === UNRESOLVED || right === UNRESOLVED) r = UNRESOLVED;
      else if (left === GC_ROOT || right === GC_ROOT) r = GC_ROOT;
      else if (left !== null) r = left;
      else if (right !== null) r = right;
      else r = UNRESOLVED; // no parent and no origin: malformed
    }
    if (r !== UNRESOLVED) memo.set(s, r);
    return r;
  };

  for (const arr of own.values()) {
    for (const s of arr) {
      const r = rootOfStruct(s, 0);
      if (r === UNRESOLVED) return UNRESOLVED;
      if (r !== GC_ROOT && !CLIENT_WRITABLE_ROOTS.has(r)) return r;
    }
  }

  for (const [client, ranges] of decoded.ds.clients) {
    const known = Y.getState(doc.store, client);
    for (const r of ranges) {
      for (let clock = r.clock; clock < r.clock + r.len; ) {
        if (clock >= known) {
          // a delete of something the room does not have yet: only fine if the update
          // itself inserts it (already checked above); otherwise it would wait as a
          // pending delete for a future (stamper) item
          const it = findOwn(Y.createID(client, clock));
          if (!it) return 'pending';
          clock = it.id.clock + it.length;
          continue;
        }
        let item: Y.Item | Y.GC;
        try {
          item = Y.getItem(doc.store, Y.createID(client, clock)) as Y.Item | Y.GC;
        } catch {
          return UNRESOLVED;
        }
        // already-deleted items are a no-op (a full-state update repeats the whole delete set)
        if (item instanceof Y.Item && !item.deleted) {
          const root = rootNameOfType(item.parent as Y.AbstractType<unknown>, doc);
          if (root === null) return UNRESOLVED;
          if (!CLIENT_WRITABLE_ROOTS.has(root)) return root;
        }
        clock = item.id.clock + item.length;
      }
    }
  }
  return null;
}

/** Apply the update to a scratch copy of the room and inspect what actually changed. */
function scratchRootCheck(doc: Y.Doc, update: Uint8Array): string | null {
  const scratch = new Y.Doc({ gc: doc.gc });
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  // pending structs/deletes the room already had are part of the state copied above, so an
  // update that releases them into a forbidden root shows up as a change below
  const hadPending = !!(doc.store.pendingStructs || doc.store.pendingDs);
  let bad: string | null = null;
  const onTr = (tr: Y.Transaction) => {
    for (const t of tr.changed.keys()) {
      const root = rootNameOfType(t as unknown as Y.AbstractType<unknown>, scratch);
      if (root === null || !CLIENT_WRITABLE_ROOTS.has(root)) {
        bad = bad ?? root ?? 'unknown';
      }
    }
  };
  scratch.on('afterTransaction', onTr);
  try {
    Y.applyUpdate(scratch, update);
  } finally {
    scratch.off('afterTransaction', onTr);
  }
  const pending = !!(scratch.store.pendingStructs || scratch.store.pendingDs);
  scratch.destroy();
  if (bad) return bad;
  if (pending && !hadPending) return 'pending';
  return null;
}

function rootNameOfType(t: Y.AbstractType<unknown> | null, doc: Y.Doc): string | null {
  let cur: Y.AbstractType<unknown> | null = t;
  while (cur && cur._item) cur = cur._item.parent as Y.AbstractType<unknown>;
  if (!cur) return null;
  for (const [name, type] of doc.share) if (type === cur) return name;
  return null;
}
