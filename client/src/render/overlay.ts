import type { Editor } from '../editor/editor';
import { peers, type LaserPoint } from '../collab/presence';
import { LASER_COLOR } from '../model/colors';
import { displayUser, hoverLines, shortName } from '../model/people';
import { lineGeometry, lineMidpoint, shapeBounds, shapeCorners } from '../geometry/shapes';
import { HANDLE_DIR, type Handle } from '../geometry/transform';
import { type Pt, rotate } from '../geometry/vec';
import { EraserTool, SelectTool, selectionFrame } from '../tools/tools';
import { t } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLE = 9;

export interface HandleHit {
  kind: 'resize' | 'rotate' | 'bend' | 'start' | 'end';
  handle?: Handle;
  cursor: string;
}

const CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

/** Screen-space UI over the canvas: selection, handles, marquee, eraser, laser, cursors, hover card. */
export class Overlay {
  readonly svg: SVGSVGElement;
  readonly laserSvg: SVGSVGElement;
  readonly cursors: HTMLElement;
  readonly hover: HTMLElement;
  private handles: { p: Pt; hit: HandleHit }[] = [];
  private frame = 0;
  private cursorEls = new Map<number, HTMLElement>();

  constructor(private ed: Editor) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'overlay');
    this.laserSvg = document.createElementNS(SVG_NS, 'svg');
    this.laserSvg.setAttribute('class', 'overlay laser');
    this.laserSvg.innerHTML = '<defs><filter id="laser-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs><g class="trails"></g>';
    this.cursors = document.createElement('div');
    this.cursors.className = 'cursors';
    this.hover = document.createElement('div');
    this.hover.className = 'hovercard';
    this.hover.setAttribute('data-testid', 'hovercard');
    this.hover.style.display = 'none';
    ed.stage.append(this.svg, this.laserSvg, this.cursors, this.hover);
  }

  update() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
      this.updateCursors();
      this.updateHover();
    });
  }

  private render() {
    const ed = this.ed;
    this.handles = [];
    let out = '';
    const z = ed.camera.z;
    const tool = ed.activeTool;
    if (ed.annotationsVisible) {
      // selected shapes
      const sel = ed.selected();
      for (const s of sel) {
        const pts = shapeCorners(s, ed.renderer.env).map((p) => ed.toScreen(p));
        if (sel.length > 1 || s.type === 'draw') out += `<path d="${poly(pts)}" fill="none" stroke="#2563eb" stroke-width="1" opacity="0.6"/>`;
      }
      const f = selectionFrame(ed);
      const editing = !!ed.editingId;
      if (f && !editing) {
        const single = f.single;
        const isLine = single && (single.type === 'line' || single.type === 'arrow');
        if (isLine) {
          const g = lineGeometry(single, ed.renderer.env);
          const a = ed.toScreen(g.a);
          const b = ed.toScreen(g.b);
          const m = ed.toScreen(lineMidpoint(g));
          out += `<path d="${poly(g.pts.map((p) => ed.toScreen(p)))}" fill="none" stroke="#2563eb" stroke-width="1"/>`;
          for (const [p, kind] of [[a, 'start'], [b, 'end'], [m, 'bend']] as const) {
            out += `<circle cx="${p.x}" cy="${p.y}" r="${kind === 'bend' ? 4.5 : 5.5}" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>`;
            this.handles.push({ p, hit: { kind, cursor: 'grab' } });
          }
        } else {
          const b = f.box;
          const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
          const corner = (hx: number, hy: number) => ed.toScreen(rotate({ x: c.x + (hx * b.w) / 2, y: c.y + (hy * b.h) / 2 }, c, f.rotation));
          const outline = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
          const locked = ed.selected().every((s) => s.locked);
          out += `<path d="${poly(outline)}" fill="none" stroke="#2563eb" stroke-width="1.5"${locked ? ' stroke-dasharray="4 3"' : ''}/>`;
          if (!locked && !ed.readOnly) {
            const small = b.w * z < 24 || b.h * z < 24;
            for (const h of Object.keys(HANDLE_DIR) as Handle[]) {
              const [hx, hy] = HANDLE_DIR[h];
              if (small && (hx === 0 || hy === 0)) continue;
              const p = corner(hx, hy);
              out += `<rect x="${p.x - HANDLE / 2}" y="${p.y - HANDLE / 2}" width="${HANDLE}" height="${HANDLE}" rx="2" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>`;
              this.handles.push({ p, hit: { kind: 'resize', handle: h, cursor: rotateCursor(CURSOR[h], h, f.rotation) } });
            }
            const top = corner(0, -1);
            const dir = rotate({ x: 0, y: -1 }, { x: 0, y: 0 }, f.rotation);
            const rp = { x: top.x + dir.x * 22, y: top.y + dir.y * 22 };
            out += `<line x1="${top.x}" y1="${top.y}" x2="${rp.x}" y2="${rp.y}" stroke="#2563eb" stroke-width="1"/>`;
            out += `<circle cx="${rp.x}" cy="${rp.y}" r="5.5" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>`;
            this.handles.push({ p: rp, hit: { kind: 'rotate', cursor: 'grab' } });
          }
        }
      }
      // hovered shape outline
      if (ed.hoverId && !ed.selection.has(ed.hoverId)) {
        const s = ed.doc.get(ed.hoverId);
        if (s) out += `<path d="${poly(shapeCorners(s, ed.renderer.env).map((p) => ed.toScreen(p)))}" fill="none" stroke="#2563eb" stroke-width="1" opacity="0.45"/>`;
      }
    }
    if (tool instanceof SelectTool && tool.marquee) {
      const a = ed.toScreen({ x: tool.marquee.x, y: tool.marquee.y });
      out += `<rect data-testid="marquee" x="${a.x}" y="${a.y}" width="${tool.marquee.w * z}" height="${tool.marquee.h * z}" fill="rgba(37,99,235,0.08)" stroke="#2563eb" stroke-width="1"/>`;
    }
    if (tool instanceof EraserTool && tool.trail.length > 1) {
      out += `<path d="${poly(tool.trail.map((p) => ed.toScreen(p)), false)}" fill="none" stroke="#9ca3af" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`;
    }
    this.svg.innerHTML = out;
  }

  /** The handle under a screen point, if any. */
  handleAt(p: Pt): HandleHit | null {
    for (let i = this.handles.length - 1; i >= 0; i--) {
      const h = this.handles[i];
      if (Math.hypot(p.x - h.p.x, p.y - h.p.y) <= 9) return h.hit;
    }
    return null;
  }

  updateCursors() {
    const ed = this.ed;
    const conn = ed.conn;
    if (!conn) return;
    const seen = new Set<number>();
    for (const peer of peers(conn.awareness)) {
      const st = peer.state;
      if (!st.cursor || !st.user) continue;
      if (st.user.id === ed.me?.id && peer.clientId === conn.awareness.clientID) continue;
      seen.add(peer.clientId);
      let el = this.cursorEls.get(peer.clientId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'cursor';
        el.setAttribute('data-testid', 'remote-cursor');
        this.cursors.appendChild(el);
        this.cursorEls.set(peer.clientId, el);
      }
      const p = ed.toScreen(st.cursor);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const name = shortName(st.user.name, st.user.anonymous);
      const status = st.status && st.status.startsWith('cursor.') ? ` · ${t(st.status as 'cursor.typing')}` : '';
      const label = name + status;
      if (el.dataset.label !== label || el.dataset.color !== st.user.color) {
        el.dataset.label = label;
        el.dataset.color = st.user.color;
        el.dataset.userId = st.user.id;
        el.innerHTML = `<svg width="18" height="20"><path d="M1 1 L1 17 L5.5 12.5 L9 19 L11.5 18 L8 11.5 L14 11.5 Z" fill="${st.user.color}" stroke="#fff" stroke-width="1.2"/></svg><span class="lbl" style="background:${st.user.color}"></span>`;
        el.querySelector('.lbl')!.textContent = label;
      }
    }
    for (const [id, el] of this.cursorEls) {
      if (!seen.has(id)) {
        el.remove();
        this.cursorEls.delete(id);
      }
    }
  }

  /** Draw every laser trail; returns true while some trail is still visible. */
  updateLaser(): boolean {
    const ed = this.ed;
    const g = this.laserSvg.querySelector('.trails')!;
    let out = '';
    let active = false;
    const nowLocal = performance.now();
    const trails: { pts: LaserPoint[]; age: (t: number) => number; name: string; presenting: boolean }[] = [];
    if (ed.laser.length && ed.me) {
      const now = Date.now();
      trails.push({ pts: ed.laser, age: (tt) => now - tt, name: ed.me.name, presenting: ed.presenting });
    }
    if (ed.conn) {
      for (const p of peers(ed.conn.awareness)) {
        const l = p.state.laser;
        if (!l || !l.pts.length || !p.state.user) continue;
        const seen = ed.laserSeen.get(p.clientId);
        const offset = seen ? nowLocal - seen.at : 0;
        trails.push({ pts: l.pts, age: (tt) => l.now - tt + offset, name: p.state.user.name, presenting: !!p.state.presenting });
      }
    }
    for (const tr of trails) {
      const pts = tr.pts.filter((q) => tr.age(q[2]) < 1000);
      if (!pts.length) continue;
      active = true;
      for (let i = 1; i < pts.length; i++) {
        const a = ed.toScreen({ x: pts[i - 1][0], y: pts[i - 1][1] });
        const b = ed.toScreen({ x: pts[i][0], y: pts[i][1] });
        const alpha = Math.max(0, 1 - tr.age(pts[i][2]) / 1000);
        out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${LASER_COLOR}" stroke-width="7" stroke-linecap="round" opacity="${(alpha * 0.45).toFixed(3)}" filter="url(#laser-glow)"/>`;
        out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${LASER_COLOR}" stroke-width="2.5" stroke-linecap="round" opacity="${alpha.toFixed(3)}"/>`;
      }
      const last = pts[pts.length - 1];
      const lp = ed.toScreen({ x: last[0], y: last[1] });
      const alpha = Math.max(0, 1 - tr.age(last[2]) / 1000);
      out += `<circle data-testid="laser-dot" cx="${lp.x}" cy="${lp.y}" r="6" fill="${LASER_COLOR}" opacity="${alpha.toFixed(3)}"/>`;
      const label = t(tr.presenting ? 'laser.presenting' : 'laser.label', { name: shortName(tr.name) });
      out += `<g opacity="${alpha.toFixed(3)}" transform="translate(${lp.x + 10} ${lp.y + 6})"><rect width="${label.length * 6.2 + 12}" height="17" rx="4" fill="${LASER_COLOR}"/><text x="6" y="12.5" font-size="10.5" font-weight="600" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif">${esc(label)}</text></g>`;
    }
    g.innerHTML = out;
    return active;
  }

  updateHover() {
    const ed = this.ed;
    const id = ed.hoverId;
    const s = id ? ed.doc.get(id) : undefined;
    if (!s || !ed.annotationsVisible || ed.tool !== 'select') {
      this.hover.style.display = 'none';
      return;
    }
    const [l1, l2] = hoverLines(s, ed.doc.attributionOf(s.id), (u) => ed.doc.user(u));
    const b = shapeBounds(s, ed.renderer.env);
    const p = ed.toScreen({ x: b.x, y: b.y + b.h });
    this.hover.innerHTML = '';
    const a = document.createElement('div');
    a.innerHTML = boldNames(l1);
    const c = document.createElement('div');
    c.className = 'dim';
    c.textContent = l2;
    this.hover.append(a, c);
    this.hover.style.display = 'block';
    const x = Math.min(Math.max(8, p.x), ed.viewW - 240);
    const y = Math.min(p.y + 8, ed.viewH - 60);
    this.hover.style.transform = `translate(${x}px, ${y}px)`;
    const author = ed.doc.attributionOf(s.id)?.createdBy;
    if (author) this.hover.dataset.author = displayUser((u) => ed.doc.user(u), author).name;
  }
}

function boldNames(line: string): string {
  const i = line.indexOf(' · ');
  if (i < 0) return `<b>${esc(line)}</b>`;
  const type = line.slice(0, i);
  const rest = line.slice(i + 3);
  const m = rest.match(/^(.*\b(?:por|by)\s)(.+)$/);
  return `<b>${esc(type)}</b> · ` + (m ? `${esc(m[1])}<b>${esc(m[2])}</b>` : esc(rest));
}

function poly(pts: Pt[], closed = true): string {
  if (!pts.length) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + (closed ? 'Z' : '');
}

function rotateCursor(base: string, h: Handle, rotation: number): string {
  if (!rotation) return base;
  const order: Handle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const steps = Math.round(rotation / (Math.PI / 4));
  const idx = (order.indexOf(h) + steps + 8 * 4) % 8;
  return CURSOR[order[idx]];
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
