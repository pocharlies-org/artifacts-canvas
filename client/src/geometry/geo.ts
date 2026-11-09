import type { GeoKind } from '../model/types';
import type { Pt } from './vec';

/**
 * Outline of a geo shape as a closed polygon in local coordinates (0..w, 0..h).
 * Curved kinds (ellipse, cloud, heart, oval) are sampled densely enough to render smoothly.
 */
export function geoOutline(kind: GeoKind, w: number, h: number): Pt[] {
  w = Math.max(w, 1);
  h = Math.max(h, 1);
  switch (kind) {
    case 'rectangle':
    case 'check-box':
    case 'x-box':
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    case 'ellipse':
      return ellipse(w, h, 72);
    case 'triangle':
      return [{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    case 'diamond':
      return [{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }];
    case 'pentagon':
      return regular(5, w, h);
    case 'hexagon':
      return regular(6, w, h, 0);
    case 'octagon':
      return regular(8, w, h, Math.PI / 8);
    case 'star':
      return star(w, h);
    case 'rhombus': {
      const o = Math.min(w * 0.25, h);
      return [{ x: o, y: 0 }, { x: w, y: 0 }, { x: w - o, y: h }, { x: 0, y: h }];
    }
    case 'trapezoid': {
      const o = Math.min(w * 0.22, h);
      return [{ x: o, y: 0 }, { x: w - o, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    }
    case 'oval':
      return stadium(w, h);
    case 'cloud':
      return cloud(w, h);
    case 'heart':
      return heart(w, h);
    case 'arrow-right':
      return blockArrow(w, h);
    case 'arrow-left':
      return blockArrow(w, h).map((p) => ({ x: w - p.x, y: p.y }));
    case 'arrow-down':
      return blockArrow(h, w).map((p) => ({ x: p.y, y: p.x }));
    case 'arrow-up':
      return blockArrow(h, w).map((p) => ({ x: p.y, y: h - p.x }));
    default:
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }
}

/** Extra open strokes drawn inside a geo shape (the check of check-box, the X of x-box). */
export function geoExtras(kind: GeoKind, w: number, h: number): Pt[][] {
  if (kind === 'check-box') {
    return [[{ x: w * 0.22, y: h * 0.52 }, { x: w * 0.42, y: h * 0.74 }, { x: w * 0.8, y: h * 0.28 }]];
  }
  if (kind === 'x-box') {
    return [
      [{ x: w * 0.22, y: h * 0.22 }, { x: w * 0.78, y: h * 0.78 }],
      [{ x: w * 0.78, y: h * 0.22 }, { x: w * 0.22, y: h * 0.78 }],
    ];
  }
  return [];
}

function ellipse(w: number, h: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: w / 2 + (Math.cos(a) * w) / 2, y: h / 2 + (Math.sin(a) * h) / 2 });
  }
  return out;
}

function regular(n: number, w: number, h: number, offset = -Math.PI / 2): Pt[] {
  const raw: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = offset + (i / n) * Math.PI * 2;
    raw.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  return fitTo(raw, w, h);
}

function star(w: number, h: number): Pt[] {
  const raw: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.42;
    raw.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return fitTo(raw, w, h);
}

function stadium(w: number, h: number): Pt[] {
  const out: Pt[] = [];
  const horizontal = w >= h;
  const r = (horizontal ? h : w) / 2;
  const seg = 18;
  if (horizontal) {
    for (let i = 0; i <= seg; i++) {
      const a = -Math.PI / 2 + (i / seg) * Math.PI;
      out.push({ x: w - r + Math.cos(a) * r, y: r + Math.sin(a) * r });
    }
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI / 2 + (i / seg) * Math.PI;
      out.push({ x: r + Math.cos(a) * r, y: r + Math.sin(a) * r });
    }
  } else {
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI + (i / seg) * Math.PI;
      out.push({ x: r + Math.cos(a) * r, y: r + Math.sin(a) * r });
    }
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI;
      out.push({ x: r + Math.cos(a) * r, y: h - r + Math.sin(a) * r });
    }
  }
  return out;
}

function cloud(w: number, h: number): Pt[] {
  const bumps = Math.max(7, Math.min(14, Math.round((w + h) / 45)));
  const base = ellipse(w * 0.84, h * 0.76, bumps).map((p) => ({ x: p.x + w * 0.08, y: p.y + h * 0.12 }));
  const c = { x: w / 2, y: h / 2 };
  const out: Pt[] = [];
  for (let i = 0; i < bumps; i++) {
    const a = base[i];
    const b = base[(i + 1) % bumps];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = { x: m.x - c.x, y: m.y - c.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const bulge = Math.hypot(b.x - a.x, b.y - a.y) * 0.55;
    const ctrl = { x: m.x + (d.x / l) * bulge, y: m.y + (d.y / l) * bulge };
    for (let k = 0; k < 8; k++) {
      const t = k / 8;
      const it = 1 - t;
      out.push({ x: it * it * a.x + 2 * it * t * ctrl.x + t * t * b.x, y: it * it * a.y + 2 * it * t * ctrl.y + t * t * b.y });
    }
  }
  return fitTo(out, w, h);
}

function heart(w: number, h: number): Pt[] {
  const raw: Pt[] = [];
  const n = 72;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    raw.push({
      x: 16 * Math.sin(t) ** 3,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    });
  }
  return fitTo(raw, w, h);
}

function blockArrow(w: number, h: number): Pt[] {
  const head = Math.min(w * 0.45, h);
  const shaftTop = h * 0.28;
  const shaftBot = h * 0.72;
  return [
    { x: 0, y: shaftTop },
    { x: w - head, y: shaftTop },
    { x: w - head, y: 0 },
    { x: w, y: h / 2 },
    { x: w - head, y: h },
    { x: w - head, y: shaftBot },
    { x: 0, y: shaftBot },
  ];
}

/** Scale raw points to exactly fill 0..w x 0..h. */
function fitTo(raw: Pt[], w: number, h: number): Pt[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const sx = w / (maxX - minX || 1);
  const sy = h / (maxY - minY || 1);
  return raw.map((p) => ({ x: (p.x - minX) * sx, y: (p.y - minY) * sy }));
}
