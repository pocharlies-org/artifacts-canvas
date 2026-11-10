/**
 * The canvas document model: the single source of truth for the Yjs document schema,
 * shared by the client (client/src/model/*) and the server (server/src/*).
 *
 * Every room is TWO Yjs documents (two trust domains, see docs/protocol.md §5-§6):
 *
 * CONTENT document — clients write it (raw Yjs updates, guarded by the server):
 *   shapes       Y.Map<Y.Map>      one Y.Map per shape, keyed by shape id
 *   assets       Y.Map<string>     image data URLs, keyed by asset id
 *   meta         Y.Map<any>        pageWidth, ...
 *
 * LEDGER document — only the server's stamper writes it; clients receive it read-only on
 * their own message type (MSG_LEDGER) and the server never applies a client byte to it:
 *   attribution  Y.Map<Attribution> keyed by shape id
 *   users        Y.Map<UserInfo>   keyed by user id
 *   history      Y.Array<HistoryEntry>
 *   writers      Y.Map<string>     Yjs client id (decimal) -> principal that writes with it
 * "The stamper" is the server when it announces `attribution: 'server'`; with 'client'
 * (development against a plain relay) each tab stamps its own, local, ledger.
 */
export const ROOT = {
  shapes: 'shapes',
  assets: 'assets',
  meta: 'meta',
  attribution: 'attribution',
  users: 'users',
  history: 'history',
  writers: 'writers',
} as const;

/** Roots of the content document (the only ones a client may write). */
export const CONTENT_ROOTS: readonly string[] = [ROOT.shapes, ROOT.assets, ROOT.meta];
/** Roots of the ledger document (server-only). */
export const LEDGER_ROOTS: readonly string[] = [ROOT.attribution, ROOT.users, ROOT.history, ROOT.writers];

// Shape and style types of the shared canvas document.
// Every shape is stored in the Yjs document as a Y.Map under the root map `shapes`.
// The plain objects below are read-only views of those maps.

export type ColorName =
  | 'black' | 'grey' | 'violet' | 'pink' | 'blue' | 'light-blue'
  | 'orange' | 'yellow' | 'red' | 'green' | 'light-green' | 'white';

export type Fill = 'none' | 'semi' | 'solid' | 'pattern';
export type Dash = 'solid' | 'dashed' | 'dotted' | 'draw';
export type Size = 's' | 'm' | 'l' | 'xl';
export type Font = 'draw' | 'sans' | 'serif' | 'mono';
export type Arrowheads = 'none' | 'end' | 'both' | 'dot';

/** Allow-lists of the style enums: the server refuses anything else, the client reader
 *  falls back to the default for anything else (a stored value from before the check). */
export const COLOR_NAMES: readonly ColorName[] = [
  'black', 'grey', 'violet', 'pink', 'blue', 'light-blue', 'orange', 'yellow', 'red', 'green', 'light-green', 'white',
];
export const FILLS: readonly Fill[] = ['none', 'semi', 'solid', 'pattern'];
export const DASHES: readonly Dash[] = ['solid', 'dashed', 'dotted', 'draw'];
export const SIZES: readonly Size[] = ['s', 'm', 'l', 'xl'];
export const FONTS: readonly Font[] = ['draw', 'sans', 'serif', 'mono'];
export const ARROWHEADS: readonly Arrowheads[] = ['none', 'end', 'both', 'dot'];
/** Style key -> its allow-list (opacity is a number, checked as one). */
export const STYLE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  color: COLOR_NAMES, fill: FILLS, dash: DASHES, size: SIZES, font: FONTS, arrowheads: ARROWHEADS,
};

export interface Style {
  color: ColorName;
  fill: Fill;
  dash: Dash;
  size: Size;
  font: Font;
  arrowheads: Arrowheads;
  /** 0.1 .. 1 */
  opacity: number;
}

export const STYLE_KEYS: (keyof Style)[] = ['color', 'fill', 'dash', 'size', 'font', 'arrowheads', 'opacity'];

