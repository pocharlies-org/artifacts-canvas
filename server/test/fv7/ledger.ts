/**
 * fv7 F1: what the stamper adds to the ledger per update, against ledgerBound() (rooms.ts), the
 * bound the memory budget counts ahead of an update. A real Room (guard + stamper); shapes
 * created, moved by a second user (attribution rewritten, the creator as owner) and deleted,
 * with short ids and with the longest ids the protocol allows (256 characters of 3 UTF-8 bytes).
 * Prints one JSON line per case; exits 1 if any ledger passed its bound.
 *   npx tsx server/test/fv7/ledger.ts
 */
import * as Y from 'yjs';
import { checkClientUpdate, utf8Length } from '@pocharlies/artifacts-canvas-shared/stamper';
import { Room, type Conn } from '../../src/room.js';
import { loadConfig } from '../../src/config.js';
import { ledgerBound } from '../../src/rooms.js';
import { MemoryCanvasObjectStore } from '../../src/store.js';
import { createLogger } from '../../src/logging.js';
import { Metrics } from '../../src/metrics.js';

const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://c/', ARTIFACT_BASE_URL: 'http://c/', S3_BUCKET: 'b', METRICS_PORT: '0' });
const who = (id: string) => ({ identity: { id, name: '名'.repeat(128), anonymous: false, color: '#123456' } }) as unknown as Conn;
let over = 0;

for (const [label, idChar, idLen, users, n] of [
  ['short ids, 1 shape', 's', 12, ['ana@example.com', 'bob@example.com'], 1],
  ['short ids, 100 shapes', 's', 12, ['ana@example.com', 'bob@example.com'], 100],
  ['short ids, 2000 shapes', 's', 12, ['ana@example.com', 'bob@example.com'], 2000],
  ['longest ids, 1 shape', '世', 256, ['€'.repeat(256), 'ü'.repeat(256)], 1],
  ['longest ids, 100 shapes', '世', 256, ['€'.repeat(256), 'ü'.repeat(256)], 100],
  ['longest ids, 1000 shapes', '世', 256, ['€'.repeat(256), 'ü'.repeat(256)], 1000],
] as const) {
  const room = new Room('m', { cfg, store: new MemoryCanvasObjectStore(), log: createLogger('silent'), metrics: new Metrics(), onEmpty: () => undefined });
  const client = new Y.Doc();
  const ids = Array.from({ length: n }, (_, i) => `${i}-`.padEnd(idLen, idChar));
  const send = (user: string, f: () => void) => {
    const sv = Y.encodeStateVector(client);
    client.transact(f);
    const u = Y.encodeStateAsUpdate(client, sv);
    const check = checkClientUpdate(room.doc, u, { serverClient: room.doc.clientID });
    if (check.bad) throw new Error(`guard: ${check.bad}`);
    const l0 = room.ledgerApproxBytes;
    Y.applyUpdate(room.doc, u, who(user));
    const ledger = room.ledgerApproxBytes - l0;
    const bound = ledgerBound(check.shapes, check.shapeKeyBytes, Math.max(utf8Length(user), room.maxUserIdBytes));
    if (ledger > bound) over++;
    return { shapes: check.shapes, update: u.byteLength, ledger, bound, perShape: Math.round(ledger / Math.max(1, check.shapes)) };
  };
  const create = send(users[0], () => {
    for (const id of ids) {
      const m = new Y.Map();
      client.getMap('shapes').set(id, m);
      m.set('type', 'geo');
    }
  });
  const move = send(users[1], () => {
    for (const id of ids) (client.getMap('shapes').get(id) as Y.Map<unknown>).set('x', 5);
  });
  const del = send(users[1], () => {
    for (const id of ids) client.getMap('shapes').delete(id);
  });
  console.log(JSON.stringify({ label, idBytes: utf8Length(ids[0]), userIdBytes: users.map(utf8Length), create, move, del }));
  room.dispose();
}
console.log(JSON.stringify({ result: over ? `${over} ledger(s) over the bound` : 'every ledger within its bound' }));
process.exit(over ? 1 : 0);
