import * as Y from 'yjs';
import { assetValueOk } from '@pocharlies/artifacts-canvas-shared/model';

/**
 * Pasted and dropped images (fv8 U1). A room holds MAX_DOC_BYTES (5 MiB; 1.25 MiB for anonymous
 * visitors) and a Full HD screenshot pasted as PNG is ~450 KiB of base64: 11 of them filled a room
 * (4 for an anonymous visitor). Images are stored at most IMAGE_MAX_SIDE px on their longest side,
 * re-encoded as WebP (JPEG where the browser cannot encode WebP and the image is opaque) at
 * IMAGE_QUALITY; the PNG or the original file is kept only when it is smaller (flat UI screenshots
 * often are). The server still accepts only `data:image/(png|jpeg|gif|webp)` (docs/protocol.md §6).
 */
export const IMAGE_MAX_SIDE = 1600;
export const IMAGE_QUALITY = 0.8;

/**
 * What the server counts ahead for one image (fv7 F1, server/src/rooms.ts ledgerBound): the image
 * shape's own structs plus the attribution and history lines the stamper writes for it.
 */
export const IMAGE_SHAPE_BYTES = 4096;
/**
 * Room size the editor keeps free before it refuses an image client-side: the server's estimate
 * runs ahead of the encoded room between two saves (every update counted at its size).
 */
export function roomMargin(cap: number): number {
  return Math.round(cap * 0.02) + 16 * 1024;
}

/** The shortest data URL of `candidates` (null ones skipped) the server stores, or null. */
export function smallestImage(candidates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const c of candidates) if (c && assetValueOk(c) && (best === null || c.length < best.length)) best = c;
  return best;
}

/** Bytes of the room as the server measures it: content + ledger, encoded. */
export function roomBytes(doc: Y.Doc, ledger: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength + Y.encodeStateAsUpdate(ledger).byteLength;
}

/**
 * True when adding an image of `dataUrlLength` characters takes a room of `currentBytes` past
 * `cap` (with the margin): the editor says the canvas is full instead of sending an update the
 * server would refuse by closing the connection (4413).
 */
export function wouldOverfill(currentBytes: number, dataUrlLength: number, cap: number): boolean {
  return currentBytes + dataUrlLength + IMAGE_SHAPE_BYTES + roomMargin(cap) > cap;
}

/**
 * The stored form of an image (browser only): the smallest of WebP (else JPEG for an opaque
 * image), PNG, and the original file when its type is stored and it needs no downscale. An
 * animated GIF that fits is kept as it is (a canvas keeps only its first frame).
 */
export function encodeImage(img: HTMLImageElement, original: string, type: string, maxBytes: number): string | null {
  const fits = img.naturalWidth <= IMAGE_MAX_SIDE && img.naturalHeight <= IMAGE_MAX_SIDE;
  if (type === 'image/gif' && fits && assetValueOk(original) && original.length * 0.75 <= maxBytes) return original;
  const candidates: (string | null)[] = [];
  if (fits) candidates.push(original);
  const webp = downscale(img, IMAGE_MAX_SIDE, 'image/webp', IMAGE_QUALITY);
  if (webp.startsWith('data:image/webp')) candidates.push(webp);
  else if (!hasAlpha(img)) candidates.push(downscale(img, IMAGE_MAX_SIDE, 'image/jpeg', IMAGE_QUALITY));
  candidates.push(downscale(img, IMAGE_MAX_SIDE, 'image/png'));
  return smallestImage(candidates);
}

function canvasFor(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  return c;
}

/** `img` at most `maxSide` px on its longest side, as a data URL of `type`. */
export function downscale(img: HTMLImageElement, maxSide: number, type: string, q = 0.9): string {
  const c = canvasFor(img, maxSide);
  const ctx = c.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, q);
}

/** True when the image has a pixel that is not fully opaque (JPEG would fill it white). */
function hasAlpha(img: HTMLImageElement): boolean {
  const c = canvasFor(img, IMAGE_MAX_SIDE);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}