export type GeoKind =
  | 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon' | 'octagon'
  | 'star' | 'rhombus' | 'trapezoid' | 'cloud' | 'heart' | 'oval'
  | 'check-box' | 'x-box' | 'arrow-right' | 'arrow-left' | 'arrow-up' | 'arrow-down';

export const GEO_KINDS: GeoKind[] = [
  'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon',
  'star', 'rhombus', 'trapezoid', 'cloud', 'heart', 'oval',
  'check-box', 'x-box', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down',
];

export type ShapeType = 'draw' | 'line' | 'arrow' | 'text' | 'note' | 'geo' | 'frame' | 'image';

/** One end of a line or arrow. `x,y` is the last known world point; `bind` makes it follow a shape. */
export interface Terminal {
  x: number;
  y: number;
  /** Normalised anchor inside the bound shape's unrotated box (0..1). */
  bind?: { shapeId: string; nx: number; ny: number };
}

export interface ShapeBase extends Style {
  id: string;
  type: ShapeType;
  /** Top-left of the unrotated box, world units (= artifact CSS px). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, around the box centre. */
  rotation: number;
  /** Z order; higher is drawn later. Ties break on id. */
  index: number;
  groupId: string;
  locked: boolean;
}

export interface DrawShape extends ShapeBase {
  type: 'draw';
  /** Flat [x, y, pressure, ...] relative to (x, y), in the original box (ow x oh). */
  points: number[];
  highlight: boolean;
  /** Original box size of `points`; the stroke is scaled by w/ow, h/oh. 0 while drawing. */
  ow: number;
  oh: number;
  done: boolean;
  /** true when the input device reported real pressure (pen). */
  pen: boolean;
}

export interface LineShape extends ShapeBase {
  type: 'line' | 'arrow';
  start: Terminal;
  end: Terminal;
  /** Perpendicular offset of the curve's midpoint, world units. */
  bend: number;
}

export interface TextShape extends ShapeBase {
  type: 'text';
  text: string;
  /** true when the width was set by the user (wraps); false = grows with the text. */
  fixedWidth: boolean;
}

export interface NoteShape extends ShapeBase {
  type: 'note';
  text: string;
}

export interface GeoShape extends ShapeBase {
  type: 'geo';
  geo: GeoKind;
  text: string;
}

export interface FrameShape extends ShapeBase {
  type: 'frame';
  name: string;
}

export interface ImageShape extends ShapeBase {
  type: 'image';
  assetId: string;
}

export type Shape = DrawShape | LineShape | TextShape | NoteShape | GeoShape | FrameShape | ImageShape;

/** Who did what to a shape. Lives in the root map `attribution`, keyed by shape id. */
export interface Attribution {
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  /** when the shape was deleted (absent while it exists); the entry is pruned some time after */
  deletedAt?: number;
}

/** A participant as recorded in the root map `users` (keyed by user id). */
export interface UserInfo {
  name: string;
  anonymous: boolean;
  color?: string;
}

export type HistoryVerb =
  | 'create' | 'move' | 'resize' | 'rotate' | 'edit' | 'style' | 'delete' | 'order' | 'group' | 'lock';

/** One line of the history timeline. Lives in the root array `history`. */
export interface HistoryEntry {
  t: number;
  by: string;
  verb: HistoryVerb;
  shapeId: string;
  shapeType: ShapeType;
  geo?: GeoKind;
  highlight?: boolean;
  /** createdBy of the shape at the time of the change, when it differs from `by`. */
  owner?: string;
}

/** The identity the server sends on connect (see docs/protocol.md §4). */
export interface Identity {
  id: string;
  name: string;
  anonymous: boolean;
  color?: string;
  /** 'server': the server stamps attribution/history/users. 'client': this client must do it. */
  attribution: 'server' | 'client';
  readOnly?: boolean;
}

