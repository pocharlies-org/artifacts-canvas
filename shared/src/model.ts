/**
 * The canvas document model: the single source of truth for the Yjs document schema,
 * shared by the client (client/src/model/*) and the server (server/src/*).
 *
 * Root types of the shared Yjs document (see docs/protocol.md §6):
 *   shapes       Y.Map<Y.Map>      one Y.Map per shape, keyed by shape id   (clients write)
 *   assets       Y.Map<string>     image data URLs, keyed by asset id       (clients write)
 *   meta         Y.Map<any>        pageWidth, ...                           (clients write)
 *   attribution  Y.Map<Attribution> keyed by shape id                       (stamper writes)
 *   users        Y.Map<UserInfo>   keyed by user id                         (stamper writes)
 *   history      Y.Array<HistoryEntry>                                      (stamper writes)
 * "Stamper writes" means the server when it announces `attribution: 'server'`, else this client.
 */
export const ROOT = {
  shapes: 'shapes',
  assets: 'assets',
  meta: 'meta',
  attribution: 'attribution',
  users: 'users',
  history: 'history',
} as const;

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
const SHAPE_STRING_FIELDS: ReadonlySet<string> = new Set(['id', 'groupId', 'name', 'assetId', 'color', 'fill', 'dash', 'size', 'font', 'arrowheads']);
export const MAX_COORD = 1e9;
const MAX_FIELD_STRING = 1024;

/**
 * How a shape field is stored: a plain JSON value, or a nested Yjs type. Callers map their
 * own Yjs values to this tag, so this module stays free of a yjs import.
 */
export type ShapeFieldKind = 'value' | 'text' | 'array' | 'map' | 'other';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

function terminalOk(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (!finite(t.x) || !finite(t.y)) return false;
  if (t.bind === undefined || t.bind === null) return true;
  if (typeof t.bind !== 'object' || Array.isArray(t.bind)) return false;
  const b = t.bind as Record<string, unknown>;
  return typeof b.shapeId === 'string' && finite(b.nx) && finite(b.ny);
}

/** A point list value (plain array, or the elements of the `points` Y.Array). */
export function pointsOk(v: unknown): boolean {
  return Array.isArray(v) && v.every((n) => finite(n));
}

/**
 * Problem with one field of a shape (`key` = field name, `v` = value; for a nested Yjs type
 * pass `kind` and, for `array`, its elements as `v`), or null when it is acceptable.
 * Unknown fields are allowed as plain JSON values (forward compatibility), never as Yjs types.
 */
export function shapeFieldProblem(key: string, v: unknown, kind: ShapeFieldKind = 'value'): string | null {
  if (key === 'text') {
    if (kind === 'text') return null;
    return kind === 'value' && typeof v === 'string' ? null : 'text';
  }
  if (key === 'points') {
    if (kind === 'array' || kind === 'value') return pointsOk(v) ? null : 'points';
    return 'points';
  }
  if (kind !== 'value') return key;
  if (key === 'type') return typeof v === 'string' && (SHAPE_TYPES as readonly string[]).includes(v) ? null : 'type';
  if (key === 'geo') return typeof v === 'string' && (GEO_KINDS as readonly string[]).includes(v) ? null : 'geo';
  if (SHAPE_NUMBER_FIELDS.has(key)) return finite(v) ? null : key;
  if (SHAPE_BOOLEAN_FIELDS.has(key)) return typeof v === 'boolean' ? null : key;
  if (SHAPE_STRING_FIELDS.has(key)) return typeof v === 'string' && v.length <= MAX_FIELD_STRING ? null : key;
  if (key === 'start' || key === 'end') return terminalOk(v) ? null : key;
  return null;
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

/** Values a client may store under `assets` (image data URLs) and `meta` (plain JSON). */
export function assetValueOk(v: unknown): boolean {
  return typeof v === 'string';
}
export function metaValueOk(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean', 'object'].includes(typeof v);
}
