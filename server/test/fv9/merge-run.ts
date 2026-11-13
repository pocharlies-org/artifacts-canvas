/**
 * fv9 probe A: ONE update of K single-number items that continue each other (a run Yjs merges
 * back into one item at the end of the transaction). Honest encoders send such a run as one
 * struct; a crafted update sends K structs. Yjs' cleanup merges them right-to-left with
 * ContentAny.mergeWith = arr.concat(right.arr): the accumulated array is copied on every merge,
 * K^2/2 element copies. The guard counts 0 cuts and 0 scan (each item "continues a run").
 *   node --import tsx test/fv9/merge-run.ts [K=100000] [strokes=1]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import type { Conn } from '../../src/room.js';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs, loadConfig } from '../../src/config.js';

const K = Number(process.argv[2] ?? 100000);
const strokes = Number(process.argv[3] ?? 1);
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const room = testCore(cfg.maxApplyMs); // the room worker's core (fv9: the server runs it in the room's worker)
const conn = { identity: { id: 'mallory@corp', name: 'M', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:mallory@corp' } as unknown as Conn;
const a = new Y.Doc();
a.clientID = 11;
const shapes = a.getMap<Y.Map<unknown>>('shapes');
a.transact(() => {
  for (let s = 0; s < strokes; s++) {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id: `d${s}`, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: s, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
    m.set('points', new Y.Array<number>());
    shapes.set(`d${s}`, m);
  }
});
for (let s = 0; s < strokes; s++) (shapes.get(`d${s}`)!.get('points') as Y.Array<number>).insert(0, [1, 2]);
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
// the attack: client 12, K one-number items per stroke, each right after the previous one
const e = encoding.createEncoder();
encoding.writeVarUint(e, 1); // one client
encoding.writeVarUint(e, K * strokes);
encoding.writeVarUint(e, 12);
encoding.writeVarUint(e, 0);
let clock = 0;
for (let s = 0; s < strokes; s++) {
  const pts = (room.doc.getMap('shapes').get(`d${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>;
  let last = pts._start!;
  while (last.right) last = last.right;
  let origin = { client: last.id.client, clock: last.id.clock + last.length - 1 };
  for (let i = 0; i < K; i++) {
    encoding.writeUint8(e, 8 | 0x80); // ContentAny, origin, no right origin (end of the list)
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, i % 50);
    origin = { client: 12, clock: clock++ };
  }
}
encoding.writeVarUint(e, 0); // empty delete set
push(`attack K=${K} x ${strokes}`, encoding.toUint8Array(e));
const pts0 = (room.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
console.log('points length', pts0.length, 'structs of client 12:', room.doc.store.clients.get(12)?.length);
process.exit(0);
