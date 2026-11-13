// review F-1 probe: the guard estimate (and the apply) of deleting K shapes of a room of N written from ONE client id, by selection pattern; the editor deletes DELETE_BATCH (client/src/model/doc.ts) at a time.
// run: cd server && npx tsx test/fv9/delete-batch.ts
import * as Y from 'yjs';
import { testCore } from '../helpers/core.js';
import { applyEstimateMs } from '../../src/config.js';
const geo = (id: string, i: number) => ({ id, type: 'geo', geo: 'rectangle', x: i, y: i, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const small = (id: string, i: number) => ({ id, type: 'geo', geo: 'rectangle', x: i, y: 0, w: 1, h: 1, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
function shapeMap(o: Record<string, unknown>) { const m = new Y.Map<unknown>(); for (const [k, v] of Object.entries(o)) m.set(k, v); return m; }
function build(n: number, mk: typeof geo, idp: string) {
  const room = testCore(1000);
  const d = new Y.Doc();
  const origin = { identity: { id: 'm@x', name: 'm', anonymous: false, color: '#000' } };
  for (let b = 0; b < n; b += 500) {
    const sv = Y.encodeStateVector(d);
    d.transact(() => { const s = d.getMap('shapes'); for (let i = b; i < Math.min(n, b + 500); i++) s.set(`${idp}${i}`, shapeMap(mk(`${idp}${i}`, i))); });
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(d, sv), origin);
  }
  return room.save();
}
const pats: Record<string, (n: number, k: number, off: number) => number[]> = {
  run: (n, k, off) => Array.from({ length: k }, (_, i) => off + i),
  alt: (n, k, off) => Array.from({ length: k }, (_, i) => (off + 2 * i) % n),
  spread: (n, k) => Array.from({ length: k }, (_, i) => Math.floor((i * n) / k)),
};
for (const [N, mk, idp] of [[10400, geo, 'f'], [14000, small, 'g']] as const) {
  const saved = build(N as number, mk as typeof geo, idp as string);
  console.log(JSON.stringify({ N, bytes: saved.content.byteLength + saved.ledger.byteLength }));
  for (const K of [500, 1000, 2000]) for (const [pn, pat] of Object.entries(pats)) for (const off of [0, Math.floor((N as number) / 2)]) {
    const core = testCore(1000); core.load(saved.ledger, saved.content, false);
    const a = new Y.Doc(); Y.applyUpdate(a, saved.content); const sv = Y.encodeStateVector(a);
    const ids = pat(N as number, K, off);
    a.transact(() => { const s = a.getMap('shapes'); for (const i of ids) s.delete(`${idp}${i}`); });
    const u = Y.encodeStateAsUpdate(a, sv);
    const c = core.check(u, 'alice@x', new Set());
    const est = applyEstimateMs(0, c.splitWork, c.scanWork);
    let applyMs = -1; if (!c.bad) { const t = performance.now(); core.apply({ id: 'alice@x', name: 'A', anonymous: false, color: '#111' }); applyMs = performance.now() - t; }
    console.log(JSON.stringify({ N, K, pat: pn, off, bad: c.bad, deletesOnly: c.deletesOnly, estNoBytesMs: +est.toFixed(0), applyMs: +applyMs.toFixed(0) }));
  }
}
