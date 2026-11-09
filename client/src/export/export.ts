import type { Editor } from '../editor/editor';
import { shapeBounds } from '../geometry/shapes';
import { type Box, boxesOverlap } from '../geometry/vec';
import { defsMarkup, shapeElement } from '../render/shapeSvg';
import { buildPdf, type PdfPage } from './pdf';

export type ExportScope = 'view' | 'full';
export type ExportFormat = 'png' | 'pdf';

const MAX_SIDE = 16000;
const BG = '#e9ebef';

/** SVG of the annotations inside `rect` (world units), sized rect * scale. */
export function annotationsSvg(ed: Editor, rect: Box, scale: number): string {
  const env = ed.renderer.env;
  const shapes = ed.annotationsVisible ? ed.visibleShapes().filter((s) => boxesOverlap(shapeBounds(s, env), rect)) : [];
  const body = shapes.map((s) => shapeElement(s, env)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(rect.w * scale)}" height="${Math.round(rect.h * scale)}" viewBox="${rect.x} ${rect.y} ${rect.w} ${rect.h}"><defs>${defsMarkup()}</defs>${body}</svg>`;
}

/** Render artifact + annotations of a world rectangle into a canvas. */
export async function renderRegion(ed: Editor, rect: Box, scale: number): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w * scale));
  c.height = Math.max(1, Math.round(rect.h * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, c.width, c.height);
  // the artifact page
  const page = ed.pageBox();
  const inter = intersect(rect, page);
  if (inter) {
    ctx.fillStyle = '#fff';
    ctx.fillRect((inter.x - rect.x) * scale, (inter.y - rect.y) * scale, inter.w * scale, inter.h * scale);
    const img = await ed.frame.snapshot(inter, scale);
    if (img) ctx.drawImage(img, (inter.x - rect.x) * scale, (inter.y - rect.y) * scale, inter.w * scale, inter.h * scale);
  }
  // annotations
  const svg = annotationsSvg(ed, rect, scale);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return c;
}

export function exportRect(ed: Editor, scope: ExportScope): Box {
  if (scope === 'view') return ed.visibleWorld();
  const b = ed.contentBox();
  const pad = 24;
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

export function exportScale(rect: Box, scope: ExportScope): number {
  const want = scope === 'view' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1.5;
  return Math.max(0.1, Math.min(want, MAX_SIDE / rect.w, MAX_SIDE / rect.h));
}

export async function exportCanvas(ed: Editor, format: ExportFormat, scope: ExportScope): Promise<{ blob: Blob; filename: string }> {
  ed.renderer.flush();
  const rect = exportRect(ed, scope);
  const scale = exportScale(rect, scope);
  const canvas = await renderRegion(ed, rect, scale);
  const base = fileBase(ed);
  if (format === 'png') {
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    return { blob, filename: `${base}.png` };
  }
  const pages = await pdfPages(canvas);
  const pdf = buildPdf(pages, ed.frame.title || ed.cfg.title || ed.cfg.artifactPath);
  return { blob: new Blob([pdf as BlobPart], { type: 'application/pdf' }), filename: `${base}.pdf` };
}

/** Split a tall canvas into pages no taller than ~1.42x the width (A4-like). */
async function pdfPages(canvas: HTMLCanvasElement): Promise<PdfPage[]> {
  const maxH = Math.max(200, Math.round(canvas.width * 1.42));
  const pages: PdfPage[] = [];
  for (let y = 0; y < canvas.height; y += maxH) {
    const h = Math.min(maxH, canvas.height - y);
    const p = document.createElement('canvas');
    p.width = canvas.width;
    p.height = h;
    const ctx = p.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, p.width, h);
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, p.width, h);
    const blob = await new Promise<Blob>((res, rej) => p.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.9));
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: p.width, height: h });
  }
  return pages;
}

function fileBase(ed: Editor): string {
  const name = (ed.cfg.artifactPath.split('/').pop() || 'artifact').replace(/\.[a-z0-9]+$/i, '');
  return `${name.replace(/[^\w.-]+/g, '_') || 'artifact'}-anotado`;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image'));
    i.src = url;
  });
}
