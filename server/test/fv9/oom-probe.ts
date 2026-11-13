/**
 * fv9 probe: a room worker allocating without bound (WORKER_TEST_HOOKS) against its heap limit:
 * how long until ERR_WORKER_OUT_OF_MEMORY, and the main thread's event loop meanwhile.
 *   npx tsx test/fv9/oom-probe.ts [oldMb=47] [youngMb=16]
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as Y from 'yjs';
import { WorkerHost } from '../../src/worker-host.js';

const oldMb = Number(process.argv[2] ?? 47);
const youngMb = Number(process.argv[3] ?? 16);
const h = new WorkerHost({ name: 'x', core: { attributionRetentionDays: 30, maxSplits: 5000, maxSplitWork: 1e9, maxScanWork: 1e9, maxClients: 256 }, testHooks: true }, { oldMb, youngMb });
await h.ready;
await h.call({ op: 'load', ledger: null, content: null, recovery: false }, 10_000);
const d = new Y.Doc();
d.getMap('meta').set('k', 'canvas-test-hook:alloc');
const u = Y.encodeStateAsUpdate(d);
const hist = monitorEventLoopDelay({ resolution: 10 });
hist.enable();
const t0 = performance.now();
let kind = 'none';
try {
  await h.call({ op: 'check', update: u, writer: 'x', claimed: [] }, 60_000);
} catch (err) {
  kind = String(err);
}
const ms = performance.now() - t0;
await h.terminate();
const t1 = performance.now();
hist.disable();
console.log(JSON.stringify({ oldMb, youngMb, faultMs: Math.round(ms), terminateMs: Math.round(t1 - t0 - ms), kind: kind.slice(0, 80), maxStallMs: Math.round(hist.max / 1e6), p99StallMs: Math.round(hist.percentile(99) / 1e6) }));
process.exit(0);
