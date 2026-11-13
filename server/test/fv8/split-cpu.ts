/**
 * fv8 P2 probe: server CPU of ONE update of N inserts that each cut a live item (guard vs apply),
 * with the server's caps (MAX_SPLITS_PER_MESSAGE, MAX_APPLY_MS) and without them (what Yjs did
 * before: 16 s on an M-series core, 53-65 s live on x86 for N = 100 000, 2 strokes).
 *   node --import tsx test/fv8/split-cpu.ts [N=100000] [strokes=2] [nocap]
 */
import * as Y from 'yjs';
import type { Conn } from '../../src/room.js';
import { RoomCore } from '../../src/room-core.js';
import { SCAN_WORK_NS, SPLIT_WORK_NS, loadConfig } from '../../src/config.js';
import { insertsBetween, itemAt } from './craft.js';
const N = Number(process.argv[2] ?? 100000);
const shapesN = Number(process.argv[3] ?? 2);
const capped = process.argv[4] !== 'nocap';
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: '1000000' });
const conn = { identity: { id: 'mallory@corp', name: 'M', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:mallory@corp' } as unknown as Conn;
const caps = capped ? { maxSplits: cfg.maxSplitsPerMessage, maxSplitWork: (cfg.maxApplyMs * 1e6) / SPLIT_WORK_NS, maxScanWork: (cfg.maxApplyMs * 1e6) / SCAN_WORK_NS } : {};
// fv9: what a room's worker runs, with the server's caps or none
const room = new RoomCore({ attributionRetentionDays: 30, maxSplits: caps.maxSplits ?? Infinity, maxSplitWork: caps.maxSplitWork ?? Infinity, maxScanWork: caps.maxScanWork ?? Infinity, maxClients: Infinity });
const a = new Y.Doc();
a.clientID = 4294967000;
const shapes = a.getMap<Y.Map<unknown>>('shapes');
a.transact(() => { for (let s = 0; s < shapesN; s++) { const m = new Y.Map<unknown>(); for (const [k, v] of Object.entries({ id: `d${s}`, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: s, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false })) m.set(k, v); m.set('points', new Y.Array<number>()); shapes.set(`d${s}`, m); } });
for (let s = 0; s < shapesN; s++) { const arr = shapes.get(`d${s}`)!.get('points') as Y.Array<number>; arr.insert(0, [1]); arr.insert(0, Array.from({ length: N + 1 }, (_, i) => i % 100)); }
const push = (u: Uint8Array) => {
  const t0 = performance.now();
  const chk = room.check(u, conn.identity.id, new Set());
  const t1 = performance.now();
  if (chk.bad) return { bytes: u.byteLength, refused: chk.bad, guardMs: Math.round(t1 - t0) };
  const o = room.apply(conn.identity);
  const t2 = performance.now();
  return { bytes: u.byteLength, splits: chk.splits, guardMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), threw: o.threw };
};
console.log('base', JSON.stringify(push(Y.encodeStateAsUpdate(a))));
// the attack, crafted (building it through a Y.Doc cuts the client's own copy: as slow as the server)
const items = Array.from({ length: shapesN }, (_, s) => itemAt((room.doc.getMap('shapes').get(`d${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>, 0));
console.log(capped ? 'attack (server caps)' : 'attack (no caps: before fv8)', JSON.stringify(push(insertsBetween(items.map((into) => ({ into, count: N })), 4294967001, 0))));
// the room's save timer and awareness interval would keep the process alive
process.exit(0);
