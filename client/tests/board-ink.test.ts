import { describe, expect, it } from 'vitest';
import type { ColorName, Shape } from '../src/model/types';
import { COLORS, COLOR_ORDER, BLACK_ON_DARK, HIGHLIGHT_DARK_OPACITY, highlightBlend, highlightInk, hexToRgb, strokeColor } from '../src/model/colors';
import { defsMarkup, fillFor, shapeMarkup } from '../src/render/shapeSvg';
import { exportLayers } from '../src/export/export';
import { luminance } from '../src/ui/theme';

/**
 * The shapes follow the board (the artifact's background, ui/theme.ts). On a dark board the
 * highlighter screens in a fluorescent ink (a bright band in front of the page) instead of
 * multiplying (which darkens a dark page almost to black, so the stroke looks behind the text),
 * and `black`, the default ink, is drawn near-white. The stored colour never changes.
 */

const light = { get: () => undefined, asset: () => undefined, dark: false };
const dark = { get: () => undefined, asset: () => undefined, dark: true };
const base = { rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 } as const;

const highlight = (color: ColorName, points = [0, 0, 0.5, 60, 0, 0.5, 120, 4, 0.5]): Shape =>
  ({ ...base, id: 'h', type: 'draw', color, x: 0, y: 0, w: 120, h: 4, points, highlight: true, ow: 120, oh: 4, done: true, pen: false });
const pen = (color: ColorName): Shape =>
  ({ ...base, id: 'p', type: 'draw', color, x: 0, y: 0, w: 120, h: 4, points: [0, 0, 0.5, 60, 0, 0.5, 120, 4, 0.5], highlight: false, ow: 120, oh: 4, done: true, pen: false });

/** What a highlighter stroke turns a page pixel into: the blend at the stroke's opacity (W3C compositing, separable modes). */
function underStroke(page: [number, number, number], ink: ReturnType<typeof highlightInk>): [number, number, number] {
  const c = hexToRgb(ink.color);
  return page.map((b, i) => {
    const s = c[i];
    const mixed = ink.blend === 'multiply' ? (b * s) / 255 : b + s - (b * s) / 255;
    return (1 - ink.opacity) * b + ink.opacity * mixed;
  }) as [number, number, number];
}
const lum = (c: [number, number, number]) => luminance({ r: c[0], g: c[1], b: c[2], a: 1 });

describe('highlighter: multiply on a light board, screen on a dark one', () => {
  it('a light board keeps the marker on paper: the swatch colour, 0.38, multiply', () => {
    const svg = shapeMarkup(highlight('yellow'), light);
    expect(svg).toContain(`stroke="${COLORS.yellow}"`);
    expect(svg).toContain('stroke-opacity="0.38"');
    expect(svg).toContain('style="mix-blend-mode:multiply"');
    expect(svg).not.toContain('screen');
  });

  it('a dark board gets a fluorescent ink that screens', () => {
    const svg = shapeMarkup(highlight('yellow'), dark);
    const ink = highlightInk('yellow', true);
    expect(ink).toEqual({ color: '#ffe81a', opacity: HIGHLIGHT_DARK_OPACITY, blend: 'screen' });
    expect(svg).toContain(`stroke="${ink.color}"`);
    expect(svg).toContain(`stroke-opacity="${HIGHLIGHT_DARK_OPACITY}"`);
    expect(svg).toContain('style="mix-blend-mode:screen"');
    expect(svg).not.toContain('multiply');
  });

  it('a one-point highlight (a dot) is painted the same way as a stroke', () => {
    const dot = highlight('green', [0, 0, 0.5]);
    expect(shapeMarkup(dot, light)).toMatch(/^<circle [^>]*fill="#2f9e44" fill-opacity="0.38" style="mix-blend-mode:multiply"\/>$/);
    expect(shapeMarkup(dot, dark)).toMatch(new RegExp(`^<circle [^>]*fill="${highlightInk('green', true).color}" fill-opacity="${HIGHLIGHT_DARK_OPACITY}" style="mix-blend-mode:screen"/>$`));
  });

  it('every colour lightens a dark page and darkens a light one, and white text under it stays readable', () => {
    const darkPage: [number, number, number] = [17, 17, 16]; // a dark deck's background
    const whitePage: [number, number, number] = [255, 255, 255];
    for (const c of COLOR_ORDER) {
      const onDark = underStroke(darkPage, highlightInk(c, true));
      expect(lum(onDark), c).toBeGreaterThan(lum(darkPage) * 4);
      // white text under the band stays white: screen never darkens
      expect(underStroke([255, 255, 255], highlightInk(c, true)).every((v) => v > 254), c).toBe(true);
      if (c === 'white') continue; // multiply by white leaves white as it is
      const onLight = underStroke(whitePage, highlightInk(c, false));
      expect(lum(onLight), c).toBeLessThan(lum(whitePage));
    }
    // the bug: the old multiply on a dark page leaves it as dark as it was (yellow on #111110)
    const old = underStroke(darkPage, { color: COLORS.yellow, opacity: 0.38, blend: 'multiply' });
    expect(lum(old)).toBeLessThanOrEqual(lum(darkPage));
    // the fix: a visible band (yellow over the same page)
    expect(lum(underStroke(darkPage, highlightInk('yellow', true)))).toBeGreaterThan(0.2);
  });

  it('the blend is one per board, the one the export uses for the highlighter layer', () => {
    expect(highlightBlend(false)).toBe('multiply');
    expect(highlightBlend(true)).toBe('screen');
    for (const d of [false, true]) {
      for (const c of COLOR_ORDER) expect(highlightInk(c, d).blend).toBe(highlightBlend(d));
      expect(exportLayers(d)).toEqual([
        { layer: 0, op: 'source-over' },
        { layer: 1, op: highlightBlend(d) },
        { layer: 2, op: 'source-over' },
      ]);
    }
  });
});

