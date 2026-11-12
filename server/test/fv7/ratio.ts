/**
 * fv7: real resident memory per encoded byte (content + ledger) of rooms built by an attacker
 * through the REAL guard + stamper (Room from server/src/room.ts), loaded back through Room.load
 * (the server's path), join frames encoded. Compares with ROOM_COST_FACTOR (config.ts).
 *   node --expose-gc --import tsx ratio.ts <shape> <targetBytes> <copies>
 */
import * as Y from 'yjs';
import v8 from 'node:v8';
import { Room, type Conn } from '../../src/room.js';
import { loadConfig, ROOM_COST_FACTOR, ROOM_BASE_COST_BYTES } from '../../src/config.js';
import { MemoryCanvasObjectStore } from '../../src/store.js';
import { createLogger } from '../../src/logging.js';
import { Metrics } from '../../src/metrics.js';
import { applyGuarded, checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';

const shape = process.argv[2] ?? 'alt-overwrite';
const target = Number(process.argv[3] ?? 4 * 1024 * 1024);
const copies = Number(process.argv[4] ?? 4);
const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://x/a', ARTIFACT_BASE_URL: 'http://x', S3_BUCKET: 'b', LOG_LEVEL: 'silent', ALLOWED_ORIGINS: 'http://x', SAVE_DEBOUNCE_MS: "1000000" });
const log = createLogger('silent');
const metrics = new Metrics();
const store = new MemoryCanvasObjectStore();
const mkRoom = (name: string) => new Room(name, { cfg, store, log, metrics, onEmpty: () => {} });
const conn = { identity: { id: 'user:mallory', name: 'Mallory', anonymous: false, color: '#123456', readOnly: false }, principal: 'u:user:mallory' } as unknown as Conn;

function geoMap(id: string, i: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  const v: Record<string, unknown> = { id, type: 'geo', geo: 'rectangle', x: i % 900, y: Math.floor(i / 900) * 20, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 };
  for (const [k, x] of Object.entries(v)) m.set(k, x);
  return m;
}

/** push the attacker doc's diff into the room through the guard, in pieces of <= 4 MiB */
function push(room: Room, a: Y.Doc): number {
  const u = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room.doc));
  const chk = checkClientUpdate(room.doc, u, { serverClient: room.doc.clientID, mayWrite: (c: number) => room.mayWrite(c, conn.identity.id, conn) } as never);
  if (chk.bad) throw new Error('guard refused: ' + chk.bad);
  const o = applyGuarded(room.doc, u, conn);
  if (o.threw || o.droppedPending) throw new Error('apply ' + JSON.stringify(o));
  room.claimWriters(chk.writers, conn.identity.id);
  return u.byteLength;
}

async function build(): Promise<{ content: Uint8Array; ledger: Uint8Array }> {
  const room = mkRoom('pub/build/index.html');
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
  room.markDirty();
  await room.save();
  const content = (await store.get(room.objectKey))!;
  const ledger = (await store.get(room.ledgerKey))!;
  room.dispose();
  console.log(JSON.stringify({ shape, sentUpdateBytes: sent, contentBytes: content.byteLength, ledgerBytes: ledger.byteLength }));
  return { content, ledger };
}

const gc = (globalThis as any).gc as () => void;
const used = () => { gc(); gc(); const h = v8.getHeapStatistics(); const m = process.memoryUsage(); return { heap: h.used_heap_size, ext: m.external + m.arrayBuffers, rss: m.rss }; };

const { content, ledger } = await build();
const enc = content.byteLength + ledger.byteLength;
const rooms: Room[] = [];
const holdStore = new MemoryCanvasObjectStore();
const before = used();
for (let c = 0; c < copies; c++) {
  const r = new Room(`pub/r${c}/index.html`, { cfg, store: holdStore, log, metrics, onEmpty: () => {} });
  await holdStore.put(r.ledgerKey, ledger.slice(), undefined);
  await holdStore.put(r.objectKey, content.slice(), undefined);
  rooms.push(r);
}
const mid = used();
for (const r of rooms) { await r.load(); r.ledgerFrames(); r.contentFrames(); }
const after = used();
// the stored copies themselves are not part of a loaded room in the server (fetched, applied, dropped)
const perRoomHeap = (after.heap - mid.heap) / copies;
const perRoomExt = (after.ext - mid.ext) / copies;
const perRoom = perRoomHeap + perRoomExt;
console.log(JSON.stringify({ shape, encodedBytes: enc, perRoomHeapMiB: +(perRoomHeap / 1048576).toFixed(1), perRoomExtMiB: +(perRoomExt / 1048576).toFixed(1), ratioHeapPlusExt: +(perRoom / enc).toFixed(1), ratioHeapOnly: +(perRoomHeap / enc).toFixed(1), estimate: ROOM_BASE_COST_BYTES + ROOM_COST_FACTOR * enc, estimateRatio: ROOM_COST_FACTOR }));
void rooms.length;
process.exit(0);
