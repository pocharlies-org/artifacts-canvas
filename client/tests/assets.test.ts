/**
 * Image data and the room budget. An image's data lives in `assets`, apart from the image shape
 * that names it. Deleting the last shape that names an asset deletes the asset with it (same
 * transaction, same undo step), so a room filled by images can be emptied by deleting them: the
 * room as the server stores it shrinks at once (roomBytes), although this tab's undo history keeps
 * the data for an undo. Before, the data stayed after its shapes were gone and "delete something
 * first" could not be satisfied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc, FREED_GRACE_MS } from '../src/model/doc';
import { roomBytes, storedBytes, wouldOverfill } from '../src/editor/images';
import { linkedDocs } from './helpers';
import type { Shape } from '../src/model/types';

const KiB = 1024;
/** A data URL the server accepts (assetValueOk) of about `n` characters. */
const dataUrl = (n: number, c = 'A') => 'data:image/png;base64,' + c.repeat(n);

/** What the editor does for one image: the data and its shape in one transaction and one undo step. */
function insertImage(doc: CanvasDoc, assetId: string, url: string, x = 0): string {
  let id = '';
  doc.transact(() => {
    doc.setAsset(assetId, url);
    id = doc.create({ type: 'image', assetId, x, y: 0, w: 100, h: 100 } as Partial<Shape> & { type: 'image' });
  });
  doc.endGesture();
  return id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deleting the last shape that names image data frees it', () => {
  it('the asset goes with its last shape, and the room as stored shrinks by its size although undo keeps it locally', () => {
    const doc = new CanvasDoc();
    const a = insertImage(doc, 'a1', dataUrl(400 * KiB, 'A'), 0);
    const b = insertImage(doc, 'a2', dataUrl(400 * KiB, 'B'), 200);
    const full = roomBytes(doc.doc, doc.ledger);
    expect(full).toBeGreaterThan(800 * KiB);
    doc.delete([a]);
    doc.endGesture();
    expect(doc.assets.has('a1')).toBe(false);
    expect(doc.assets.has('a2')).toBe(true);
    const after = roomBytes(doc.doc, doc.ledger);
    expect(full - after).toBeGreaterThan(400 * KiB - 1 * KiB);
    // the tab's own encoding still holds the deleted data (the undo history keeps it), the measure does not
    expect(Y.encodeStateAsUpdate(doc.doc).byteLength).toBeGreaterThan(800 * KiB);
    expect(storedBytes(doc.doc)).toBeLessThan(400 * KiB + 4 * KiB);
    doc.delete([b]);
    doc.endGesture();
    expect(doc.assets.size).toBe(0);
    expect(roomBytes(doc.doc, doc.ledger)).toBeLessThan(4 * KiB);
  });

  it('undo of the delete brings the shape and its data back; redo deletes both again', () => {
    const doc = new CanvasDoc();
    const url = dataUrl(100 * KiB);
    const id = insertImage(doc, 'a1', url);
    doc.delete([id]);
    doc.endGesture();
    expect(doc.has(id) || doc.assets.has('a1')).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.has(id)).toBe(true);
    expect(doc.assets.get('a1')).toBe(url);
    expect(doc.redo()).toBe(true);
    expect(doc.has(id) || doc.assets.has('a1')).toBe(false);
  });

  it('undo of an image insert removes its data too (one step), redo restores both', () => {
    const doc = new CanvasDoc();
    const url = dataUrl(50 * KiB);
    const id = insertImage(doc, 'a1', url);
    expect(doc.undo()).toBe(true);
    expect(doc.has(id)).toBe(false);
    expect(doc.assets.has('a1')).toBe(false);
    expect(roomBytes(doc.doc, doc.ledger)).toBeLessThan(4 * KiB);
    expect(doc.redo()).toBe(true);
    expect(doc.has(id)).toBe(true);
    expect(doc.assets.get('a1')).toBe(url);
  });

  it('data named by two shapes (a duplicate) stays until the last of them is deleted', () => {
    const doc = new CanvasDoc();
    const id = insertImage(doc, 'a1', dataUrl(10 * KiB));
    const copy = doc.create({ type: 'image', assetId: 'a1', x: 300, y: 0, w: 100, h: 100 } as Partial<Shape> & { type: 'image' });
    doc.endGesture();
    doc.delete([id]);
    expect(doc.assets.has('a1')).toBe(true);
    doc.delete([copy]);
    expect(doc.assets.has('a1')).toBe(false);
  });

  it('a delete of more than one batch removes the data in its last batch', () => {
    const doc = new CanvasDoc();
    const img = insertImage(doc, 'a1', dataUrl(10 * KiB));
    const ids = [img];
    doc.transact(() => {
      for (let i = 0; i < 1500; i++) ids.push(doc.create({ type: 'geo', geo: 'rectangle', x: i, y: 0, w: 1, h: 1 } as Partial<Shape> & { type: 'geo' }));
    });
    doc.endGesture();
    doc.delete(ids);
    doc.endGesture();
    expect(doc.ids().length).toBe(0);
    expect(doc.assets.size).toBe(0);
    doc.undo();
    expect(doc.ids().length).toBe(1501);
    expect(doc.assets.has('a1')).toBe(true);
  });

  it('another tab sees the data go: its measure of the room drops too', () => {
    const { docs } = linkedDocs(['ana', 'bob']);
    const [ana, bob] = docs;
    const id = insertImage(ana, 'a1', dataUrl(300 * KiB));
    const before = roomBytes(bob.doc, bob.ledger);
    expect(bob.assets.has('a1')).toBe(true);
    ana.delete([id]);
    expect(bob.assets.has('a1')).toBe(false);
    expect(before - roomBytes(bob.doc, bob.ledger)).toBeGreaterThan(300 * KiB - 1 * KiB);
    // bob deletes nothing, but his undo cannot bring ana's image back: undo is per user
    expect(bob.undo()).toBe(false);
  });

  it('data no shape names (left by a client that did not delete it) is collected, outside the undo history', () => {
    const doc = new CanvasDoc();
    // what an older client left: the shape deleted, the data kept
    doc.doc.transact(() => doc.assets.set('orphan', dataUrl(200 * KiB)), 'remote');
    const keep = insertImage(doc, 'a1', dataUrl(10 * KiB));
    expect(doc.unreferencedAssets()).toEqual(['orphan']);
    const freed = doc.collectUnreferencedAssets();
    expect(freed).toBeGreaterThan(200 * KiB);
    expect(doc.assets.has('orphan')).toBe(false);
    expect(doc.assets.has('a1')).toBe(true);
    expect(doc.has(keep)).toBe(true);
    // the collection is not this user's edit: undo takes back the image insert, not the collection
    doc.undo();
    expect(doc.assets.has('orphan')).toBe(false);
    expect(doc.collectUnreferencedAssets()).toBe(0);
  });
});

