/**
 * The board follows the artifact's background (docs/protocol.md §3 "Background"). The reporter
 * posts the page's effective background colour; this module checks it strictly (only `rgb()`,
 * `rgba()` and hex colours, never arbitrary CSS), turns it into an opaque colour (over white, the
 * browser's canvas colour) and says whether it is dark, so the canvas chrome and the default
 * stroke colour can follow.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** The board before the artifact has said anything: white, the browser's own page colour. */
export const DEFAULT_BOARD: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** Below this relative luminance the board is dark: dark chrome, a light default stroke. */
export const DARK_LUMINANCE = 0.4;

const MAX_COLOR_LENGTH = 64;
const NUM = String.raw`(\d{1,3}(?:\.\d+)?)`;
const ALPHA = String.raw`(\d*\.?\d+%?)`;
// legacy comma syntax and the CSS Color 4 space syntax, as computed styles serialise them
const RGB_COMMA = new RegExp(String.raw`^rgba?\(\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*(?:,\s*${ALPHA}\s*)?\)$`, 'i');
const RGB_SPACE = new RegExp(String.raw`^rgba?\(\s*${NUM}\s+${NUM}\s+${NUM}\s*(?:\/\s*${ALPHA}\s*)?\)$`, 'i');
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse a colour the reporter sent; null for anything but rgb(), rgba() or a hex colour. */
export function parseColor(v: unknown): Rgba | null {
  if (typeof v !== 'string' || v.length > MAX_COLOR_LENGTH) return null;
  const s = v.trim();
  const m = RGB_COMMA.exec(s) ?? RGB_SPACE.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (![r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) return null;
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      if (!Number.isFinite(a) || a < 0 || a > 1) return null;
    }
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  const h = HEX.exec(s);
  if (h) {
    let x = h[1];
    if (x.length <= 4) x = x.split('').map((c) => c + c).join('');
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: x.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  return null;
}

/** The colour as seen on the board: composited over white (what the browser shows under a translucent page). */
export function opaque(c: Rgba): Rgba {
  if (c.a >= 1) return { ...c, a: 1 };
  const mix = (v: number) => Math.round(v * c.a + 255 * (1 - c.a));
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: 1 };
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function isDark(c: Rgba): boolean {
  return luminance(opaque(c)) < DARK_LUMINANCE;
}

/** CSS for an opaque colour (built from numbers only: nothing the artifact wrote reaches a style). */
export function toCss(c: Rgba): string {
  const o = opaque(c);
  return `rgb(${o.r}, ${o.g}, ${o.b})`;
}
