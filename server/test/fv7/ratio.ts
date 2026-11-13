/**
 * fv7: real resident memory per encoded byte (content + ledger) of rooms built by an attacker
 * through the REAL guard + stamper (fv9: RoomCore, what a room's worker runs), loaded back through
 * RoomCore.load (the worker's path), join frames encoded. Compares with ROOM_COST_FACTOR
 * (config.ts); the worker's own base cost is server/test/fv9/worker-cost.mjs.
 *   node --expose-gc --import tsx ratio.ts <shape> <targetBytes> <copies>
 */
import * as Y from 'yjs';
import v8 from 'node:v8';
import { ROOM_COST_FACTOR, ROOM_BASE_COST_BYTES } from '../../src/config.js';
import type { RoomCore } from '../../src/room-core.js';
import { testCore } from '../helpers/core.js';

const shape = process.argv[2] ?? 'alt-overwrite';
const target = Number(process.argv[3] ?? 4 * 1024 * 1024);
const copies = Number(process.argv[4] ?? 4);
const mkRoom = () => testCore(1e9);
const conn = { identity: { id: 'user:mallory', name: 'Mallory', anonymous: false, color: '#123456' } };

function geoMap(id: string, i: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  const v: Record<string, unknown> = { id, type: 'geo', geo: 'rectangle', x: i % 900, y: Math.floor(i / 900) * 20, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 };
  for (const [k, x] of Object.entries(v)) m.set(k, x);
  return m;
}

/** push the attacker doc's diff into the room through the guard, in pieces of <= 4 MiB */
function push(room: RoomCore, a: Y.Doc): number {
  const u = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room.doc));
  const chk = room.check(u, conn.identity.id, new Set());
  if (chk.bad) throw new Error('guard refused: ' + chk.bad);
  const o = room.apply(conn.identity);
  if (o.threw || o.droppedPending) throw new Error('apply ' + JSON.stringify(o));
  room.take();
  return u.byteLength;
}

