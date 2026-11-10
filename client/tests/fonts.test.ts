import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAND_FACES, HAND_FAMILY, exportFontCss, fontFaceCss, fontUrl, toBase64 } from '../src/render/fonts';
import { FONT_FAMILY } from '../src/render/text';
import { exportScale, wrapSvg } from '../src/export/export';
import { shapeElement } from '../src/render/shapeSvg';

const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/fonts');

/** Does a CSS unicode-range list cover code point `cp`? */
function covers(range: string, cp: number): boolean {
  return range.split(',').some((r) => {
    const [a, b] = r.replace('U+', '').split('-');
    const lo = parseInt(a, 16);
    const hi = b ? parseInt(b, 16) : lo;
    return cp >= lo && cp <= hi;
  });
}

describe('bundled hand font', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is first in the draw font stack, before the system hand fonts', () => {
    expect(FONT_FAMILY.draw.startsWith(`"${HAND_FAMILY}",`)).toBe(true);
    expect(FONT_FAMILY.draw.endsWith('cursive')).toBe(true);
  });

  it('ships woff2 files and the OFL licence next to them', () => {
    for (const f of HAND_FACES) {
      const buf = fs.readFileSync(path.join(FONTS, f.file));
      expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    const ofl = fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(ofl).toContain('Shantell Sans Project Authors');
  });

  it('covers the Spanish UI strings (latin + latin-ext)', () => {
    const all = HAND_FACES.map((f) => f.unicodeRange).join(',');
    for (const ch of 'Anónimo ¿nota? ¡Sí! ñÑ áéíóú ü € ŁĞ') expect(covers(all, ch.codePointAt(0)!), ch).toBe(true);
  });

  it('serves the faces from the client bundle base', () => {
    expect(fontUrl('x.woff2', '/_canvas/_/')).toBe('/_canvas/_/fonts/x.woff2');
    expect(fontUrl('x.woff2', '/base')).toBe('/base/fonts/x.woff2');
  });

  it('builds @font-face rules with the unicode ranges', () => {
    const css = fontFaceCss([{ src: 'data:font/woff2;base64,AAAA', unicodeRange: 'U+0000-00FF' }]);
    expect(css).toBe('@font-face{font-family:"Shantell Sans";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,AAAA") format("woff2");unicode-range:U+0000-00FF;}');
  });

  it('embeds the real font bytes as base64 for exports', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      const bytes = fs.readFileSync(path.join(FONTS, url.split('/').pop()!));
      return new Response(bytes);
    });
    const css = await exportFontCss();
    expect(fetched).toEqual(HAND_FACES.map((f) => fontUrl(f.file)));
    expect(css.match(/@font-face/g)).toHaveLength(2);
    const first = fs.readFileSync(path.join(FONTS, HAND_FACES[0].file));
    expect(css).toContain(`data:font/woff2;base64,${toBase64(new Uint8Array(first))}`);
    expect(css).toContain(HAND_FACES[1].unicodeRange);
  });

  it('puts the @font-face inside the export SVG, before the hand-font text', () => {
    const text = shapeElement(
      { id: 't', type: 'text', x: 0, y: 0, w: 50, h: 20, text: 'Anónimo ¿nota?', fixedWidth: false, rotation: 0, index: 1, groupId: '', locked: false, color: 'red', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 } as never,
      { get: () => undefined, asset: () => undefined },
    );
    expect(text).toContain('Shantell Sans');
    const css = fontFaceCss([{ src: 'data:font/woff2;base64,AAAA', unicodeRange: 'U+0000-00FF' }]);
    const svg = wrapSvg(text, { x: 10, y: 20, w: 300, h: 200 }, 2, css);
    expect(svg).toMatch(/^<svg [^>]*width="600" height="400" viewBox="10 20 300 200"><defs><style>@font-face\{font-family:"Shantell Sans";/);
    expect(svg.indexOf('@font-face')).toBeLessThan(svg.indexOf('<text'));
    expect(wrapSvg(text, { x: 0, y: 0, w: 1, h: 1 }, 1)).not.toContain('<style>');
  });
});

describe('export scale', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('view export: one world unit = zoom x pixel ratio output px (the screen, not 1:1 world)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    // a 1440x900 viewport at 150% shows 960x600 world units; it must export at 1440x900
    expect(exportScale({ x: 0, y: 0, w: 960, h: 600 }, 'view', 1.5)).toBe(1.5);
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(exportScale({ x: 0, y: 0, w: 960, h: 600 }, 'view', 1.5)).toBe(3);
    expect(exportScale({ x: 0, y: 0, w: 2880, h: 1800 }, 'view', 0.5)).toBe(1);
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(exportScale({ x: 0, y: 0, w: 1440, h: 900 }, 'view', 1)).toBe(2); // ratio capped at 2
  });

  it('full export keeps 1.5 px per artifact px, capped at 16000 px a side', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(exportScale({ x: 0, y: 0, w: 1000, h: 5000 }, 'full', 3)).toBe(1.5);
    expect(exportScale({ x: 0, y: 0, w: 1000, h: 32000 }, 'full')).toBe(0.5);
  });
});