export const DEFAULT_STYLE: Style = {
  color: 'black',
  fill: 'none',
  dash: 'solid',
  size: 'm',
  font: 'draw',
  arrowheads: 'end',
  opacity: 1,
};

// ---------- minimal shape schema (shared by the server guard and the client reader) ----------

export const SHAPE_TYPES: readonly ShapeType[] = ['draw', 'line', 'arrow', 'text', 'note', 'geo', 'frame', 'image'];

/** Geometry/order fields: finite numbers within ±MAX_COORD. */
export const SHAPE_NUMBER_FIELDS: ReadonlySet<string> = new Set(['x', 'y', 'w', 'h', 'rotation', 'index', 'opacity', 'bend', 'ow', 'oh']);
const SHAPE_BOOLEAN_FIELDS: ReadonlySet<string> = new Set(['locked', 'highlight', 'done', 'pen', 'fixedWidth']);
const SHAPE_STRING_FIELDS: ReadonlySet<string> = new Set(['id', 'groupId', 'name', 'assetId']);
/**
 * Every field the client reader takes from a shape map (anything else is ignored by the
 * client; the server keeps unknown fields only as plain JSON values, for forward
 * compatibility).
 */
export const SHAPE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'index', 'groupId', 'locked',
  'color', 'fill', 'dash', 'size', 'font', 'arrowheads', 'opacity',
  'points', 'highlight', 'ow', 'oh', 'done', 'pen', 'start', 'end', 'bend', 'text', 'fixedWidth', 'geo', 'name', 'assetId',
]);
export const MAX_COORD = 1e9;
const MAX_FIELD_STRING = 1024;
/** Most numbers a `points` list may hold (x, y, pressure triplets: 100 000 samples). */
export const MAX_POINTS = 300_000;
/**
 * Longest text of a shape (UTF-16 code units, the unit of Y.Text.length). The server refuses
 * longer text; the client renders at most this many characters of whatever a document holds.
 */
export const MAX_TEXT_LENGTH = 10_000;
/** Longest map key (shape id, field name, asset id, meta key). */
export const MAX_KEY_LENGTH = 256;
/** Deepest nesting of a plain JSON value (unknown shape fields, meta values). */
const MAX_JSON_DEPTH = 16;

/**
 * Names that are never a key anywhere in the documents (shape ids, field names, asset ids,
 * meta keys, JSON object keys): reading them into a plain object would replace or shadow
 * its prototype (`o['__proto__'] = v` sets the prototype of `o`).
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A key a client may use for a shape id, a shape field, an asset id or a meta key. */
export function keyOk(k: unknown): k is string {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LENGTH && !FORBIDDEN_KEYS.has(k);
}

/**
 * How a shape field is stored: a plain JSON value, or a nested Yjs type. Callers map their
 * own Yjs values to this tag, so this module stays free of a yjs import.
 */
export type ShapeFieldKind = 'value' | 'text' | 'array' | 'map' | 'other';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

/**
 * A plain JSON value as the Yjs decoder builds it: null, boolean, finite number, string,
 * array, or an object whose prototype is Object.prototype (or null) and none of whose keys
 * is forbidden. An object decoded with a `__proto__` key has a DIFFERENT prototype (the
 * decoder assigns `o[key] = v`), which is how a polluted value is told apart.
 */
export function plainJsonOk(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth >= MAX_JSON_DEPTH || typeof v !== 'object') return false;
  if (Array.isArray(v)) return Object.getPrototypeOf(v) === Array.prototype && v.every((x) => plainJsonOk(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return false;
    if (!plainJsonOk((v as Record<string, unknown>)[k], depth + 1)) return false;
  }
  return true;
}

const ownKeysOnly = (v: object, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));

