/**
 * Review M-1 measurement: one authenticated writer floods the canvas with 4 MiB updates the guard
 * accepts (re-sends of an image its room already holds, as an honest reconnect re-sends structs),
 * from one connection or from several (MAX_CONNS_PER_USER is 8). The server runs as its own process
 * (`node server/dist/index.js`, the chart's HEAP_LIMIT_MB=1776, fake core + in-memory S3 as in
 * client/e2e-server/stack.ts); its RSS (ps) and canvas_ws_inflight_bytes (metrics port) are sampled
 * every 100 ms, and an honest user in another room relays an edit to a second one every 200 ms.
 * Each flooding connection sends as fast as the server reads (it keeps at most 8 MiB in its own
 * socket buffer), so what the server holds is what it chose to read.
 *
 *   npm run build -w shared -w server
 *   npx tsx server/test/inflight/flood.ts [serverEntry=server/dist/index.js] [conns=1] [messages=100] [kind=image|shapes]
 *
 * kind: what the writer's room holds and every message re-sends: `image`, one 3.9 MiB image it wrote
 * (cheap to process: the server nearly keeps up with a fast link), or `shapes`, 9 000 shapes a
 * co-writer's session stored (3.3 MiB of structs the guard walks one by one: slower to process
 * than the link delivers).
 *
 * Prints one JSON line. Against a build without the in-flight cap (the fv9 branch before the
 * review) the RSS follows what the link delivers; with it, it stays near the baseline.
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { startFakeCore, allowUser } from '../../../dev/fake-core.js';
import { startS3Mock } from '../../../dev/s3-mock.js';
import { TEST_ORIGIN, TestClient, waitFor } from '../helpers/yclient.js';
import { syncMsg } from '../fv9/craft.js';
import { testCore } from '../helpers/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const entry = path.resolve(process.argv[2] ?? path.join(repo, 'server', 'dist', 'index.js'));
const CONNS = Number(process.argv[3] ?? 1);
const MESSAGES = Number(process.argv[4] ?? 100);
const KIND = (process.argv[5] ?? 'image') as 'image' | 'shapes';
const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mib = (b: number) => Math.round((b / MiB) * 10) / 10;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const core = await startFakeCore();
const s3 = await startS3Mock();
const port = await freePort();
const metricsPort = await freePort();
const child = spawn(process.execPath, [entry], {
  cwd: repo,
  env: {
    PATH: process.env.PATH,
    HOST: '127.0.0.1', PORT: String(port), METRICS_PORT: String(metricsPort), METRICS_HOST: '127.0.0.1',
    GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl,
    S3_ENDPOINT: s3.url, S3_BUCKET: 'artifacts', S3_ACCESS_KEY_ID: 'p', S3_SECRET_ACCESS_KEY: 'p', S3_FORCE_PATH_STYLE: 'true',
    STATIC_DIR: path.join(repo, 'client', 'dist'), ALLOWED_ORIGINS: TEST_ORIGIN, LOG_LEVEL: 'warn',
    AUTHZ_RECHECK_SECONDS: '300', SAVE_DEBOUNCE_MS: '2000', HEAP_LIMIT_MB: '1776',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
let exited: number | null = null;
child.on('exit', (c) => (exited = c ?? -1));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 150 || exited !== null) throw new Error(`server did not start\n${log}`);
  await sleep(100);
}

const rssMiB = (): number => {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()) / 1024;
  } catch {
    return NaN;
  }
};
async function metrics(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const text = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const i = line.lastIndexOf(' ');
      out.set(line.slice(0, i), Number(line.slice(i + 1)));
    }
  } catch {
    /* gone */
  }
  return out;
}
const sumOf = (m: Map<string, number>, prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);

const base = `ws://127.0.0.1:${port}/_canvas/_/ws`;
const floodKey = 'u/flood/index.html';
const honestKey = 'u/honest/index.html';
core.rulesByCookie.set(`sid=mallory|${floodKey}`, allowUser('mallory@corp', 'mallory'));
for (const u of ['ana', 'bob']) core.rulesByCookie.set(`sid=${u}|${honestKey}`, allowUser(`${u}@corp`, u));

const join = async (key: string, cookie: string) => {
  const c = new TestClient(`${base}/${key}`, cookie);
  await c.connect();
  await waitFor(() => c.step1Received > 0 || c.closeCode !== null, 15_000, 'joined').catch(() => undefined);
  return c;
};

