import type { DrawShape, LineShape, Shape, Size, Terminal } from '../model/types';
import { geoExtras, geoOutline } from './geo';
import {
  type Box, type Pt, boxFromPoints, boxCorners, distToSegment, pointInPolygon, rotate,
  segmentDistance, segmentIntersection, boxesOverlap, boxContains, sub, len, add, mul,
} from './vec';

export const STROKE_WIDTH: Record<Size, number> = { s: 2, m: 3.5, l: 5, xl: 10 };
export const FONT_SIZE: Record<Size, number> = { s: 18, m: 24, l: 36, xl: 44 };
export const NOTE_FONT_SIZE: Record<Size, number> = { s: 14, m: 18, l: 24, xl: 32 };
export const LABEL_FONT_SIZE: Record<Size, number> = { s: 14, m: 18, l: 24, xl: 32 };
export const NOTE_SIZE = 200;
/** Height of a frame's name label, drawn above the frame. */
export const FRAME_LABEL = 22;

export function freehandSize(s: DrawShape): number {
  const base = STROKE_WIDTH[s.size] ?? 3.5;
  return s.highlight ? base * 4.5 + 6 : base * 1.7 + 1;
}

export interface GeomCtx {
  get(id: string): Shape | undefined;
}

/** Points of a freehand stroke in local coordinates (relative to x, y), scaled to w/h. */
export function drawLocalPoints(s: DrawShape): Pt[] {
  const sx = s.ow > 0 ? s.w / s.ow : 1;
  const sy = s.oh > 0 ? s.h / s.oh : 1;
  const out: Pt[] = [];
  const p = s.points;
  for (let i = 0; i + 1 < p.length; i += 3) out.push({ x: p[i] * sx, y: p[i + 1] * sy });
  return out;
}

/** The unrotated local box of a shape (relative to x, y). */
export function localBox(s: Shape): Box {
  if (s.type === 'draw') {
    if (s.ow > 0 || s.done) return { x: 0, y: 0, w: s.w, h: s.h };
    return boxFromPoints(drawLocalPoints(s));
  }
  return { x: 0, y: 0, w: s.w, h: s.h };
}

/** World centre of a box-like shape (rotation pivot). */
export function shapeCenter(s: Shape): Pt {
  const b = localBox(s);
  return { x: s.x + b.x + b.w / 2, y: s.y + b.y + b.h / 2 };
}

export function toWorld(s: Shape, p: Pt): Pt {
  return rotate({ x: s.x + p.x, y: s.y + p.y }, shapeCenter(s), s.rotation);
}

export function toLocal(s: Shape, p: Pt): Pt {
  const q = rotate(p, shapeCenter(s), -s.rotation);
  return { x: q.x - s.x, y: q.y - s.y };
}

// ---------------------------------------------------------------- lines and arrows

export function resolveTerminal(t: Terminal, ctx: GeomCtx): { p: Pt; bound: Shape | null } {
  if (t.bind) {
    const target = ctx.get(t.bind.shapeId);
    if (target && target.type !== 'arrow' && target.type !== 'line') {
      const b = localBox(target);
      return { p: toWorld(target, { x: b.x + t.bind.nx * b.w, y: b.y + t.bind.ny * b.h }), bound: target };
    }
  }
  return { p: { x: t.x, y: t.y }, bound: null };
}

/** World outline (closed polygon) used to clip arrows to a bound shape's edge. */
function clipPolygon(s: Shape): Pt[] {
  const b = localBox(s);
  let local: Pt[];
  if (s.type === 'geo') local = geoOutline(s.geo, s.w, s.h);
  else if (s.type === 'frame') local = boxCorners({ x: 0, y: -FRAME_LABEL, w: s.w, h: s.h + FRAME_LABEL });
  else local = boxCorners(b);
  return local.map((p) => toWorld(s, p));
}

function clipToShape(from: Pt, to: Pt, s: Shape, gap: number): Pt {
  const poly = clipPolygon(s);
  if (pointInPolygon(from, poly)) return to;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const hit = segmentIntersection(from, to, poly[i], poly[(i + 1) % poly.length]);
    if (hit) {
      const d = Math.hypot(hit.x - from.x, hit.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = hit;
      }
    }
  }
  if (!best) return to;
  const dir = sub(from, best);
  const l = len(dir);
  return l > gap ? add(best, mul(dir, gap / l)) : best;
}

