/**
 * fv8 P1/P2 measure: what one cut of an item adds to the encoded room, and what it costs Yjs to
 * make, for every way an update can cut items (docs/protocol.md §10). For each variant one update
 * is built, checked by the real guard and applied with applyGuarded to a content document:
 *   growth      encoded content after - before (encodeIntegratedState)
 *   perSplit    (growth - update bytes) / cuts the guard counted: what SPLIT_COST_BYTES must cover
 *   applyMs     Yjs apply time; nsPerWork = applyMs / splitWork (the server's CPU estimate)
 * Variants:
 *   points-ro / points    an insert between every two points of a stroke (with / without a right origin)
 *   text-ro / text        the same in a text
 *   del-points / del-text every other element deleted (delete-set cuts, fv5 L-2)
 *   fresh-cut             one new long item plus inserts into its middle, merged into one update
 *   known-cut             structs the room has, with origins in the middle of a long room item
 *   big-ids               points-ro with 5-byte client ids and clocks past 2^28
 *   many-structs          cuts of short items of a client with a very long struct array (moves)
 *   honest-image / honest-shapes   no cuts: a 3 MB image, 20 000 geo shapes (bytes only)
 *   node --import tsx test/fv8/split-growth.ts [n=4000]
 */
import * as Y from 'yjs';
import { applyGuarded, checkClientUpdate, encodeIntegratedState } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import * as lib0enc from 'lib0/encoding';

