import type { ColorName } from './types';

/** The 12 swatches of the style panel, in panel order (as in the approved mockup). */
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

export function strokeColor(c: ColorName): string {
  return COLORS[c] ?? COLORS.black;
}

/** Background of a sticky note of colour `c`. */
export function noteFill(c: ColorName): string {
  if (c === 'white') return '#ffffff';
  if (c === 'black') return '#e9ecef';
  return tint(COLORS[c], 0.78);
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
