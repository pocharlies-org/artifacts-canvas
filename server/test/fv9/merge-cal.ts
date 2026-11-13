/**
 * fv9 calibration of the merge work (stamper.ts MERGE_BASE_WORK, MERGE_MOVE_DIVISOR): the guard's
 * merge count and splitWork against the time Yjs takes to apply, for
 *   bulk  an honest delete of the first `k` shapes of a room one client filled with `n` shapes
 *         (each deleted shape's fields become GC structs that merge: one splice per shape)
 *   run   one update of a run of `k` one-number items continuing each other (copies, fv9 A)
 *   pairs one update of `k` separate mergeable pairs (one splice each, fv9 B)
 *   node --import tsx test/fv9/merge-cal.ts bulk 12000 2000
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { SPLIT_WORK_NS } from '../../src/config.js';
import { testCore } from '../helpers/core.js';

const kind = process.argv[2] ?? 'bulk';
const n = Number(process.argv[3] ?? 12000);
const k = Number(process.argv[4] ?? 2000);
const geo = (id: string, j: number) => ({ id, type: 'geo', geo: 'rectangle', x: j, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
// with `stamped`: the room's real core (stamper attached), the update applied as a user's
const core = process.argv[5] === 'stamped' ? testCore() : null;
const measure = (room: Y.Doc, u: Uint8Array, label: string) => {
  const t0 = performance.now();
  const c = checkClientUpdate(room, u, {});
  const t1 = performance.now();
  Y.applyUpdate(room, u, core ? { identity: { id: 'ana@corp', name: 'Ana', anonymous: false, color: '#000' } } : 'x');
  const t2 = performance.now();
  console.log(label, JSON.stringify({ bytes: u.byteLength, bad: c.bad, merges: c.merges, deletes: (c as { deletes?: number }).deletes, splitWork: c.splitWork, estimateMs: +((c.splitWork * SPLIT_WORK_NS) / 1e6).toFixed(1), guardMs: +(t1 - t0).toFixed(1), applyMs: +(t2 - t1).toFixed(1), nsPerUnit: c.splitWork ? +(((t2 - t1) * 1e6) / c.splitWork).toFixed(2) : null }));
};
const room = core ? core.doc : new Y.Doc();
const a = new Y.Doc();
a.clientID = 11;
if (kind === 'bulk') {
  for (let b = 0; b < n; b += 500) {
    a.transact(() => {
      for (let i = b; i < Math.min(n, b + 500); i++) {
        const m = new Y.Map<unknown>();
        for (const [f, v] of Object.entries(geo(`f${i}`, i))) m.set(f, v);
        a.getMap('shapes').set(`f${i}`, m);
      }
    });
  }
  Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
  const sv = Y.encodeStateVector(a);
  a.transact(() => {
    for (let i = 0; i < k; i++) a.getMap('shapes').delete(`f${i}`);
  });
  console.log('structs of the client', room.store.clients.get(11)!.length);
  measure(room, Y.encodeStateAsUpdate(a, sv), `bulk delete ${k} of ${n}`);
} else {
  a.transact(() => {
    for (let s = 0; s < 2; s++) {
      const m = new Y.Map<unknown>();
      a.getMap('shapes').set(`d${s}`, m);
      const p = new Y.Array<number>();
      m.set('points', p);
      p.insert(0, [1, 2]);
    }
  });
  Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
  const lastOf = (s: number) => {
    const pts = (room.getMap('shapes').get(`d${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>;
    let last = pts._start!;
    while (last.right) last = last.right;
    return { client: last.id.client, clock: last.id.clock + last.length - 1 };
  };
  const e = encoding.createEncoder();
  const per = kind === 'run' ? k : 2 * k;
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, per);
  encoding.writeVarUint(e, 12);
  encoding.writeVarUint(e, 0);
  const tail = [lastOf(0), lastOf(1)];
  let clock = 0;
  for (let i = 0; i < (kind === 'run' ? k : k); i++) {
    const s = kind === 'run' ? 0 : i % 2;
    for (let j = 0; j < (kind === 'run' ? 1 : 2); j++) {
      encoding.writeUint8(e, 8 | 0x80);
      encoding.writeVarUint(e, tail[s].client);
      encoding.writeVarUint(e, tail[s].clock);
      encoding.writeVarUint(e, 1);
      encoding.writeAny(e, (i + j) % 50);
      tail[s] = { client: 12, clock: clock++ };
    }
  }
  encoding.writeVarUint(e, 0);
  measure(room, encoding.toUint8Array(e), `${kind} k=${k}`);
}
