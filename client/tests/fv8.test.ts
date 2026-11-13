/**
 * fv8 U1: pasted images are stored small, and the editor says the canvas is full before the
 * server would refuse the update (the browser part, encodeImage, runs in
 * e2e-system/adversarial-fv8.spec.ts against the full system).
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IMAGE_SHAPE_BYTES, roomBytes, roomMargin, smallestImage, wouldOverfill } from '../src/editor/images';
import { resolveConfig } from '../src/config';

describe('fv8 U1: images and the canvas-full notice', () => {
  it('the stored form is the shortest data URL the server accepts (png/jpeg/gif/webp, base64)', () => {
    const png = 'data:image/png;base64,' + 'A'.repeat(4000);
    const webp = 'data:image/webp;base64,' + 'A'.repeat(1200);
    const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(1500);
    expect(smallestImage([png, webp, jpeg])).toBe(webp);
    // a flat screenshot: the PNG is the smallest and is kept
    expect(smallestImage([png.slice(0, 900), webp, jpeg])).toBe(png.slice(0, 900));
    // what the server would refuse is never chosen (svg, a browser that returned no WebP)
    expect(smallestImage(['data:image/svg+xml;base64,AAAA', null, undefined, 'data:,', jpeg])).toBe(jpeg);
    expect(smallestImage([null, 'data:image/bmp;base64,AA'])).toBeNull();
  });

  it('the canvas is full when the room plus the image, its shape and the margin pass the cap', () => {
    const cap = 5 * 1024 * 1024;
    const room = 4 * 1024 * 1024;
    const free = cap - room - IMAGE_SHAPE_BYTES - roomMargin(cap);
    expect(wouldOverfill(room, free, cap)).toBe(false);
    expect(wouldOverfill(room, free + 1, cap)).toBe(true);
    // the anonymous cap
    expect(wouldOverfill(1_200_000, 100_000, 1280 * 1024)).toBe(true);
    expect(wouldOverfill(600_000, 100_000, 1280 * 1024)).toBe(false);
  });

  it('the room size is measured like the server measures it: content + ledger, encoded', () => {
    const d = new Y.Doc();
    const l = new Y.Doc();
    d.getMap('assets').set('a', 'data:image/png;base64,' + 'A'.repeat(10_000));
    l.getMap('users').set('u', { name: 'x' });
    expect(roomBytes(d, l)).toBe(Y.encodeStateAsUpdate(d).byteLength + Y.encodeStateAsUpdate(l).byteLength);
    expect(roomBytes(d, l)).toBeGreaterThan(10_000);
  });

  it('the wrapper config carries the cap (default 5 MiB when the page has none)', () => {
    const loc = new URL('http://h/_canvas/u/x/index.html') as unknown as Location;
    const doc = { getElementById: () => ({ textContent: JSON.stringify({ maxDocBytes: 1310720 }) }) } as unknown as Document;
    expect(resolveConfig(loc, doc, false).maxDocBytes).toBe(1310720);
    const none = { getElementById: () => null } as unknown as Document;
    expect(resolveConfig(loc, none, false).maxDocBytes).toBe(5 * 1024 * 1024);
  });
});
