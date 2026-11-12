/**
 * Regressions of the sixth independent verification (fv6), through the real server. Each case is
 * one of the verifier's PoCs with the expectation turned around: the attack is bounded or refused,
 * and honest clients keep working. The numbers in the comments are the verifier's (before).
 *   H-1  loaded rooms are bounded by a memory budget (q4: R rooms of ~17 MB, one ACL member,
 *        OOM-killed the pod in a loop): a load past it, or growth past it, is refused with 1013
 *   M-A  anonymous principals are minted within a rate; join encodes are shared until the room
 *        changed a lot; principals in CPU debt are refused (q2: honest RTT p95 710 ms)
 *   L-A  paused sockets cannot hold the outgoing budget against honest joins (q5b: 64 of 133
 *        honest joins refused)
 *   L-C  the room's sync step 1 is cached on its own (it encoded the whole room)
 * The live variants (2 GiB container, the real core) are e2e-system/adversarial-fv6.spec.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import WebSocket from 'ws';
import v8 from 'node:v8';
import { loadConfig, roomMemoryBudget, ROOM_COST_FACTOR, RUNTIME_RESERVE_BYTES, MESSAGE_COST_FACTOR } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { Metrics } from '../src/metrics.js';
import { Room, TAIL_MAX_MESSAGES } from '../src/room.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 26600;
const apps: App[] = [];
const silent = createLogger('silent');
const MiB = 1024 * 1024;

async function startApp(env: Record<string, string> = {}): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '30', SAVE_DEBOUNCE_MS: '50',
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
const httpBase = (app: App) => `http://127.0.0.1:${port(app)}/_canvas`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const geo = (id: string, j = 0) => ({
  id, type: 'geo', geo: 'rectangle', x: j, y: j, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false,
  color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1,
});
const shapeMap = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
async function rejected(app: App, reason: string): Promise<number> {
  const m = await app.metrics.wsRejected.get();
  return m.values.filter((v) => v.labels.reason === reason).reduce((a, v) => a + v.value, 0);
}
const cfgOf = (app: App) => (app.manager as unknown as { deps: { cfg: ReturnType<typeof loadConfig> } }).deps.cfg;

/**
 * Stored rooms made like a client makes them (batches of geo shapes from one writer, stamped by
 * the real Room into a ledger), so a test starts with big rooms in storage without filling them
 * through sockets. Returns the encoded size (content + ledger).
 */
const seedCache = new Map<string, { content: Uint8Array; ledger: Uint8Array }>();
async function seed(key: string, shapes: number, author = 'bob@corp'): Promise<number> {
  const id = `${shapes}|${author}`;
  let objs = seedCache.get(id);
  if (!objs) {
    const tmp = new MemoryCanvasObjectStore();
    const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://core.test/', ARTIFACT_BASE_URL: 'http://core.test/', S3_BUCKET: 'b', METRICS_PORT: '0' });
    const room = new Room('seed', { cfg, store: tmp, log: silent, metrics: new Metrics(), onEmpty: () => undefined });
    const d = new Y.Doc();
    const origin = { identity: { id: author, name: author, anonymous: false, color: '#000' } };
    for (let b = 0; b < shapes; b += 2000) {
      const sv = Y.encodeStateVector(d);
      d.transact(() => {
        const s = d.getMap('shapes');
        for (let i = b; i < Math.min(shapes, b + 2000); i++) s.set(`f${i}`, shapeMap(geo(`f${i}`, i)));
      });
      Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(d, sv), origin);
    }
    room.markDirty();
    await room.save();
    objs = { content: tmp.objects.get(room.objectKey)!.body, ledger: tmp.objects.get(room.ledgerKey)!.body };
    room.dispose();
    seedCache.set(id, objs);
  }
  await store.put(`_plugins/canvas/${key}.ydoc`, objs.content);
  await store.put(`_plugins/canvas/${key}.ydoc.ledger`, objs.ledger);
  return objs.content.byteLength + objs.ledger.byteLength;
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv6-static-'));
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

function share(key: string, ...who: string[]) {
  for (const u of who) core.rulesByCookie.set(`sid=${u}|${key}`, allowUser(`${u}@corp`, u));
}
async function join(app: App, key: string, cookie?: string): Promise<TestClient> {
  const c = new TestClient(`${base(app)}/${key}`, cookie);
  await c.connect();
  return c;
}
/** Wait until the client either synced `n` shapes or was closed; the close code (null = open). */
async function settled(c: TestClient, n: number, ms = 15_000): Promise<number | null> {
  await waitFor(() => c.closeCode !== null || c.doc.getMap('shapes').size >= n, ms, 'join settled').catch(() => undefined);
  return c.closeCode;
}

