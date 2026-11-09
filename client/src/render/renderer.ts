import type { CanvasDoc } from '../model/doc';
import { compareOrder } from '../model/doc';
import type { Shape } from '../model/types';
import { displayUser, shortName } from '../model/people';
import { shapeBounds } from '../geometry/shapes';
import { defsMarkup, shapeMarkup, shapeTransform, type RenderEnv } from './shapeSvg';
import { measureWidth } from './text';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Renders the shapes of the document into one SVG that lives in world coordinates
 * (inside the camera-transformed world layer, above the artifact iframe).
 * Only changed shapes are re-rendered; arrows bound to a changed shape follow it.
 */
export class Renderer {
  readonly svg: SVGSVGElement;
  private shapesLayer: SVGGElement;
  private tagsLayer: SVGGElement;
  private els = new Map<string, SVGGElement>();
  private tags = new Map<string, SVGGElement>();
  private arrows = new Set<string>();
  private dirty = new Set<string>();
  private dirtyAll = false;
  private reorder = false;
  private frame = 0;
  hiddenAuthors = new Set<string>();
  /** Shapes being erased: drawn faded. */
  fading = new Set<string>();
  tagsVisible = true;
  /** Hide name tags when there are more shapes than this (keeps big canvases light). */
  tagLimit = 600;
  env: RenderEnv;
  onRendered: (() => void) | null = null;

  constructor(parent: HTMLElement, private doc: CanvasDoc) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'shapes');
    this.svg.setAttribute('overflow', 'visible');
    this.svg.setAttribute('width', '1');
    this.svg.setAttribute('height', '1');
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = defsMarkup();
    this.svg.appendChild(defs);
    this.shapesLayer = document.createElementNS(SVG_NS, 'g');
    this.shapesLayer.setAttribute('class', 'shapes-layer');
    this.tagsLayer = document.createElementNS(SVG_NS, 'g');
    this.tagsLayer.setAttribute('class', 'tags-layer');
    this.svg.append(this.shapesLayer, this.tagsLayer);
    parent.appendChild(this.svg);
    this.env = {
      get: (id) => doc.get(id),
      asset: (id) => doc.assets.get(id),
    };
    doc.onChange((c) => {
      for (const id of c.shapes) this.invalidate(id);
      if (c.attribution) for (const id of c.attribution) this.invalidate(id);
      if (c.users) this.invalidateAll();
      if (c.assets) for (const id of this.els.keys()) if (doc.get(id)?.type === 'image') this.invalidate(id);
    });
  }

  invalidate(id: string) {
    this.dirty.add(id);
    this.schedule();
  }

  invalidateAll() {
    this.dirtyAll = true;
    this.schedule();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  /** Render pending changes now (tests and export call this). */
  flush() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const ids = this.dirtyAll ? new Set([...this.doc.ids(), ...this.els.keys()]) : new Set(this.dirty);
    this.dirtyAll = false;
    this.dirty.clear();
    if (!ids.size) return;
    // arrows bound to changed shapes must follow them
    for (const aid of this.arrows) {
      if (ids.has(aid)) continue;
      const a = this.doc.get(aid);
      if (!a || (a.type !== 'arrow' && a.type !== 'line')) continue;
      if ((a.start.bind && ids.has(a.start.bind.shapeId)) || (a.end.bind && ids.has(a.end.bind.shapeId))) ids.add(aid);
    }
    const showTags = this.tagsVisible && this.doc.shapes.size <= this.tagLimit;
    for (const id of ids) this.renderOne(id, showTags);
    if (this.reorder) this.applyOrder();
    this.onRendered?.();
  }

  private renderOne(id: string, showTags: boolean) {
    const s = this.doc.get(id);
    const a = s ? this.doc.attributionOf(id) : undefined;
    const hidden = !s || (a && this.hiddenAuthors.has(a.createdBy));
    let el = this.els.get(id);
    if (!s || hidden) {
      el?.remove();
      this.els.delete(id);
      this.tags.get(id)?.remove();
      this.tags.delete(id);
      this.arrows.delete(id);
      return;
    }
    if (s.type === 'arrow' || s.type === 'line') this.arrows.add(id);
    if (!el) {
      el = document.createElementNS(SVG_NS, 'g');
      el.setAttribute('data-shape-id', id);
      el.setAttribute('data-shape-type', s.type);
      this.els.set(id, el);
      this.shapesLayer.appendChild(el);
      this.reorder = true;
    }
    const key = `${s.index}|${s.type === 'draw' && s.highlight ? 1 : 0}`;
    if (el.dataset.order !== key) {
      el.dataset.order = key;
      this.reorder = true;
    }
    const t = shapeTransform(s);
    if (t) el.setAttribute('transform', t);
    else el.removeAttribute('transform');
    const op = this.fading.has(id) ? s.opacity * 0.3 : s.opacity;
    if (op < 1) el.setAttribute('opacity', String(op));
    else el.removeAttribute('opacity');
    el.setAttribute('data-author', a?.createdBy ?? '');
    el.innerHTML = shapeMarkup(s, this.env);
    this.renderTag(s, a?.createdBy, showTags);
  }

  private renderTag(s: Shape, author: string | undefined, show: boolean) {
    let tag = this.tags.get(s.id);
    if (!show || !author || s.type === 'frame') {
      tag?.remove();
      this.tags.delete(s.id);
      return;
    }
    const u = displayUser((id) => this.doc.user(id), author);
    const label = shortName(u.name, u.anonymous);
    const b = shapeBounds(s, this.env);
    const fs = 10.5;
    const w = measureWidth(label, 'sans', fs) + 12;
    if (!tag) {
      tag = document.createElementNS(SVG_NS, 'g');
      tag.setAttribute('class', 'name-tag');
      tag.setAttribute('data-tag-for', s.id);
      this.tags.set(s.id, tag);
      this.tagsLayer.appendChild(tag);
    }
    const x = b.x;
    const y = b.y - 19;
    tag.setAttribute('transform', `translate(${Math.round(x)} ${Math.round(y)})`);
    tag.innerHTML =
      `<rect width="${w.toFixed(1)}" height="17" rx="4" fill="${u.color}"/>` +
      `<text x="6" y="12.5" font-size="${fs}" font-weight="600" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif">${escape(label)}</text>`;
  }

  private applyOrder() {
    this.reorder = false;
    const sorted = Array.from(this.els.keys())
      .map((id) => this.doc.get(id))
      .filter((s): s is Shape => !!s)
      .sort(compareOrder);
    let prev: Element | null = null;
    for (const s of sorted) {
      const el = this.els.get(s.id)!;
      const expected: Element | null = prev ? prev.nextElementSibling : this.shapesLayer.firstElementChild;
      if (expected !== el) {
        if (prev) prev.after(el);
        else this.shapesLayer.prepend(el);
      }
      prev = el;
    }
  }

  setVisible(v: boolean) {
    this.svg.style.display = v ? '' : 'none';
  }

  setTagsVisible(v: boolean) {
    this.tagsVisible = v;
    this.invalidateAll();
  }

  elementFor(id: string): SVGGElement | undefined {
    return this.els.get(id);
  }

  renderedCount(): number {
    return this.els.size;
  }
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
