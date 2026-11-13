/**
 * fv9 probe C: a delete-only update (never refused, no cut) whose every range removes one whole
 * live item between two deleted ones of the same run: Yjs' tryMergeDeleteSet merges the three
 * and splices the client's struct array once per range, moving everything after it: K x S
 * pointer moves. The room is built first by `rounds` updates of n items each, alternating live /
 * deleted-in-the-same-update (they never merge while their deleted states differ).
 *   node --import tsx test/fv9/merge-delete.ts [n=180000] [rounds=2] [K=90000]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import type { Conn } from '../../src/room.js';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs, loadConfig } from '../../src/config.js';
import { encodeIntegratedState } from '@pocharlies/artifacts-canvas-shared/stamper';
const n = Number(process.argv[2] ?? 180000);
const rounds = Number(process.argv[3] ?? 2);
const K = Number(process.argv[4] ?? 90000);
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const room = testCore(cfg.maxApplyMs); // the room worker's core (fv9: the server runs it in the room's worker)
const conn = { identity: { id: 'mallory@corp', name: 'M', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:mallory@corp' } as unknown as Conn;
const a = new Y.Doc();
a.clientID = 11;
const shapes = a.getMap<Y.Map<unknown>>('shapes');
a.transact(() => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ id: 'd0', type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 0, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
  m.set('points', new Y.Array<number>());
  shapes.set('d0', m);
});
(shapes.get('d0')!.get('points') as Y.Array<number>).insert(0, [1, 2]);
const push = (label: string, u: Uint8Array) => {
  const t0 = performance.now();
  const chk = room.check(u, conn.identity.id, new Set());
  const t1 = performance.now();
  if (chk.bad) { console.log(label, JSON.stringify({ bytes: u.byteLength, refused: chk.bad, guardMs: Math.round(t1 - t0) })); process.exit(1); }
  const est = applyEstimateMs(u.byteLength, chk.splitWork, chk.scanWork);
  const o = room.apply(conn.identity);
  const t2 = performance.now();
  console.log(label, JSON.stringify({ bytes: u.byteLength, grows: chk.grows, splits: chk.splits, scanWork: chk.scanWork, estimateMs: Math.round(est), guardMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), threw: o.threw }));
};
push('base', Y.encodeStateAsUpdate(a));
const pts = (room.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
let last = pts._start!;
while (last.right) last = last.right;
let origin = { client: last.id.client, clock: last.id.clock + last.length - 1 };
let clock = 0;
for (let r = 0; r < rounds; r++) {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, n);
  encoding.writeVarUint(e, 12);
  encoding.writeVarUint(e, clock);
  const from = clock;
  for (let i = 0; i < n; i++) {
    encoding.writeUint8(e, 8 | 0x80);
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, i % 50);
    origin = { client: 12, clock: clock++ };
  }
  // delete set: every odd item of this round (deleted in the same update: never merged with the live ones)
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, 12);
  encoding.writeVarUint(e, Math.floor(n / 2));
  for (let i = 1; i < n; i += 2) {
    encoding.writeVarUint(e, from + i);
    encoding.writeVarUint(e, 1);
  }
  push(`build round ${r}`, encoding.toUint8Array(e));
}
console.log('structs of client 12:', room.doc.store.clients.get(12)!.length, 'room bytes', encodeIntegratedState(room.doc).byteLength);
// the attack: delete-only, K ranges, each one whole live item (even clocks) around the middle of the array (V8 splices move the shorter side)
const e = encoding.createEncoder();
encoding.writeVarUint(e, 0);
encoding.writeVarUint(e, 1);
encoding.writeVarUint(e, 12);
encoding.writeVarUint(e, K);
for (let i = 0; i < K; i++) {
  encoding.writeVarUint(e, 4 * (Math.floor((n * rounds) / 8) - Math.floor(K / 2) + i) + 2); // every other live item: the merged runs stay apart
  encoding.writeVarUint(e, 1);
}
push(`attack delete-only K=${K}`, encoding.toUint8Array(e));
console.log('structs of client 12 after:', room.doc.store.clients.get(12)!.length);
process.exit(0);