describe('black ink: black on a light board, near-white on a dark one, stored as black', () => {
  it('the colour lookup', () => {
    expect(strokeColor('black')).toBe(COLORS.black);
    expect(strokeColor('black', false)).toBe(COLORS.black);
    expect(strokeColor('black', true)).toBe(BLACK_ON_DARK);
    expect(lum(hexToRgb(BLACK_ON_DARK) as [number, number, number])).toBeGreaterThan(0.85);
    // every other swatch is itself on both boards
    for (const c of COLOR_ORDER.filter((x) => x !== 'black')) expect(strokeColor(c, true), c).toBe(COLORS[c]);
    // an unknown value falls back to black, and follows the board like black
    expect(strokeColor('zzz' as ColorName, true)).toBe(BLACK_ON_DARK);
  });

  it('pen strokes, lines, arrows, shapes and text that use black', () => {
    const shapes: Shape[] = [
      pen('black'),
      { ...base, id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0 },
      { ...base, id: 'l', type: 'line', x: 0, y: 0, w: 0, h: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0 },
      { ...base, id: 'g', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 80, h: 60, text: 'label' },
      { ...base, id: 'gd', type: 'geo', geo: 'ellipse', x: 0, y: 0, w: 80, h: 60, text: '', dash: 'draw' },
      { ...base, id: 't', type: 'text', x: 0, y: 0, w: 50, h: 20, text: 'hola', fixedWidth: false },
    ];
    for (const s of shapes) {
      const onLight = shapeMarkup(s, light);
      const onDark = shapeMarkup(s, dark);
      expect(onLight, s.id).toContain(COLORS.black);
      expect(onLight, s.id).not.toContain(BLACK_ON_DARK);
      expect(onDark, s.id).toContain(BLACK_ON_DARK);
      expect(onDark, s.id).not.toContain(COLORS.black);
      // the same markup but for the colour: nothing else changes with the board
      expect(onDark.split(BLACK_ON_DARK).join(COLORS.black), s.id).toBe(onLight);
      // the shape itself is untouched
      expect(s.color).toBe('black');
    }
  });

  it('other colours draw the same on both boards', () => {
    for (const c of COLOR_ORDER.filter((x) => x !== 'black')) {
      const s = { ...pen(c), id: `p-${c}` };
      expect(shapeMarkup(s, dark), c).toBe(shapeMarkup(s, light));
    }
  });

  it('the fills of a black shape follow the board; the solid grey stays', () => {
    expect(fillFor({ ...base, fill: 'semi' }, false)).toBe('rgba(29,29,31,0.1)');
    expect(fillFor({ ...base, fill: 'semi' }, true)).toBe('rgba(241,243,245,0.1)');
    expect(fillFor({ ...base, fill: 'solid' }, true)).toBe('#495057');
    expect(fillFor({ ...base, fill: 'pattern' }, true)).toBe('url(#hatch-black)');
    // the black hatch pattern is drawn in the board's black
    const hatch = (d: boolean) => defsMarkup(d).match(/<pattern id="hatch-black"[^]*?<\/pattern>/)![0];
    expect(hatch(false)).toContain(`stroke="${COLORS.black}"`);
    expect(hatch(true)).toContain(`stroke="${BLACK_ON_DARK}"`);
    expect(defsMarkup(true).match(/<pattern /g)).toHaveLength(12);
    // other patterns do not move
    expect(defsMarkup(true).replace(hatch(true), '')).toBe(defsMarkup(false).replace(hatch(false), ''));
  });

  it('the label of a white shape: dark on its white fill, white on a dark board without one', () => {
    const geo = (fill: 'none' | 'semi' | 'solid' | 'pattern'): Shape =>
      ({ ...base, id: `w-${fill}`, type: 'geo', geo: 'rectangle', color: 'white', fill, x: 0, y: 0, w: 120, h: 60, text: 'label' });
    const label = (s: Shape, env: typeof light) => shapeMarkup(s, env).match(/<text [^>]*fill="([^"]+)"/)![1];
    for (const fill of ['none', 'semi', 'solid', 'pattern'] as const) expect(label(geo(fill), light), fill).toBe(COLORS.black);
    expect(label(geo('solid'), dark)).toBe(COLORS.black);
    expect(label(geo('semi'), dark)).toBe(COLORS.black);
    expect(label(geo('none'), dark)).toBe(COLORS.white);
    expect(label(geo('pattern'), dark)).toBe(COLORS.white);
  });

  it('a note keeps its light paper and dark text on both boards', () => {
    const note: Shape = { ...base, id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'nota' };
    expect(shapeMarkup(note, dark)).toBe(shapeMarkup(note, light));
  });

  it('without a board flag (older callers) the light look is drawn', () => {
    const env = { get: () => undefined, asset: () => undefined };
    expect(shapeMarkup(pen('black'), env)).toBe(shapeMarkup(pen('black'), light));
    expect(shapeMarkup(highlight('yellow'), env)).toBe(shapeMarkup(highlight('yellow'), light));
  });
});