async function build(): Promise<{ content: Uint8Array; ledger: Uint8Array }> {
  const room = mkRoom();
  const a = new Y.Doc();
  let sent = 0;
  const bytes = () => sent;
  if (shape === 'alt-overwrite') {
    // one shape, its `x` overwritten alternately by two tiny client ids (deleted items do not merge)
    a.clientID = 1;
    a.getMap('shapes').set('s0', geoMap('s0', 0));
    sent += push(room, a);
    const m = a.getMap('shapes').get('s0') as Y.Map<unknown>;
    let i = 0;
    while (bytes() < target) {
      for (let k = 0; k < 20000; k++) { a.clientID = 1 + (i & 1); m.set('x', i++ % 7); }
      sent += push(room, a);
    }
  } else if (shape === 'alt-text') {
    // a text shape, characters typed alternately by two tiny client ids, every char deleted again
    a.clientID = 1;
    const s = new Y.Map<unknown>(); a.getMap('shapes').set('t0', s);
    const v: Record<string, unknown> = { id: 't0', type: 'text', x: 0, y: 0, w: 100, h: 20, rotation: 0, index: 0, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 };
    for (const [k, x] of Object.entries(v)) s.set(k, x);
    const t = new Y.Text(); s.set('text', t);
    sent += push(room, a);
    let i = 0;
    while (bytes() < target) {
      for (let k = 0; k < 20000; k++) { a.clientID = 1 + (i & 1); t.insert(t.length, 'a'); i++; if (t.length > 2) { a.clientID = 1 + (i & 1); t.delete(0, 1); } }
      sent += push(room, a);
    }
  } else if (shape === 'alt-overwrite-many') {
    // like alt-overwrite, but each pair of client ids writes < 128 clocks (1-byte origin clocks)
    a.clientID = 1;
    a.getMap('shapes').set('s0', geoMap('s0', 0));
    sent += push(room, a);
    const m = a.getMap('shapes').get('s0') as Y.Map<unknown>;
    let i = 0, pair = 1;
    while (bytes() < target) {
      for (let k = 0; k < 20000; k++) { if (i % 250 === 0) pair++; a.clientID = 2 * pair + (i & 1); m.set('x', i++ % 7); }
      sent += push(room, a);
    }
  } else if (shape === 'many-clients') {
    // geo shapes, each written with a client id of its own (one writers entry per id)
    let i = 0;
    while (bytes() < target) {
      for (let k = 0; k < 5000; k++) { a.clientID = 10 + i; a.getMap('shapes').set('m' + i, geoMap('m' + i, i)); i++; }
      sent += push(room, a);
    }
  } else if (shape === 'alt-geo') {
    // geo shapes, every field written by alternating tiny client ids
    let i = 0;
    while (bytes() < target) {
      for (let k = 0; k < 2000; k++) {
        const id = 'g' + i; a.clientID = 1; const m = new Y.Map<unknown>(); a.getMap('shapes').set(id, m);
        const v: Record<string, unknown> = { id, type: 'geo', geo: 'rectangle', x: i % 900, y: 0, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 };
        let j = 0; for (const [kk, x] of Object.entries(v)) { a.clientID = 1 + (j++ & 1); m.set(kk, x); }
        i++;
      }
      sent += push(room, a);
    }
  } else if (shape === 'meta-overwrite') {
    a.clientID = 1; let i = 0;
    while (bytes() < target) { for (let k = 0; k < 20000; k++) { a.clientID = 1 + (i & 1); a.getMap('meta').set('pageWidth', 100 + (i++ % 7)); } sent += push(room, a); }
  } else if (shape === 'create-delete') {
    // shapes created and deleted alternately by two client ids (ledger attribution kept w/ deletedAt)
    let i = 0;
    while (bytes() < target) {
      for (let k = 0; k < 2000; k++) { a.clientID = 1 + (i & 1); const id = 'c' + i; a.getMap('shapes').set(id, geoMap(id, i)); i++; }
      sent += push(room, a);
      for (let k = i - 2000; k < i; k++) { a.clientID = 1 + (k & 1); a.getMap('shapes').delete('c' + k); }
      sent += push(room, a);
    }
  } else throw new Error('shape?');
  const { content, ledger } = room.save();
  console.log(JSON.stringify({ shape, sentUpdateBytes: sent, contentBytes: content.byteLength, ledgerBytes: ledger.byteLength }));
  return { content, ledger };
}

const gc = (globalThis as any).gc as () => void;
const used = () => { gc(); gc(); const h = v8.getHeapStatistics(); const m = process.memoryUsage(); return { heap: h.used_heap_size, ext: m.external + m.arrayBuffers, rss: m.rss }; };

const { content, ledger } = await build();
const enc = content.byteLength + ledger.byteLength;
const rooms: { core: RoomCore; frames: unknown }[] = [];
const before = used();
const mid = used();
for (let c = 0; c < copies; c++) {
  const core = mkRoom();
  core.load(ledger.slice(), content.slice(), false);
  core.take();
  // the join frames (fv9: held by the main thread, the room's documents by its worker)
  rooms.push({ core, frames: core.frames(true, true, true) });
}
const after = used();
void before;
// the stored copies themselves are not part of a loaded room in the server (fetched, applied, dropped)
const perRoomHeap = (after.heap - mid.heap) / copies;
const perRoomExt = (after.ext - mid.ext) / copies;
const perRoom = perRoomHeap + perRoomExt;
console.log(JSON.stringify({ shape, encodedBytes: enc, perRoomHeapMiB: +(perRoomHeap / 1048576).toFixed(1), perRoomExtMiB: +(perRoomExt / 1048576).toFixed(1), ratioHeapPlusExt: +(perRoom / enc).toFixed(1), ratioHeapOnly: +(perRoomHeap / enc).toFixed(1), estimate: ROOM_BASE_COST_BYTES + ROOM_COST_FACTOR * enc, estimateRatio: ROOM_COST_FACTOR }));
void rooms.length;
process.exit(0);
