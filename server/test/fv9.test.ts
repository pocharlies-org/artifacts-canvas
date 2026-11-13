/**
 * Regressions of the ninth independent verification (fv9). Its PoCs are server/test/fv9/*.ts
 * (the numbers in the comments are the verifier's, before; craft.ts builds the same updates).
 *   A  ONE update of 20 000 single-number items continuing each other (143 KB, anonymous-sized):
 *      Yjs merges them by concatenating the growing array per item; the canvas ran out of heap.
 *   B  ONE update of 100 000 separate mergeable pairs: one splice of the struct array per pair, 5.4 s.
 *   C  a delete-only update of 80 000 ranges in a fragmented room: one merge splice each, 8.6 s.
 *   D  ONE anonymous update of 60 000 formatting items + 9 000 characters in a note: 60 s.
 *   E  the guard itself: 20 000 items over 20 000 client blocks chained backwards, 27 s.
 *   F  anonymous visitors loading 5 MiB pub/ rooms were charged one visitor share each while the
 *      rooms cost 651 MiB: a signed-in user could no longer grow anything.
 * And the architecture that bounds every path nobody has found yet: each room runs in a worker
 * thread of its own with a heap limit; the main thread waits for its answers with a watchdog,
 * terminates a worker that misses it or runs out of heap, closes and strikes the sender, and
 * rebuilds the room from its saved objects and write-ahead log (byte for byte the room it was).
 * The full-system variants (the real core, the chart's memory limit) are
 * e2e-system/adversarial-fv9.spec.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { checkClientUpdate, applyGuarded } from '@pocharlies/artifacts-canvas-shared/stamper';
import { loadConfig, oldSpaceFlag } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';
import { testCore } from './helpers/core.js';
import { runHonestFuzz } from './fuzz/honest-fuzz.js';
import { alternating, chain, deleteRanges, formatting, mergePairs, mergeRun, syncMsg } from './fv9/craft.js';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 29900;
const apps: App[] = [];
const silent = createLogger('silent');
const MiB = 1024 * 1024;
const mib = (b: number) => Math.round((b / MiB) * 100) / 100;
const BASE_ENV = { GATE_AUTHZ_URL: 'http://c/', ARTIFACT_BASE_URL: 'http://c/', S3_BUCKET: 'b', METRICS_PORT: '0' };

async function startApp(env: Record<string, string> = {}): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '300', SAVE_DEBOUNCE_MS: '50',
      READYZ_CACHE_MS: '10', PORT: String(++portSeq), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0', ...env,
    });
    const app = createApp({ config: cfg, store, logger: silent });
    try {
      await app.listen();
    } catch (e) {
      await app.close().catch(() => undefined);
      if (String(e).includes('EADDRINUSE')) continue;
      throw e;
    }
    apps.push(app);
    return app;
  }
}
const port = (app: App) => (app.server.address() as { port: number }).port;
const base = (app: App) => `ws://127.0.0.1:${port(app)}/_canvas/_/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function metric(app: App, name: 'wsRejected' | 'workerFaults' | 'workerRecoveries' | 'strikes', label: string, value: string): Promise<number> {
  const m = await (app.metrics[name] as unknown as { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }).get();
  return m.values.filter((v) => v.labels[label] === value).reduce((a, v) => a + v.value, 0);
}
function share(key: string, ...who: string[]) {
  for (const u of who) core.rulesByCookie.set(`sid=${u}|${key}`, allowUser(`${u}@corp`, u));
}
async function join(app: App, key: string, cookie?: string): Promise<TestClient> {
  const c = new TestClient(`${base(app)}/${key}`, cookie);
  await c.connect();
  await waitFor(() => c.step1Received > 0 || c.closeCode !== null, 10_000, 'join settled').catch(() => undefined);
  return c;
}
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
const draw = (id: string, j = 0) => ({ id, type: 'draw', x: j, y: 0, w: 100, h: 100, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false });
const geo = (id: string, j = 0) => ({ id, type: 'geo', geo: 'rectangle', x: j * 20, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const note = (id: string) => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'yellow', size: 'm', font: 'draw', align: 'middle', opacity: 1 });
/** A stroke `id` with points [1, 2] written by `d` (its own transaction). */
function stroke(d: Y.Doc, id: string): Y.Array<number> {
  const pts = new Y.Array<number>();
  d.transact(() => {
    const m = mapOf(draw(id));
    m.set('points', pts);
    d.getMap('shapes').set(id, m);
  });
  pts.insert(0, [1, 2]);
  return pts;
}
const asUser = { identity: { id: 'ana@corp', name: 'Ana', anonymous: false, color: '#000' } };
/** The main thread's event loop delay (ms, max) while `fn` runs: the server lives in this process. */
async function stall<T>(fn: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  try {
    const value = await fn();
    return { value, maxMs: h.max / 1e6 };
  } finally {
    h.disable();
  }
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv9-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>c</title>');
});
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await core.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});
beforeEach(() => {
  store = new MemoryCanvasObjectStore();
  core.rules.clear();
  core.rulesByCookie.clear();
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------
describe('fv9 known paths: the guard counts what Yjs does after an update (in the room worker\'s core)', () => {
  it('A: a run of 20 000 one-number items continuing each other (143 KB) is refused; a run of 1 000 is counted at least what it costs', () => {
    const c = testCore();
    const a = new Y.Doc();
    a.clientID = 11;
    stroke(a, 'd0');
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), asUser);
    const pts = (c.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
    const big = mergeRun(pts, 12, 20_000);
    const t0 = performance.now();
    const chk = c.check(big, 'mallory@corp', new Set());
    const guardMs = performance.now() - t0;
    expect(big.byteLength).toBeLessThan(1024 * 1024); // anonymous-sized
    expect(chk.bad).toBe('splits');
    // the same update, 1 000 items: accepted, its merges counted (999), and the estimate is no
    // smaller than what the apply takes
    const small = mergeRun(pts, 12, 1000);
    const ok = c.check(small, 'mallory@corp', new Set());
    expect(ok.bad).toBeNull();
    expect(ok.merges).toBe(999);
    const t1 = performance.now();
    expect(c.apply(asUser.identity).threw).toBeNull();
    const applyMs = performance.now() - t1;
    const estimate = (small.byteLength * 100 + ok.splitWork * 6 + ok.scanWork * 250) / 1e6;
    console.log('[fv9 A]', JSON.stringify({ bytes: big.byteLength, refused: chk.bad, guardMs: Math.round(guardMs), small: { merges: ok.merges, estimateMs: +estimate.toFixed(1), applyMs: +applyMs.toFixed(1) } }));
    expect(((c.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>).length).toBe(1002);
  });

  it('B: 100 000 separate mergeable pairs (1.58 MB) are refused', () => {
    const c = testCore();
    const a = new Y.Doc();
    a.clientID = 11;
    stroke(a, 'd0');
    stroke(a, 'd1');
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), asUser);
    const p = (id: string) => (c.doc.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>;
    const u = mergePairs(p('d0'), p('d1'), 12, 100_000);
    const t0 = performance.now();
    expect(c.check(u, 'mallory@corp', new Set()).bad).toBe('splits');
    console.log('[fv9 B]', JSON.stringify({ bytes: u.byteLength, guardMs: Math.round(performance.now() - t0) }));
  });

  it('C: a delete-only update of 80 000 ranges that each make a merge in a 360 000-struct room is refused; deleting one shape is not', () => {
    const c = testCore();
    const a = new Y.Doc();
    a.clientID = 11;
    stroke(a, 'd0');
    a.getMap('shapes').set('g0', mapOf(geo('g0')));
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), asUser);
    const pts = (c.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
    let origin = { client: 11, clock: 0 };
    {
      let it = pts._start!;
      while (it.right) it = it.right;
      origin = { client: it.id.client, clock: it.id.clock + it.length - 1 };
    }
    let clock = 0;
    for (let r = 0; r < 2; r++) {
      const b = alternating(origin, 12, clock, 180_000);
      origin = b.origin;
      clock += 180_000;
      expect(c.check(b.update, 'mallory@corp', new Set()).bad).toBeNull();
      expect(c.apply(asUser.identity).threw).toBeNull();
    }
    expect(c.doc.store.clients.get(12)!.length).toBe(360_000);
    const u = deleteRanges(12, 360_000, 80_000);
    const t0 = performance.now();
    const chk = c.check(u, 'mallory@corp', new Set());
    expect(chk.grows).toBe(false);
    expect(chk.bad).toBe('splits');
    // an honest delete of one shape in the same room: accepted
    const del = new Y.Doc();
    Y.applyUpdate(del, Y.encodeStateAsUpdate(c.doc));
    del.clientID = 13;
    const sv = Y.encodeStateVector(del);
    del.getMap('shapes').delete('g0');
    const honest = c.check(Y.encodeStateAsUpdate(del, sv), 'bob@corp', new Set());
    expect(honest.bad).toBeNull();
    console.log('[fv9 C]', JSON.stringify({ bytes: u.byteLength, guardMs: Math.round(performance.now() - t0), honestDelete: { merges: honest.merges, splitWork: honest.splitWork } }));
  }, 60_000);

  it('D: formatting items in a note\'s text are refused (the 0.72 MB anonymous update, and a single one)', () => {
    const c = testCore();
    const a = new Y.Doc();
    a.clientID = 11;
    a.transact(() => {
      const m = mapOf(note('n'));
      m.set('text', new Y.Text('a'));
      a.getMap('shapes').set('n', m);
    });
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), asUser);
    const text = (c.doc.getMap('shapes').get('n') as Y.Map<unknown>).get('text') as Y.Text;
    const u = formatting(text, 12, 60_000, 9_000);
    expect(u.byteLength).toBeLessThan(1024 * 1024);
    const t0 = performance.now();
    expect(c.check(u, 'anon:1', new Set()).bad).toBe('shapes-schema');
    const guardMs = performance.now() - t0;
    expect(c.check(formatting(text, 12, 1, 0), 'anon:1', new Set()).bad).toBe('shapes-schema');
    // characters alone are fine
    expect(c.check(formatting(text, 12, 0, 50), 'anon:1', new Set()).bad).toBeNull();
    console.log('[fv9 D]', JSON.stringify({ bytes: u.byteLength, guardMs: Math.round(guardMs) }));
  });

  it('E: the guard is O(n log n) in the structs whatever the client blocks; more than MAX_CLIENTS_PER_UPDATE blocks are refused', () => {
    const c = testCore();
    const a = new Y.Doc();
    a.clientID = 11;
    stroke(a, 'd0');
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), asUser);
    const pts = (c.doc.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>;
    const wide = chain(pts, 1000, 20_000, 20_000);
    let t0 = performance.now();
    expect(c.check(wide, 'mallory@corp', new Set()).bad).toBe('blocks');
    const refusedMs = performance.now() - t0;
    // 20 000 items chained backwards over 200 blocks (under the cap): the dependency check is linear
    const narrow = chain(pts, 1000, 20_000, 200);
    t0 = performance.now();
    const chk = c.check(narrow, 'mallory@corp', new Set());
    const guardMs = performance.now() - t0;
    expect(chk.bad).toBeNull();
    // and it agrees with Yjs: the chain integrates completely
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(c.doc));
    const out = applyGuarded(copy, narrow, 'x');
    expect(out.droppedPending).toBe(false);
    expect(((copy.getMap('shapes').get('d0') as Y.Map<unknown>).get('points') as Y.Array<number>).length).toBe(20_002);
    // a cycle across two blocks never integrates: pending (refused), as before
    const cyc = encoding.createEncoder();
    encoding.writeVarUint(cyc, 2);
    for (const [cl, other] of [[2000, 2001], [2001, 2000]]) {
      encoding.writeVarUint(cyc, 1);
      encoding.writeVarUint(cyc, cl);
      encoding.writeVarUint(cyc, 0);
      encoding.writeUint8(cyc, 8 | 0x80);
      encoding.writeVarUint(cyc, other);
      encoding.writeVarUint(cyc, 0);
      encoding.writeVarUint(cyc, 1);
      encoding.writeAny(cyc, 1);
    }
    encoding.writeVarUint(cyc, 0);
    expect(checkClientUpdate(c.doc, encoding.toUint8Array(cyc)).bad).toBe('pending');
    console.log('[fv9 E]', JSON.stringify({ wide: { bytes: wide.byteLength, refusedMs: Math.round(refusedMs) }, narrow: { bytes: narrow.byteLength, guardMs: Math.round(guardMs) } }));
    expect(guardMs).toBeLessThan(5000); // before: 20 000 x 200 passes
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv9 A-E through the server: refused in the room\'s worker, the main thread never stalls', () => {
  it('each PoC closes its sender; the room is unchanged; the event loop of the server never stalls 200 ms', async () => {
    const app = await startApp();
    const key = 'u/fv9-poc/index.html';
    share(key, 'ana', 'mallory');
    const ana = await join(app, key, 'sid=ana');
    ana.doc.clientID = 11;
    const d0 = stroke(ana.doc, 'd0');
    const d1 = stroke(ana.doc, 'd1');
    ana.doc.transact(() => {
      const m = mapOf(note('n'));
      m.set('text', new Y.Text('a'));
      ana.doc.getMap('shapes').set('n', m);
    });
    const room = app.manager.get(key)!;
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').size === 3, 5000, 'honest');
    const before = await room.inspect();
    const text = (ana.doc.getMap('shapes').get('n') as Y.Map<unknown>).get('text') as Y.Text;
    const pocs: [string, Uint8Array, number][] = [
      ['A', mergeRun(d0, 900_001, 20_000), 4413],
      ['B', mergePairs(d0, d1, 900_002, 100_000), 4413],
      ['D', formatting(text, 900_003, 60_000, 9_000), 4403],
      ['E', chain(d0, 900_100, 20_000, 2_000), 4413],
    ];
    const out: Record<string, unknown> = {};
    for (const [name, u, code] of pocs) {
      const m = await join(app, key, 'sid=mallory');
      const r = await stall(async () => {
        const t0 = performance.now();
        m.sendRaw(syncMsg(u));
        const c = await m.closed;
        return { code: c, ms: Math.round(performance.now() - t0) };
      });
      out[name] = { bytes: u.byteLength, ...r.value, maxStallMs: Math.round(r.maxMs) };
      expect(r.value.code).toBe(code);
      expect(r.maxMs).toBeLessThan(200);
    }
    const after = await room.inspect();
    expect(Buffer.from(after.contentBytes).equals(Buffer.from(before.contentBytes))).toBe(true);
    expect(ana.closeCode).toBeNull();
    expect(await metric(app, 'workerFaults', 'kind', 'timeout')).toBe(0);
    // A, B, E are refused for their work: a strike each (D is a schema refusal), the third a cooldown
    expect(await metric(app, 'strikes', 'outcome', 'strike')).toBe(3);
    expect(await metric(app, 'strikes', 'outcome', 'cooldown')).toBe(1);
    const again = await join(app, key, 'sid=mallory');
    expect(again.closeCode).toBe(1013);
    console.log('[fv9 through the server]', JSON.stringify(out));
    ana.close();
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
describe('fv9 F: the anonymous pool pays the full cost of the rooms its visitors load', () => {
  /** A stored room of ~`target` encoded bytes: one image asset and its shape, stamped by the real core. */
  async function seedImage(key: string, target: number): Promise<number> {
    const c = testCore();
    const d = new Y.Doc();
    d.transact(() => {
      d.getMap('assets').set('a1', 'data:image/png;base64,' + 'A'.repeat(target - 2048));
      d.getMap('shapes').set('img', mapOf({ id: 'img', type: 'image', assetId: 'a1', x: 0, y: 0, w: 600, h: 400, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
    });
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(d), { identity: { id: 'bob@corp', name: 'bob', anonymous: false, color: '#000' } });
    const saved = c.save();
    await store.put(`_plugins/canvas/${key}.ydoc`, saved.content);
    await store.put(`_plugins/canvas/${key}.ydoc.ledger`, saved.ledger);
    return saved.content.byteLength + saved.ledger.byteLength;
  }

  it('three cookieless visitors open three 4.94 MiB pub/ rooms: one loads, the others wait (1013); the anonymous pool stays under its third; a signed-in user\'s 0.9 MiB edit is accepted', async () => {
    const pubs = ['pub/a/index.html', 'pub/b/index.html', 'pub/c/index.html'];
    const sizes: number[] = [];
    for (const k of pubs) sizes.push(await seedImage(k, Math.floor(5 * MiB) - 64 * 1024));
    for (const k of pubs) core.rules.set(k, allowAnon());
    const victimRoom = 'u/victim/index.html';
    share(victimRoom, 'vic');
    // the verifier's sizing (2 GiB pod before fv9: 872 MiB of loaded rooms)
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(872 * MiB) });
    const visitors: TestClient[] = [];
    for (const k of pubs) visitors.push(await join(app, k));
    await sleep(300);
    const mem = app.manager.memory();
    const loaded = pubs.filter((k) => app.manager.get(k));
    const out = {
      storedMiB: sizes.map(mib),
      visitorsClose: visitors.map((v) => v.closeCode),
      loaded: loaded.length,
      loadedMiB: mib(mem.total),
      anonChargedMiB: mib(app.manager.anonHeld()),
      anonShareMiB: mib(app.manager.anonShare()),
      refusedAnon: await metric(app, 'wsRejected', 'reason', 'room_memory_anon'),
    };
    // before: all three loaded (651 MiB of rooms, the pool charged 218 MiB)
    expect(loaded.length).toBe(1);
    expect(visitors.filter((v) => v.closeCode === 1013).length).toBe(2);
    expect(app.manager.anonHeld()).toBeLessThanOrEqual(app.manager.anonShare());
    expect(app.manager.anonHeld()).toBeGreaterThanOrEqual(app.manager.get(loaded[0])!.cost - 1);
    // the signed-in user grows a room of its own by a 0.9 MiB image: accepted (before: 1013)
    const small = await join(app, victimRoom, 'sid=vic');
    small.doc.transact(() => {
      small.doc.getMap('assets').set('a9', 'data:image/png;base64,' + 'B'.repeat(Math.floor(0.9 * MiB)));
      small.doc.getMap('shapes').set('i9', mapOf({ id: 'i9', type: 'image', assetId: 'a9', x: 0, y: 0, w: 60, h: 40, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
    });
    await waitFor(async () => small.closeCode !== null || !!(await app.manager.get(victimRoom)?.inspect())?.doc.getMap('assets').has('a9'), 10_000, 'growth settled');
    console.log('[fv9 F]', JSON.stringify({ ...out, victimGrowthClose: small.closeCode, loadedAfterMiB: mib(app.manager.memory().total) }));
    expect(small.closeCode).toBeNull();
    // the one-user + all-anonymous bound: a third each at most, two thirds together
    const h = app.manager.heldStats();
    expect(h.user + app.manager.anonHeld()).toBeLessThanOrEqual((2 / 3) * 872 * MiB + 1);
    for (const c of [...visitors, small]) c.close();
  }, 120_000);

  it('a pub/ room whose cost alone passes the anonymous pool never loads for an anonymous visitor (4413), and loads for a signed-in user', async () => {
    const key = 'pub/huge/index.html';
    await seedImage(key, Math.floor(5 * MiB) - 64 * 1024);
    core.rules.set(key, allowAnon());
    share(key, 'bob');
    // a budget whose anonymous third is smaller than that room's cost
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(600 * MiB) });
    expect(app.manager.cost(5 * MiB)).toBeGreaterThan(app.manager.anonShare());
    const v = await join(app, key);
    expect(v.closeCode).toBe(4413);
    const b = await join(app, key, 'sid=bob');
    expect(b.closeCode).toBeNull();
    b.close();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('fv9 isolation: a message that makes its room\'s worker misbehave costs that worker, never the server', () => {
  const HOOKS = { WORKER_TEST_HOOKS: 'true' };
  /** An update writing meta `k` = `v` from a fresh client id (the test hooks look for their marker in it). */
  const metaUpdate = (v: string) => {
    const d = new Y.Doc();
    d.getMap('meta').set('k', v);
    return Y.encodeStateAsUpdate(d);
  };
  async function honestRoom(app: App, key: string) {
    share(key, 'ana', 'bob', 'mallory');
    const ana = await join(app, key, 'sid=ana');
    const bob = await join(app, key, 'sid=bob');
    for (let i = 0; i < 20; i++) ana.doc.getMap('shapes').set(`a${i}`, mapOf(geo(`a${i}`, i)));
    for (let i = 0; i < 20; i++) bob.doc.getMap('shapes').set(`b${i}`, mapOf(geo(`b${i}`, i)));
    const room = app.manager.get(key)!;
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').size === 40, 5000, 'honest edits');
    await waitFor(() => ana.ledger.getMap('attribution').size === 40 && bob.ledger.getMap('attribution').size === 40, 5000, 'ledgers');
    return { ana, bob, room };
  }

  for (const hook of ['busy', 'alloc', 'throw'] as const) {
    // --max-old-space-size (NODE_OPTIONS) overrides every worker's heap limit: the worker would
    // allocate up to the whole heap before it ends (the server warns at start; protocol §12)
    it.skipIf(hook === 'alloc' && oldSpaceFlag())(`${hook}: the worker is terminated (${hook === 'busy' ? 'watchdog' : hook === 'alloc' ? 'out of heap' : 'error'}), the sender closed 4413 and struck, the room rebuilt byte for byte; honest users keep editing; the event loop never stalls 200 ms`, async () => {
      // a small heap for the room's worker, so that allocating without bound ends it quickly
      const env = hook === 'alloc' ? { ...HOOKS, ROOM_MEMORY_BUDGET_BYTES: String(96 * MiB), MAX_MESSAGE_BYTES: String(256 * 1024), WORKER_MESSAGE_TIMEOUT_MS: '20000' } : { ...HOOKS, SAVE_DEBOUNCE_MS: '1000000' };
      const app = await startApp(env);
      const key = `u/fv9-${hook}/index.html`;
      const { ana, bob, room } = await honestRoom(app, key);
      const pre = await room.inspect();
      const m = await join(app, key, 'sid=mallory');
      const r = await stall(async () => {
        const t0 = performance.now();
        m.sendRaw(syncMsg(metaUpdate(`canvas-test-hook:${hook}`)));
        const code = await m.closed;
        await room.settled();
        return { code, ms: Math.round(performance.now() - t0) };
      });
      expect(r.value.code).toBe(4413);
      expect(m.notices.map((n) => n.kind)).toContain('too-large');
      expect(r.maxMs).toBeLessThan(200);
      const kind = hook === 'busy' ? 'timeout' : hook === 'alloc' ? 'oom' : 'error';
      expect(await metric(app, 'workerFaults', 'kind', kind)).toBe(1);
      expect(await metric(app, 'workerRecoveries', 'outcome', 'ok')).toBe(1);
      expect(await metric(app, 'strikes', 'outcome', 'strike')).toBe(1);
      expect(room.restarts).toBe(1);
      expect(app.manager.get(key)).toBe(room);
      // the same room, byte for byte (content and ledger): every accepted edit replayed, never the offending one
      const post = await room.inspect();
      expect(Buffer.from(post.contentBytes).equals(Buffer.from(pre.contentBytes))).toBe(true);
      expect(Buffer.from(post.ledgerBytes).equals(Buffer.from(pre.ledgerBytes))).toBe(true);
      expect(post.doc.getMap('meta').has('k')).toBe(false);
      // honest users were never closed, and edit on: stamped as before
      expect(ana.closeCode).toBeNull();
      expect(bob.closeCode).toBeNull();
      ana.doc.getMap('shapes').set('after', mapOf(geo('after', 99)));
      await waitFor(() => bob.doc.getMap('shapes').has('after') && (bob.ledger.getMap('attribution').get('after') as { createdBy?: string } | undefined)?.createdBy === 'ana@corp', 5000, 'edit after the rebuild');
      console.log(`[fv9 isolation ${hook}]`, JSON.stringify({ ...r.value, maxStallMs: Math.round(r.maxMs), heapLimitMb: room.heapLimitMb }));
      for (const c of [ana, bob]) c.close();
    }, 60_000);
  }

  it('the log covers what was saved and what was not: a room saved mid-session and then rebuilt is the room it was', async () => {
    const app = await startApp({ ...HOOKS, SAVE_DEBOUNCE_MS: '50' });
    const key = 'u/fv9-wal/index.html';
    const { ana, bob, room } = await honestRoom(app, key);
    await room.flush();
    expect(room.walBytes).toBe(0);
    // more edits, not saved yet
    for (let i = 0; i < 5; i++) (ana.doc.getMap('shapes').get(`a${i}`) as Y.Map<unknown>).set('x', 1000 + i);
    bob.doc.getMap('shapes').delete('b0');
    await waitFor(async () => !(await room.inspect()).doc.getMap('shapes').has('b0'), 5000, 'edits');
    const pre = await room.inspect();
    await room.restart();
    const post = await room.inspect();
    expect(Buffer.from(post.contentBytes).equals(Buffer.from(pre.contentBytes))).toBe(true);
    expect(Buffer.from(post.ledgerBytes).equals(Buffer.from(pre.ledgerBytes))).toBe(true);
    // the rebuilt room saves as usual, and a load of what it saved is that room again
    ana.doc.getMap('shapes').set('z', mapOf(geo('z', 50)));
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').has('z'), 5000, 'z');
    await room.flush();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, store.objects.get(`_plugins/canvas/${key}.ydoc`)!.body);
    expect(stored.getMap('shapes').toJSON()).toEqual((await room.inspect()).doc.getMap('shapes').toJSON());
    for (const c of [ana, bob]) c.close();
  }, 60_000);

  it('strikes: WORKER_STRIKES faults put the principal in a cooldown (joins and writes 1013); others are not affected', async () => {
    const app = await startApp({ ...HOOKS, WORKER_STRIKES: '2', WORKER_MESSAGE_TIMEOUT_MS: '100' });
    const key = 'u/fv9-strikes/index.html';
    const { ana, bob } = await honestRoom(app, key);
    for (let i = 0; i < 2; i++) {
      const m = await join(app, key, 'sid=mallory');
      expect(m.closeCode).toBeNull();
      m.sendRaw(syncMsg(metaUpdate('canvas-test-hook:busy')));
      expect(await m.closed).toBe(4413);
    }
    expect(await metric(app, 'strikes', 'outcome', 'cooldown')).toBe(1);
    const again = await join(app, key, 'sid=mallory');
    expect(again.closeCode).toBe(1013);
    expect(await metric(app, 'wsRejected', 'reason', 'cooldown')).toBe(1);
    const ana2 = await join(app, key, 'sid=ana');
    expect(ana2.closeCode).toBeNull();
    for (const c of [ana, bob, ana2]) c.close();
  }, 60_000);

  it('strikes: cookieless anonymous visitors count together (WORKER_ANON_POOL_STRIKES), a signed-in user still joins', async () => {
    const app = await startApp({ ...HOOKS, WORKER_ANON_POOL_STRIKES: '2', WORKER_MESSAGE_TIMEOUT_MS: '100' });
    const key = 'pub/fv9-anon/index.html';
    core.rules.set(key, allowAnon());
    share(key, 'bob');
    for (let i = 0; i < 2; i++) {
      const m = await join(app, key); // no cookie: a new visitor every time
      expect(m.closeCode).toBeNull();
      m.sendRaw(syncMsg(metaUpdate('canvas-test-hook:busy')));
      expect(await m.closed).toBe(4413);
    }
    const anon = await join(app, key);
    expect(anon.closeCode).toBe(1013);
    expect(await metric(app, 'wsRejected', 'reason', 'cooldown_anon')).toBe(1);
    const bob = await join(app, key, 'sid=bob');
    expect(bob.closeCode).toBeNull();
    bob.close();
  }, 60_000);

  it('honest-edit fuzz with the room\'s worker replaced at random steps (CI slice): 0 refusals, 0 divergence', async () => {
    for (const mode of ['ywebsocket', 'client'] as const) {
      const r = await runHonestFuzz(15, 909, 400, mode, 0.03);
      expect(r.refusals).toEqual({});
      expect(r.refused + r.diverged).toBe(0);
      expect(r.restarts).toBeGreaterThan(20);
    }
  }, 300_000);
});
