import { getStroke } from 'perfect-freehand';
import { COLORS, noteFill, rgba, strokeColor, tint } from '../model/colors';
import type { ColorName, DrawShape, LineShape, Shape, Style } from '../model/types';
import { geoExtras, geoOutline } from '../geometry/geo';
import {
  FONT_SIZE, FRAME_LABEL, LABEL_FONT_SIZE, NOTE_FONT_SIZE, STROKE_WIDTH, type GeomCtx,
  drawLocalPoints, freehandSize, lineGeometry, localBox, shapeCenter,
} from '../geometry/shapes';
import { type Pt, seededRandom } from '../geometry/vec';
import { FONT_FAMILY, escapeXml, layoutText } from './text';

export interface RenderEnv extends GeomCtx {
  asset(id: string): string | undefined;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** SVG transform of a box-like shape (translate + rotate around its centre). */
export function shapeTransform(s: Shape): string {
  if (s.type === 'line' || s.type === 'arrow') return '';
  const c = shapeCenter(s);
  const rot = s.rotation ? ` rotate(${n((s.rotation * 180) / Math.PI)} ${n(c.x - s.x)} ${n(c.y - s.y)})` : '';
  return `translate(${n(s.x)} ${n(s.y)})${rot}`;
}

export function svgPathFromStroke(points: number[][]): string {
  if (!points.length) return '';
  const d: (string | number)[] = ['M', n(points[0][0]), n(points[0][1]), 'Q'];
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    d.push(n(x0), n(y0), n((x0 + x1) / 2), n((y0 + y1) / 2));
  }
  d.push('Z');
  return d.join(' ');
}

export function polyPath(pts: Pt[], closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${n(pts[i].x)} ${n(pts[i].y)}`;
  return closed ? d + 'Z' : d;
}

/** Hand-drawn look: subdivide, jitter and draw twice. Deterministic per shape id. */
export function sketchPaths(pts: Pt[], closed: boolean, seed: string, sw: number): string[] {
  const rnd = seededRandom(seed);
  const amp = Math.min(1.2 + sw * 0.35, 4);
  const ring = closed ? [...pts, pts[0]] : pts;
  const paths: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const out: Pt[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.min(8, Math.round(segLen / 60)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push({ x: a.x + (b.x - a.x) * t + (rnd() - 0.5) * amp, y: a.y + (b.y - a.y) * t + (rnd() - 0.5) * amp });
      }
    }
    const last = ring[ring.length - 1];
    out.push({ x: last.x + (rnd() - 0.5) * amp, y: last.y + (rnd() - 0.5) * amp });
    paths.push(smoothPath(out));
  }
  return paths;
}

function smoothPath(pts: Pt[]): string {
  if (pts.length < 3) return polyPath(pts, false);
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n(mx)} ${n(my)}`;
  }
  const l = pts[pts.length - 1];
  return d + `L${n(l.x)} ${n(l.y)}`;
}

export function dashArray(style: Style, sw: number): string {
  if (style.dash === 'dashed') return ` stroke-dasharray="${n(sw * 2.5)} ${n(sw * 2)}"`;
  if (style.dash === 'dotted') return ` stroke-dasharray="0.01 ${n(sw * 2.2)}"`;
  return '';
}

export function fillFor(style: Style): string {
  const c = COLORS[style.color] ?? COLORS.black;
  switch (style.fill) {
    case 'semi':
      return style.color === 'white' ? 'rgba(255,255,255,0.6)' : rgba(c, 0.1);
    case 'solid':
      return style.color === 'white' ? '#ffffff' : style.color === 'black' ? '#495057' : tint(c, 0.45);
    case 'pattern':
      return `url(#hatch-${style.color})`;
    default:
      return 'none';
  }
}

