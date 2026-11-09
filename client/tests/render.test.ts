import { describe, expect, it } from 'vitest';
import type { Shape } from '../src/model/types';
import { GEO_KINDS } from '../src/model/types';
import { shapeElement, sketchPaths, defsMarkup } from '../src/render/shapeSvg';
import { layoutText } from '../src/render/text';

const base = { rotation: 0, index: 1, groupId: '', locked: false, color: 'red', fill: 'pattern', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 0.5 } as const;
const env = { get: () => undefined, asset: () => 'data:image/png;base64,AAAA' };

describe('shape markup', () => {
  it('renders every shape type and style without throwing', () => {
    const shapes: Shape[] = [
      { ...base, id: 'd', type: 'draw', x: 0, y: 0, w: 10, h: 10, points: [0, 0, 0.5, 5, 5, 0.5, 10, 10, 0.5], highlight: false, ow: 10, oh: 10, done: true, pen: false },
      { ...base, id: 'h', type: 'draw', x: 0, y: 0, w: 10, h: 10, points: [0, 0, 0.5, 10, 10, 0.5], highlight: true, ow: 10, oh: 10, done: true, pen: false },
      { ...base, id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 10 },
      { ...base, id: 'l', type: 'line', x: 0, y: 0, w: 0, h: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0, dash: 'dotted' },
      { ...base, id: 't', type: 'text', x: 0, y: 0, w: 50, h: 20, text: 'a <b>&', fixedWidth: false },
      { ...base, id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'nota' },
      { ...base, id: 'f', type: 'frame', x: 0, y: 0, w: 200, h: 200, name: 'Marco 1' },
      { ...base, id: 'i', type: 'image', x: 0, y: 0, w: 20, h: 20, assetId: 'x' },
      ...GEO_KINDS.map((g) => ({ ...base, id: g, type: 'geo' as const, geo: g, x: 0, y: 0, w: 80, h: 60, text: g === 'cloud' ? 'label' : '', dash: 'draw' as const })),
    ];
    for (const s of shapes) {
      const svg = shapeElement(s, env);
      expect(svg.startsWith('<g'), s.id).toBe(true);
      expect(svg).toContain('opacity="0.5"');
      expect(svg).not.toContain('NaN');
    }
    expect(shapeElement(shapes[4], env)).toContain('a &lt;b&gt;&amp;');
    expect(shapeElement(shapes[0], env)).toMatch(/<path d="M[^"]+Z" fill="#e03131"/);
  });

  it('sketchy strokes are deterministic per shape id', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(sketchPaths(pts, true, 'abc', 2)).toEqual(sketchPaths(pts, true, 'abc', 2));
    expect(sketchPaths(pts, true, 'abc', 2)).not.toEqual(sketchPaths(pts, true, 'xyz', 2));
  });

  it('defines one hatch pattern per colour', () => {
    expect(defsMarkup().match(/<pattern /g)).toHaveLength(12);
  });

  it('wraps text to a width', () => {
    const l = layoutText('uno dos tres cuatro cinco seis', 'sans', 10, 60);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(layoutText('a\nb', 'sans', 10, null).lines).toEqual(['a', 'b']);
  });
});
