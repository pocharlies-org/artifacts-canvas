/**
 * Regressions of the fifth independent verification (fv5), client side.
 *   M-3  the document model never writes a text longer than MAX_TEXT_LENGTH
 *   undo/redo origins (found by the fv5 honest-edit fuzzer): Yjs' redo can write an item whose
 *        origins contradict each other ("after X and before X", or a right origin before the
 *        left one); a document whose items are merged differently (the room after a reload from
 *        storage) then placed it elsewhere. CanvasDoc rewrites those origins to the place the
 *        item took before the update is encoded.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_TEXT_LENGTH } from '@pocharlies/artifacts-canvas-shared/model';
import { CanvasDoc, fixSelfOrigins } from '../src/model/doc';
import { clampText } from '../src/editor/editor';

describe('fv5 M-3: text length', () => {
  it('CanvasDoc clamps texts it writes; clampText never splits a surrogate pair', () => {
    const cd = new CanvasDoc(new Y.Doc(), new Y.Doc());
    const id = cd.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'x'.repeat(12_000) } as never);
    expect((cd.get(id) as unknown as { text: string }).text.length).toBe(MAX_TEXT_LENGTH);
    cd.update(id, { text: 'y'.repeat(10_001) } as never);
    expect((cd.get(id) as unknown as { text: string }).text).toBe('y'.repeat(MAX_TEXT_LENGTH));
    expect(clampText('ab😀', 3)).toBe('ab');
    expect(clampText('ab😀', 4)).toBe('ab😀');
    expect(clampText('abc', 10)).toBe('abc');
  });
});

describe('undo/redo items converge on every document', () => {
  /** Random edits, deletes of shapes, undo and redo on one document; the others replay its updates. */
  function run(seed: number, fix: boolean) {
    let s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const texts = (d: Y.Doc) => JSON.stringify([...d.getMap('shapes').entries()].map(([k, m]) => [k, ((m as Y.Map<unknown>).get('text') as Y.Text)?.toString()]).sort());
    let diverged = 0;
    let fixed = 0;
    for (let r = 0; r < 600; r++) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      const shapes = a.getMap('shapes');
      const um = new Y.UndoManager([shapes], { captureTimeout: 0 });
      if (fix) a.on('afterTransaction', (tr: Y.Transaction) => tr.origin === um && (fixed += fixSelfOrigins(tr)));
      const ups: Uint8Array[] = [];
      a.on('update', (u: Uint8Array) => {
        ups.push(u);
        Y.applyUpdate(b, u);
      });
      const ids: string[] = [];
      for (let step = 0; step < 120; step++) {
        const x = rnd();
        const live = ids.filter((id) => shapes.get(id));
        const text = () => (shapes.get(live[Math.floor(rnd() * live.length)]) as Y.Map<unknown>).get('text') as Y.Text;
        if (x < 0.15 || !live.length) {
          const id = `s${step}`;
          ids.push(id);
          a.transact(() => {
            const m = new Y.Map<unknown>();
            shapes.set(id, m);
            const t = new Y.Text();
            m.set('text', t);
            t.insert(0, 'ab');
          });
        } else if (x < 0.5) {
          const t = text();
          t.insert(Math.floor(rnd() * (t.length + 1)), ['x', 'yz', ' '][Math.floor(rnd() * 3)]);
        } else if (x < 0.65) {
          const t = text();
          if (t.length) {
            const p = Math.floor(rnd() * t.length);
            t.delete(p, 1 + Math.floor(rnd() * Math.min(3, t.length - p)));
          }
        } else if (x < 0.72) shapes.delete(live[Math.floor(rnd() * live.length)]);
        else if (x < 0.85) um.undo();
        else if (x < 0.95) um.redo();
        else um.stopCapturing();
        if (rnd() < 0.5) um.stopCapturing();
      }
      // documents with other item layouts: one merged update (a room loaded from storage), a
      // stored first half plus the rest incrementally
      const c = new Y.Doc();
      Y.applyUpdate(c, Y.mergeUpdates(ups));
      const e = new Y.Doc();
      Y.applyUpdate(e, Y.mergeUpdates(ups.slice(0, ups.length >> 1)));
      for (const u of ups.slice(ups.length >> 1)) Y.applyUpdate(e, u);
      const want = texts(a);
      if ([b, c, e].some((d) => texts(d) !== want)) diverged++;
    }
    return { diverged, fixed };
  }

  it('with the origins rewritten, every document holds the same texts (without: 2 of 3 000 runs diverged, seed 1)', () => {
    let fixed = 0;
    for (const seed of [1, 7, 13]) {
      const r = run(seed, true);
      expect(r.diverged).toBe(0);
      fixed += r.fixed;
    }
    expect(fixed).toBeGreaterThan(0);
  }, 120_000);

  it('CanvasDoc rewrites them on its own undo/redo', () => {
    const cd = new CanvasDoc(new Y.Doc(), new Y.Doc());
    let seen = 0;
    cd.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin !== cd.undoManager) return;
      // after CanvasDoc's handler: no list item of the transaction contradicts its neighbours
      for (const [client, after] of tr.afterState) {
        const before = tr.beforeState.get(client) ?? 0;
        const structs = cd.doc.store.clients.get(client) as (Y.Item | Y.GC)[];
        for (let i = after > before ? Y.findIndexSS(structs, before) : structs.length; i < structs.length; i++) {
          const it = structs[i];
          if (!(it instanceof Y.Item) || it.parentSub !== null || !it.origin || !it.rightOrigin) continue;
          seen++;
          expect(it.origin.client === it.rightOrigin.client && it.origin.clock === it.rightOrigin.clock).toBe(false);
        }
      }
    });
    const id = cd.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'hello' } as never);
    cd.endGesture();
    for (let i = 0; i < 20; i++) {
      const t = (cd.get(id) as unknown as { text: string }).text;
      cd.update(id, { text: t.slice(0, i % (t.length + 1)) + 'ab' + t.slice(i % (t.length + 1)) } as never);
      cd.endGesture();
      if (i % 3 === 0) cd.undo();
      if (i % 5 === 0) cd.redo();
    }
    cd.delete([id]);
    cd.endGesture();
    cd.undo();
    cd.redo();
    cd.undo();
    expect(seen).toBeGreaterThan(0);
  });
});