/** <defs> needed by shape markup: one hatch pattern per colour and the note shadow. */
export function defsMarkup(): string {
  let d = '';
  for (const [name, hex] of Object.entries(COLORS) as [ColorName, string][]) {
    d += `<pattern id="hatch-${name}" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">` +
      `<rect width="8" height="8" fill="${rgba(hex, 0.06)}"/><line x1="0" y1="0" x2="0" y2="8" stroke="${hex}" stroke-width="2" stroke-opacity="0.55"/></pattern>`;
  }
  d += '<filter id="note-shadow" x="-10%" y="-10%" width="125%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.16"/></filter>';
  return d;
}

function strokeLine(pts: Pt[], closed: boolean, s: Shape, sw: number, fill = 'none'): string {
  const color = strokeColor(s.color);
  if (s.dash === 'draw') {
    const [p1, p2] = sketchPaths(pts, closed, s.id, sw);
    const fillPart = fill !== 'none' ? `<path d="${polyPath(pts, closed)}" fill="${fill}" stroke="none"/>` : '';
    return fillPart +
      `<path d="${p1}" fill="none" stroke="${color}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="${p2}" fill="none" stroke="${color}" stroke-width="${n(sw * 0.6)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>`;
  }
  return `<path d="${polyPath(pts, closed)}" fill="${fill}" stroke="${color}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round"${dashArray(s, sw)}/>`;
}

function textBlock(text: string, s: Shape, x: number, y: number, maxW: number, size: number, anchor: 'start' | 'middle', color: string): { svg: string; h: number } {
  if (!text) return { svg: '', h: 0 };
  const lay = layoutText(text, s.font, size, maxW);
  const family = escapeXml(FONT_FAMILY[s.font]);
  let out = `<text x="${n(x)}" y="${n(y)}" font-family="${family}" font-size="${n(size)}" fill="${color}" text-anchor="${anchor}" dominant-baseline="hanging" xml:space="preserve">`;
  lay.lines.forEach((line, i) => {
    out += `<tspan x="${n(x)}" dy="${i === 0 ? 0 : n(lay.lineHeight)}">${escapeXml(line) || ' '}</tspan>`;
  });
  return { svg: out + '</text>', h: lay.height };
}

