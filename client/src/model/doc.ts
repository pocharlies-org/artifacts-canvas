import * as Y from 'yjs';
import { ROOT } from '@pocharlies/artifacts-canvas-shared/model';
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

/** Convert a shape Y.Map into a plain object. */
export function readShape(m: Y.Map<unknown>): Shape {
  const o: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) {
    if (v instanceof Y.Text) o[k] = v.toString();
    else if (v instanceof Y.Array) o[k] = v.toArray();
    else o[k] = v;
  }
  for (const k of STYLE_KEYS) if (o[k] === undefined) o[k] = DEFAULT_STYLE[k];
  o.rotation ??= 0;
  o.groupId ??= '';
  o.locked ??= false;
  o.index ??= 0;
  return o as unknown as Shape;
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
 * Typed wrapper around the Yjs document with per-user undo.
 * Only `shapes` is in the undo scope: undo never touches other people's work,
 * attribution or history.
 */
export class CanvasDoc {
  readonly doc: Y.Doc;
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

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.shapes = doc.getMap(ROOT.shapes);
    this.assets = doc.getMap(ROOT.assets);
    this.meta = doc.getMap(ROOT.meta);
    this.attribution = doc.getMap(ROOT.attribution);
    this.users = doc.getMap(ROOT.users);
    this.history = doc.getArray(ROOT.history);
    this.undoManager = new Y.UndoManager([this.shapes], {
      trackedOrigins: new Set([this.origin]),
      // Gestures are delimited explicitly with stopCapturing(); never merge by time alone
      // across separate gestures, always merge within one gesture.
      captureTimeout: 24 * 3600 * 1000,
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

  undo() {
    this.undoManager.stopCapturing();
    this.undoManager.undo();
  }

  redo() {
    this.undoManager.stopCapturing();
    this.undoManager.redo();
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
    const m = this.shapes.get(id);
    if (!m) return undefined;
    const s = readShape(m);
    this.cache.set(id, s);
    return s;
  }

  has(id: string) {
    return this.shapes.has(id);
  }

  ids(): string[] {
    return Array.from(this.shapes.keys());
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
    for (const id of this.shapes.keys()) m = Math.max(m, (this.shapes.get(id)?.get('index') as number) ?? 0);
    return m;
  }

  minIndex(): number {
    let m = 0;
    let first = true;
    for (const id of this.shapes.keys()) {
      const v = (this.shapes.get(id)?.get('index') as number) ?? 0;
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
    for (const id of this.shapes.keys()) {
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
        if (YTEXT_FIELDS.has(k)) m.set(k, new Y.Text(String(v)));
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
    const m = this.shapes.get(id);
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
          if (a) {
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
  private setText(m: Y.Map<unknown>, next: string) {
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
    const m = this.shapes.get(id);
    if (!m) return;
    this.transact(() => {
      const a = m.get('points') as Y.Array<number> | undefined;
      if (a) a.push(pts);
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

  setAsset(id: string, dataUrl: string) {
    this.transact(() => this.assets.set(id, dataUrl), 'asset');
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
