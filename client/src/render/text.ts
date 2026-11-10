import type { Font } from '../model/types';
import { own } from '../model/colors';
import { MAX_TEXT_LENGTH } from '@pocharlies/artifacts-canvas-shared/model';

/** The bundled hand font (client/public/fonts, loaded by render/fonts.ts). */
export const HAND_FAMILY = 'Shantell Sans';

export const FONT_FAMILY: Record<Font, string> = {
  draw: `"${HAND_FAMILY}","Comic Sans MS","Segoe Print","Bradley Hand","Chalkboard SE","Comic Neue",cursive`,
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif',
  serif: 'Georgia,"Times New Roman",Times,serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
};

export const LINE_HEIGHT = 1.35;

let ctx2d: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx2d !== undefined) return ctx2d;
  try {
    ctx2d = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  } catch {
    ctx2d = null;
  }
  return ctx2d;
}

const widthCache = new Map<string, number>();

/** Forget measured widths (after a web font finishes loading the old ones are wrong). */
export function clearMeasureCache() {
  widthCache.clear();
}

export function measureWidth(text: string, font: Font, size: number): number {
  const key = `${font}|${size}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const c = measureCtx();
  let w: number;
  if (c) {
    c.font = `${size}px ${own(FONT_FAMILY, font, FONT_FAMILY.draw)}`;
    w = c.measureText(text).width;
  } else {
    w = text.length * size * (font === 'mono' ? 0.6 : 0.55);
  }
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export interface TextLayout {
  lines: string[];
  width: number;
  height: number;
  lineHeight: number;
}

/**
 * Longest prefix of `word` (at least one character) that fits in `maxWidth`. Galloping then
 * binary search: O(log k) measurements of at most 2k characters, k = the answer. The old
 * character-by-character shrink was O(n) measurements of O(n) characters per line — cubic
 * in the length of one unbroken word (fv4 H3: 6000 characters froze a viewer for 42 s).
 */
function fittingPrefix(word: string, font: Font, size: number, maxWidth: number): number {
  let lo = 1; // fits (or is the one character a line always takes)
  let hi = 2;
  while (hi <= word.length && measureWidth(word.slice(0, hi), font, size) <= maxWidth) {
    lo = hi;
    hi *= 2;
  }
  hi = Math.min(hi, word.length + 1); // first length known (or assumed) not to fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (measureWidth(word.slice(0, mid), font, size) <= maxWidth) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Wrap `text` to `maxWidth` (or not at all when null). Explicit newlines are kept. At most
 * MAX_TEXT_LENGTH characters are laid out (the server refuses longer text; a document
 * written before that limit is shown truncated instead of freezing the tab).
 */
export function layoutText(text: string, font: Font, size: number, maxWidth: number | null): TextLayout {
  const lineHeight = size * LINE_HEIGHT;
  const out: string[] = [];
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  for (const para of text.split('\n')) {
    if (maxWidth === null) {
      out.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      if (!word) continue;
      const candidate = line + word;
      if (measureWidth(candidate.trimEnd(), font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate.trimStart();
      }
      // a word longer than the width is broken by characters; the line kept is the rest,
      // which fits (only fitting text is ever measured again for the next word)
      while (line.length > 1) {
        const cut = fittingPrefix(line, font, size, maxWidth);
        if (cut >= line.length) break;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  let width = 0;
  for (const l of out) width = Math.max(width, measureWidth(l, font, size));
  return { lines: out, width, height: Math.max(1, out.length) * lineHeight, lineHeight };
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