const n = Number(process.argv[2] ?? 4000);
const only = process.argv[3];
const origin = { identity: { id: 'm@corp' } };
const draw = (id: string) => ({ id, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false });
const note = (id: string) => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'yellow', size: 'm', font: 'draw', align: 'middle', opacity: 1 });
const geo = (id: string, j: number) => ({ id, type: 'geo', geo: 'rectangle', x: j % 900, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};

interface Row {
  variant: string;
  bytes: number;
  splits: number;
  splitWork: number;
  scanWork: number;
  growth: number;
  perSplit: number | null;
  guardMs: number;
  applyMs: number;
  nsPerWork: number | null;
}

/** Push `update` into `room` through the guard; growth of the encoded content and timings. */
function push(variant: string, room: Y.Doc, update: Uint8Array): Row {
  const before = encodeIntegratedState(room).byteLength;
  const t0 = performance.now();
  const chk = checkClientUpdate(room, update, { serverClient: room.clientID });
  const t1 = performance.now();
  if (chk.bad) throw new Error(`${variant}: guard refused ${chk.bad}`);
  const o = applyGuarded(room, update, origin);
  const t2 = performance.now();
  if (o.threw || o.droppedPending) throw new Error(`${variant}: apply ${JSON.stringify(o)}`);
  const growth = encodeIntegratedState(room).byteLength - before;
  return {
    variant,
    bytes: update.byteLength,
    splits: chk.splits,
    splitWork: chk.splitWork,
    scanWork: chk.scanWork,
    growth,
    perSplit: chk.splits ? +((growth - update.byteLength) / chk.splits).toFixed(2) : null,
    guardMs: +(t1 - t0).toFixed(1),
    applyMs: +(t2 - t1).toFixed(1),
    nsPerWork: chk.splitWork ? +(((t2 - t1) * 1e6) / chk.splitWork).toFixed(2) : null,
  };
}

/** A client doc and a room that both hold the client's base state. */
function base(build: (d: Y.Doc) => void, client = 1000): { a: Y.Doc; room: Y.Doc } {
  const a = new Y.Doc();
  a.clientID = client;
  build(a);
  const room = materializeContent(new Y.Doc());
  const u = Y.encodeStateAsUpdate(a);
  const chk = checkClientUpdate(room, u);
  if (chk.bad) throw new Error('base refused ' + chk.bad);
  applyGuarded(room, u, origin);
  return { a, room };
}
function strokeWithPoints(d: Y.Doc, len: number, ro: boolean) {
  const sm = mapOf(draw('s1'));
  sm.set('points', new Y.Array<number>());
  d.getMap('shapes').set('s1', sm);
  const arr = sm.get('points') as Y.Array<number>;
  if (ro) arr.insert(0, [1]);
  arr.insert(0, Array.from({ length: len }, (_, i) => i % 100));
}
function noteWithText(d: Y.Doc, len: number, ro: boolean) {
  const nm = mapOf(note('n1'));
  nm.set('text', new Y.Text());
  d.getMap('shapes').set('n1', nm);
  const t = nm.get('text') as Y.Text;
  if (ro) t.insert(0, 'z');
  t.insert(0, 'a'.repeat(len));
}
const points = (d: Y.Doc) => (d.getMap('shapes').get('s1') as Y.Map<unknown>).get('points') as Y.Array<number>;
const text = (d: Y.Doc) => (d.getMap('shapes').get('n1') as Y.Map<unknown>).get('text') as Y.Text;
/** One update: the client's edits made in `edit`, as client `client`. */
function edit(a: Y.Doc, client: number, fn: () => void): Uint8Array {
  const sv = Y.encodeStateVector(a);
  a.clientID = client;
  a.transact(fn);
  return Y.encodeStateAsUpdate(a, sv);
}

const rows: Row[] = [];
const run = (name: string, fn: () => Row) => {
  if (only && only !== name) return;
  rows.push(fn());
  console.log(JSON.stringify(rows[rows.length - 1]));
};

for (const ro of [true, false]) {
  run(ro ? 'points-ro' : 'points', () => {
    const { a, room } = base((d) => strokeWithPoints(d, n + 1, ro));
    // inserted from the end, so that every insert cuts the long item of the base (a client cuts
    // its own copy the same way; the update names the base clocks as origins)
    const u = edit(a, 2000, () => {
      for (let i = n; i >= 1; i--) points(a).insert(i, [7]);
    });
    return push(ro ? 'points-ro' : 'points', room, u);
  });
  run(ro ? 'text-ro' : 'text', () => {
    const len = Math.min(n, 9000);
    const { a, room } = base((d) => noteWithText(d, len + 1, ro));
    const u = edit(a, 2000, () => {
      for (let i = len; i >= 1; i--) text(a).insert(i, 'x');
    });
    return push(ro ? 'text-ro' : 'text', room, u);
  });
}
run('del-points', () => {
  const { a, room } = base((d) => strokeWithPoints(d, 2 * n + 1, true));
  const u = edit(a, 2000, () => {
    for (let i = 2 * n - 1; i >= 1; i -= 2) points(a).delete(i, 1);
  });
  return push('del-points', room, u);
});
run('del-text', () => {
  const len = Math.min(2 * n, 9000);
  const { a, room } = base((d) => noteWithText(d, len + 1, true));
  const u = edit(a, 2000, () => {
    for (let i = len - 1; i >= 1; i -= 2) text(a).delete(i, 1);
  });
  return push('del-text', room, u);
});
run('fresh-cut', () => {
  // the room has the stroke; ONE update adds a long run of points and inserts into its middle:
  // merged, the run travels as one struct and the inserts name clocks inside it
  const { a, room } = base((d) => strokeWithPoints(d, 1, true));
  const sv = Y.encodeStateVector(a);
  const u1 = edit(a, 2000, () => points(a).insert(1, Array.from({ length: n + 1 }, (_, i) => i % 100)));
  const u2 = edit(a, 2001, () => {
    for (let i = n; i >= 1; i--) points(a).insert(1 + i, [7]);
  });
  void sv;
  return push('fresh-cut', room, Y.mergeUpdates([u1, u2]));
});
run('known-cut', () => {
  // the room has a long stroke (client 1000) and a run of n single-point items of client 1500;
  // the update re-sends client 1500's items (known) naming clocks inside the stroke as origins
  const { a, room } = base((d) => strokeWithPoints(d, n + 2, true));
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const u0 = edit(b, 1500, () => {
    for (let i = 0; i < n; i++) points(b).insert(points(b).length, [9]);
  });
  const c0 = checkClientUpdate(room, u0);
  if (c0.bad) throw new Error('known-cut base ' + c0.bad);
  applyGuarded(room, u0, origin);
  // forge: the same structs, origins rewritten into the stroke's middle (raw encoder below)
  const forged = forgeKnown(1500, n, 1000);
  return push('known-cut', room, forged);
});
run('big-ids', () => {
  // client ids of 5 bytes and clocks past 2^28 (5 bytes each): a GC run of 2^28 clocks first (an
  // update the guard accepts: it writes nothing), then the stroke
  const big = 4294967000;
  const gc = lib0enc.createEncoder();
  lib0enc.writeVarUint(gc, 1);
  lib0enc.writeVarUint(gc, 1);
  lib0enc.writeVarUint(gc, big);
  lib0enc.writeVarUint(gc, 0);
  lib0enc.writeUint8(gc, 0); // GC
  lib0enc.writeVarUint(gc, 2 ** 28 + 7);
  lib0enc.writeVarUint(gc, 0);
  const { a, room } = base(() => undefined, 1000);
  Y.applyUpdate(a, lib0enc.toUint8Array(gc));
  Y.applyUpdate(room, lib0enc.toUint8Array(gc));
  a.clientID = big;
  a.transact(() => {
    const sm = mapOf(draw('s1'));
    sm.set('points', new Y.Array<number>());
    a.getMap('shapes').set('s1', sm);
  });
  a.transact(() => {
    points(a).insert(0, [1]);
    points(a).insert(0, Array.from({ length: n + 1 }, (_, i) => i % 100));
  });
  const up = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room));
  const cb = checkClientUpdate(room, up);
  if (cb.bad) throw new Error('big-ids base ' + cb.bad);
  applyGuarded(room, up, origin);
  const u = edit(a, big + 1, () => {
    for (let i = n; i >= 1; i--) points(a).insert(i, [7]);
  });
  return push('big-ids', room, u);
});
run('big-ids-del', () => {
  // the same ids, every other point deleted: two cuts, one deleted piece and one delete range each
  const big = 4294967000;
  const gc = lib0enc.createEncoder();
  lib0enc.writeVarUint(gc, 1);
  lib0enc.writeVarUint(gc, 1);
  lib0enc.writeVarUint(gc, big);
  lib0enc.writeVarUint(gc, 0);
  lib0enc.writeUint8(gc, 0);
  lib0enc.writeVarUint(gc, 2 ** 28 + 7);
  lib0enc.writeVarUint(gc, 0);
  const { a, room } = base(() => undefined, 1000);
  Y.applyUpdate(a, lib0enc.toUint8Array(gc));
  Y.applyUpdate(room, lib0enc.toUint8Array(gc));
  a.clientID = big;
  a.transact(() => {
    const sm = mapOf(draw('s1'));
    sm.set('points', new Y.Array<number>());
    a.getMap('shapes').set('s1', sm);
  });
  a.transact(() => {
    points(a).insert(0, [1]);
    points(a).insert(0, Array.from({ length: 2 * n + 1 }, (_, i) => i % 100));
  });
  const up = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room));
  applyGuarded(room, up, origin);
  const u = edit(a, big + 1, () => {
    for (let i = 2 * n - 1; i >= 1; i -= 2) points(a).delete(i, 1);
  });
  return push('big-ids-del', room, u);
});
run('many-structs', () => {
  // client 1000 owns a very long struct array (one item per shape field); the update cuts n of
  // its short multi-point items: every cut moves the structs after it
  const { a, room } = base((d) => {
    for (let s = 0; s < 400; s++) {
      const sm = mapOf(draw(`s${s}`));
      sm.set('points', new Y.Array<number>());
      d.getMap('shapes').set(`s${s}`, sm);
    }
  });
  for (let s = 0; s < 400; s++) {
    const arr = (a.getMap('shapes').get(`s${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>;
    for (let k = 0; k < 200; k++) a.transact(() => arr.insert(arr.length, [k % 100, 1, 2]));
  }
  const up = Y.encodeStateAsUpdate(a, Y.encodeStateVector(room));
  applyGuarded(room, up, origin);
  const u = edit(a, 2000, () => {
    let c = 0;
    for (let s = 0; s < 400 && c < n; s++) {
      const arr = (a.getMap('shapes').get(`s${s}`) as Y.Map<unknown>).get('points') as Y.Array<number>;
      for (let k = 199; k >= 0 && c < n; k--, c++) arr.insert(k * 3 + 1, [5]);
    }
  });
  return push('many-structs', room, u);
});
run('honest-image', () => {
  const { a, room } = base(() => undefined);
  const u = edit(a, 2000, () => {
    a.getMap('assets').set('img', 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024));
    a.getMap('shapes').set('i', mapOf({ id: 'i', type: 'image', assetId: 'img', x: 0, y: 0, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false, opacity: 1 }));
  });
  return push('honest-image', room, u);
});
run('honest-shapes', () => {
  const { a, room } = base(() => undefined);
  const u = edit(a, 2000, () => {
    for (let i = 0; i < 20_000; i++) a.getMap('shapes').set(`g${i}`, mapOf(geo(`g${i}`, i)));
  });
  return push('honest-shapes', room, u);
});

const cut = rows.filter((r) => r.perSplit !== null);
console.log(
  'summary',
  JSON.stringify({
    n,
    worstPerSplit: Math.max(...cut.map((r) => r.perSplit as number)),
    worstNsPerWork: Math.max(...cut.map((r) => r.nsPerWork as number)),
    maxApplyMsPerMB: Math.max(...rows.filter((r) => !r.splits).map((r) => (r.applyMs + r.guardMs) / (r.bytes / 1048576))),
  }),
);

/**
 * An update of `count` structs of `client` that the room has (clocks 0..count-1), each of length
 * one, ContentAny, with an origin inside client `into`'s long item (clock 1 + i): Yjs resolves
 * those origins (cutting the item) before it skips the structs.
 */
function forgeKnown(client: number, count: number, into: number): Uint8Array {
  const e = lib0enc.createEncoder();
  lib0enc.writeVarUint(e, 1); // one client block
  lib0enc.writeVarUint(e, count);
  lib0enc.writeVarUint(e, client);
  lib0enc.writeVarUint(e, 0); // first clock
  for (let i = 0; i < count; i++) {
    // info: ContentAny (8) | has origin (0x80)
    lib0enc.writeUint8(e, 8 | 0x80);
    lib0enc.writeVarUint(e, into);
    lib0enc.writeVarUint(e, 1 + i);
    lib0enc.writeVarUint(e, 1); // one value
    lib0enc.writeAny(e, 9);
  }
  lib0enc.writeVarUint(e, 0); // empty delete set
  return lib0enc.toUint8Array(e);
}
