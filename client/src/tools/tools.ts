import type { Editor } from '../editor/editor';
import type { DrawShape, LineShape, Shape, Terminal } from '../model/types';
import { t } from '../i18n';
import {
  FONT_SIZE, NOTE_SIZE, lineGeometry, lineMidpoint, localBox, marqueeHits, normaliseDraw, segmentHits,
  shapeBounds, toLocal,
} from '../geometry/shapes';
import {
  type Handle, frameChildren, resizeSinglePatch, rotatePatches, scalePatches, translatePatches, resizeBox,
} from '../geometry/transform';
import { type Box, type Pt, boxFrom2, dist, snapAngle, unionBoxes } from '../geometry/vec';
import { layoutText } from '../render/text';

export type ToolId =
  | 'select' | 'hand' | 'draw' | 'highlight' | 'eraser' | 'arrow' | 'line' | 'text' | 'note'
  | 'geo' | 'frame' | 'image' | 'laser';

export interface PointerInfo {
  screen: Pt;
  world: Pt;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  pressure: number;
  pen: boolean;
  button: number;
}

export interface Tool {
  down(p: PointerInfo): void;
  move(p: PointerInfo): void;
  up(p: PointerInfo): void;
  cancel?(): void;
  doubleClick?(p: PointerInfo): void;
}

const DRAG = 3; // screen px before a press becomes a drag

// ------------------------------------------------------------------ helpers

export function nudgeSelection(ed: Editor, dx: number, dy: number) {
  const shapes = ed.selected().filter((s) => !s.locked);
  if (!shapes.length) return;
  ed.doc.updateMany(translatePatches(shapes, dx, dy, ed.renderer.env));
  ed.doc.endGesture();
}

/** The selection box: the rotated box of a single shape, or the union AABB of several. */
export function selectionFrame(ed: Editor): { box: Box; rotation: number; single: Shape | null } | null {
  const sel = ed.selected();
  if (!sel.length) return null;
  if (sel.length === 1 && sel[0].type !== 'line' && sel[0].type !== 'arrow' && !(sel[0].type === 'draw' && !sel[0].done)) {
    const s = sel[0];
    const lb = localBox(s);
    return { box: { x: s.x + lb.x, y: s.y + lb.y, w: lb.w, h: lb.h }, rotation: s.rotation, single: s };
  }
  const box = unionBoxes(sel.map((s) => shapeBounds(s, ed.renderer.env)))!;
  return { box, rotation: 0, single: sel.length === 1 ? sel[0] : null };
}

function arrowTarget(ed: Editor, p: Pt, excludeId?: string): Shape | null {
  return ed.shapeAt(p, (s) => s.id === excludeId || s.type === 'arrow' || s.type === 'line');
}

