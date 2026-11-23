import type { ColorName } from './types';

/** The 12 swatches of the style panel, in panel order (as in the approved mockup), as a light board shows them. */
export const COLORS: Record<ColorName, string> = {
  black: '#1d1d1f',
  grey: '#868e96',
  violet: '#7048e8',
  pink: '#d6336c',
  blue: '#1971c2',
  'light-blue': '#4dabf7',
  orange: '#f08c00',
  yellow: '#fab005',
  red: '#e03131',
  green: '#2f9e44',
  'light-green': '#69db7c',
  white: '#ffffff',
};

export const COLOR_ORDER = Object.keys(COLORS) as ColorName[];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Mix a colour with white. t=0 -> colour, t=1 -> white. */
export function tint(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(c + (255 - c) * t);
  return '#' + [m(r), m(g), m(b)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * `rec[key]` when `key` is an OWN key of `rec`, else `fallback`. Every lookup of a style
 * value from the document goes through this: a value outside the allow-list (or a name like
 * `__proto__`, which would return Object.prototype) never reaches the renderer.
 */
export function own<K extends string, V>(rec: Readonly<Record<K, V>>, key: unknown, fallback: NoInfer<V>): V {
  return typeof key === 'string' && Object.hasOwn(rec, key) ? rec[key as K] : fallback;
}

/** The colour name itself when it is one of the swatches, else 'black'. */
export function colorName(c: unknown): ColorName {
  return typeof c === 'string' && Object.hasOwn(COLORS, c) ? (c as ColorName) : 'black';
}

/**
 * `black` as a dark board shows it: near-white, the way tldraw draws black in dark mode. The
 * stored colour stays `black`, so the same stroke is black on a light board and light on a dark
 * one, and the default ink is visible on both.
 */
export const BLACK_ON_DARK = '#f1f3f5';

/** The colour a swatch is drawn in on the board (`dark`: the board is dark, ui/theme.ts). */
export function strokeColor(c: ColorName, dark = false): string {
  const hex = own(COLORS, c, COLORS.black);
  return dark && hex === COLORS.black ? BLACK_ON_DARK : hex;
}

/** Fluorescent highlighter inks for a dark board, one per swatch. */
const HIGHLIGHT_ON_DARK: Record<ColorName, string> = {
  black: BLACK_ON_DARK,
  grey: '#ced4da',
  violet: '#c69cff',
  pink: '#ff6bb5',
  blue: '#3db8ff',
  'light-blue': '#2ef2ff',
  orange: '#ffa31a',
  yellow: '#ffe81a',
  red: '#ff5c5c',
  green: '#3dff8b',
  'light-green': '#9dff4d',
  white: '#ffffff',
};

/** How a highlighter stroke is painted: its ink, its opacity and how it mixes with the page under it. */
export interface HighlightInk {
  color: string;
  opacity: number;
  blend: 'multiply' | 'screen';
}

/** Opacity of a highlighter stroke on a dark board (screen). */
export const HIGHLIGHT_DARK_OPACITY = 0.7;

/**
 * A highlighter stroke sits above the page and mixes with it. On a light board it multiplies, so
 * it only darkens, like a marker on paper. Multiply on a dark page darkens it further, almost to
 * black, and the text shows through as if the stroke were behind it. On a dark board it screens
 * instead: it only lightens, in a fluorescent ink, so it reads as a bright band in front of the
 * page, and white text under it stays white.
 */
export function highlightInk(c: ColorName, dark: boolean): HighlightInk {
  const blend = highlightBlend(dark);
  if (!dark) return { color: strokeColor(c), opacity: 0.38, blend };
  return { color: own(HIGHLIGHT_ON_DARK, c, HIGHLIGHT_ON_DARK.black), opacity: HIGHLIGHT_DARK_OPACITY, blend };
}

/** The blend of every highlighter stroke on a light (multiply) or a dark (screen) board. */
export function highlightBlend(dark: boolean): HighlightInk['blend'] {
  return dark ? 'screen' : 'multiply';
}

/** Background of a sticky note of colour `c`. */
export function noteFill(c: ColorName): string {
  if (c === 'white') return '#ffffff';
  if (c === 'black') return '#e9ecef';
  return tint(own(COLORS, c, COLORS.black), 0.78);
}

/** Person colours: stable per user id. Anonymous people get muted greys/teals. */
const PERSON = ['#2f9e44', '#7048e8', '#1971c2', '#e8590c', '#d6336c', '#0c8599', '#5f3dc4', '#c2255c', '#2b8a3e', '#e67700', '#1864ab', '#862e9c'];
const ANON = ['#868e96', '#5c7080', '#7a8288', '#6c757d', '#839099', '#5f6b73'];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function personColor(id: string, anonymous: boolean): string {
  const pal = anonymous ? ANON : PERSON;
  return pal[hashString(id) % pal.length];
}

/** Colour of the laser pointer (same for everyone, as in the mockup). */
export const LASER_COLOR = '#ff2d55';
