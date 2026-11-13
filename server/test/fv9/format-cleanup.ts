/**
 * fv9 probe D: ONE update into a note's Y.Text of F formatting items (ContentFormat, distinct
 * keys: the guard accepts ContentFormat in `text` with any key) followed by S one-character items
 * sent as separate structs. After a remote transaction with formatting, Yjs runs
 * cleanupYTextFormatting over the whole text BEFORE the structs are merged: for every character
 * item it copies the current attribute map (F entries): F x S map entries. Text stays under
 * MAX_TEXT_LENGTH; no cut, (almost) no scan.
 *   node --import tsx test/fv9/format-cleanup.ts [F=20000] [S=5000]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import type { Conn } from '../../src/room.js';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs, loadConfig } from '../../src/config.js';

const F = Number(process.argv[2] ?? 20000);
const S = Number(process.argv[3] ?? 5000);
const anonymous = process.argv[4] === 'anon';
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const room = testCore(cfg.maxApplyMs); // the room worker's core (fv9: the server runs it in the room's worker)
const conn = { identity: { id: anonymous ? 'anon:1' : 'mallory@corp', name: 'M', anonymous, color: '#123456', readOnly: false }, principal: anonymous ? 'a:1' : 'u:mallory@corp' } as unknown as Conn;
const a = new Y.Doc();
a.clientID = 11;
const shapes = a.getMap<Y.Map<unknown>>('shapes');
a.transact(() => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 200, rotation: 0, index: 0, groupId: '', locked: false, color: 'yellow', size: 'm', opacity: 1 })) m.set(k, v);
  m.set('text', new Y.Text('a'));
  shapes.set('n', m);
});
const push = (label: string, u: Uint8Array) => {
  const t0 = performance.now();
  const chk = room.check(u, conn.identity.id, new Set());
  const t1 = performance.now();
  if (chk.bad) return console.log(label, JSON.stringify({ bytes: u.byteLength, refused: chk.bad, guardMs: Math.round(t1 - t0) }));
  const est = applyEstimateMs(u.byteLength, chk.splitWork, chk.scanWork);
  const o = room.apply(conn.identity);
  const t2 = performance.now();
  console.log(label, JSON.stringify({ bytes: u.byteLength, anonCap: cfg.anonMaxMessageBytes, splits: chk.splits, scanWork: chk.scanWork, estimateMs: Math.round(est), guardMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), threw: o.threw }));
};
push('base', Y.encodeStateAsUpdate(a));
const text = (room.doc.getMap('shapes').get('n') as Y.Map<unknown>).get('text') as Y.Text;
let last = text._start!;
while (last.right) last = last.right;
let origin = { client: last.id.client, clock: last.id.clock + last.length - 1 };
const e = encoding.createEncoder();
encoding.writeVarUint(e, 1);
encoding.writeVarUint(e, F + S);
encoding.writeVarUint(e, 12);
encoding.writeVarUint(e, 0);
let clock = 0;
for (let i = 0; i < F; i++) {
  encoding.writeUint8(e, 6 | 0x80); // ContentFormat with origin
  encoding.writeVarUint(e, origin.client);
  encoding.writeVarUint(e, origin.clock);
  encoding.writeVarString(e, i.toString(36));
  encoding.writeVarString(e, '1');
  origin = { client: 12, clock: clock++ };
}
for (let i = 0; i < S; i++) {
  encoding.writeUint8(e, 4 | 0x80); // ContentString with origin
  encoding.writeVarUint(e, origin.client);
  encoding.writeVarUint(e, origin.clock);
  encoding.writeVarString(e, 'x');
  origin = { client: 12, clock: clock++ };
}
encoding.writeVarUint(e, 0);
push(`attack F=${F} S=${S}${anonymous ? ' (anonymous)' : ''}`, encoding.toUint8Array(e));
console.log('text length', text.length);
process.exit(0);
