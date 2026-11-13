import { WorkerHost } from '../../src/worker-host.js';
const t0 = performance.now();
for (let i = 0; i < 5; i++) {
  const h = new WorkerHost({ name: 'x', core: { attributionRetentionDays: 30, maxSplits: 5000, maxSplitWork: 1e7, maxScanWork: 2e5, maxClients: 256 }, testHooks: false }, { oldMb: 256, youngMb: 16 });
  const s = performance.now();
  await h.ready;
  console.log('ready', Math.round(performance.now() - s), 'ms');
  await h.terminate();
}
console.log('total', Math.round(performance.now() - t0));
