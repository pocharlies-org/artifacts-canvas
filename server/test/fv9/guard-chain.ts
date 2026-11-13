/**
 * fv9 probe E: the GUARD's own time (checkClientUpdate, before any refusal) for ONE update of N
 * single-number items spread over C client blocks, chained so that each item's origin is the
 * previous item of the chain, held by the client block BEFORE it in the update: integrates()
 * (stamper.ts) advances one struct per pass over every block, N x C steps.
 *   node --import tsx test/fv9/guard-chain.ts [N=20000] [C=2000] [anon]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import type { Conn } from '../../src/room.js';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs, loadConfig } from '../../src/config.js';

const N = Number(process.argv[2] ?? 20000);
const C = Number(process.argv[3] ?? 2000);
const anonymous = process.argv[4] === 'anon';
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const room = testCore(cfg.maxApplyMs); // the room worker's core (fv9: the server runs it in the room's worker)
const conn = { identity: { id: anonymous ? 'anon:1' : 'mallory@corp', name: 'M', anonymous, color: '#123456', readOnly: false }, principal: anonymous ? 'a:1' : 'u:mallory@corp' } as unknown as Conn;
const a = new Y.Doc();
a.clientID = 11;
a.transact(() => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ id: 'd0', type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 0, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v);
  const p = new Y.Array<number>();
  m.set('points', p);
  p.insert(0, [1, 2]);
  a.getMap('shapes').set('d0', m);
});
const push = (label: string, u: Uint8Array, apply = true) => {
  const t0 = performance.now();
  const chk = room.check(u, conn.identity.id, new Set());
  const t1 = performance.now();
  if (chk.bad) return console.log(label, JSON.stringify({ bytes: u.byteLength, refused: chk.bad, guardMs: Math.round(t1 - t0) }));
  const est = applyEstimateMs(u.byteLength, chk.splitWork, chk.scanWork);
  if (!apply) return console.log(label, JSON.stringify({ bytes: u.byteLength, estimateMs: Math.round(est), scanWork: chk.scanWork, guardMs: Math.round(t1 - t0) }));
  const o = room.apply(conn.identity);
  const t2 = performance.now();
  console.log(label, JSON.stringify({ bytes: u.byteLength, estimateMs: Math.round(est), scanWork: chk.scanWork, guardMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), threw: o.threw }));
};
push('base', Y.encodeStateAsUpdate(a));
const pts = (room.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
let last = pts._start!;
while (last.right) last = last.right;
const M = Math.ceil(N / C);
// chain position j (0-based): block b = C-1 - (j mod C), clock k = floor(j / C)
const blockOf = (j: number) => C - 1 - (j % C);
const e = encoding.createEncoder();
encoding.writeVarUint(e, C);
for (let b = 0; b < C; b++) {
  const js: number[] = [];
  for (let j = C - 1 - b; j < N; j += C) js.push(j);
  encoding.writeVarUint(e, js.length);
  encoding.writeVarUint(e, 1000 + b);
  encoding.writeVarUint(e, 0);
  for (const j of js) {
    const origin = j === 0 ? { client: last.id.client, clock: last.id.clock + last.length - 1 } : { client: 1000 + blockOf(j - 1), clock: Math.floor((j - 1) / C) };
    encoding.writeUint8(e, 8 | 0x80);
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, j % 50);
  }
}
encoding.writeVarUint(e, 0);
push(`chain N=${N} C=${C} (${M} per client)${anonymous ? ' anonymous' : ''}`, encoding.toUint8Array(e), process.argv[5] !== 'noapply');
process.exit(0);