function terminalOk(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  if (!ownKeysOnly(v, ['x', 'y', 'bind'])) return false;
  const t = v as Record<string, unknown>;
  if (!finite(t.x) || !finite(t.y)) return false;
  if (!Object.hasOwn(t, 'bind') || t.bind === undefined || t.bind === null) return true;
  if (typeof t.bind !== 'object' || Array.isArray(t.bind) || Object.getPrototypeOf(t.bind) !== Object.prototype) return false;
  if (!ownKeysOnly(t.bind, ['shapeId', 'nx', 'ny'])) return false;
  const b = t.bind as Record<string, unknown>;
  return typeof b.shapeId === 'string' && b.shapeId.length <= MAX_FIELD_STRING && finite(b.nx) && finite(b.ny);
}

/** A point list value (plain array, or the elements of the `points` Y.Array). */
export function pointsOk(v: unknown): boolean {
  return Array.isArray(v) && v.length <= MAX_POINTS && v.every((n) => finite(n));
}

/**
 * Problem with one field of a shape (`key` = field name, `v` = value; for a nested Yjs type
 * pass `kind` and, for `array`, its elements as `v`), or null when it is acceptable.
 * Unknown fields are allowed as plain JSON values (forward compatibility), never as Yjs
 * types, and never under a forbidden name.
 */
export function shapeFieldProblem(key: string, v: unknown, kind: ShapeFieldKind = 'value'): string | null {
  if (!keyOk(key)) return 'key';
  if (key === 'text') {
    // a Y.Text is passed as its string (or not at all for a new, empty one)
    if (kind === 'text') return v === undefined || (typeof v === 'string' && v.length <= MAX_TEXT_LENGTH) ? null : 'text';
    return kind === 'value' && typeof v === 'string' && v.length <= MAX_TEXT_LENGTH ? null : 'text';
  }
  if (key === 'points') {
    if (kind === 'array' || kind === 'value') return pointsOk(v) ? null : 'points';
    return 'points';
  }
  if (kind !== 'value') return key;
  if (key === 'type') return typeof v === 'string' && (SHAPE_TYPES as readonly string[]).includes(v) ? null : 'type';
  if (key === 'geo') return typeof v === 'string' && (GEO_KINDS as readonly string[]).includes(v) ? null : 'geo';
  const allowed = STYLE_ENUMS[key];
  if (allowed && Object.hasOwn(STYLE_ENUMS, key)) return typeof v === 'string' && allowed.includes(v) ? null : key;
  if (SHAPE_NUMBER_FIELDS.has(key)) return finite(v) ? null : key;
  if (SHAPE_BOOLEAN_FIELDS.has(key)) return typeof v === 'boolean' ? null : key;
  if (SHAPE_STRING_FIELDS.has(key)) return typeof v === 'string' && v.length <= MAX_FIELD_STRING ? null : key;
  if (key === 'start' || key === 'end') return terminalOk(v) ? null : key;
  return plainJsonOk(v) ? null : key;
}

/**
 * Problem with a whole shape record (field -> [value, kind]), or null. `type` is required;
 * with `requireTerminals` (the client reader) lines and arrows also need both terminals,
 * which the renderer reads unconditionally.
 */
export function shapeRecordProblem(fields: Map<string, [unknown, ShapeFieldKind]>, requireTerminals = true): string | null {
  const type = fields.get('type');
  if (!type) return 'type';
  for (const [k, [v, kind]] of fields) {
    const p = shapeFieldProblem(k, v, kind);
    if (p) return p;
  }
  if (requireTerminals && (type[0] === 'line' || type[0] === 'arrow')) {
    if (!fields.has('start')) return 'start';
    if (!fields.has('end')) return 'end';
  }
  return null;
}

/**
 * An asset value: a base64 data URL of a raster image the browser decodes itself, nothing
 * else. Any other string would be rendered as an `<image href>` that every viewer's browser
 * fetches with its cookies — a same-origin URL such as `/oauth2/sign_out` logged every viewer
 * out (fv4 M2) — and SVG could carry its own references.
 */
export const ASSET_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
export function assetValueOk(v: unknown): boolean {
  return typeof v === 'string' && ASSET_DATA_URL.test(v);
}
export function metaValueOk(v: unknown): boolean {
  return v !== undefined && plainJsonOk(v);
}
