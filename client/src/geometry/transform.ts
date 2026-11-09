import type { LineShape, Shape, Terminal } from '../model/types';
import { type GeomCtx, localBox, shapeCenter } from './shapes';
import { type Box, type Pt, rotate } from './vec';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLE_DIR: Record<Handle, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};

type Patch = Record<string, unknown>;

/** Move shapes by (dx, dy). Line terminals bound to a shape that is not moving get unbound. */
export function translatePatches(shapes: Shape[], dx: number, dy: number, ctx: GeomCtx): Map<string, Patch> {
  const moving = new Set(shapes.map((s) => s.id));
  const out = new Map<string, Patch>();
  for (const s of shapes) {
    if (s.type === 'line' || s.type === 'arrow') {
      out.set(s.id, {
        start: moveTerminal(s.start, dx, dy, moving, ctx),
        end: moveTerminal(s.end, dx, dy, moving, ctx),
      });
    } else {
      out.set(s.id, { x: s.x + dx, y: s.y + dy });
    }
  }
  return out;
}

function moveTerminal(t: Terminal, dx: number, dy: number, moving: Set<string>, ctx: GeomCtx): Terminal {
  if (t.bind && moving.has(t.bind.shapeId)) return t;
  if (t.bind && ctx.get(t.bind.shapeId)) {
    // bound to a shape that stays: keep the binding (the arrow stretches), like tldraw
    return t;
  }
  return { x: t.x + dx, y: t.y + dy };
}

/**
 * Compute the new frame-space box when dragging `handle` to world point p.
 * The box is expressed in a frame rotated by `angle` with origin at the original
 * box's unrotated top-left; returns the new box (unrotated, world units) + flip info.
 */
export function resizeBox(box: Box, angle: number, handle: Handle, p: Pt, keepAspect: boolean, fromCenter = false): Box {
  const [hx, hy] = HANDLE_DIR[handle];
  const c0 = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  // pointer in the unrotated frame of the box
  const q = rotate(p, c0, -angle);
  let x0 = box.x;
  let x1 = box.x + box.w;
  let y0 = box.y;
  let y1 = box.y + box.h;
  if (hx === 1) x1 = q.x;
  if (hx === -1) x0 = q.x;
  if (hy === 1) y1 = q.y;
  if (hy === -1) y0 = q.y;
  if (fromCenter) {
    if (hx !== 0) {
      const half = Math.abs(q.x - c0.x);
      x0 = c0.x - half;
      x1 = c0.x + half;
    }
    if (hy !== 0) {
      const half = Math.abs(q.y - c0.y);
      y0 = c0.y - half;
      y1 = c0.y + half;
    }
  }
  if (keepAspect && box.w > 0 && box.h > 0) {
    const sx = (x1 - x0) / box.w;
    const sy = (y1 - y0) / box.h;
    let s: number;
    if (hx === 0) s = sy;
    else if (hy === 0) s = sx;
    else s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
    const nw = box.w * Math.abs(s);
    const nh = box.h * Math.abs(s);
    if (hx === -1) x0 = x1 - nw * Math.sign(sx || 1);
    else if (hx === 1) x1 = x0 + nw * Math.sign(sx || 1);
    else {
      x0 = c0.x - nw / 2;
      x1 = c0.x + nw / 2;
    }
    if (hy === -1) y0 = y1 - nh * Math.sign(sy || 1);
    else if (hy === 1) y1 = y0 + nh * Math.sign(sy || 1);
    else {
      y0 = c0.y - nh / 2;
      y1 = c0.y + nh / 2;
    }
  }
  const nx0 = Math.min(x0, x1);
  const nx1 = Math.max(x0, x1);
  const ny0 = Math.min(y0, y1);
  const ny1 = Math.max(y0, y1);
  // The new box is in the unrotated frame around c0; re-centre so the opposite corner stays put in world space.
  const nb = { x: nx0, y: ny0, w: Math.max(nx1 - nx0, 1), h: Math.max(ny1 - ny0, 1) };
  if (!angle) return nb;
  const nc = { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 };
  const ncWorld = rotate(nc, c0, angle);
  return { x: ncWorld.x - nb.w / 2, y: ncWorld.y - nb.h / 2, w: nb.w, h: nb.h };
}

