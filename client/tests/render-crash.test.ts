import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readShape } from '../src/model/doc';
import { shapeMarkup } from '../src/render/shapeSvg';
import { shapeValueProblem } from '@pocharlies/artifacts-canvas-shared/stamper';
import type { Shape } from '../src/model/types';

/**
 * Regression of the third verifier's render-crash.mts (fv3 findings 3 and 4): a style value
 * outside its allow-list, or a field named `__proto__`, used to throw inside the renderer
 * (one bad shape aborted the whole render pass for every viewer) or to give the shape
 * object an attacker-chosen prototype (a 3e8-point "stroke" froze the tab). The server now
 * refuses all of them; the client reader falls back to defaults and never reads unknown
 * fields, and the render lookups are own-key only.
 */
const env = { get: () => undefined, asset: () => undefined };

function stored(f: Record<string, unknown>, extra?: (m: Y.Map<unknown>) => void): { shapes: Y.Map<unknown>; m: Y.Map<unknown> } {
  const d = new Y.Doc();
  const shapes = d.getMap('shapes');
  const m = new Y.Map<unknown>();
  shapes.set('s', m);
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  extra?.(m);
  return { shapes, m };
}

describe('render-crash.mts (fv3)', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['note color=zzz', { type: 'note', color: 'zzz', x: 0, y: 0, w: 100, h: 100 }],
    ['text font=zzz', { type: 'text', font: 'zzz', text: 'hi', x: 0, y: 0, w: 100, h: 20 }],
    ['geo fill=zzz', { type: 'geo', geo: 'rectangle', fill: 'zzz', x: 0, y: 0, w: 10, h: 10 }],
    ['geo size=zzz', { type: 'geo', geo: 'rectangle', size: 'zzz', text: 'a', x: 0, y: 0, w: 10, h: 10 }],
    ['note color=__proto__', { type: 'note', color: '__proto__' }],
    ['geo dash=constructor', { type: 'geo', geo: 'rectangle', dash: 'constructor' }],
    ['arrow arrowheads=zzz', { type: 'arrow', start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, arrowheads: 'zzz' }],
  ];
  for (const [label, f] of cases) {
    it(`${label}: refused by the server schema, rendered with the default by the client`, () => {
      const { shapes, m } = stored(f);
      expect(shapeValueProblem(shapes, 's')).toBe('shapes-schema');
      const s = readShape(m, 's');
      expect(s).not.toBeNull();
      expect(() => shapeMarkup(s!, env as never)).not.toThrow();
      expect(shapeMarkup(s!, env as never)).not.toContain('undefined');
    });
  }

  it('the renderer lookups never throw on a raw invalid shape (no reader in between)', () => {
    const raw = { id: 'r', type: 'note', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'zzz', fill: '__proto__', dash: 'zzz', size: 'zzz', font: 'zzz', arrowheads: 'zzz', opacity: 1, text: 'x' } as unknown as Shape;
    expect(() => shapeMarkup(raw, env as never)).not.toThrow();
    const geo = { ...raw, type: 'geo', geo: 'rectangle', fill: 'pattern', color: 'constructor' } as unknown as Shape;
    expect(shapeMarkup(geo, env as never)).toContain('url(#hatch-black)');
  });

  it('a `__proto__` field never becomes the prototype of the shape object', () => {
    const { shapes, m } = stored({ type: 'text' }, (mm) => mm.set('__proto__', { text: 12345, font: 'nope' }));
    expect(shapeValueProblem(shapes, 's')).toBe('shapes-schema');
    const s = readShape(m, 's') as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(s)).toBeNull();
    expect(s.text).toBe(''); // the default, not the inherited 12345
    expect(s.font).toBe('draw');
    expect(() => shapeMarkup(s as never, env as never)).not.toThrow();
  });

  it('a `__proto__` field with a fake 3e7-point list renders instantly (it is never read)', () => {
    const { shapes, m } = stored({ type: 'draw', x: 0, y: 0, w: 10, h: 10 }, (mm) => mm.set('__proto__', { points: { length: 3e7 }, ow: 0, done: false }));
    expect(shapeValueProblem(shapes, 's')).toBe('shapes-schema');
    const s = readShape(m, 's') as unknown as Record<string, unknown>;
    expect(s.points).toEqual([]);
    const t0 = Date.now();
    shapeMarkup(s as never, env as never);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('a terminal decoded with a `__proto__` key is refused (no inherited bind)', () => {
    const start = JSON.parse('{"x":0,"y":0,"__proto__":{"bind":{"shapeId":"x","nx":0,"ny":0}}}');
    const { shapes, m } = stored({ type: 'arrow', start, end: { x: 5, y: 5 } });
    expect(shapeValueProblem(shapes, 's')).toBe('shapes-schema');
    expect(readShape(m, 's')).toBeNull();
  });

  it('a forbidden shape id is never read', () => {
    const d = new Y.Doc();
    const m = new Y.Map<unknown>();
    d.getMap('shapes').set('__proto__', m);
    m.set('type', 'geo');
    expect(readShape(m, '__proto__')).toBeNull();
  });
});
