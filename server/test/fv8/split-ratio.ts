/**
 * fv8 P1 probe: how much bigger does the stored room get than the server's estimate
 * (update.byteLength + splits x 24) when an update INSERTS into the middle of existing items
 * (every insert splits a live item; the guard counts splits only for deletes)?
 *   node --import tsx split-ratio.ts <variant> <baseN> <inserts>
 */
import * as Y from 'yjs';
import type { Conn } from '../../src/room.js';
import { RoomCore } from '../../src/room-core.js';
import { loadConfig } from '../../src/config.js';
import { SPLIT_COST_BYTES, encodeIntegratedState } from '@pocharlies/artifacts-canvas-shared/stamper';

const variant = process.argv[2] ?? 'points-ro';
const baseN = Number(process.argv[3] ?? 120000);
const inserts = Number(process.argv[4] ?? 100000);
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
// fv9: what a room's worker runs, without the caps (this measures what uncapped cuts store)
const room = new RoomCore({ attributionRetentionDays: 30, maxSplits: Infinity, maxSplitWork: Infinity, maxScanWork: Infinity, maxClients: Infinity });
void cfg;
const conn = { identity: { id: 'mallory@corp', name: 'M', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:mallory@corp' } as unknown as Conn;
const measured = () => encodeIntegratedState(room.doc).byteLength + encodeIntegratedState(room.ledger).byteLength;
function push(a: Y.Doc) {
  const u = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room.doc));
  const chk = room.check(u, conn.identity.id, new Set());
  if (chk.bad) throw new Error('guard refused: ' + chk.bad);
  const before = measured();
  const o = room.apply(conn.identity);
  if (o.threw || o.droppedPending) throw new Error('apply ' + JSON.stringify(o));
  return { bytes: u.byteLength, splits: chk.splits, grows: chk.grows, estimate: u.byteLength + chk.splits * SPLIT_COST_BYTES, growth: measured() - before };
}
const a = new Y.Doc();
a.clientID = 4294967000; // 5-byte varuint
const shapes = a.getMap<Y.Map<unknown>>('shapes');
const nShapes = Math.ceil(inserts / Math.min(inserts, 150000));
const per = Math.ceil(inserts / nShapes);
a.transact(() => {
  for (let s = 0; s < nShapes; s++) {
    const m = new Y.Map<unknown>();
    const f: Record<string, unknown> = { id: `d${s}`, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: s, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false };
    for (const [k, v] of Object.entries(f)) m.set(k, v);
    if (variant.startsWith('points')) m.set('points', new Y.Array<number>());
    else m.set('text', new Y.Text());
    shapes.set(`d${s}`, m);
  }
});
// base: one big item per shape; with -ro it is inserted BEFORE a 1-element item, so it carries a rightOrigin
for (let s = 0; s < nShapes; s++) {
  const m = shapes.get(`d${s}`)!;
  if (variant.startsWith('points')) {
    const arr = m.get('points') as Y.Array<number>;
    if (variant.endsWith('-ro')) arr.insert(0, [1]);
    arr.insert(0, Array.from({ length: baseN }, (_, i) => i % 100));
  } else {
    const t = m.get('text') as Y.Text;
    if (variant.endsWith('-ro')) t.insert(0, 'z');
    t.insert(0, 'a'.repeat(Math.min(baseN, 5000)));
  }
}
const r0 = push(a);
console.log('base', JSON.stringify(r0), 'room', measured());
// attack: one transaction, one insert between every pair of the base item (every insert splits it)
a.clientID = 4294967001;
a.transact(() => {
  for (let s = 0; s < nShapes; s++) {
    const m = shapes.get(`d${s}`)!;
    if (variant.startsWith('points')) {
      const arr = m.get('points') as Y.Array<number>;
      for (let i = Math.min(per, baseN - 1); i >= 1; i--) arr.insert(i, [7]);
    } else {
      const t = m.get('text') as Y.Text;
      const n = Math.min(per, Math.min(baseN, 5000) - 1);
      for (let i = n; i >= 1; i--) t.insert(i, 'x');
    }
  }
});
const r1 = push(a);
console.log('attack', JSON.stringify(r1), 'ratio measured/estimate', (r1.growth / r1.estimate).toFixed(3), 'room', measured());
