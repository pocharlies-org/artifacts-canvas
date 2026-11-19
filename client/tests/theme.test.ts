import { describe, expect, it } from 'vitest';
import { DARK_LUMINANCE, isDark, luminance, opaque, parseColor, toCss } from '../src/ui/theme';

describe('artifact background: parse and validate', () => {
  it('takes rgb() and rgba() as computed styles write them, comma and space syntax', () => {
    expect(parseColor('rgb(11, 11, 15)')).toEqual({ r: 11, g: 11, b: 15, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgba(255,255,255,1)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgb(16 20 24)')).toEqual({ r: 16, g: 20, b: 24, a: 1 });
    expect(parseColor('rgb(16 20 24 / 25%)')).toEqual({ r: 16, g: 20, b: 24, a: 0.25 });
    expect(parseColor('  RGB(1, 2, 3)  ')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgb(10.6, 0, 0)')).toEqual({ r: 11, g: 0, b: 0, a: 1 });
  });

  it('takes hex colours of 3, 4, 6 and 8 digits', () => {
    expect(parseColor('#000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('#0b0b0f')).toEqual({ r: 11, g: 11, b: 15, a: 1 });
    expect(parseColor('#FFF8')).toEqual({ r: 255, g: 255, b: 255, a: 0.533 });
    expect(parseColor('#11223380')).toEqual({ r: 17, g: 34, b: 51, a: 0.502 });
  });

  it('refuses everything else: names, other functions, CSS injection, out of range, wrong types', () => {
    for (const v of [
      'black', 'transparent', 'red', 'hsl(0, 0%, 0%)', 'oklch(0.2 0 0)', 'color(srgb 0 0 0)', 'var(--x)',
      'url(https://example.org/x.png)', 'rgb(0, 0, 0); background: url(x)', 'rgb(0,0,0)}body{display:none',
      'expression(alert(1))', 'rgb(256, 0, 0)', 'rgb(-1, 0, 0)', 'rgba(0, 0, 0, 2)', 'rgb(0, 0)', 'rgb(0, 0, 0, 0, 0)',
      '#12', '#12345', '#1234567', '#ggg', 'rgb(1e3, 0, 0)', '', ' ', `rgb(${'0'.repeat(80)}, 0, 0)`,
    ]) {
      expect(parseColor(v), v).toBeNull();
    }
    for (const v of [null, undefined, 0, 1, {}, [], { r: 0, g: 0, b: 0 }, true]) expect(parseColor(v)).toBeNull();
  });
});

describe('artifact background: luminance, dark or light', () => {
  it('computes WCAG relative luminance', () => {
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 6);
    expect(luminance({ r: 128, g: 128, b: 128, a: 1 })).toBeCloseTo(0.2158, 3);
    expect(luminance({ r: 255, g: 0, b: 0, a: 1 })).toBeCloseTo(0.2126, 4);
  });

  it(`is dark under ${DARK_LUMINANCE}`, () => {
    expect(isDark(parseColor('rgb(11, 11, 15)')!)).toBe(true);
    expect(isDark(parseColor('#101418')!)).toBe(true);
    expect(isDark(parseColor('#1e3a8a')!)).toBe(true); // a dark blue
    expect(isDark(parseColor('#777777')!)).toBe(true); // mid grey, luminance 0.18
    expect(isDark(parseColor('#aaaaaa')!)).toBe(false); // luminance 0.40
    expect(isDark(parseColor('#fafafa')!)).toBe(false);
    expect(isDark(parseColor('#ffffff')!)).toBe(false);
    expect(isDark(parseColor('#fde68a')!)).toBe(false); // a light yellow
  });

  it('a translucent background is seen over white', () => {
    expect(opaque({ r: 0, g: 0, b: 0, a: 0.5 })).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(opaque({ r: 0, g: 0, b: 0, a: 0.1 })).toEqual({ r: 230, g: 230, b: 230, a: 1 });
    expect(isDark({ r: 0, g: 0, b: 0, a: 0.1 })).toBe(false);
    expect(isDark({ r: 0, g: 0, b: 0, a: 0.9 })).toBe(true);
  });

  it('writes CSS from numbers only', () => {
    expect(toCss({ r: 11, g: 11, b: 15, a: 1 })).toBe('rgb(11, 11, 15)');
    expect(toCss({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('rgb(128, 128, 128)');
  });
});
