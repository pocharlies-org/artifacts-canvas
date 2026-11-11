import * as Y from 'yjs';
import {
  MAX_TEXT_LENGTH, ROOT, SHAPE_FIELDS, STYLE_ENUMS, assetValueOk, keyOk, shapeFieldProblem, shapeRecordProblem, type ShapeFieldKind,
} from '@pocharlies/artifacts-canvas-shared/model';
import {
  DEFAULT_STYLE, STYLE_KEYS,
  type Attribution, type HistoryEntry, type Shape, type ShapeType, type Style, type UserInfo,
} from './types';

// The root names are defined once, in @pocharlies/artifacts-canvas-shared/model
// (see docs/protocol.md §6); re-exported here for the client's historical paths.
export { ROOT };

/** Fields kept as nested Y types instead of plain values. */
const YTEXT_FIELDS = new Set(['text']);
const YARRAY_FIELDS = new Set(['points']);

let idCounter = 0;
export function newId(prefix = 's'): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${rnd}${idCounter.toString(36)}`;
}

export type ShapeInit = Partial<Shape> & { type: ShapeType };

/**
 * Convert a shape Y.Map into a plain object, or null when the entry is malformed (not a
 * Y.Map, no valid `type`, a non-numeric geometry field, a line without terminals, ...).
 * The server refuses such writes; this keeps a document that already holds one (or a
 * development relay) usable: the bad entry is skipped and every good shape still renders.
 * `key` is the entry's key in `shapes`, which is the shape id whatever the map says.
 *
 * The object is built from an allow-list of known fields on a null-prototype object:
 * unknown fields (`__proto__` included) are never read, so nothing stored in the document
 * can give the shape a prototype or shadow a field. A style value outside its allow-list
 * (stored before the server checked enums) falls back to the default instead of reaching
 * the renderer; terminals are rebuilt as clean {x, y, bind?} objects.
 */
export function readShape(m: unknown, key?: string): Shape | null {
  if (!(m instanceof Y.Map)) return null;
  if (key !== undefined && !keyOk(key)) return null;
  const o: Record<string, unknown> = Object.create(null);
  const fields = new Map<string, [unknown, ShapeFieldKind]>();
  for (const [k, v] of (m as Y.Map<unknown>).entries()) {
    if (!SHAPE_FIELDS.has(k)) continue;
    if (v instanceof Y.Text) {
      // at most MAX_TEXT_LENGTH characters reach the renderer (the server refuses more; a
      // longer text stored before that limit is shown truncated, still selectable/deletable)
      o[k] = v.toString().slice(0, MAX_TEXT_LENGTH);
      fields.set(k, [o[k], 'text']);
    } else if (v instanceof Y.Array) {
      o[k] = v.toArray();
      fields.set(k, [o[k], 'array']);
    } else if (v instanceof Y.AbstractType) {
      fields.set(k, [v, v instanceof Y.Map ? 'map' : 'other']);
    } else {
      // an invalid style enum (or opacity) is dropped: the default applies below
      if ((Object.hasOwn(STYLE_ENUMS, k) || k === 'opacity') && shapeFieldProblem(k, v)) continue;
      const val = k === 'text' && typeof v === 'string' ? v.slice(0, MAX_TEXT_LENGTH) : v;
      o[k] = k === 'start' || k === 'end' ? cleanTerminal(val) : val;
      fields.set(k, [val, 'value']);
    }
  }
  if (shapeRecordProblem(fields, true)) return null;
  if (key !== undefined) o.id = key;
  else if (typeof o.id !== 'string') return null;
  for (const k of STYLE_KEYS) if (o[k] === undefined) o[k] = DEFAULT_STYLE[k];
  o.x ??= 0;
  o.y ??= 0;
  o.w ??= 0;
  o.h ??= 0;
  o.rotation ??= 0;
  o.groupId ??= '';
  o.locked ??= false;
  o.index ??= 0;
  if (o.type === 'draw') {
    o.points ??= [];
    o.ow ??= 0;
    o.oh ??= 0;
  }
  if (o.type === 'text' || o.type === 'note' || o.type === 'geo') o.text ??= '';
  if (o.type === 'geo') o.geo ??= 'rectangle';
  if (o.type === 'frame') o.name ??= '';
  if (o.type === 'image') o.assetId ??= '';
  return o as unknown as Shape;
}

/** A validated terminal value rebuilt from its own fields only (no inherited properties). */
function cleanTerminal(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const t = v as Record<string, unknown>;
  const out: Record<string, unknown> = { x: t.x, y: t.y };
  const b = Object.hasOwn(t, 'bind') ? (t.bind as Record<string, unknown> | null | undefined) : undefined;
  if (b && typeof b === 'object') out.bind = { shapeId: b.shapeId, nx: b.nx, ny: b.ny };
  return out;
}

/** The shape Y.Map at `id`, or undefined when absent or not a Y.Map. */
function shapeMapOf(shapes: Y.Map<Y.Map<unknown>>, id: string): Y.Map<unknown> | undefined {
  const m = shapes.get(id) as unknown;
  return m instanceof Y.Map ? (m as Y.Map<unknown>) : undefined;
}

export interface ChangeSet {
  /** Shape ids added, updated or removed in this batch. */
  shapes: Set<string>;
  /** Attribution keys (shape ids) that changed. */
  attribution: Set<string> | false;
  users: boolean;
  history: boolean;
  assets: boolean;
  meta: boolean;
}

/**
 * Typed wrapper around the room's two Yjs documents with per-user undo:
 *   doc     the CONTENT document (shapes, assets, meta) — this tab writes it;
 *   ledger  the LEDGER document (attribution, users, history) — read-only here: the server
 *           stamps it and sends it on its own message type (a dev tab against a plain relay
 *           stamps a local one, see Editor.setIdentity).
 * Only `shapes` is in the undo scope: undo never touches other people's work,
 * attribution or history.
 */
export class CanvasDoc {
  readonly doc: Y.Doc;
  readonly ledger: Y.Doc;
  readonly shapes: Y.Map<Y.Map<unknown>>;
  readonly assets: Y.Map<string>;
  readonly meta: Y.Map<unknown>;
  readonly attribution: Y.Map<Attribution>;
  readonly users: Y.Map<UserInfo>;
  readonly history: Y.Array<HistoryEntry>;
  /** Origin of every local edit; the UndoManager tracks only this origin. */
  readonly origin = { local: true };
  readonly undoManager: Y.UndoManager;
  private cache = new Map<string, Shape>();
  private listeners = new Set<(c: ChangeSet) => void>();

  constructor(doc: Y.Doc = new Y.Doc(), ledger: Y.Doc = new Y.Doc()) {
    if (doc === ledger) throw new Error('CanvasDoc: the ledger must be a separate Y.Doc');
    this.doc = doc;
    this.ledger = ledger;
    this.shapes = doc.getMap(ROOT.shapes);
    this.assets = doc.getMap(ROOT.assets);
    this.meta = doc.getMap(ROOT.meta);
    this.attribution = ledger.getMap(ROOT.attribution);
    this.users = ledger.getMap(ROOT.users);
    this.history = ledger.getArray(ROOT.history);
    this.undoManager = new Y.UndoManager([this.shapes], {
      trackedOrigins: new Set([this.origin]),
      // Gestures are delimited explicitly with stopCapturing(); never merge by time alone
      // across separate gestures, always merge within one gesture.
      captureTimeout: 24 * 3600 * 1000,
    });
    // fv5 (found by the honest-edit fuzzer): Yjs' undo/redo can create an item whose left
    // origin equals its right origin; documents then place it differently depending on how
    // their items happen to be merged (the room, loaded from storage, diverged from the tabs).
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === this.undoManager) fixSelfOrigins(tr);
    });

    this.shapes.observeDeep((events) => {
      const ids = new Set<string>();
      for (const e of events) {
        if (e.target === this.shapes) {
          for (const k of (e as Y.YMapEvent<unknown>).keysChanged) ids.add(k);
        } else {
          const key = e.path[0];
          if (typeof key === 'string') ids.add(key);
          else {
            // event on a shape map itself: path is empty, find its key
            const item = (e.target as Y.AbstractType<unknown>)._item;
            if (item && typeof item.parentSub === 'string') ids.add(item.parentSub);
          }
        }
      }
      for (const id of ids) this.cache.delete(id);
      this.emit({ shapes: ids, attribution: false, users: false, history: false, assets: false, meta: false });
    });
    this.attribution.observe((e) => this.emit({ ...this.flag('users'), users: false, attribution: new Set(e.keysChanged) }));
    this.users.observe(() => this.emit(this.flag('users')));
    this.history.observe(() => this.emit(this.flag('history')));
    this.assets.observe(() => this.emit(this.flag('assets')));
    this.meta.observe(() => this.emit(this.flag('meta')));
  }

  private flag(k: Exclude<keyof ChangeSet, 'shapes' | 'attribution'>): ChangeSet {
    return { shapes: new Set(), attribution: false, users: false, history: false, assets: false, meta: false, [k]: true };
  }

  private emit(c: ChangeSet) {
    for (const l of this.listeners) l(c);
  }

  onChange(fn: (c: ChangeSet) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  transact<T>(fn: () => T, origin: unknown = this.origin): T {
    let out!: T;
    this.doc.transact(() => {
      out = fn();
    }, origin);
    return out;
  }

  /** End the current undo step; the next local edit starts a new one. */
  endGesture() {
    this.undoManager.stopCapturing();
  }

  /**
   * Undo / redo one step. Yjs' UndoManager can throw while it redoes an item whose
   * neighbours a concurrent edit split or removed (fv6 L-B: `TypeError: Cannot read
   * properties of undefined (reading 'client')` in getItemCleanStart, ~1 in 30 000 random
   * concurrent operations). The throw happens inside Yjs' own transaction, which still
   * commits what it did and runs the afterTransaction handlers (fixSelfOrigins included), so
   * every document stays consistent; only that undo step is lost (it was popped). The throw
   * never reaches the UI: the step is reported as not done.
   */
  undo(): boolean {
    this.undoManager.stopCapturing();
    return this.safeStep(() => this.undoManager.undo(), 'undo');
  }

  redo(): boolean {
    this.undoManager.stopCapturing();
    return this.safeStep(() => this.undoManager.redo(), 'redo');
  }

  /** Steps that threw inside Yjs (fv6 L-B), for tests and diagnostics. */
  undoErrors = 0;

  private safeStep(step: () => unknown, what: string): boolean {
    try {
      return step() !== null;
    } catch (err) {
      this.undoErrors++;
      console.warn(`canvas: ${what} step dropped (Yjs threw):`, err);
      return false;
    }
  }

  canUndo() {
    return this.undoManager.canUndo();
  }

  canRedo() {
    return this.undoManager.canRedo();
  }

  // ---------- reads ----------

  get(id: string): Shape | undefined {
    const c = this.cache.get(id);
    if (c) return c;
    const s = readShape(this.shapes.get(id), id);
    if (!s) return undefined;
    this.cache.set(id, s);
    return s;
  }

  /** True for a readable shape (malformed entries are invisible, see readShape). */
  has(id: string) {
    return this.get(id) !== undefined;
  }

  ids(): string[] {
    return Array.from(this.shapes.keys()).filter((id) => this.get(id) !== undefined);
  }

  /** All shapes in paint order. */
  all(): Shape[] {
    const out: Shape[] = [];
    for (const id of this.shapes.keys()) {
      const s = this.get(id);
      if (s) out.push(s);
    }
    return out.sort(compareOrder);
  }

  maxIndex(): number {
    let m = 0;
    for (const id of this.shapes.keys()) m = Math.max(m, this.get(id)?.index ?? 0);
    return m;
  }

  minIndex(): number {
    let m = 0;
    let first = true;
    for (const id of this.shapes.keys()) {
      const s = this.get(id);
      if (!s) continue;
      const v = s.index;
      m = first ? v : Math.min(m, v);
      first = false;
    }
    return m;
  }

  attributionOf(id: string): Attribution | undefined {
    return this.attribution.get(id);
  }

  user(id: string): UserInfo | undefined {
    return this.users.get(id);
  }

  historyEntries(): HistoryEntry[] {
    return this.history.toArray();
  }

  /** Shape count per createdBy. */
  countsByAuthor(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.ids()) {
      const a = this.attribution.get(id);
      const by = a?.createdBy ?? '';
      out.set(by, (out.get(by) ?? 0) + 1);
    }
    return out;
  }

  // ---------- writes (local, undoable) ----------

  create(init: ShapeInit): string {
    const id = init.id ?? newId();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      const base: Record<string, unknown> = {
        x: 0, y: 0, w: 0, h: 0, rotation: 0, groupId: '', locked: false,
        ...DEFAULT_STYLE,
        index: this.maxIndex() + 1,
        ...init,
        id,
      };
      for (const [k, v] of Object.entries(base)) {
        if (v === undefined) continue;
        if (YTEXT_FIELDS.has(k)) m.set(k, new Y.Text(String(v).slice(0, MAX_TEXT_LENGTH)));
        else if (YARRAY_FIELDS.has(k)) {
          const a = new Y.Array<number>();
          a.push(v as number[]);
          m.set(k, a);
        } else m.set(k, structuredCloneSafe(v));
      }
      this.shapes.set(id, m);
    });
    return id;
  }

  update(id: string, patch: Partial<Shape> | Record<string, unknown>) {
    const m = shapeMapOf(this.shapes, id);
    if (!m) return;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || v === undefined) continue;
        if (YTEXT_FIELDS.has(k)) {
          this.setText(m, String(v));
          continue;
        }
        if (YARRAY_FIELDS.has(k)) {
          const a = m.get(k) as Y.Array<number> | undefined;
          if (a instanceof Y.Array) {
            a.delete(0, a.length);
            a.push(v as number[]);
          } else {
            const na = new Y.Array<number>();
            na.push(v as number[]);
            m.set(k, na);
          }
          continue;
        }
        const cur = m.get(k);
        if (!sameValue(cur, v)) m.set(k, structuredCloneSafe(v));
      }
    });
  }

  updateMany(patches: Map<string, Partial<Shape> | Record<string, unknown>>) {
    this.transact(() => {
      for (const [id, p] of patches) this.update(id, p);
    });
  }

  /** Minimal-diff update of a Y.Text so concurrent typing merges. */
  private setText(m: Y.Map<unknown>, nextIn: string) {
    // never more than the server accepts (fv5 M-3): it would close the connection
    let next = nextIn;
    if (next.length > MAX_TEXT_LENGTH) {
      const c = next.charCodeAt(MAX_TEXT_LENGTH - 1);
      next = next.slice(0, c >= 0xd800 && c <= 0xdbff ? MAX_TEXT_LENGTH - 1 : MAX_TEXT_LENGTH);
    }
    let t = m.get('text') as Y.Text | undefined;
    if (!(t instanceof Y.Text)) {
      t = new Y.Text();
      m.set('text', t);
    }
    const prev = t.toString();
    if (prev === next) return;
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length;
    let endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--;
      endNext--;
    }
    if (endPrev > start) t.delete(start, endPrev - start);
    if (endNext > start) t.insert(start, next.slice(start, endNext));
  }

  appendPoints(id: string, pts: number[]) {
    const m = shapeMapOf(this.shapes, id);
    if (!m) return;
    this.transact(() => {
      const a = m.get('points');
      if (a instanceof Y.Array) (a as Y.Array<number>).push(pts);
    });
  }

  delete(ids: Iterable<string>) {
    const set = new Set(ids);
    if (!set.size) return;
    this.transact(() => {
      // Arrows bound to deleted shapes keep their last position, unbound.
      for (const sid of this.shapes.keys()) {
        if (set.has(sid)) continue;
        const s = this.get(sid);
        if (!s || (s.type !== 'arrow' && s.type !== 'line')) continue;
        const patch: Record<string, unknown> = {};
        if (s.start.bind && set.has(s.start.bind.shapeId)) patch.start = { x: s.start.x, y: s.start.y };
        if (s.end.bind && set.has(s.end.bind.shapeId)) patch.end = { x: s.end.x, y: s.end.y };
        if (Object.keys(patch).length) this.update(sid, patch);
      }
      for (const id of set) this.shapes.delete(id);
    });
  }

  setStyle(ids: string[], style: Partial<Style>) {
    this.transact(() => {
      for (const id of ids) this.update(id, style);
    });
  }

  bringToFront(ids: string[]) {
    let top = this.maxIndex();
    const sorted = ids.map((id) => this.get(id)).filter(Boolean).sort((a, b) => compareOrder(a!, b!));
    this.transact(() => {
      for (const s of sorted) this.update(s!.id, { index: ++top });
    });
  }

  sendToBack(ids: string[]) {
    let bottom = this.minIndex();
    const sorted = ids.map((id) => this.get(id)).filter(Boolean).sort((a, b) => compareOrder(b!, a!));
    this.transact(() => {
      for (const s of sorted) this.update(s!.id, { index: --bottom });
    });
  }

  group(ids: string[]): string {
    const gid = newId('g');
    this.transact(() => {
      for (const id of ids) this.update(id, { groupId: gid });
    });
    return gid;
  }

  ungroup(ids: string[]) {
    this.transact(() => {
      for (const id of ids) this.update(id, { groupId: '' });
    });
  }

  setLocked(ids: string[], locked: boolean) {
    this.transact(() => {
      for (const id of ids) this.update(id, { locked });
    });
  }

  /** All ids sharing a group with any of `ids`. */
  expandGroups(ids: Iterable<string>): string[] {
    const out = new Set<string>(ids);
    const groups = new Set<string>();
    for (const id of out) {
      const g = this.get(id)?.groupId;
      if (g) groups.add(g);
    }
    if (groups.size) {
      for (const id of this.shapes.keys()) {
        const g = this.get(id)?.groupId;
        if (g && groups.has(g)) out.add(id);
      }
    }
    return Array.from(out);
  }

  /** Store an image asset; only raster data URLs (assetValueOk, what the server accepts). */
  setAsset(id: string, dataUrl: string): boolean {
    if (!assetValueOk(dataUrl)) return false;
    this.transact(() => this.assets.set(id, dataUrl), 'asset');
    return true;
  }

  pageWidth(fallback: number): number {
    const w = this.meta.get('pageWidth');
    return typeof w === 'number' && w > 0 ? w : fallback;
  }

  ensurePageWidth(w: number) {
    if (this.meta.get('pageWidth') === undefined) this.transact(() => this.meta.set('pageWidth', w), 'meta');
  }
}

export function compareOrder(a: Shape, b: Shape): number {
  const la = layerOf(a);
  const lb = layerOf(b);
  if (la !== lb) return la - lb;
  if (a.index !== b.index) return a.index - b.index;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Frames paint first, then highlighter strokes, then everything else. */
export function layerOf(s: Shape): number {
  if (s.type === 'frame') return 0;
  if (s.type === 'draw' && s.highlight) return 1;
  return 2;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function structuredCloneSafe<T>(v: T): T {
  if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
  return v;
}

/**
 * Give every list item an undo/redo transaction created the origins of the place it actually
 * took in this document: its left neighbour's last id and its right neighbour's id, skipping
 * items the same transaction created later (an origin must name an earlier clock). Yjs' redo
 * can write origins that contradict each other — "after X and before X", or a right origin
 * that comes before the left one — and documents then place the item differently depending on
 * how their own items happen to be merged (fv5: the room, loaded from storage, diverged from
 * the tabs). This runs before Yjs encodes the transaction's update, so every other document
 * integrates the item exactly where this one put it. Returns how many items it rewrote.
 */
export function fixSelfOrigins(tr: Y.Transaction): number {
  let fixed = 0;
  const store = tr.doc.store;
  for (const [client, after] of tr.afterState) {
    const before = tr.beforeState.get(client) ?? 0;
    if (after <= before) continue;
    const structs = store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
    if (!structs) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
      const it = structs[i];
      if (!(it instanceof Y.Item) || it.parentSub !== null) continue;
      const later = (x: Y.Item) => x.id.client === client && x.id.clock > it.id.clock;
      let l = it.left;
      while (l && later(l)) l = l.left;
      let r = it.right;
      while (r && later(r)) r = r.right;
      const origin = l ? l.lastId : null;
      const rightOrigin = r ? r.id : null;
      const same = (a: Y.ID | null, b: Y.ID | null) => (a === null ? b === null : b !== null && a.client === b.client && a.clock === b.clock);
      if (same(origin, it.origin) && same(rightOrigin, it.rightOrigin)) continue;
      it.origin = origin;
      it.rightOrigin = rightOrigin;
      fixed++;
    }
  }
  return fixed;
}