describe('the bytes of deleted data count until the server measured the room again', () => {
  it('recentlyFreedBytes holds what was deleted for FREED_GRACE_MS, then nothing', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const doc = new CanvasDoc();
    const url = dataUrl(300 * KiB);
    const id = insertImage(doc, 'a1', url);
    expect(doc.recentlyFreedBytes()).toBe(0);
    doc.delete([id]);
    expect(doc.recentlyFreedBytes()).toBe(url.length);
    vi.advanceTimersByTime(FREED_GRACE_MS - 1);
    expect(doc.recentlyFreedBytes()).toBe(url.length);
    vi.advanceTimersByTime(1);
    expect(doc.recentlyFreedBytes()).toBe(0);
  });

  it('a room at its cap takes a new image after its images are deleted (the editor waits out the grace first)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cap = 1024 * KiB;
    const doc = new CanvasDoc();
    const ids = [insertImage(doc, 'a1', dataUrl(400 * KiB, 'A')), insertImage(doc, 'a2', dataUrl(400 * KiB, 'B'))];
    const next = dataUrl(400 * KiB, 'C').length;
    expect(wouldOverfill(roomBytes(doc.doc, doc.ledger), next, cap)).toBe(true);
    doc.delete(ids);
    doc.endGesture();
    // the room as stored has room again, but the server counts the data until it saves
    expect(wouldOverfill(roomBytes(doc.doc, doc.ledger), next, cap)).toBe(false);
    expect(wouldOverfill(roomBytes(doc.doc, doc.ledger) + doc.recentlyFreedBytes(), next, cap)).toBe(true);
    vi.advanceTimersByTime(FREED_GRACE_MS);
    expect(wouldOverfill(roomBytes(doc.doc, doc.ledger) + doc.recentlyFreedBytes(), next, cap)).toBe(false);
  });
});
