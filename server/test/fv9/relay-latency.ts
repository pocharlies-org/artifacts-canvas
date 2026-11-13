/**
 * fv9 perf probe: honest edit relay latency through the real server (fake core, in-memory store):
 * a writer moves a shape every `interval` ms, a reader in the same room observes it; the time from
 * the writer's local change to the reader's is measured. Runs unchanged against the server before
 * fv9 (no workers) and after (the room in its worker), for a before/after comparison.
 *   npx tsx test/fv9/relay-latency.ts [edits=2000] [interval=10] [rooms=1]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { MemoryCanvasObjectStore } from '../../src/store.js';
import { createLogger } from '../../src/logging.js';
import { startFakeCore, allowUser } from '../helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from '../helpers/yclient.js';

const edits = Number(process.argv[2] ?? 2000);
const interval = Number(process.argv[3] ?? 10);
const roomsN = Number(process.argv[4] ?? 1);
const core = await startFakeCore();
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-static-'));
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>c</title>');
const cfg = loadConfig({
  GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test', STATIC_DIR: staticDir,
  LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '300', SAVE_DEBOUNCE_MS: '2000', PORT: '29977', ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0',
  MSG_RATE_PER_SEC: '100000', MSG_BURST: '100000',
});
const app = createApp({ config: cfg, store: new MemoryCanvasObjectStore(), logger: createLogger('silent') });
await app.listen();
const base = `ws://127.0.0.1:29977/_canvas/_/ws`;
const geo = (id: string) => ({ id, type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10, rotation: 0, index: 0, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const lat: number[] = [];
const pairs: { w: TestClient; r: TestClient }[] = [];
for (let k = 0; k < roomsN; k++) {
  const key = `u/relay${k}/index.html`;
  core.rulesByCookie.set(`sid=w|${key}`, allowUser('w@corp', 'W'));
  core.rulesByCookie.set(`sid=r|${key}`, allowUser('r@corp', 'R'));
  const w = new TestClient(`${base}/${key}`, 'sid=w');
  const r = new TestClient(`${base}/${key}`, 'sid=r');
  await w.connect();
  await r.connect();
  const m = new Y.Map<unknown>();
  for (const [f, v] of Object.entries(geo('s'))) m.set(f, v);
  w.doc.getMap('shapes').set('s', m);
  await waitFor(() => r.doc.getMap('shapes').has('s'), 10_000, 'first shape');
  pairs.push({ w, r });
}
for (let i = 1; i <= edits; i++) {
  const { w, r } = pairs[i % pairs.length];
  const t0 = performance.now();
  const target = (r.doc.getMap('shapes').get('s') as Y.Map<unknown>);
  const seen = new Promise<void>((resolve) => {
    const f = () => {
      if (target.get('x') === i) {
        target.unobserve(f);
        resolve();
      }
    };
    target.observe(f);
  });
  (w.doc.getMap('shapes').get('s') as Y.Map<unknown>).set('x', i);
  await seen;
  lat.push(performance.now() - t0);
  await new Promise((res) => setTimeout(res, interval));
}
lat.sort((a, b) => a - b);
const q = (p: number) => +lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(3);
console.log(JSON.stringify({ node: process.version, edits, rooms: roomsN, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) }));
for (const { w, r } of pairs) {
  w.close();
  r.close();
}
await app.close();
await core.close();
process.exit(0);