// the writer's room: one 3.9 MiB image it writes, or 9 000 shapes stored by a co-writer's session
// (under the 5 MiB room and 4 MiB message caps)
const mapOf = (o: Record<string, unknown>) => {
  const s = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(o)) s.set(k, v);
  return s;
};
if (KIND === 'shapes') {
  const room = testCore(1000);
  const d = new Y.Doc();
  const origin = { identity: { id: 'sam@corp', name: 'sam', anonymous: false, color: '#000' } };
  for (let b = 0; b < 9000; b += 500) {
    const sv = Y.encodeStateVector(d);
    d.transact(() => {
      for (let i = b; i < b + 500; i++) d.getMap('shapes').set(`f${i}`, mapOf({ id: `f${i}`, type: 'geo', geo: 'rectangle', x: i, y: i, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 }));
    });
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(d, sv), origin);
  }
  const saved = room.save();
  const now = new Date().toUTCString();
  s3.objects.set(`_plugins/canvas/${floodKey}.ydoc`, { body: saved.content, lastModified: now } as never);
  s3.objects.set(`_plugins/canvas/${floodKey}.ydoc.ledger`, { body: saved.ledger, lastModified: now } as never);
}
const m0 = await join(floodKey, 'sid=mallory');
if (KIND === 'image') {
  m0.doc.transact(() => {
    m0.doc.getMap('assets').set('a0', 'data:image/png;base64,' + 'A'.repeat(Math.floor(3.9 * MiB)));
    m0.doc.getMap('shapes').set('i0', mapOf({ id: 'i0', type: 'image', assetId: 'a0', x: 0, y: 0, w: 60, h: 40, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
  });
} else {
  await waitFor(() => m0.doc.getMap('shapes').size === 9000, 30_000, 'room synced');
}
await sleep(3000);
if (m0.closeCode !== null) throw new Error(`the writer was closed before the flood: ${m0.closeCode}\n${log}`);
const flood = syncMsg(Y.encodeStateAsUpdate(m0.doc));

// the honest pair in another room
const ana = await join(honestKey, 'sid=ana');
const bob = await join(honestKey, 'sid=bob');
const lat: number[] = [];
const sentAt = new Map<string, number>();
bob.doc.getMap('shapes').observe((e) => {
  for (const k of e.keysChanged) {
    const t = sentAt.get(k);
    if (t !== undefined && bob.doc.getMap('shapes').has(k)) lat.push(Date.now() - t), sentAt.delete(k);
  }
});
let edits = 0;
const editTimer = setInterval(() => {
  const id = `e${edits++}`;
  sentAt.set(id, Date.now());
  const s = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ id, type: 'geo', geo: 'rectangle', x: edits, y: 0, w: 10, h: 10, rotation: 0, index: edits, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 })) s.set(k, v);
  ana.doc.getMap('shapes').set(id, s);
}, 200);

// baseline
await sleep(2000);
const baseRss: number[] = [];
for (let i = 0; i < 10; i++) {
  baseRss.push(rssMiB());
  await sleep(100);
}
const baseline = Math.max(...baseRss);
const m = await metrics();
const baseExternal = m.get('nodejs_external_memory_bytes') ?? NaN;

// the flood
const floods = [m0];
for (let i = 1; i < CONNS; i++) floods.push(await join(floodKey, 'sid=mallory'));
let peakRss = baseline;
let peakInflight = 0;
let peakExternal = baseExternal;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    peakRss = Math.max(peakRss, rssMiB() || 0);
    const mm = await metrics();
    peakInflight = Math.max(peakInflight, mm.get('canvas_ws_inflight_bytes') ?? 0);
    peakExternal = Math.max(peakExternal, mm.get('nodejs_external_memory_bytes') ?? 0);
    await sleep(100);
  }
})();
const t0 = Date.now();
const sent = floods.map(() => 0);
await Promise.all(
  floods.map(async (c, i) => {
    while (sent[i] < MESSAGES && c.closeCode === null && Date.now() - t0 < 90_000) {
      if (c.ws.bufferedAmount < 8 * MiB) {
        c.sendRaw(flood);
        sent[i]++;
      } else await sleep(2);
    }
  }),
);
const floodMs = Date.now() - t0;
// what was read is processed or dropped
for (let i = 0; i < 100 && ((await metrics()).get('canvas_ws_inflight_bytes') ?? 0) > 0; i++) await sleep(100);
await sleep(3000);
sampling = false;
await sampler;
clearInterval(editTimer);
await sleep(1000);
const after = rssMiB();
const mm = await metrics();
const rejected: Record<string, number> = {};
for (const [k, v] of mm) {
  const r = /^canvas_ws_rejected_total\{reason="([^"]+)"\}/.exec(k);
  if (r && v) rejected[r[1]] = v;
}
const ls = [...lat].sort((a, b) => a - b);
console.log(JSON.stringify({
  node: process.version, entry: path.relative(repo, entry), kind: KIND, conns: CONNS, messageMiB: mib(flood.byteLength), messagesPerConn: MESSAGES,
  sent: sent.reduce((a, b) => a + b, 0), sentMiB: mib(sent.reduce((a, b) => a + b, 0) * flood.byteLength), floodMs,
  floodCloses: floods.map((c) => c.closeCode),
  baselineRssMiB: Math.round(baseline), peakRssMiB: Math.round(peakRss), peakOverBaselineMiB: Math.round(peakRss - baseline), afterRssMiB: Math.round(after),
  peakInflightMiB: mib(peakInflight), baseExternalMiB: mib(baseExternal), peakExternalMiB: mib(peakExternal),
  paused: sumOf(mm, 'canvas_ws_paused_total'), rejected,
  workerReplies: mm.get('canvas_worker_reply_seconds_count') ?? null, pendingResync: mm.get('canvas_pending_resync_total') ?? null,
  honest: { edits, relayed: lat.length, p50: ls[Math.floor(ls.length / 2)] ?? null, p95: ls[Math.floor(ls.length * 0.95)] ?? null, max: ls[ls.length - 1] ?? null, anaClose: ana.closeCode, bobClose: bob.closeCode },
  serverExited: exited,
}));
for (const c of [...floods, ana, bob]) c.ws.terminate();
child.kill('SIGTERM');
await core.close();
await s3.close();
process.exit(0);