/** Resize one shape in its own rotated frame. */
export function resizeSinglePatch(s: Shape, handle: Handle, p: Pt, keepAspect: boolean, fromCenter: boolean): Patch {
  const lb = localBox(s);
  const box = { x: s.x + lb.x, y: s.y + lb.y, w: lb.w, h: lb.h };
  const nb = resizeBox(box, s.rotation, handle, p, keepAspect, fromCenter);
  const patch: Patch = { x: nb.x - lb.x, y: nb.y - lb.y, w: nb.w, h: nb.h };
  if (s.type === 'text') patch.fixedWidth = true;
  if (s.type === 'draw' && !(s.ow > 0)) {
    patch.ow = lb.w || 1;
    patch.oh = lb.h || 1;
  }
  return patch;
}

/** Scale several shapes from box `from` to box `to` (axis aligned). */
export function scalePatches(shapes: Shape[], from: Box, to: Box, ctx: GeomCtx): Map<string, Patch> {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const map = (p: Pt): Pt => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy });
  const moving = new Set(shapes.map((s) => s.id));
  const out = new Map<string, Patch>();
  for (const s of shapes) {
    if (s.type === 'line' || s.type === 'arrow') {
      const t = (term: Terminal): Terminal =>
        term.bind && (moving.has(term.bind.shapeId) || ctx.get(term.bind.shapeId)) ? term : { ...map(term), bind: undefined };
      out.set(s.id, { start: clean(t(s.start)), end: clean(t(s.end)), bend: (s.bend || 0) * Math.sqrt(Math.abs(sx * sy)) });
      continue;
    }
    const c = shapeCenter(s);
    const nc = map(c);
    const lb = localBox(s);
    const w = Math.max(lb.w * Math.abs(sx), 1);
    const h = Math.max(lb.h * Math.abs(sy), 1);
    const patch: Patch = { x: nc.x - w / 2 - lb.x * Math.abs(sx), y: nc.y - h / 2 - lb.y * Math.abs(sy), w, h };
    if (s.type === 'draw' && !(s.ow > 0)) {
      patch.ow = lb.w || 1;
      patch.oh = lb.h || 1;
    }
    if (s.type === 'text') patch.fixedWidth = true;
    out.set(s.id, patch);
  }
  return out;
}

function clean(t: Terminal): Terminal {
  return t.bind ? t : { x: t.x, y: t.y };
}

/** Rotate shapes by `delta` radians around `center`. */
export function rotatePatches(shapes: Shape[], center: Pt, delta: number, ctx: GeomCtx): Map<string, Patch> {
  const moving = new Set(shapes.map((s) => s.id));
  const out = new Map<string, Patch>();
  for (const s of shapes) {
    if (s.type === 'line' || s.type === 'arrow') {
      const t = (term: Terminal): Terminal => {
        if (term.bind && (moving.has(term.bind.shapeId) || ctx.get(term.bind.shapeId))) return term;
        const p = rotate(term, center, delta);
        return { x: p.x, y: p.y };
      };
      out.set(s.id, { start: t(s.start), end: t(s.end) });
      continue;
    }
    const c = shapeCenter(s);
    const nc = rotate(c, center, delta);
    out.set(s.id, { x: s.x + (nc.x - c.x), y: s.y + (nc.y - c.y), rotation: normAngle(s.rotation + delta) });
  }
  return out;
}

export function normAngle(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

/** Shapes whose bounds lie inside a frame (they move with it). */
export function frameChildren(frame: Shape, all: Shape[], boundsOf: (s: Shape) => Box): Shape[] {
  if (frame.type !== 'frame') return [];
  const fb = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  return all.filter((s) => {
    if (s.id === frame.id || s.type === 'frame') return false;
    const b = boundsOf(s);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return cx >= fb.x && cx <= fb.x + fb.w && cy >= fb.y && cy <= fb.y + fb.h;
  });
}

export type { LineShape };
