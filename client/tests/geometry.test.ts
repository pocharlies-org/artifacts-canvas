import { describe, expect, it } from 'vitest';
import { CanvasDoc } from '../src/model/doc';
import type { DrawShape, GeoShape, LineShape, Shape } from '../src/model/types';
import { GEO_KINDS } from '../src/model/types';
import { geoOutline } from '../src/geometry/geo';
import {
  hitTest, lineGeometry, marqueeHits, normaliseDraw, segmentHits, shapeBounds, toLocal, toWorld,
} from '../src/geometry/shapes';
import { resizeBox, resizeSinglePatch, rotatePatches, scalePatches, translatePatches } from '../src/geometry/transform';
import { boxFromPoints, distToSegment, pointInPolygon, segmentsIntersect } from '../src/geometry/vec';

const base = { rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 } as const;
const rect = (over: Partial<GeoShape> = {}): GeoShape => ({ ...base, id: 'r', type: 'geo', geo: 'rectangle', text: '', x: 100, y: 100, w: 200, h: 100, ...over });
const ctxOf = (...shapes: Shape[]) => ({ get: (id: string) => shapes.find((s) => s.id === id) });

describe('vector helpers', () => {
  it('segments, polygons, distances', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 9 })).toBe(false);
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(pointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
    expect(boxFromPoints([{ x: 3, y: 4 }, { x: -1, y: 9 }])).toEqual({ x: -1, y: 4, w: 4, h: 5 });
  });
});

describe('geo outlines', () => {
  it('every geo kind fills its box exactly', () => {
    for (const k of GEO_KINDS) {
      const b = boxFromPoints(geoOutline(k, 120, 80));
      expect(b.x, k).toBeCloseTo(0, 5);
      expect(b.y, k).toBeCloseTo(0, 5);
      expect(b.w, k).toBeCloseTo(120, 5);
      expect(b.h, k).toBeCloseTo(80, 5);
    }
  });
});

describe('bounds, rotation and hit testing', () => {
  it('rotated shapes have rotated bounds and local/world round-trips', () => {
    const r = rect({ rotation: Math.PI / 2 });
    const b = shapeBounds(r, ctxOf(r));
    expect(b.w).toBeCloseTo(100);
    expect(b.h).toBeCloseTo(200);
    const w = toWorld(r, { x: 10, y: 20 });
    const l = toLocal(r, w);
    expect(l.x).toBeCloseTo(10);
    expect(l.y).toBeCloseTo(20);
  });

  it('hits inside hollow geo when selecting, only the outline when erasing', () => {
    const r = rect();
    const ctx = ctxOf(r);
    expect(hitTest(r, { x: 200, y: 150 }, 2, ctx, 'select')).toBe(true);
    expect(hitTest(r, { x: 200, y: 150 }, 2, ctx, 'erase')).toBe(false);
    expect(hitTest(r, { x: 101, y: 150 }, 2, ctx, 'erase')).toBe(true);
    expect(hitTest(r, { x: 50, y: 50 }, 2, ctx)).toBe(false);
  });

  it('eraser segments and marquee boxes', () => {
    const r = rect();
    const ctx = ctxOf(r);
    expect(segmentHits(r, { x: 90, y: 150 }, { x: 120, y: 150 }, 2, ctx)).toBe(true);
    expect(segmentHits(r, { x: 0, y: 0 }, { x: 50, y: 50 }, 2, ctx)).toBe(false);
    expect(marqueeHits(r, { x: 0, y: 0, w: 400, h: 400 }, ctx)).toBe(true); // contains
    expect(marqueeHits(r, { x: 250, y: 50, w: 100, h: 100 }, ctx)).toBe(true); // crosses the outline
    expect(marqueeHits(r, { x: 150, y: 120, w: 20, h: 20 }, ctx)).toBe(false); // fully inside a hollow shape
  });
});