export interface LineGeom {
  a: Pt;
  b: Pt;
  /** Quadratic control point (equal to the midpoint when straight). */
  c: Pt;
  /** Sampled points along the line/curve. */
  pts: Pt[];
}

export function lineGeometry(s: LineShape, ctx: GeomCtx): LineGeom {
  const ra = resolveTerminal(s.start, ctx);
  const rb = resolveTerminal(s.end, ctx);
  let a = ra.p;
  let b = rb.p;
  const gap = s.type === 'arrow' ? 4 : 0;
  if (rb.bound && ra.bound !== rb.bound) b = clipToShape(a, b, rb.bound, gap);
  if (ra.bound && ra.bound !== rb.bound) a = clipToShape(b, a, ra.bound, gap);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const d = sub(b, a);
  const l = len(d) || 1;
  const normal = { x: -d.y / l, y: d.x / l };
  // control point so that the curve passes through mid + normal*bend
  const c = add(mid, mul(normal, (s.bend || 0) * 2));
  const pts: Pt[] = [];
  if (!s.bend) pts.push(a, b);
  else {
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const it = 1 - t;
      pts.push({ x: it * it * a.x + 2 * it * t * c.x + t * t * b.x, y: it * it * a.y + 2 * it * t * c.y + t * t * b.y });
    }
  }
  return { a, b, c, pts };
}

/** Midpoint of the (possibly bent) line: the bend handle position. */
export function lineMidpoint(g: LineGeom): Pt {
  return { x: 0.25 * g.a.x + 0.5 * g.c.x + 0.25 * g.b.x, y: 0.25 * g.a.y + 0.5 * g.c.y + 0.25 * g.b.y };
}

// ---------------------------------------------------------------- outlines and bounds

export interface Outline {
  /** Polylines in world coordinates. */
  lines: Pt[][];
  /** Closed polygons in world coordinates (for inside tests). */
  polys: Pt[][];
  /** Extra hit tolerance (half stroke width). */
  pad: number;
}

export function worldOutline(s: Shape, ctx: GeomCtx): Outline {
  const sw = STROKE_WIDTH[s.size] ?? 3.5;
  switch (s.type) {
    case 'draw': {
      const pts = drawLocalPoints(s).map((p) => toWorld(s, p));
      return { lines: [pts], polys: [], pad: freehandSize(s) / 2 };
    }
    case 'line':
    case 'arrow': {
      const g = lineGeometry(s, ctx);
      return { lines: [g.pts], polys: [], pad: sw / 2 };
    }
    case 'geo': {
      const poly = geoOutline(s.geo, s.w, s.h).map((p) => toWorld(s, p));
      const extras = geoExtras(s.geo, s.w, s.h).map((l) => l.map((p) => toWorld(s, p)));
      return { lines: [[...poly, poly[0]], ...extras], polys: [poly], pad: sw / 2 };
    }
    case 'frame': {
      const poly = boxCorners({ x: 0, y: 0, w: s.w, h: s.h }).map((p) => toWorld(s, p));
      return { lines: [[...poly, poly[0]]], polys: [poly], pad: 1 };
    }
    default: {
      const poly = boxCorners(localBox(s)).map((p) => toWorld(s, p));
      return { lines: [[...poly, poly[0]]], polys: [poly], pad: 0 };
    }
  }
}

const boundsCache = new WeakMap<Shape, Box>();

/** World AABB. Cached per shape object (shapes are immutable views; a change creates a new one). */
export function shapeBounds(s: Shape, ctx: GeomCtx): Box {
  if (s.type === 'line' || s.type === 'arrow') return computeBounds(s, ctx);
  let b = boundsCache.get(s);
  if (!b) boundsCache.set(s, (b = computeBounds(s, ctx)));
  return b;
}

