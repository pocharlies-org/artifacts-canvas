/**
 * Regressions of the sixth independent verification (fv6), client side.
 *   L-B  Yjs' UndoManager can throw (`TypeError: Cannot read properties of undefined (reading
 *        'client')` in getItemCleanStart) while it redoes an item a concurrent edit split or
 *        removed. CanvasDoc.undo/redo catch it: nothing reaches the UI, and the documents still
 *        converge (the throwing transaction commits what it did, fixSelfOrigins included).
 *
 * The differential check is the verifier's q3-undo-diverge.ts: two CanvasDoc editors edit the
 * same notes' text and a stroke's points concurrently (insert/delete at random places, undo,
 * redo, gestures, shape deletes), updates exchanged with random delays and partial delivery.
 * Observers that do NOT run the origin rewrite: a plain Y.Doc fed in arrival order, one fed every
 * update in REVERSE order (pending-structs path), one from Y.mergeUpdates, and reloads from
 * encodeStateAsUpdate. Oracle: everyone converges to the same texts, points and shape set.
 * Verifier (before): seeds 7 and 13, 500 runs each: 1 and 2 throws reached the caller.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc } from '../src/model/doc';

interface Result { runs: number; ops: number; delivered: number; diverged: number; throwsToCaller: number; caughtInside: number; example: string }

function snap(d: Y.Doc): string {
  const out: Record<string, unknown> = {};
  for (const [k, m] of d.getMap('shapes').entries()) {
    const mm = m as Y.Map<unknown>;
    const t = mm.get('text');
    const p = mm.get('points');
    out[k] = [t instanceof Y.Text ? t.toString() : null, p instanceof Y.Array ? p.toArray().join(',') : null, mm.get('x')];
  }
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

export function undoDifferential(runs: number, seed: number): Result {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const res: Result = { runs, ops: 0, delivered: 0, diverged: 0, throwsToCaller: 0, caughtInside: 0, example: '' };
  for (let run = 0; run < runs; run++) {
    const da = new Y.Doc(), db = new Y.Doc();
    const A = new CanvasDoc(da, new Y.Doc()), B = new CanvasDoc(db, new Y.Doc());
    const plain = new Y.Doc(), all: Uint8Array[] = [];
    const qAB: Uint8Array[] = [], qBA: Uint8Array[] = [];
    da.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'net') { qAB.push(u); all.push(u); Y.applyUpdate(plain, u); } });
    db.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'net') { qBA.push(u); all.push(u); Y.applyUpdate(plain, u); } });
    const ids = [
      A.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'hello world' } as never),
      A.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'abc' } as never),
      A.create({ type: 'draw', x: 0, y: 0, w: 10, h: 10, points: [0, 0, 1, 1] } as never),
    ];
    A.endGesture();
    while (qAB.length) Y.applyUpdate(db, qAB.shift()!, 'net');
    const ed = [A, B];
    const step = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        res.throwsToCaller++;
        if (!res.example) res.example = `throw: ${String(e)} (run ${run})`;
      }
    };
    for (let k = 0; k < 120; k++) {
      const E = pick(ed);
      const r = rnd();
      res.ops++;
      const id = pick(ids);
      const sh = E.get(id) as unknown as { text?: string; points?: number[] } | undefined;
      if (r < 0.35 && sh) {
        if (typeof sh.text === 'string') {
          const t = sh.text;
          const at = Math.floor(rnd() * (t.length + 1));
          const next = rnd() < 0.6 ? t.slice(0, at) + pick(['x', 'yy', 'zzz', 'Q']) + t.slice(at) : t.slice(0, at) + t.slice(at + 1 + Math.floor(rnd() * 3));
          E.update(id, { text: next } as never);
        } else if (sh.points) E.appendPoints(id, [Math.floor(rnd() * 100), Math.floor(rnd() * 100)]);
        if (rnd() < 0.5) E.endGesture();
      } else if (r < 0.55) {
        E.endGesture();
        step(() => E.undo());
      } else if (r < 0.72) {
        E.endGesture();
        step(() => E.redo());
      } else if (r < 0.76 && sh) {
        E.update(id, { x: Math.floor(rnd() * 50) } as never);
        E.endGesture();
      } else if (r < 0.78 && sh) {
        E.delete([id]);
        E.endGesture();
      } else {
        for (const [q, d] of [[qAB, db], [qBA, da]] as const) {
          const n = Math.floor(rnd() * (q.length + 1));
          for (let i = 0; i < n; i++) {
            Y.applyUpdate(d, q.shift()!, 'net');
            res.delivered++;
          }
        }
      }
    }
    while (qAB.length) Y.applyUpdate(db, qAB.shift()!, 'net');
    while (qBA.length) Y.applyUpdate(da, qBA.shift()!, 'net');
    res.caughtInside += A.undoErrors + B.undoErrors;
    const rev = new Y.Doc();
    for (let i = all.length - 1; i >= 0; i--) Y.applyUpdate(rev, all[i]);
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.mergeUpdates(all));
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(plain));
    const reloadedA = new Y.Doc();
    Y.applyUpdate(reloadedA, Y.encodeStateAsUpdate(da));
    const views = { A: snap(da), B: snap(db), plain: snap(plain), reverse: snap(rev), merged: snap(merged), reloaded: snap(reloaded), reloadedA: snap(reloadedA) };
    if (new Set(Object.values(views)).size > 1) {
      res.diverged++;
      if (!res.example) res.example = JSON.stringify(views).slice(0, 1500);
    }
  }
  return res;
}

describe('fv6 L-B: undo/redo never throws to the UI, documents converge', () => {
  // seeds 7 and 13 are the verifier's (1 and 2 throws before); 500 runs = 60 000 operations each
  for (const seed of [7, 13, 21]) {
    it(`differential, seed ${seed}`, () => {
      const r = undoDifferential(500, seed);
      expect(r.throwsToCaller, r.example).toBe(0);
      expect(r.diverged, r.example).toBe(0);
      expect(r.ops).toBe(60_000);
      // seed 13 hits the Yjs throw: the catch inside CanvasDoc is what keeps the UI clean
      if (seed === 13) expect(r.caughtInside).toBeGreaterThan(0);
    }, 120_000);
  }
});
