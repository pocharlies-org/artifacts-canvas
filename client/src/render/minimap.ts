import type { Editor } from '../editor/editor';
import { shapeBounds } from '../geometry/shapes';
import { unionBoxes } from '../geometry/vec';
import { personColor } from '../model/colors';

/** Minimap: the artifact page, the shapes (in their author's colour) and my viewport. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private frame = 0;
  private dragging = false;

  constructor(private ed: Editor, parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.setAttribute('data-testid', 'minimap');
    parent.appendChild(this.canvas);
    ed.on('camera', () => this.schedule());
    ed.on('doc', () => {
      this.docVersion++;
      this.schedule();
    });
    ed.on('visibility', () => {
      this.docVersion++;
      this.schedule();
    });
    const go = (e: PointerEvent) => {
      const w = this.worldAt(e);
      if (w) ed.panTo(w);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      go(e);
    });
    this.canvas.addEventListener('pointermove', (e) => this.dragging && go(e));
    this.canvas.addEventListener('pointerup', () => (this.dragging = false));
    this.schedule();
  }

  private map = { s: 1, ox: 0, oy: 0 };

  private worldAt(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x: (x - this.map.ox) / this.map.s, y: (y - this.map.oy) / this.map.s };
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Shapes layer, cached until the document or the page changes. */
  private shapesLayer: HTMLCanvasElement | null = null;
  private shapesKey = '';
  private docVersion = 0;

  private draw() {
    const ed = this.ed;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, r.width, r.height);
    const view = ed.visibleWorld();
    // The map covers the page and the content; the viewport only extends it when it leaves that area.
    const content = this.contentBox();
    const all = unionBoxes([content, view])!;
    const pad = 6;
    const s = Math.min((r.width - pad * 2) / all.w, (r.height - pad * 2) / all.h);
    const ox = (r.width - all.w * s) / 2 - all.x * s;
    const oy = (r.height - all.h * s) / 2 - all.y * s;
    this.map = { s, ox, oy };
    const key = `${this.docVersion}|${s.toFixed(5)}|${ox.toFixed(1)}|${oy.toFixed(1)}|${r.width}|${r.height}|${ed.annotationsVisible}`;
    if (key !== this.shapesKey || !this.shapesLayer) {
      this.shapesKey = key;
      this.shapesLayer = this.renderShapes(r.width, r.height, dpr, s, ox, oy);
    }
    ctx.drawImage(this.shapesLayer, 0, 0, r.width, r.height);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + view.x * s, oy + view.y * s, view.w * s, view.h * s);
  }

  private contentCache: { v: number; box: ReturnType<typeof unionBoxes> } = { v: -1, box: null };
  private contentBox() {
    if (this.contentCache.v !== this.docVersion || !this.contentCache.box) {
      const ed = this.ed;
      const shapes = ed.annotationsVisible ? ed.visibleShapes() : [];
      this.contentCache = { v: this.docVersion, box: unionBoxes([ed.pageBox(), ...shapes.map((x) => shapeBounds(x, ed.renderer.env))]) };
    }
    return this.contentCache.box!;
  }

  private renderShapes(w: number, h: number, dpr: number, s: number, ox: number, oy: number): HTMLCanvasElement {
    const ed = this.ed;
    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const ctx = layer.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pg = ed.pageBox();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.fillRect(ox + pg.x * s, oy + pg.y * s, pg.w * s, pg.h * s);
    ctx.strokeRect(ox + pg.x * s + 0.5, oy + pg.y * s + 0.5, pg.w * s, pg.h * s);
    const shapes = ed.annotationsVisible ? ed.visibleShapes() : [];
    ctx.globalAlpha = 0.65;
    for (const sh of shapes) {
      const b = shapeBounds(sh, ed.renderer.env);
      const a = ed.doc.attributionOf(sh.id);
      const u = a ? ed.doc.user(a.createdBy) : undefined;
      ctx.fillStyle = u?.color || (a ? personColor(a.createdBy, !!u?.anonymous) : '#9ca3af');
      ctx.fillRect(ox + b.x * s, oy + b.y * s, Math.max(1.5, b.w * s), Math.max(1.5, b.h * s));
    }
    return layer;
  }
}