describe('arrows bind to shapes and follow them', () => {
  it('a bound end lands on the shape edge and moves with the shape', () => {
    const r = rect();
    const a: LineShape = { ...base, id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, bend: 0, start: { x: 0, y: 150 }, end: { x: 200, y: 150, bind: { shapeId: 'r', nx: 0.5, ny: 0.5 } } };
    let g = lineGeometry(a, ctxOf(r, a));
    expect(g.b.x).toBeCloseTo(96, 0); // left edge (100) minus the 4px gap
    expect(g.b.y).toBeCloseTo(150);
    const moved = { ...r, x: 300, y: 300 };
    g = lineGeometry(a, ctxOf(moved, a));
    expect(g.b.x).toBeGreaterThan(290);
    expect(g.b.y).toBeGreaterThan(290);
  });

  it('translating only the arrow keeps the binding; translating both keeps it too', () => {
    const r = rect();
    const a: LineShape = { ...base, id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, bend: 0, start: { x: 0, y: 0 }, end: { x: 200, y: 150, bind: { shapeId: 'r', nx: 0.5, ny: 0.5 } } };
    const p = translatePatches([a], 10, 10, ctxOf(r, a)).get('a')!;
    expect(p.start).toEqual({ x: 10, y: 10 });
    expect((p.end as LineShape['end']).bind?.shapeId).toBe('r');
  });

  it('bent lines pass through their bend point', () => {
    const a: LineShape = { ...base, id: 'a', type: 'line', x: 0, y: 0, w: 0, h: 0, bend: 20, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
    const g = lineGeometry(a, ctxOf(a));
    const mid = g.pts[Math.floor(g.pts.length / 2)];
    expect(Math.abs(mid.y)).toBeCloseTo(20, 0);
  });
});

describe('transforms', () => {
  it('resizing from a corner keeps the opposite corner', () => {
    const nb = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, 0, 'se', { x: 200, y: 150 }, false);
    expect(nb).toEqual({ x: 0, y: 0, w: 200, h: 150 });
    const keep = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, 0, 'se', { x: 200, y: 60 }, true);
    expect(keep.w / keep.h).toBeCloseTo(2);
  });

  it('resizing a rotated shape keeps its anchored corner in place', () => {
    const r = rect({ rotation: Math.PI / 4 });
    const anchorBefore = toWorld(r, { x: 0, y: 0 });
    const target = toWorld(r, { x: 300, y: 150 });
    const patch = resizeSinglePatch(r, 'se', target, false, false);
    const r2 = { ...r, ...patch } as GeoShape;
    const anchorAfter = toWorld(r2, { x: 0, y: 0 });
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 4);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 4);
    expect(r2.w).toBeCloseTo(300);
    expect(r2.h).toBeCloseTo(150);
  });

  it('scales several shapes and rotates around the selection centre', () => {
    const a = rect({ id: 'a', x: 0, y: 0, w: 100, h: 100 });
    const b = rect({ id: 'b', x: 100, y: 0, w: 100, h: 100 });
    const p = scalePatches([a, b], { x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 400, h: 100 }, ctxOf(a, b));
    expect(p.get('b')).toMatchObject({ x: 200, w: 200 });
    const rp = rotatePatches([a, b], { x: 100, y: 50 }, Math.PI, ctxOf(a, b));
    expect(rp.get('a')!.x as number).toBeCloseTo(100);
    expect(rp.get('a')!.rotation as number).toBeCloseTo(Math.PI);
  });

  it('normalises a finished freehand stroke to a 0-based box', () => {
    const d: DrawShape = { ...base, id: 'd', type: 'draw', x: 50, y: 50, w: 0, h: 0, points: [0, 0, 0.5, -10, 5, 0.5, 20, -8, 0.5], highlight: false, ow: 0, oh: 0, done: false, pen: false };
    const n = normaliseDraw(d);
    expect(n).toMatchObject({ x: 40, y: 42, w: 30, h: 13, ow: 30, oh: 13 });
    expect(Math.min(n.points[0], n.points[3], n.points[6])).toBe(0);
  });
});

describe('live document geometry', () => {
  it('works on shapes read back from the document', () => {
    const d = new CanvasDoc();
    const id = d.create({ type: 'geo', geo: 'star', x: 0, y: 0, w: 100, h: 100, text: '' } as never);
    const s = d.get(id)!;
    expect(hitTest(s, { x: 50, y: 50 }, 1, { get: (x) => d.get(x) })).toBe(true);
  });
});

import { frameChildren } from '../src/geometry/transform';
describe('frames', () => {
  it('carry the shapes whose centre is inside them', () => {
    const f = { ...base, id: 'f', type: 'frame', name: 'F', x: 0, y: 0, w: 300, h: 200 } as Shape;
    const inside = rect({ id: 'in', x: 10, y: 10, w: 50, h: 50 });
    const outside = rect({ id: 'out', x: 400, y: 10, w: 50, h: 50 });
    const ctx = ctxOf(f, inside, outside);
    expect(frameChildren(f, [f, inside, outside], (s) => shapeBounds(s, ctx)).map((s) => s.id)).toEqual(['in']);
  });
});
