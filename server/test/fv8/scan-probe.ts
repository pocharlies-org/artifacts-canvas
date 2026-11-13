/** probe: Yjs conflict scan — new items whose right origin is far from their origin (no cuts). */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { applyGuarded, checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
const CHAIN = Number(process.argv[2] ?? 50000);
const K = Number(process.argv[3] ?? 2000);
const room = materializeContent(new Y.Doc());
const a = new Y.Doc();
a.clientID = 1000;
a.transact(() => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ id: 's', type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
  m.set('points', new Y.Array<number>());
  a.getMap('shapes').set('s', m);
});
Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
const arr = () => (room.getMap('shapes').get('s') as Y.Map<unknown>).get('points') as Y.Array<number>;
// a chain of CHAIN separate items: clients 2000/2001 alternate, each appended after the previous
const e = encoding.createEncoder();
const half = CHAIN / 2;
const pointsItem = (room.getMap('shapes').get('s') as Y.Map<unknown>)._map.get('points')!;
encoding.writeVarUint(e, 2);
for (const c of [2001, 2000]) {
  encoding.writeVarUint(e, half);
  encoding.writeVarUint(e, c);
  encoding.writeVarUint(e, 0);
  for (let i = 0; i < half; i++) {
    // item i of client c: chain position p = 2i + (c - 2000); origin = position p - 1
    const p = 2 * i + (c - 2000);
    if (p === 0) {
      encoding.writeUint8(e, 8); // no origin: parent = the points array (by id)
      encoding.writeVarUint(e, 0); // parentInfo: parent is an ID
      encoding.writeVarUint(e, pointsItem.id.client);
      encoding.writeVarUint(e, pointsItem.id.clock);
    } else {
      const q = p - 1;
      encoding.writeUint8(e, 8 | 0x80);
      encoding.writeVarUint(e, 2000 + (q % 2));
      encoding.writeVarUint(e, Math.floor(q / 2));
    }
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, p % 100);
  }
}
encoding.writeVarUint(e, 0);
let u = encoding.toUint8Array(e);
let chk = checkClientUpdate(room, u);
console.log('chain guard', chk.bad, chk.splits);
let t = performance.now();
applyGuarded(room, u, { identity: { id: 'x' } });
console.log('chain applied', arr().length, Math.round(performance.now() - t), 'ms');
// attack: K new items of client 3000, origin = the chain's FIRST element, no right origin
const f = encoding.createEncoder();
encoding.writeVarUint(f, 1);
encoding.writeVarUint(f, K);
encoding.writeVarUint(f, 3000);
encoding.writeVarUint(f, 0);
for (let i = 0; i < K; i++) {
  encoding.writeUint8(f, 8 | 0x80);
  encoding.writeVarUint(f, 2000);
  encoding.writeVarUint(f, 0);
  encoding.writeVarUint(f, 1);
  encoding.writeAny(f, 5);
}
encoding.writeVarUint(f, 0);
u = encoding.toUint8Array(f);
t = performance.now();
chk = checkClientUpdate(room, u);
const g = performance.now() - t;
t = performance.now();
const o = applyGuarded(room, u, { identity: { id: 'x' } });
console.log(JSON.stringify({ CHAIN, K, bytes: u.byteLength, bad: chk.bad, splits: chk.splits, scanWork: chk.scanWork, guardMs: Math.round(g), applyMs: Math.round(performance.now() - t), threw: o.threw, len: arr().length }));
