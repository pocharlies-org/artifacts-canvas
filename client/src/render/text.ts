import type { Font } from '../model/types';
import { own } from '../model/colors';

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

/** Wrap `text` to `maxWidth` (or not at all when null). Explicit newlines are kept. */
export function layoutText(text: string, font: Font, size: number, maxWidth: number | null): TextLayout {
  const lineHeight = size * LINE_HEIGHT;
  const out: string[] = [];
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
      if (line && measureWidth(candidate.trimEnd(), font, size) > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
        // a single word longer than the width is broken by characters
        while (line && measureWidth(line, font, size) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measureWidth(line.slice(0, cut), font, size) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
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
