/** fv7: heap needed to guard + apply ONE ~7.8 MiB update of alternating meta overwrites (fresh room). */
import * as Y from 'yjs';
import v8 from 'node:v8';
import { checkClientUpdate, applyGuarded } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
const mode = process.argv[2] ?? 'check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const F = process.argv[3] ?? path.join(os.tmpdir(), 'fv7-alt-7.8MiB.bin');
if (mode === 'gen') {
  const a = new Y.Doc(); const meta = a.getMap('meta'); let i = 0; let u = new Uint8Array();
  for (;;) { for (let k = 0; k < 50000; k++) { a.clientID = 5000 + (i & 1); meta.set('pageWidth', 800 + (i++ % 7)); } u = Y.encodeStateAsUpdate(a); if (u.byteLength >= 7.8 * 1048576) break; }
  fs.writeFileSync(F, u); console.log('written', u.byteLength); process.exit(0);
}
const bytes = new Uint8Array(fs.readFileSync(F));
(globalThis as any).gc?.();
const before = v8.getHeapStatistics().used_heap_size;
const room = materializeContent(new Y.Doc());
const r = checkClientUpdate(room, bytes, { serverClient: room.clientID, mayWriteClient: () => true } as never);
const afterCheck = v8.getHeapStatistics().used_heap_size;
let applied = 'no';
if (mode === 'apply' && !r.bad) { applyGuarded(room, bytes, {}); applied = 'yes'; }
console.log(JSON.stringify({ updateMiB: +(bytes.byteLength / 1048576).toFixed(2), bad: r.bad, applied, heapLimitMiB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), usedBeforeMiB: Math.round(before / 1048576), usedAfterCheckMiB: Math.round(afterCheck / 1048576), usedEndMiB: Math.round(v8.getHeapStatistics().used_heap_size / 1048576) }));