function computeBounds(s: Shape, ctx: GeomCtx): Box {
  if (s.type === 'line' || s.type === 'arrow') {
    const g = lineGeometry(s, ctx);
    return boxFromPoints(g.pts);
  }
  if (s.type === 'draw') {
    const pts = drawLocalPoints(s).map((p) => toWorld(s, p));
    const b = boxFromPoints(pts);
    const r = freehandSize(s) / 2;
    return { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
  }
  const corners = boxCorners(localBox(s)).map((p) => toWorld(s, p));
  const b = boxFromPoints(corners);
  if (s.type === 'frame') return { x: b.x, y: b.y - FRAME_LABEL, w: b.w, h: b.h + FRAME_LABEL };
  return b;
}

/** The rotated box of a shape, as 4 world corners (selection outline). */
export function shapeCorners(s: Shape, ctx: GeomCtx): Pt[] {
  if (s.type === 'line' || s.type === 'arrow' || s.type === 'draw') return boxCorners(shapeBounds(s, ctx));
  return boxCorners(localBox(s)).map((p) => toWorld(s, p));
}

// ---------------------------------------------------------------- hit testing

export type HitMode = 'select' | 'erase';

export function hitTest(s: Shape, p: Pt, tol: number, ctx: GeomCtx, mode: HitMode = 'select'): boolean {
  const bb = shapeBounds(s, ctx);
  if (p.x < bb.x - tol || p.y < bb.y - tol || p.x > bb.x + bb.w + tol || p.y > bb.y + bb.h + tol) return false;
  if (s.type === 'frame') {
    // the name label above the frame, or its border
    const lp = toLocal(s, p);
    if (lp.y < 0 && lp.y >= -FRAME_LABEL && lp.x >= 0 && lp.x <= Math.max(80, s.w * 0.6)) return true;
  }
  const o = worldOutline(s, ctx);
  for (const line of o.lines) {
    if (line.length === 1 && Math.hypot(p.x - line[0].x, p.y - line[0].y) <= tol + o.pad) return true;
    for (let i = 0; i + 1 < line.length; i++) {
      if (distToSegment(p, line[i], line[i + 1]) <= tol + o.pad) return true;
    }
  }
  const insideCounts =
    s.type === 'note' || s.type === 'text' || s.type === 'image' ||
    (s.type === 'geo' && (mode === 'select' || s.fill !== 'none' || !!s.text));
  if (insideCounts) for (const poly of o.polys) if (pointInPolygon(p, poly)) return true;
  return false;
}

/** Does the segment a-b (an eraser stroke) touch the shape? */
export function segmentHits(s: Shape, a: Pt, b: Pt, tol: number, ctx: GeomCtx): boolean {
  const bb = shapeBounds(s, ctx);
  const sb = boxFromPoints([a, b]);
  if (!boxesOverlap({ x: bb.x - tol, y: bb.y - tol, w: bb.w + 2 * tol, h: bb.h + 2 * tol }, sb)) return false;
  if (hitTest(s, b, tol, ctx, 'erase')) return true;
  const o = worldOutline(s, ctx);
  for (const line of o.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (segmentDistance(a, b, line[i], line[i + 1]) <= tol + o.pad) return true;
    }
  }
  return false;
}

/** Marquee selection: the shape is inside the box, or its outline crosses the box edges. */
export function marqueeHits(s: Shape, box: Box, ctx: GeomCtx): boolean {
  const bb = shapeBounds(s, ctx);
  if (!boxesOverlap(bb, box)) return false;
  if (boxContains(box, bb)) return true;
  const edges = boxCorners(box);
  const o = worldOutline(s, ctx);
  for (const line of o.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      for (let e = 0; e < 4; e++) {
        if (segmentDistance(line[i], line[i + 1], edges[e], edges[(e + 1) % 4]) === 0) return true;
      }
      if (line[i].x >= box.x && line[i].x <= box.x + box.w && line[i].y >= box.y && line[i].y <= box.y + box.h) return true;
    }
  }
  return false;
}

/** Top-most shape under p, honouring hidden authors. `shapes` must be in paint order. */
export function topShapeAt(shapes: Shape[], p: Pt, tol: number, ctx: GeomCtx, skip?: (s: Shape) => boolean): Shape | null {
  // two passes: filled/solid hits first so a shape drawn on top of a hollow one wins
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (skip?.(s)) continue;
    if (hitTest(s, p, tol, ctx)) return s;
  }
  return null;
}

/** Normalise a finished freehand stroke: shift points so the box starts at 0,0. */
export function normaliseDraw(s: DrawShape): { x: number; y: number; w: number; h: number; ow: number; oh: number; points: number[] } {
  const pts = s.points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxX = Math.max(maxX, pts[i]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  if (!isFinite(minX)) return { x: s.x, y: s.y, w: 1, h: 1, ow: 1, oh: 1, points: pts };
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) out.push(round2(pts[i] - minX), round2(pts[i + 1] - minY), pts[i + 2] ?? 0.5);
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  return { x: s.x + minX, y: s.y + minY, w, h, ow: w, oh: h, points: out };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