function arrowHead(tip: Pt, from: Pt, size: number, color: string): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const left = { x: back.x - uy * size * 0.55, y: back.y + ux * size * 0.55 };
  const right = { x: back.x + uy * size * 0.55, y: back.y - ux * size * 0.55 };
  return `<path d="M${n(left.x)} ${n(left.y)}L${n(tip.x)} ${n(tip.y)}L${n(right.x)} ${n(right.y)}Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
}

function lineMarkup(s: LineShape, ctx: GeomCtx): string {
  const g = lineGeometry(s, ctx);
  const sw = STROKE_WIDTH[s.size] ?? 3.5;
  const color = strokeColor(s.color);
  let out = '';
  // wide transparent stroke: easier hovering, invisible in export
  out += strokeLine(g.pts, false, s, sw);
  if (s.type === 'arrow') {
    const head = Math.max(10, sw * 3.2);
    const nearB = s.bend ? g.pts[g.pts.length - 2] : g.a;
    const nearA = s.bend ? g.pts[1] : g.b;
    if (s.arrowheads === 'end' || s.arrowheads === 'both') out += arrowHead(g.b, nearB, head, color);
    if (s.arrowheads === 'both') out += arrowHead(g.a, nearA, head, color);
    if (s.arrowheads === 'dot') out += `<circle cx="${n(g.b.x)}" cy="${n(g.b.y)}" r="${n(Math.max(4, sw * 1.4))}" fill="${color}"/>`;
  }
  return out;
}

function drawMarkup(s: DrawShape): string {
  const pts = drawLocalPoints(s);
  const raw: number[][] = [];
  const pr = s.points;
  for (let i = 0, k = 0; k < pts.length; i += 3, k++) raw.push([pts[k].x, pts[k].y, pr[i + 2] ?? 0.5]);
  const size = freehandSize(s);
  const color = strokeColor(s.color);
  if (raw.length === 1) {
    return `<circle cx="${n(raw[0][0])}" cy="${n(raw[0][1])}" r="${n(size / 2)}" fill="${s.highlight ? rgba(color, 0.4) : color}"/>`;
  }
  if (s.highlight) {
    const d = polyPath(pts, false);
    return `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="0.38" stroke-width="${n(size)}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:multiply"/>`;
  }
  const outline = getStroke(raw, {
    size,
    thinning: s.pen ? 0.6 : 0.5,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !s.pen,
    last: s.done,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
  });
  const path = svgPathFromStroke(outline);
  if (s.dash === 'dashed' || s.dash === 'dotted') {
    return `<path d="${polyPath(pts, false)}" fill="none" stroke="${color}" stroke-width="${n(size * 0.8)}" stroke-linecap="round" stroke-linejoin="round"${dashArray(s, size * 0.8)}/>`;
  }
  return `<path d="${path}" fill="${color}" stroke="none"/>`;
}

/** Inner SVG markup of one shape, in its local coordinates (see shapeTransform). */
export function shapeMarkup(s: Shape, env: RenderEnv): string {
  const sw = STROKE_WIDTH[s.size] ?? 3.5;
  switch (s.type) {
    case 'draw':
      return drawMarkup(s);
    case 'line':
    case 'arrow':
      return lineMarkup(s, env);
    case 'geo': {
      const poly = geoOutline(s.geo, s.w, s.h);
      let out = strokeLine(poly, true, s, sw, fillFor(s));
      for (const extra of geoExtras(s.geo, s.w, s.h)) out += strokeLine(extra, false, s, sw);
      if (s.text) {
        const size = LABEL_FONT_SIZE[s.size] ?? 18;
        const lay = layoutText(s.text, s.font, size, Math.max(20, s.w - 16));
        const y = s.h / 2 - lay.height / 2;
        out += textBlock(s.text, s, s.w / 2, y, Math.max(20, s.w - 16), size, 'middle', strokeColor(s.color === 'white' ? 'black' : s.color)).svg;
      }
      return out;
    }
    case 'note': {
      const size = NOTE_FONT_SIZE[s.size] ?? 18;
      let out = `<rect x="0" y="0" width="${n(s.w)}" height="${n(s.h)}" rx="2" fill="${noteFill(s.color)}" filter="url(#note-shadow)"/>`;
      out += textBlock(s.text, s, 14, 14, s.w - 28, size, 'start', '#1d1d1f').svg;
      return out;
    }
    case 'text': {
      const size = FONT_SIZE[s.size] ?? 24;
      return textBlock(s.text, s, 0, 0, s.fixedWidth ? s.w : 100000, size, 'start', strokeColor(s.color)).svg;
    }
    case 'frame': {
      const lb = localBox(s);
      return `<rect x="0" y="0" width="${n(lb.w)}" height="${n(lb.h)}" fill="rgba(255,255,255,0.04)" stroke="#6b7280" stroke-width="1.5" rx="2"/>` +
        `<text x="2" y="${-FRAME_LABEL + 4}" font-family="${escapeXml(FONT_FAMILY.sans)}" font-size="13" fill="#4b5563" dominant-baseline="hanging">${escapeXml(s.name || 'Frame')}</text>`;
    }
    case 'image': {
      const href = env.asset(s.assetId);
      if (!href) {
        return `<rect width="${n(s.w)}" height="${n(s.h)}" fill="#f3f4f6" stroke="#d1d5db"/>`;
      }
      return `<image href="${escapeXml(href)}" x="0" y="0" width="${n(s.w)}" height="${n(s.h)}" preserveAspectRatio="none"/>`;
    }
  }
}

/** A complete <g> element string for one shape (used by export). */
export function shapeElement(s: Shape, env: RenderEnv): string {
  const t = shapeTransform(s);
  const op = s.opacity < 1 ? ` opacity="${n(s.opacity)}"` : '';
  return `<g${t ? ` transform="${t}"` : ''}${op}>${shapeMarkup(s, env)}</g>`;
}
