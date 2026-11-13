/**
 * fv9 probe B: ONE update of P pairs of single-number items, the pairs alternating between two
 * strokes, so each pair (x, y = right after x) is merged by Yjs' cleanup but never with its
 * neighbours in the client's struct array. Every merge splices the struct array, moving the
 * tail: P^2/2 pointer moves. Contents are tiny (2 numbers per merge), no cut, no scan.
 *   node --import tsx test/fv9/merge-splice.ts [P=100000]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import type { Conn } from '../../src/room.js';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs, loadConfig } from '../../src/config.js';

const P = Number(process.argv[2] ?? 100000);
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const room = testCore(cfg.maxApplyMs); // the room worker's core (fv9: the server runs it in the room's worker)
const conn = { identity: { id: 'mallory@corp', name: 'M', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:mallory@corp' } as unknown as Conn;
const a = new Y.Doc();
a.clientID = 11;
const shapes = a.getMap<Y.Map<unknown>>('shapes');
a.transact(() => {
  for (let s = 0; s < 2; s++) {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id: `d${s}`, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: s, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
    m.set('points', new Y.Array<number>());
    shapes.set(`d${s}`, m);
  }
});
for (let s = 0; s < 2; s++) (shapes.get(`d${s}`)!.get('points') as Y.Array<number>).insert(0, [1, 2]);
const push = (label: string, u: Uint8Array) => {
  const t0 = performance.now();
  const chk = room.check(u, conn.identity.id, new Set());
  const t1 = performance.now();
  if (chk.bad) return console.log(label, JSON.stringify({ bytes: u.byteLength, refused: chk.bad, guardMs: Math.round(t1 - t0) }));
  const est = applyEstimateMs(u.byteLength, chk.splitWork, chk.scanWork);
  const refusedByApplyCap = applyEstimateMs(0, chk.splitWork, chk.scanWork) > cfg.maxApplyMs;
  const o = room.apply(conn.identity);
  const t2 = performance.now();
  console.log(label, JSON.stringify({ bytes: u.byteLength, splits: chk.splits, splitWork: chk.splitWork, scanWork: chk.scanWork, estimateMs: Math.round(est), refusedByApplyCap, guardMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), threw: o.threw }));
};
push('base', Y.encodeStateAsUpdate(a));
const e = encoding.createEncoder();
encoding.writeVarUint(e, 1);
encoding.writeVarUint(e, 2 * P);
encoding.writeVarUint(e, 12);
encoding.writeVarUint(e, 0);
const lastOf = (s: number) => {
  const pts = (room.doc.getMap('shapes').get(`d${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>;
  let last = pts._start!;
  while (last.right) last = last.right;
  return { client: last.id.client, clock: last.id.clock + last.length - 1 };
};
const tail = [lastOf(0), lastOf(1)];
let clock = 0;
for (let k = 0; k < P; k++) {
  const s = k % 2;
  for (let j = 0; j < 2; j++) {
    encoding.writeUint8(e, 8 | 0x80);
    encoding.writeVarUint(e, tail[s].client);
    encoding.writeVarUint(e, tail[s].clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, (k + j) % 50);
    tail[s] = { client: 12, clock: clock++ };
  }
}
encoding.writeVarUint(e, 0);
push(`attack P=${P} pairs`, encoding.toUint8Array(e));
console.log('structs of client 12:', room.doc.store.clients.get(12)?.length);
process.exit(0);
