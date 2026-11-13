/** fv8 P2 probe: time of decodeUpdate vs the whole guard vs Yjs apply, for the 200 000-cut update (crafted). */
import * as Y from 'yjs';
import { applyGuarded, checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import { insertsBetween, itemAt } from './craft.js';
const N = Number(process.argv[2] ?? 100000);
const apply = process.argv[3] === 'apply';
const room = materializeContent(new Y.Doc());
const a = new Y.Doc();
a.clientID = 4294967000;
const strokes: Y.Array<number>[] = [];
a.transact(() => {
  for (let s = 0; s < 2; s++) {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id: `d${s}`, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: s, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
    const arr = new Y.Array<number>();
    m.set('points', arr);
    a.getMap('shapes').set(`d${s}`, m);
    strokes.push(arr);
  }
});
for (const arr of strokes) {
  arr.insert(0, [1]);
  arr.insert(0, Array.from({ length: N + 1 }, (_, i) => i % 100));
}
Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
const rs = ['d0', 'd1'].map((id) => itemAt((room.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>, 0));
const u = insertsBetween(rs.map((into) => ({ into, count: N })), 4294967001, 0);
let t = performance.now();
Y.decodeUpdate(u);
const decodeMs = performance.now() - t;
t = performance.now();
const chk = checkClientUpdate(room, u, { serverClient: room.clientID, maxSplits: Number(process.env.MAX_SPLITS ?? Infinity), maxSplitWork: Number(process.env.MAX_SPLIT_WORK ?? Infinity) } as never);
const guardMs = performance.now() - t;
let applyMs = -1;
if (apply && !chk.bad) {
  t = performance.now();
  applyGuarded(room, u, { identity: { id: 'm' } });
  applyMs = performance.now() - t;
}
console.log(JSON.stringify({ N, bytes: u.byteLength, bad: chk.bad, splits: chk.splits, splitWork: chk.splitWork, decodeMs: Math.round(decodeMs), guardMs: Math.round(guardMs), applyMs: Math.round(applyMs) }));