// ---------------------------------------------------------------------------------------------
describe('fv6 H-1: loaded rooms are bounded by a memory budget', () => {
  it('the default budget is derived from the V8 heap limit (any memory setting), and the env overrides it', () => {
    const env = { GATE_AUTHZ_URL: 'http://c/', ARTIFACT_BASE_URL: 'http://c/', S3_BUCKET: 'b', METRICS_PORT: '0' };
    const cfg = loadConfig(env);
    expect(cfg.roomMemoryBudgetSource).toBe('heap');
    const expected = v8.getHeapStatistics().heap_size_limit - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - MESSAGE_COST_FACTOR * cfg.maxMessageBytes;
    expect(cfg.roomMemoryBudgetBytes).toBe(Math.floor(expected));
    // the chart's setting: --max-old-space-size=1536 gives heap_size_limit 1560 MiB in the image
    // under the 2Gi limit (Node 22; 1584 MiB on a host with more memory)
    expect(roomMemoryBudget(1560 * MiB, cfg)).toBe(920 * MiB);
    expect(roomMemoryBudget(1584 * MiB, cfg)).toBe(944 * MiB);
    // a bigger heap, a bigger budget; a tiny heap never goes below the floor
    expect(roomMemoryBudget(3120 * MiB, cfg)).toBe(2480 * MiB);
    expect(roomMemoryBudget(256 * MiB, cfg)).toBe(64 * MiB);
    const over = loadConfig({ ...env, ROOM_MEMORY_BUDGET_BYTES: String(100 * MiB) });
    expect(over.roomMemoryBudgetBytes).toBe(100 * MiB);
    expect(over.roomMemoryBudgetSource).toBe('env');
    expect(cfg.roomCostFactor).toBe(ROOM_COST_FACTOR);
  });

  it('q4 (one ACL member keeps R big rooms loaded): loads past the budget are refused 1013 busy, rooms already loaded stay joinable, the estimate stays under the budget', async () => {
    // rooms of ~0.93 MB encoded (2000 shapes: 23.5 MiB each at 24x); a budget that loads two of
    // them (loads stop at 90% of it), like 920 MiB holds two ~17 MB rooms in the live q4
    const keys = Array.from({ length: 5 }, (_, i) => `u/q4-${i}/index.html`);
    let roomBytes = 0;
    for (const k of keys) {
      roomBytes = await seed(k, 2000);
      share(k, 'mallory', 'ana', 'carl', 'dora');
    }
    const perRoom = 24 * roomBytes + 32 * 1024;
    const budget = Math.ceil((2.5 * perRoom) / 0.9);
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(budget) });
    // four principals: the per-principal share is not what stops it here
    const holders = ['mallory', 'ana', 'carl', 'dora'];
    const held: TestClient[] = [];
    const codes: (number | null)[] = [];
    for (let i = 0; i < keys.length; i++) {
      const c = await join(app, keys[i], `sid=${holders[i % 4]}`);
      codes.push(await settled(c, 2000));
      held.push(c);
    }
    const fits = 2;
    expect(codes.filter((c) => c === null).length).toBe(fits);
    expect(codes.slice(fits).every((c) => c === 1013)).toBe(true);
    expect(held[fits].notices.map((n) => n.kind)).toContain('busy');
    expect(app.manager.rooms.size).toBe(fits);
    expect(app.manager.memory().total).toBeLessThanOrEqual(budget);
    expect(await rejected(app, 'room_memory')).toBe(3);
    // a join to a room that is loaded is never refused for memory
    const second = await join(app, keys[0], 'sid=ana');
    expect(await settled(second, 2000)).toBeNull();
    // the loaded rooms stay usable: an edit lands
    second.doc.getMap('shapes').set('after', shapeMap(geo('after')));
    await waitFor(() => app.manager.get(keys[0])!.doc.getMap('shapes').has('after'), 5000, 'edit lands');
    // the holder of room 1 leaves: its room is evicted, and the refused room loads now
    held[1].close();
    await waitFor(() => !app.manager.get(keys[1]), 5000, 'room 1 evicted');
    const retry = await join(app, keys[fits], 'sid=dora');
    expect(await settled(retry, 2000)).toBeNull();
    for (const c of [...held, second, retry]) c.close();
  }, 60_000);

  it('growth past the budget is refused 1013 (nothing applied); rooms filled after they loaded empty count too', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(32 * MiB), MAX_DOC_BYTES: String(8 * MiB) });
    const keys = ['u/g0/index.html', 'u/g1/index.html'];
    for (const k of keys) share(k, 'mallory', 'ana');
    // empty rooms load for free; Mallory fills them (the verifier's q4 does exactly this)
    const m0 = await join(app, keys[0], 'sid=mallory');
    const a0 = await join(app, keys[0], 'sid=ana'); // keeps the room loaded after mallory is closed
    const a1 = await join(app, keys[1], 'sid=ana');
    let refusedAt = -1;
    for (let b = 0; b < 20_000 && m0.closeCode === null; b += 1000) {
      m0.doc.transact(() => {
        const s = m0.doc.getMap('shapes');
        for (let i = b; i < b + 1000; i++) s.set(`f${i}`, shapeMap(geo(`f${i}`, i)));
      });
      await waitFor(() => m0.closeCode !== null || app.manager.get(keys[0])!.doc.getMap('shapes').size >= b + 1000, 10_000, 'batch').catch(() => undefined);
      if (m0.closeCode !== null) refusedAt = b;
    }
    expect(m0.closeCode).toBe(1013);
    expect(m0.notices.map((n) => n.kind)).toContain('busy');
    expect(refusedAt).toBeGreaterThan(0);
    // the refused batch was not applied, and the estimate never passed the budget
    expect(app.manager.get(keys[0])!.doc.getMap('shapes').size).toBe(refusedAt);
    expect(app.manager.memory().total).toBeLessThanOrEqual(32 * MiB);
    expect(await rejected(app, 'room_memory') + await rejected(app, 'room_memory_principal')).toBeGreaterThanOrEqual(1);
    for (const c of [m0, a0, a1]) c.close();
  }, 60_000);

  it('one principal keeps at most its share loaded (a large-room cap): another principal still loads', async () => {
    // budget 64 MiB, user cap 1 MiB (a full room costs 24 MiB): share = max(32 MiB, 24 MiB) = 32 MiB
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(64 * MiB), MAX_DOC_BYTES: String(1 * MiB), ANON_MAX_DOC_BYTES: String(512 * 1024) });
    const keys = Array.from({ length: 4 }, (_, i) => `u/s${i}/index.html`);
    let bytes = 0;
    for (const k of keys) {
      bytes = await seed(k, 2000);
      share(k, 'mallory', 'ana');
    }
    const perRoom = 24 * bytes + 32 * 1024;
    const mine: TestClient[] = [];
    const codes: (number | null)[] = [];
    for (const k of keys.slice(0, 3)) {
      const c = await join(app, k, 'sid=mallory');
      codes.push(await settled(c, 2000));
      mine.push(c);
    }
    const fit = Math.floor((32 * MiB) / perRoom);
    expect(fit).toBeLessThan(3);
    expect(codes.slice(0, fit).every((c) => c === null)).toBe(true);
    expect(codes[fit]).toBe(1013);
    expect(await rejected(app, 'room_memory_principal')).toBeGreaterThanOrEqual(1);
    // Ana is someone else: the room Mallory could not load loads for her
    const ana = await join(app, keys[fit], 'sid=ana');
    expect(await settled(ana, 2000)).toBeNull();
    for (const c of [...mine, ana]) c.close();
  }, 60_000);

  it('the rooms only anonymous visitors hold share half the budget: logged-in users keep the other half', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(96 * MiB), ANON_MAX_DOC_BYTES: String(1 * MiB) });
    const pubs = Array.from({ length: 6 }, (_, i) => `pub/a${i}/index.html`);
    let bytes = 0;
    for (const k of pubs) {
      bytes = await seed(k, 2000);
      core.rules.set(k, allowAnon());
    }
    const perRoom = 24 * bytes + 32 * 1024;
    const anons: TestClient[] = [];
    const codes: (number | null)[] = [];
    for (const k of pubs) {
      const c = await join(app, k); // a new visitor each time (minted by the join)
      codes.push(await settled(c, 2000));
      anons.push(c);
    }
    const fit = Math.floor((48 * MiB) / perRoom);
    expect(codes.filter((c) => c === null).length).toBe(fit);
    expect(await rejected(app, 'room_memory_anon')).toBeGreaterThanOrEqual(1);
    // a logged-in user loads a room of the same size in the other half
    const key = 'u/team/index.html';
    await seed(key, 2000);
    share(key, 'carol');
    const carol = await join(app, key, 'sid=carol');
    expect(await settled(carol, 2000)).toBeNull();
    for (const c of [...anons, carol]) c.close();
  }, 60_000);

  it('a socket that goes away while its room loads leaves no room loaded (before: it stayed in memory forever)', async () => {
    const app = await startApp();
    const key = 'pub/leak/index.html';
    await seed(key, 4000);
    core.rules.set(key, allowAnon());
    const slow = store.get.bind(store);
    store.get = async (k: string) => {
      await sleep(300);
      return slow(k);
    };
    const c = new TestClient(`${base(app)}/${key}`);
    void c.connect().catch(() => undefined);
    await waitFor(() => app.manager.rooms.size === 1, 3000, 'load started');
    c.ws.terminate();
    await sleep(800);
    expect(app.manager.rooms.size).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe('fv6 M-A: minted principals, shared join encodes, CPU debt', () => {
  it('visitor cookies are minted within a global rate and a per-IP rate (HEAD floods mint no principals)', async () => {
    const app = await startApp({ ANON_MINT_BURST: '20', ANON_MINT_RATE_PER_MIN: '60', ANON_IP_MINT_BURST: '5', ANON_IP_MINT_RATE_PER_MIN: '10', CLIENT_IP_HOPS: '1' });
    const key = 'pub/mint/index.html';
    core.rules.set(key, allowAnon());
    const head = async (ip: string) => (await fetch(`${httpBase(app)}/${key}`, { method: 'HEAD', headers: { 'x-forwarded-for': ip } })).headers.get('set-cookie');
    // one IP: 5 cookies, then the page is still served but without a cookie
    const one: (string | null)[] = [];
    for (let i = 0; i < 12; i++) one.push(await head('203.0.113.7'));
    expect(one.filter((c) => c).length).toBe(5);
    // many IPs (or no IP known): the global burst caps them all (20 - 5 already taken)
    const many: (string | null)[] = [];
    for (let i = 0; i < 40; i++) many.push(await head(`198.51.100.${i}`));
    expect(many.filter((c) => c).length).toBe(15);
    // the WebSocket path mints too (a global bucket of its own: a flood of cookieless joins cannot
    // stop the wrapper page from giving honest visitors their cookie), and from the same per-IP
    // bucket: 127.0.0.1 (no X-Forwarded-For) gets 5 visitors, the 6th cookieless join is refused
    const codes: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await join(app, key);
      await sleep(100);
      codes.push(c.closeCode);
      if (i === 5) {
        expect(await c.closed).toBe(1013);
        expect(c.setCookie).toBeNull();
        expect(c.notices.map((n) => n.kind)).toContain('busy');
      }
      c.close();
    }
    expect(codes.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(await rejected(app, 'anon_mint')).toBe(1);
    const minted = await app.metrics.anonMinted.get();
    expect(minted.values.find((v) => v.labels.outcome === 'minted')?.value).toBe(25);
  });

  it('joins share one encoding of the room until the updates since outgrow it; snapshot + tail is exactly the room (and the ledger)', async () => {
    const app = await startApp({ MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/enc/index.html';
    await seed(key, 6000);
    share(key, 'bob', 'eve', 'ana');
    const bob = await join(app, key, 'sid=bob');
    await settled(bob, 6000);
    const room = app.manager.get(key)!;
    const e0 = room.encodes;
    // q2: a tiny edit before every join (a new room version each time)
    const same = async (c: TestClient) => {
      await waitFor(() => Buffer.from(Y.encodeStateVector(c.doc)).equals(Buffer.from(Y.encodeStateVector(room.doc))), 5000, 'joiner has the room').catch(() => undefined);
      expect(Buffer.from(Y.encodeStateVector(c.doc)).equals(Buffer.from(Y.encodeStateVector(room.doc)))).toBe(true);
      expect(c.doc.getMap('shapes').toJSON()).toEqual(room.doc.getMap('shapes').toJSON());
      await waitFor(() => c.ledger.getMap('attribution').size === room.ledger.getMap('attribution').size, 5000, 'ledger').catch(() => undefined);
      expect(c.ledger.getMap('attribution').toJSON()).toEqual(room.ledger.getMap('attribution').toJSON());
    };
    for (let i = 0; i < 20; i++) {
      (bob.doc.getMap('shapes').get('f1') as Y.Map<unknown>).set('x', 1000 + i);
      await waitFor(() => (room.doc.getMap('shapes').get('f1') as Y.Map<unknown>).get('x') === 1000 + i, 3000, 'bump');
      const c = await join(app, key, i % 2 ? 'sid=eve' : 'sid=ana');
      await settled(c, 6000);
      // every joiner holds exactly the room: content and ledger (snapshot + tail + backlog)
      await same(c);
      c.close();
    }
    // before: 2 encodings per join after a version change (40); now none (the first join encoded)
    expect(room.encodes - e0).toBeLessThanOrEqual(2);
    // more updates than the tail keeps: the next join encodes once more, never once per version
    for (let v = 0; v <= TAIL_MAX_MESSAGES; v++) bob.doc.getMap('meta').set('v', v);
    await waitFor(() => room.doc.getMap('meta').get('v') === TAIL_MAX_MESSAGES, 3000, 'edits');
    const e1 = room.encodes;
    const late = await join(app, key, 'sid=ana');
    await settled(late, 6000);
    await same(late);
    expect(room.encodes - e1).toBe(1); // the content, once (meta edits leave the ledger as it was)
    expect(late.doc.getMap('meta').get('v')).toBe(TAIL_MAX_MESSAGES);
    const c2 = await join(app, key, 'sid=eve');
    await settled(c2, 6000);
    await same(c2);
    expect(room.encodes - e1).toBe(1);
    for (const c of [bob, late, c2]) c.close();
  }, 60_000);

  it('L-C: the sync step 1 the server sends (pending resync) never encodes the room', async () => {
    const app = await startApp({ MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/s1/index.html';
    await seed(key, 4000);
    share(key, 'bob');
    const bob = await join(app, key, 'sid=bob');
    await settled(bob, 4000);
    const room = app.manager.get(key)!;
    const e0 = room.encodes;
    for (let i = 0; i < 300; i++) {
      (bob.doc.getMap('shapes').get('f2') as Y.Map<unknown>).set('x', i);
      await waitFor(() => (room.doc.getMap('shapes').get('f2') as Y.Map<unknown>).get('x') === i, 3000, 'edit');
      room.step1Frame();
    }
    expect(room.encodes).toBe(e0);
    bob.close();
  }, 60_000);

  it('a principal in CPU debt joins nobody until its budget refilled (1013)', async () => {
    const app = await startApp({ CPU_MS_PER_SEC: '1', CPU_BURST_MS: '5' });
    const key = 'u/debt/index.html';
    await seed(key, 6000);
    share(key, 'eve');
    const first = await join(app, key, 'sid=eve');
    await settled(first, 6000);
    // the join payload went over her 5 ms burst
    const again = await join(app, key, 'sid=eve');
    expect(await again.closed).toBe(1013);
    expect(await rejected(app, 'cpu_debt')).toBeGreaterThanOrEqual(1);
    first.close();
  }, 30_000);

  it('q2: 5 pub/ rooms under join churn from minted anonymous principals: an honest edit in another room keeps p95 < 100 ms', async () => {
    const ROOMS = 5;
    const app = await startApp();
    const keys = Array.from({ length: ROOMS }, (_, i) => `pub/big${i}/index.html`);
    for (const k of keys) {
      await seed(k, 9000);
      core.rules.set(k, allowAnon());
      share(k, 'bob');
    }
    // bob keeps every room loaded
    const bobs: TestClient[] = [];
    for (const k of keys) {
      const b = await join(app, k, 'sid=bob');
      await settled(b, 9000, 30_000);
      bobs.push(b);
    }
    const key2 = 'u/other/index.html';
    share(key2, 'carol');
    const carol = await join(app, key2, 'sid=carol');
    const room2 = () => app.manager.get(key2)!;
    let seq = 0;
    const editRtt = async (): Promise<number> => {
      const id = `c${seq++}`;
      const t0 = performance.now();
      carol.doc.getMap('shapes').set(id, shapeMap(geo(id)));
      await waitFor(() => !!carol.ledger.getMap('attribution').get(id), 20_000, 'rtt').catch(() => undefined);
      return performance.now() - t0;
    };
    const probe = async (ms: number) => {
      const rtts: number[] = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        rtts.push(await editRtt());
        await sleep(200);
      }
      rtts.sort((a, b) => a - b);
      return { p50: rtts[rtts.length >> 1], p95: rtts[Math.floor(rtts.length * 0.95)], max: rtts[rtts.length - 1], n: rtts.length };
    };
    const baseline = await probe(4000);
    const encodes0 = keys.map((k) => app.manager.get(k)!.encodes);
    const DUR = 18;
    const children = keys.map((k) =>
      fork(path.join(here, 'fv6', 'q2-attacker.ts'), [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, HTTP: httpBase(app), BASE: base(app), KEY: k, M: '200', CONC: '9', DUR: String(DUR), EARLY: '1', ORIGIN: TEST_ORIGIN },
        stdio: 'ignore',
      }),
    );
    const readies = (await Promise.all(children.map((c) => new Promise((r) => c.once('message', r))))) as { minted: number; mintRefused: number }[];
    for (const c of children) c.send('go');
    await sleep(2000);
    const during = await probe((DUR - 5) * 1000);
    // the verifier's 18 KB paste: lands, carol stays connected
    const pid = `p${seq++}`;
    carol.doc.transact(() => {
      const m = shapeMap({ ...geo(pid), type: 'note' });
      carol.doc.getMap('shapes').set(pid, m);
      const t = new Y.Text();
      m.set('text', t);
      t.insert(0, 'é'.repeat(9000));
    });
    await waitFor(() => room2().doc.getMap('shapes').has(pid), 8000, 'paste lands');
    const results = (await Promise.all(children.map((c) => new Promise((r) => c.once('message', r))))) as { joins: number; codes: [string, number][] }[];
    for (const c of children) c.send('bye');
    const encodes = keys.map((k, i) => app.manager.get(k)!.encodes - encodes0[i]);
    console.log(`[fv6 q2] minted ${readies.map((r) => r.minted).join('+')} (refused ${readies.map((r) => r.mintRefused).join('+')}); baseline p50 ${baseline.p50.toFixed(0)} p95 ${baseline.p95.toFixed(0)} ms; during p50 ${during.p50.toFixed(0)} p95 ${during.p95.toFixed(0)} max ${during.max.toFixed(0)} ms (n=${during.n}); attacker joins ${results.map((r) => r.joins).join('+')}, closes ${JSON.stringify(results.map((r) => r.codes))}; room encodes during the attack ${encodes.join(',')}`);
    // before (verifier): p95 710 ms, server CPU 69%, 82 ms per join re-encode
    expect(during.p95).toBeLessThan(100);
    expect(carol.closeCode).toBeNull();
    // the minted principals are bounded by the mint rate (default burst 60 for the 5 x 200 HEADs)
    expect(readies.reduce((a, r) => a + r.minted, 0)).toBeLessThanOrEqual(60 + 2 * 20);
    for (const c of [...bobs, carol]) c.close();
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
describe('fv6 L-A: paused sockets cannot hold the outgoing budget against honest joins', () => {
  it('q5: paused anonymous sockets hold the budget; honest joins to other rooms all succeed (the stalled holders are dropped for them); honest connections keep editing', async () => {
    // the verifier's q5 at test scale: a pub/ room bigger than the kernel's socket buffers
    // (so the server holds what the paused sockets do not read), the budget just above what
    // the paused sockets hold: before, every honest join that needed more was refused 1013
    // (no authorization re-check: a re-check that times out in a busy event loop fails closed and revokes the honest peers)
    const app = await startApp({ ANON_MINT_BURST: '400', WS_PING_INTERVAL_MS: '600000', WS_SLOW_CONSUMER_MS: '600000', JOIN_BURST: '1000', JOIN_RATE_PER_MIN: '60000', CPU_TOTAL_MS_PER_SEC: '100000', CPU_TOTAL_BURST_MS: '100000', ANON_CPU_TOTAL_MS_PER_SEC: '100000', ANON_CPU_TOTAL_BURST_MS: '100000', AUTHZ_RECHECK_SECONDS: '3600' });
    const cfg = cfgOf(app);
    const keys = ['pub/q5-0/index.html'];
    const holders: WebSocket[] = [];
    for (const k of keys) {
      await seed(k, 40_000);
      core.rules.set(k, allowAnon());
      share(k, 'bob');
      // a logged-in user keeps the big room loaded (anonymous visitors may not load a room
      // this big: their memory share, H-1); a raw reader, no document in this process
      const b = new WebSocket(`${base(app)}/${k}`, { headers: { origin: TEST_ORIGIN, cookie: 'sid=bob' }, maxPayload: 256 << 20 });
      b.on('message', () => undefined);
      b.on('error', () => undefined);
      await new Promise((r) => b.on('open', r));
      await waitFor(() => (app.manager.get(k)?.conns.size ?? 0) === 1, 30_000, 'room loaded');
      holders.push(b);
    }
    const team = 'u/team/index.html';
    const small = 'u/small/index.html';
    await seed(team, 4000, 'carol@corp');
    for (const k of [team, small]) share(k, 'carol', 'dave', 'erin');
    const carol = await join(app, team, 'sid=carol');
    await settled(carol, 4000);
    const dave = await join(app, small, 'sid=dave');
    const honestJoin = async (key: string, n: number): Promise<string> => {
      const c = await join(app, key, 'sid=erin');
      await waitFor(() => c.closeCode !== null || c.doc.getMap('shapes').size >= n, 8000, 'honest join').catch(() => undefined);
      const r = c.closeCode !== null ? String(c.closeCode) : c.doc.getMap('shapes').size >= n ? 'joined' : 'stuck';
      c.close();
      await sleep(200);
      return r;
    };
    const held = async () => (await app.metrics.outgoingBytes.get()).values[0]?.value ?? 0;
    const droppedPeers = async () => (await rejected(app, 'outgoing_reclaim')) + (await rejected(app, 'outgoing_budget'));
    const tallyOf = (rs: string[]) => rs.reduce((m: Record<string, number>, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    // The server's own verdict on a paused socket (ws.ts `stalled`): it holds more than 256 KiB
    // and drained nothing worth counting for WS_STALL_MS. A peer is only known as stalled that
    // long after it stopped reading (an honest slow reader looks the same until then), and the
    // join frames the nine of them share are freed only when the last of them is dropped. So the
    // attack is established once ALL of them are stalled, and only then does "an honest join is
    // never refused" hold: while it ramps up, an honest join that needs more than the slack may
    // be refused 1013 by design, and how many joins fall into that window is a matter of speed.
    // (This test used to open the window 2 s after 'go': its waitFor on the held bytes was an
    // async predicate, always truthy, so it never waited for the last socket to be stalled.)
    const PER_ROOM = 9;
    const pausedOf = (k: string) => [...(app.manager.get(k)?.conns.values() ?? [])].filter((c) => c.identity.anonymous && !c.closing);
    const stalledOf = (k: string) => pausedOf(k).filter((c) => c.ws.bufferedAmount + c.backlogBytes > 256 * 1024 && Date.now() - c.progressAt >= cfg.wsStallMs);
    const honestJoins = async (ms: number, room: { key: string; shapes: number }): Promise<string[]> => {
      const out: string[] = [];
      const tEnd = Date.now() + ms;
      while (Date.now() < tEnd || out.length < 12) {
        out.push('team:' + (await honestJoin(room.key, room.shapes)));
        out.push('small:' + (await honestJoin(small, 0)));
      }
      return out;
    };
    /** One wave of the attacker (a process of its own); `stop` ends it and its sockets. */
    const attack = async () => {
      const child = fork(path.join(here, 'fv6', 'q5-attacker.ts'), [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, HTTP: httpBase(app), BASE: base(app), KEYS: keys.join(','), DUR: '600', PER_ROOM: String(PER_ROOM), ORIGIN: TEST_ORIGIN },
        stdio: 'ignore',
      });
      let last: Record<string, unknown> = {};
      child.on('message', (m) => (last = m as Record<string, unknown>));
      await new Promise((r) => child.once('message', r));
      child.send('go');
      const stop = async () => {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
        return last;
      };
      // established: every paused socket is stalled by the server's own clock
      await waitFor(() => stalledOf(keys[0]).length === PER_ROOM, 90_000, 'every paused socket is stalled').catch(async (e) => {
        await stop();
        throw e;
      });
      // the held-bytes gauge is refreshed by the sweep (once a second)
      await sleep(1100);
      return { held: await held(), stop };
    };
    const MIN_HELD = 3.5 * MiB; // the room's join payload (~4 MB for 40 000 shapes), held once by the nine
    const defaultBudget = cfg.wsOutgoingBudgetBytes;
    const teamRoom = { key: team, shapes: 4000 };

    // wave 1: the budget just above what the paused sockets hold, so an honest join to another
    // room needs room the paused sockets hold: before, it was refused 1013 for as long as they stayed
    const w1 = await attack();
    let during1: string[];
    let reclaimed1: number;
    let attacker1: Record<string, unknown>;
    // What the nine hold depends on the kernel: a socket whose buffers took the whole 4 MB join
    // frame makes the server queue the ledger frame behind it (19.6 MB held in all). Then the join
    // of the 2 MB `team` room fits the 25% slack of that budget without needing anyone's room, so
    // the honest room is one that does not (and still fits the budget alone).
    const ledgerQueued = w1.held > 8 * MiB;
    const bigKey = 'u/team-big/index.html';
    let carolBig: TestClient | undefined;
    try {
      expect(w1.held).toBeGreaterThan(MIN_HELD);
      if (ledgerQueued) {
        // a room that is loaded (carol keeps it so), or the server has no size to count for a join
        await seed(bigKey, 16_000, 'carol@corp');
        share(bigKey, 'carol', 'dave', 'erin');
        carolBig = await join(app, bigKey, 'sid=carol');
        await settled(carolBig, 16_000);
        // the sweep forgets a join's frames once they drained; until then the server counts a join
        // of the same snapshot as sharing them, and the honest join would cost nothing
        await waitFor(() => [...(app.manager.get(bigKey)?.conns.values() ?? [])].every((c) => !c.joinFrames), 15_000, 'carol\'s join frames released');
      }
      cfg.wsOutgoingBudgetBytes = w1.held + 256 * 1024;
      const reclaim0 = await rejected(app, 'outgoing_reclaim');
      during1 = await honestJoins(12_000, ledgerQueued ? { key: bigKey, shapes: 16_000 } : teamRoom);
      reclaimed1 = (await rejected(app, 'outgoing_reclaim')) - reclaim0;
    } finally {
      carolBig?.close();
      attacker1 = await w1.stop();
    }

    // wave 2: a budget below what the paused sockets hold: the sweep drops them (stalled first),
    // and the honest joins in the meantime still all succeed
    cfg.wsOutgoingBudgetBytes = defaultBudget;
    const w2 = await attack();
    let during2: string[];
    let dropped2: number;
    let attacker2: Record<string, unknown>;
    try {
      expect(w2.held).toBeGreaterThan(MIN_HELD);
      const dropped0 = await droppedPeers();
      // half of what they hold, and never less than the honest room needs to be in flight
      cfg.wsOutgoingBudgetBytes = Math.max(Math.round(w2.held / 2), 3 * MiB);
      during2 = await honestJoins(8000, teamRoom);
      dropped2 = (await droppedPeers()) - dropped0;
    } finally {
      attacker2 = await w2.stop();
    }
    console.log(`[fv6 q5] wave 1: the paused sockets held ${(w1.held / MiB).toFixed(1)} MiB, budget set just above; honest joins ${JSON.stringify(tallyOf(during1))}; stalled peers dropped for them ${reclaimed1}; attacker ${JSON.stringify(attacker1)}. wave 2: held ${(w2.held / MiB).toFixed(1)} MiB, budget halved; honest joins ${JSON.stringify(tallyOf(during2))}; peers dropped ${dropped2}; attacker ${JSON.stringify(attacker2)}`);
    // before (verifier q5b): 64 of 133 honest joins refused 1013
    expect(during1.length).toBeGreaterThan(10);
    expect(during1.every((r) => r.endsWith(':joined'))).toBe(true);
    // the stalled holders are dropped for the joins that need their room
    expect(reclaimed1).toBeGreaterThan(0);
    expect(during2.length).toBeGreaterThan(10);
    expect(during2.every((r) => r.endsWith(':joined'))).toBe(true);
    // ... and by the sweep once the budget is passed
    expect(dropped2).toBeGreaterThan(0);
    // the existing honest connections still edit
    carol.doc.getMap('shapes').set('after', shapeMap(geo('after')));
    await waitFor(() => app.manager.get(team)!.doc.getMap('shapes').has('after'), 10_000, 'carol edits');
    expect(carol.closeCode).toBeNull();
    expect(holders.every((b) => b.readyState === WebSocket.OPEN)).toBe(true);
    for (const c of [carol, dave]) c.close();
    for (const b of holders) b.close();
  }, 240_000);
});