/** A terminal at p, bound to the shape under it (arrows only). */
export function terminalAt(ed: Editor, p: Pt, bind: boolean, excludeId?: string): Terminal {
  if (!bind) return { x: p.x, y: p.y };
  const target = arrowTarget(ed, p, excludeId);
  if (!target) return { x: p.x, y: p.y };
  const lb = localBox(target);
  const lp = toLocal(target, p);
  let nx = lb.w ? (lp.x - lb.x) / lb.w : 0.5;
  let ny = lb.h ? (lp.y - lb.y) / lb.h : 0.5;
  // near the middle: bind to the centre (the arrow then points at the shape's edge)
  if (Math.abs(nx - 0.5) < 0.3 && Math.abs(ny - 0.5) < 0.3) {
    nx = 0.5;
    ny = 0.5;
  }
  return { x: p.x, y: p.y, bind: { shapeId: target.id, nx: clamp01(nx), ny: clamp01(ny) } };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ------------------------------------------------------------------ select

type SelectState =
  | { kind: 'idle' }
  | { kind: 'pressing'; start: PointerInfo; hit: Shape | null; wasSelected: boolean }
  | { kind: 'translating'; start: Pt; shapes: Shape[] }
  | { kind: 'marquee'; start: Pt; add: boolean; base: Set<string> }
  | { kind: 'resizing'; handle: Handle; shapes: Shape[]; box: Box; rotation: number }
  | { kind: 'rotating'; center: Pt; startAngle: number; shapes: Shape[] }
  | { kind: 'bending'; shape: LineShape }
  | { kind: 'terminal'; shape: LineShape; which: 'start' | 'end' };

export class SelectTool implements Tool {
  state: SelectState = { kind: 'idle' };
  marquee: Box | null = null;
  constructor(private ed: Editor) {}

  down(p: PointerInfo) {
    const ed = this.ed;
    const h = ed.overlay.handleAt(p.screen);
    if (h && !ed.readOnly) {
      const sel = ed.selected().filter((s) => !s.locked);
      if (h.kind === 'rotate' && sel.length) {
        const f = selectionFrame(ed)!;
        const c = { x: f.box.x + f.box.w / 2, y: f.box.y + f.box.h / 2 };
        const center = f.rotation ? c : c;
        this.state = { kind: 'rotating', center, startAngle: Math.atan2(p.world.y - center.y, p.world.x - center.x), shapes: sel };
        return;
      }
      if (h.kind === 'resize' && sel.length) {
        const f = selectionFrame(ed)!;
        this.state = { kind: 'resizing', handle: h.handle!, shapes: sel, box: f.box, rotation: f.rotation };
        return;
      }
      if (h.kind === 'bend' && sel[0] && (sel[0].type === 'arrow' || sel[0].type === 'line')) {
        this.state = { kind: 'bending', shape: sel[0] };
        return;
      }
      if ((h.kind === 'start' || h.kind === 'end') && sel[0] && (sel[0].type === 'arrow' || sel[0].type === 'line')) {
        this.state = { kind: 'terminal', shape: sel[0], which: h.kind };
        return;
      }
    }
    const hit = ed.shapeAt(p.world);
    const wasSelected = !!hit && ed.selection.has(hit.id);
    if (hit) {
      if (p.shift) {
        if (!wasSelected) ed.select([hit.id], true);
      } else if (!wasSelected) ed.select([hit.id]);
    }
    this.state = { kind: 'pressing', start: p, hit, wasSelected };
  }

  move(p: PointerInfo) {
    const ed = this.ed;
    const st = this.state;
    switch (st.kind) {
      case 'idle': {
        const hit = ed.shapeAt(p.world);
        ed.showHover(hit?.id ?? null);
        const h = ed.overlay.handleAt(p.screen);
        ed.stage.dataset.cursor = h ? h.cursor : hit ? 'move' : '';
        return;
      }
      case 'pressing': {
        if (dist(p.screen, st.start.screen) < DRAG) return;
        ed.hideHover();
        if (st.hit && !ed.readOnly) {
          let shapes = ed.selected().filter((s) => !s.locked);
          // frames carry the shapes inside them
          const all = ed.visibleShapes();
          const extra: Shape[] = [];
          for (const s of shapes) if (s.type === 'frame') extra.push(...frameChildren(s, all, (x) => shapeBounds(x, ed.renderer.env)));
          const ids = new Set(shapes.map((s) => s.id));
          for (const s of extra) if (!ids.has(s.id) && !s.locked) {
            ids.add(s.id);
            shapes.push(s);
          }
          shapes = shapes.map((s) => ({ ...s }) as Shape);
          this.state = { kind: 'translating', start: st.start.world, shapes };
        } else if (!st.hit) {
          const base = new Set(st.start.shift ? ed.selection : []);
          if (!st.start.shift) ed.clearSelection();
          this.state = { kind: 'marquee', start: st.start.world, add: st.start.shift, base };
        } else return;
        this.move(p);
        return;
      }
      case 'translating': {
        let dx = p.world.x - st.start.x;
        let dy = p.world.y - st.start.y;
        if (p.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        ed.doc.updateMany(translatePatches(st.shapes, dx, dy, ed.renderer.env));
        return;
      }
      case 'marquee': {
        const box = boxFrom2(st.start, p.world);
        this.marquee = box;
        const ids = new Set(st.base);
        for (const s of ed.visibleShapes()) if (!s.locked && marqueeHits(s, box, ed.renderer.env)) ids.add(s.id);
        ed.select(ids);
        ed.overlay.update();
        return;
      }
      case 'resizing': {
        const env = ed.renderer.env;
        if (st.shapes.length === 1 && st.rotation === selectionFrame(ed)?.rotation && st.shapes[0].type !== 'line' && st.shapes[0].type !== 'arrow' && !(st.shapes.length === 1 && st.shapes[0].type === 'draw' && !st.shapes[0].done)) {
          const s = st.shapes[0];
          const keep = p.shift || s.type === 'image';
          ed.doc.update(s.id, resizeSinglePatch(s, st.handle, p.world, keep, p.alt));
        } else {
          const nb = resizeBox(st.box, 0, st.handle, p.world, p.shift, p.alt);
          ed.doc.updateMany(scalePatches(st.shapes, st.box, nb, env));
        }
        return;
      }
      case 'rotating': {
        let a = Math.atan2(p.world.y - st.center.y, p.world.x - st.center.x) - st.startAngle;
        if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        ed.doc.updateMany(rotatePatches(st.shapes, st.center, a, ed.renderer.env));
        return;
      }
      case 'bending': {
        const g = lineGeometry(st.shape, ed.renderer.env);
        const d = { x: g.b.x - g.a.x, y: g.b.y - g.a.y };
        const l = Math.hypot(d.x, d.y) || 1;
        const nrm = { x: -d.y / l, y: d.x / l };
        const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
        const bend = (p.world.x - mid.x) * nrm.x + (p.world.y - mid.y) * nrm.y;
        ed.doc.update(st.shape.id, { bend: Math.abs(bend) < 4 ? 0 : bend });
        return;
      }
      case 'terminal': {
        const other = st.which === 'start' ? st.shape.end : st.shape.start;
        let pt = p.world;
        if (p.shift) pt = snapAngle(other, pt);
        const term = terminalAt(ed, pt, st.shape.type === 'arrow' && !p.mod, st.shape.id);
        ed.doc.update(st.shape.id, { [st.which]: term });
        return;
      }
    }
  }

  up(p: PointerInfo) {
    const ed = this.ed;
    const st = this.state;
    if (st.kind === 'pressing') {
      if (st.hit && st.wasSelected && p.shift) ed.deselect([st.hit.id]);
      else if (st.hit && st.wasSelected && !p.shift && ed.selection.size > 1) ed.select([st.hit.id]);
      else if (!st.hit && !p.shift) ed.clearSelection();
    }
    if (st.kind !== 'idle' && st.kind !== 'pressing' && st.kind !== 'marquee') ed.doc.endGesture();
    this.marquee = null;
    this.state = { kind: 'idle' };
    ed.overlay.update();
  }

  cancel() {
    if (this.state.kind !== 'idle' && this.state.kind !== 'pressing' && this.state.kind !== 'marquee') this.ed.doc.endGesture();
    this.state = { kind: 'idle' };
    this.marquee = null;
  }

  doubleClick(p: PointerInfo) {
    const ed = this.ed;
    const hit = ed.shapeAt(p.world);
    if (hit && (hit.type === 'text' || hit.type === 'note' || hit.type === 'geo' || hit.type === 'frame')) {
      ed.startEditing(hit.id);
      return;
    }
    if (!hit && !ed.readOnly) {
      // double click on empty canvas: new text, like tldraw
      const id = createText(ed, p.world);
      ed.startEditing(id);
    }
  }
}

// ------------------------------------------------------------------ hand

class HandTool implements Tool {
  // panning is handled by the editor (button-0 drag with the hand tool)
  down() {}
  move() {}
  up() {}
}

// ------------------------------------------------------------------ draw / highlight

class DrawTool implements Tool {
  private id: string | null = null;
  private origin: Pt = { x: 0, y: 0 };
  private last: Pt = { x: 0, y: 0 };
  private buffer: number[] = [];
  private frame = 0;
  constructor(private ed: Editor, private highlight: boolean) {}

  down(p: PointerInfo) {
    const ed = this.ed;
    ed.doc.endGesture();
    this.origin = p.world;
    this.last = p.world;
    const st = ed.style;
    this.id = ed.doc.create({
      type: 'draw',
      x: p.world.x,
      y: p.world.y,
      w: 0,
      h: 0,
      points: [0, 0, round3(p.pressure)],
      highlight: this.highlight,
      ow: 0,
      oh: 0,
      done: false,
      pen: p.pen,
      color: this.highlight && st.color === 'black' ? 'yellow' : st.color,
      size: st.size,
      dash: st.dash === 'draw' ? 'solid' : st.dash,
      opacity: st.opacity,
      fill: 'none',
    } as Partial<DrawShape> & { type: 'draw' });
  }

  move(p: PointerInfo) {
    if (!this.id) return;
    let pt = p.world;
    if (p.shift) pt = snapAngle(this.origin, pt, Math.PI / 4);
    if (dist(pt, this.last) < 0.75 / this.ed.camera.z) return;
    this.last = pt;
    this.buffer.push(round2(pt.x - this.origin.x), round2(pt.y - this.origin.y), round3(p.pressure));
    // one transaction per animation frame: live for the others, cheap for the network
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!this.id || !this.buffer.length) return;
    this.ed.doc.appendPoints(this.id, this.buffer);
    this.buffer = [];
  }

  up() {
    this.flush();
    const id = this.id;
    this.id = null;
    if (!id) return;
    const s = this.ed.doc.get(id) as DrawShape | undefined;
    if (!s) return;
    this.ed.doc.update(id, { ...normaliseDraw(s), done: true });
    this.ed.doc.endGesture();
  }

  cancel() {
    if (this.id) this.up();
  }
}

// ------------------------------------------------------------------ eraser

class EraserTool implements Tool {
  private active = false;
  private last: Pt | null = null;
  readonly trail: Pt[] = [];
  constructor(private ed: Editor) {}

  down(p: PointerInfo) {
    this.active = true;
    this.last = p.world;
    this.trail.length = 0;
    this.trail.push(p.world);
    this.hit(p.world, p.world);
  }

  move(p: PointerInfo) {
    if (!this.active || !this.last) return;
    this.hit(this.last, p.world);
    this.last = p.world;
    this.trail.push(p.world);
    if (this.trail.length > 30) this.trail.shift();
    this.ed.overlay.update();
  }

  private hit(a: Pt, b: Pt) {
    const ed = this.ed;
    const tol = 6 / ed.camera.z;
    let changed = false;
    for (const s of ed.visibleShapes()) {
      if (s.locked || ed.renderer.fading.has(s.id)) continue;
      if (segmentHits(s, a, b, tol, ed.renderer.env)) {
        for (const id of ed.doc.expandGroups([s.id])) ed.renderer.fading.add(id);
        changed = true;
      }
    }
    if (changed) for (const id of ed.renderer.fading) ed.renderer.invalidate(id);
  }

  up() {
    const ed = this.ed;
    const ids = [...ed.renderer.fading];
    ed.renderer.fading.clear();
    this.active = false;
    this.trail.length = 0;
    if (ids.length) {
      ed.doc.delete(ids);
      ed.doc.endGesture();
    }
    ed.overlay.update();
  }

  cancel() {
    const ed = this.ed;
    for (const id of ed.renderer.fading) ed.renderer.invalidate(id);
    ed.renderer.fading.clear();
    this.active = false;
    this.trail.length = 0;
  }
}

// ------------------------------------------------------------------ line / arrow

class LineTool implements Tool {
  private id: string | null = null;
  private start: Pt = { x: 0, y: 0 };
  constructor(private ed: Editor, private type: 'line' | 'arrow') {}

  down(p: PointerInfo) {
    const ed = this.ed;
    ed.doc.endGesture();
    this.start = p.world;
    const st = ed.style;
    const startTerm = terminalAt(ed, p.world, this.type === 'arrow');
    this.id = ed.doc.create({
      type: this.type,
      x: 0, y: 0, w: 0, h: 0,
      start: startTerm,
      end: { x: p.world.x, y: p.world.y },
      bend: 0,
      color: st.color, size: st.size, dash: st.dash, opacity: st.opacity, arrowheads: st.arrowheads, fill: 'none',
    } as Partial<LineShape> & { type: 'line' | 'arrow' });
  }

  move(p: PointerInfo) {
    if (!this.id) return;
    let pt = p.world;
    if (p.shift) pt = snapAngle(this.start, pt);
    const end = terminalAt(this.ed, pt, this.type === 'arrow' && !p.mod, this.id);
    this.ed.doc.update(this.id, { end });
  }

  up(p: PointerInfo) {
    const id = this.id;
    this.id = null;
    if (!id) return;
    const ed = this.ed;
    if (dist(p.world, this.start) * ed.camera.z < 4) {
      // a click: make a default-length line to the right
      const s = ed.doc.get(id) as LineShape;
      ed.doc.update(id, { end: { x: s.start.x + 120, y: s.start.y } });
    }
    ed.doc.endGesture();
    ed.setTool('select');
    ed.select([id]);
  }

  cancel() {
    if (this.id) {
      this.ed.doc.delete([this.id]);
      this.id = null;
    }
  }
}

// ------------------------------------------------------------------ geo / frame (drag a box)

class BoxTool implements Tool {
  private id: string | null = null;
  private start: PointerInfo | null = null;
  constructor(private ed: Editor, private kind: 'geo' | 'frame') {}

  down(p: PointerInfo) {
    this.ed.doc.endGesture();
    this.start = p;
  }

  private create(box: Box): string {
    const ed = this.ed;
    const st = ed.style;
    if (this.kind === 'frame') {
      const count = ed.doc.all().filter((s) => s.type === 'frame').length + 1;
      return ed.doc.create({ type: 'frame', ...box, name: t('frame.defaultName', { n: count }) } as Partial<Shape> & { type: 'frame' });
    }
    return ed.doc.create({
      type: 'geo', geo: ed.geoKind, text: '', ...box,
      color: st.color, fill: st.fill, dash: st.dash, size: st.size, font: st.font, opacity: st.opacity,
    } as Partial<Shape> & { type: 'geo' });
  }

  move(p: PointerInfo) {
    if (!this.start) return;
    if (!this.id && dist(p.screen, this.start.screen) < DRAG) return;
    let a = this.start.world;
    let b = p.world;
    if (p.shift) {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      b = { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
    }
    if (p.alt) a = { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    const box = boxFrom2(a, b);
    box.w = Math.max(box.w, 1);
    box.h = Math.max(box.h, 1);
    if (!this.id) this.id = this.create(box);
    else this.ed.doc.update(this.id, box);
  }

  up(p: PointerInfo) {
    const ed = this.ed;
    let id = this.id;
    if (!id && this.start) {
      const [w, h] = this.kind === 'frame' ? [320, 200] : [100, 100];
      id = this.create({ x: p.world.x - w / 2, y: p.world.y - h / 2, w, h });
    }
    this.id = null;
    this.start = null;
    if (!id) return;
    ed.doc.endGesture();
    ed.setTool('select');
    ed.select([id]);
  }

  cancel() {
    this.id = null;
    this.start = null;
  }
}

// ------------------------------------------------------------------ text / note / image / laser

export function createText(ed: Editor, at: Pt): string {
  const st = ed.style;
  const size = FONT_SIZE[st.size];
  const lay = layoutText(' ', st.font, size, null);
  return ed.doc.create({
    type: 'text', text: '', fixedWidth: false,
    x: at.x, y: at.y - lay.lineHeight / 2, w: 10, h: Math.ceil(lay.height),
    color: st.color, size: st.size, font: st.font, opacity: st.opacity,
  } as Partial<Shape> & { type: 'text' });
}

class TextTool implements Tool {
  constructor(private ed: Editor) {}
  down() {}
  move() {}
  up(p: PointerInfo) {
    const ed = this.ed;
    const hit = ed.shapeAt(p.world);
    ed.doc.endGesture();
    if (hit && (hit.type === 'text' || hit.type === 'note' || hit.type === 'geo')) {
      ed.setTool('select');
      ed.startEditing(hit.id);
      return;
    }
    const id = createText(ed, p.world);
    ed.setTool('select');
    ed.startEditing(id);
  }
}

class NoteTool implements Tool {
  constructor(private ed: Editor) {}
  down() {}
  move() {}
  up(p: PointerInfo) {
    const ed = this.ed;
    const st = ed.style;
    ed.doc.endGesture();
    const id = ed.doc.create({
      type: 'note', text: '',
      x: p.world.x - NOTE_SIZE / 2, y: p.world.y - NOTE_SIZE / 2, w: NOTE_SIZE, h: NOTE_SIZE,
      color: st.color === 'black' ? 'yellow' : st.color, size: st.size, font: st.font, opacity: st.opacity,
    } as Partial<Shape> & { type: 'note' });
    ed.setTool('select');
    ed.startEditing(id);
  }
}

class ImageTool implements Tool {
  constructor(private ed: Editor) {}
  down() {}
  move() {}
  up(p: PointerInfo) {
    this.ed.pickImage(p.world);
  }
}

class LaserTool implements Tool {
  private active = false;
  constructor(private ed: Editor) {}
  down(p: PointerInfo) {
    this.active = true;
    this.ed.addLaserPoint(p.world);
  }
  move(p: PointerInfo) {
    if (this.active) this.ed.addLaserPoint(p.world);
  }
  up() {
    this.active = false;
  }
  cancel() {
    this.active = false;
  }
}

export const TOOLS: Record<ToolId, (ed: Editor) => Tool> = {
  select: (ed) => new SelectTool(ed),
  hand: () => new HandTool(),
  draw: (ed) => new DrawTool(ed, false),
  highlight: (ed) => new DrawTool(ed, true),
  eraser: (ed) => new EraserTool(ed),
  arrow: (ed) => new LineTool(ed, 'arrow'),
  line: (ed) => new LineTool(ed, 'line'),
  text: (ed) => new TextTool(ed),
  note: (ed) => new NoteTool(ed),
  geo: (ed) => new BoxTool(ed, 'geo'),
  frame: (ed) => new BoxTool(ed, 'frame'),
  image: (ed) => new ImageTool(ed),
  laser: (ed) => new LaserTool(ed),
};

export { EraserTool };
export { lineMidpoint };

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
