import type { Editor } from '../editor/editor';
import { shapeBounds } from '../geometry/shapes';
import { unionBoxes } from '../geometry/vec';
import { personColor } from '../model/colors';
import { toCss } from '../ui/theme';

/** Fewest ms between two paints of the map itself (it changes on every step while the view is off the page). */
const MAP_FRAME_MS = 1000 / 30;

/**
 * Minimap: the artifact page, the shapes (in their author's colour) and my viewport. The map is
 * painted only when it changes (the document, the theme, its scale), at most 30 times a second; my
 * viewport is an element moved over it, so a pan or a scroll inside the page repaints nothing.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  /** My viewport on the map. */
  readonly box: HTMLDivElement;
  private frame = 0;
  private timer = 0;
  private dragging = false;

  constructor(private ed: Editor, parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.setAttribute('data-testid', 'minimap');
    this.box = document.createElement('div');
    this.box.className = 'minimap-view';
    this.box.setAttribute('data-testid', 'minimap-view');
    parent.append(this.canvas, this.box);
    ed.on('camera', () => this.schedule());
    // the page takes the artifact's background; the map follows (dark or light)
    ed.on('theme', () => this.schedule());
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

  /** The map as painted: world to map px. */
  private map = { s: 1, ox: 0, oy: 0 };
  /** What the painted map shows (the document, the scale, the size, the theme), and when it was painted. */
  private paintedKey = '';
  private paintedAt = -Infinity;
  private boxSize = '';
  /** Paints of the map itself (tests: a pan inside the page paints none). */
  paints = 0;

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

  private docVersion = 0;

  private draw() {
    const ed = this.ed;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const view = ed.visibleWorld();
    // The map covers the page and the content; the viewport only extends it when it leaves that area.
    const content = this.contentBox();
    const all = unionBoxes([content, view])!;
    const pad = 6;
    const s = Math.min((r.width - pad * 2) / all.w, (r.height - pad * 2) / all.h);
    const ox = (r.width - all.w * s) / 2 - all.x * s;
    const oy = (r.height - all.h * s) / 2 - all.y * s;
    const key = `${this.docVersion}|${s.toFixed(5)}|${ox.toFixed(1)}|${oy.toFixed(1)}|${r.width}|${r.height}|${ed.annotationsVisible}|${toCss(ed.board)}|${ed.dark}`;
    if (key !== this.paintedKey) {
      const wait = this.paintedAt + MAP_FRAME_MS - performance.now();
      if (wait > 0) {
        if (!this.timer) {
          this.timer = window.setTimeout(() => {
            this.timer = 0;
            this.schedule();
          }, wait);
        }
      } else {
        this.paint(r.width, r.height, s, ox, oy);
        this.paintedKey = key;
        this.paintedAt = performance.now();
        this.map = { s, ox, oy };
      }
    }
    // my viewport, on the map as painted (2 px, its line centred on the edge, as a stroke would be)
    const m = this.map;
    const w = Math.max(2, view.w * m.s + 2);
    const h = Math.max(2, view.h * m.s + 2);
    this.box.style.transform = `translate(${m.ox + view.x * m.s - 1}px, ${m.oy + view.y * m.s - 1}px)`;
    const size = `${w.toFixed(1)}x${h.toFixed(1)}`;
    if (size !== this.boxSize) {
      this.boxSize = size;
      this.box.style.width = `${w.toFixed(1)}px`;
      this.box.style.height = `${h.toFixed(1)}px`;
    }
  }

  private contentCache: { v: string; box: ReturnType<typeof unionBoxes> } = { v: '', box: null };
  private contentBox() {
    const v = `${this.docVersion}|${this.ed.pageWidth}|${this.ed.pageHeight}`;
    if (this.contentCache.v !== v || !this.contentCache.box) {
      const ed = this.ed;
      const shapes = ed.annotationsVisible ? ed.visibleShapes() : [];
      this.contentCache = { v, box: unionBoxes([ed.pageBox(), ...shapes.map((x) => shapeBounds(x, ed.renderer.env))]) };
    }
    return this.contentCache.box!;
  }

  /** The map itself: the board, the page and the shapes. */
  private paint(w: number, h: number, s: number, ox: number, oy: number) {
    const ed = this.ed;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.paints++;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = ed.dark ? '#111827' : '#f3f4f6';
    ctx.fillRect(0, 0, w, h);
    const pg = ed.pageBox();
    ctx.fillStyle = toCss(ed.board);
    ctx.strokeStyle = ed.dark ? '#4b5563' : '#d1d5db';
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
    ctx.globalAlpha = 1;
  }
}
