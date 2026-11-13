/**
 * fv9: resident cost of a room's worker with an empty room loaded (config.ts WORKER_BASE_COST_BYTES),
 * measured on the compiled server (npm run build): RSS of the process with N workers, each with an
 * empty room loaded and its join frames encoded, minus the RSS before, per worker.
 *   node test/fv9/worker-cost.mjs [N=40]
 */
import { WorkerHost } from '../../dist/worker-host.js';
const N = Number(process.argv[2] ?? 40);
const settle = () => new Promise((r) => setTimeout(r, 1500));
globalThis.gc?.();
await settle();
const rss0 = process.memoryUsage().rss;
const hosts = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const h = new WorkerHost({ name: `r${i}`, core: { attributionRetentionDays: 30, maxSplits: 5000, maxSplitWork: 1.6e8, maxScanWork: 4e6, maxClients: 256 }, testHooks: false }, { oldMb: 512, youngMb: 16 });
  await h.ready;
  await h.call({ op: 'load', ledger: null, content: null, recovery: false }, 10_000);
  await h.call({ op: 'frames', content: true, ledger: true, sv: true }, 10_000);
  hosts.push(h);
}
const startMs = (performance.now() - t0) / N;
await settle();
const rss1 = process.memoryUsage().rss;
console.log(JSON.stringify({ node: process.version, workers: N, startMsEach: +startMs.toFixed(1), rssPerWorkerMiB: +((rss1 - rss0) / N / 1048576).toFixed(2) }));
for (const h of hosts) await h.terminate();
