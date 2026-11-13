/**
 * fv8 P2 calibration: Yjs apply time of updates that cut items, against the guard's estimate
 * (UpdateCheck.splitWork), on the host it runs on. The server refuses an update whose splitWork
 * passes MAX_SPLIT_WORK and pre-charges SPLIT_WORK_NS per unit of it (config.ts): this measures
 * the ns per unit to set them so that no accepted update applies for more than ~50 ms.
 *   cuts-L       k inserts, each between two elements of ONE points item of L elements (Yjs copies
 *                the item's content on every cut)
 *   text-L       the same in a text (ContentString)
 *   known-L      k structs the room has, re-sent with origins inside the item (cut, then merged back)
 *   moves-S      k cuts of short items at the start of a client's struct array of S structs (every
 *                cut moves the structs after it)
 *   node --expose-gc --import tsx test/fv8/split-cpu-cal.ts
 */
import * as Y from 'yjs';
import { applyGuarded, checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import { insertsBetween, itemAt, knownCuts } from './craft.js';

const gc = (globalThis as { gc?: () => void }).gc ?? (() => undefined);
const origin = { identity: { id: 'm@corp' } };
const draw = (id: string) => ({ id, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false });
const note = (id: string) => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'yellow', size: 'm', font: 'draw', align: 'middle', opacity: 1 });
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};

/** A room whose client 1000 holds `extraShapes` geo-like shapes (17 structs each) after one stroke of `len` points. */
function room(len: number, kind: 'points' | 'text', extraShapes = 0): { doc: Y.Doc; item: Y.Item } {
  const a = new Y.Doc();
  a.clientID = 1000;
  a.transact(() => {
    const m = mapOf(kind === 'points' ? draw('s') : note('s'));
    m.set(kind, kind === 'points' ? new Y.Array<number>() : new Y.Text());
    a.getMap('shapes').set('s', m);
  });
  const t = (a.getMap('shapes').get('s') as Y.Map<unknown>).get(kind) as Y.Array<number> | Y.Text;
  a.transact(() => {
    if (t instanceof Y.Text) {
      t.insert(0, 'z');
      t.insert(0, 'a'.repeat(len));
    } else {
      t.insert(0, [1]);
      t.insert(0, Array.from({ length: len }, (_, i) => i % 100));
    }
  });
  for (let b = 0; b < extraShapes; b += 2000) {
    a.transact(() => {
      for (let i = b; i < Math.min(extraShapes, b + 2000); i++) a.getMap('shapes').set(`g${i}`, mapOf({ ...draw(`g${i}`), type: 'geo', geo: 'rectangle', font: 'draw', arrowheads: 'end' }));
    });
  }
  const doc = materializeContent(new Y.Doc());
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(a));
  const rt = (doc.getMap('shapes').get('s') as Y.Map<unknown>).get(kind) as Y.Array<number> | Y.Text;
  return { doc, item: itemAt(rt as Y.AbstractType<unknown>, 0) };
}

interface Row { name: string; k: number; splits: number; splitWork: number; guardMs: number; applyMs: number; nsPerWork: number; usPerCut: number }
const rows: Row[] = [];
function measure(name: string, doc: Y.Doc, update: Uint8Array, k: number) {
  gc();
  const t0 = performance.now();
  const chk = checkClientUpdate(doc, update, { serverClient: doc.clientID });
  const t1 = performance.now();
  if (chk.bad) throw new Error(`${name}: ${chk.bad}`);
  const o = applyGuarded(doc, update, origin);
  const t2 = performance.now();
  if (o.threw || o.droppedPending) throw new Error(`${name}: apply ${JSON.stringify(o)}`);
  const r: Row = {
    name, k, splits: chk.splits, splitWork: chk.splitWork, guardMs: +(t1 - t0).toFixed(1), applyMs: +(t2 - t1).toFixed(1),
    nsPerWork: +(((t2 - t1) * 1e6) / chk.splitWork).toFixed(3), usPerCut: +(((t2 - t1) * 1e3) / Math.max(1, chk.splits)).toFixed(2),
  };
  rows.push(r);
  console.log(JSON.stringify(r));
}

const K = Number(process.argv[2] ?? 5000);
for (const L of [1_000, 10_000, 100_000, 290_000]) {
  for (const k of [100, 1000, K]) {
    if (k >= L) continue;
    const { doc, item } = room(L, 'points');
    measure(`cuts-${L}`, doc, insertsBetween([{ into: item, count: k }], 2000, 0), k);
  }
}
for (const k of [1000, 4000]) {
  // a text holds at most MAX_TEXT_LENGTH (10 000) characters, inserts included
  const { doc, item } = room(5_500, 'text');
  measure('text', doc, insertsBetween([{ into: item, count: k }], 2000, 0, 'string'), k);
}
for (const L of [100_000, 290_000]) {
  for (const k of [1000, K]) {
    const { doc, item } = room(L, 'points');
    // client 1500 first writes k single points elsewhere (the structs it then re-sends as known)
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(doc));
    b.clientID = 1500;
    const arr = (b.getMap('shapes').get('s') as Y.Map<unknown>).get('points') as Y.Array<number>;
    for (let i = 0; i < k; i++) b.transact(() => arr.insert(arr.length, [9]));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(b, Y.encodeStateVector(doc)));
    measure(`known-${L}`, doc, knownCuts(item, 1500, 0, k), k);
  }
}
for (const S of [20_000, 100_000, 400_000]) {
  const { doc, item } = room(K + 2, 'points', Math.ceil(S / 17));
  measure(`moves-${S}`, doc, insertsBetween([{ into: item, count: K }], 2000, 0), K);
}
const worst = rows.reduce((a, r) => (r.nsPerWork > a.nsPerWork ? r : a));
console.log('summary', JSON.stringify({ k: K, worstNsPerWork: worst.nsPerWork, worstCase: worst.name, maxApplyMs: Math.max(...rows.map((r) => r.applyMs)), worstUsPerCut: Math.max(...rows.map((r) => r.usPerCut)) }));
