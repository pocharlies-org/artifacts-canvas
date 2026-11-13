/**
 * Regressions of the security and QA review of the fv9 branch (room isolation):
 *   M-1  client messages queued without a bound behind the one apply slot: the TCP backpressure of
 *        the single thread was gone, so one writer could make the server hold whatever its link
 *        delivered (the pod OOM-killed). Now every message counts in flight until it is processed:
 *        a connection, and a principal, is no longer read at two max messages, and the server
 *        refuses big messages past WORKER_INFLIGHT_BYTES (protocol §12).
 *   F-1  an honest bulk delete (5 000 of 10 400 shapes a co-writer wrote from one session) was
 *        refused 4413 AND struck: three tries were a 10-minute cooldown on every canvas, with a
 *        notice saying the canvas was full. Now a refused delete is not struck, says `too-costly`,
 *        and the editor deletes big selections in parts.
 *   F-4  a rebuild asks every tab for a step 1 but did not refill its resync budget.
 *   F-5  --max-old-space-size was only warned about (it overrides every worker's heap limit).
 *   F-6  while saves kept failing the write-ahead log grew without a bound.
 *   S6   tiny messages from many principals counted a few bytes each and never reached the cap:
 *        every message now counts at least INFLIGHT_MIN_COST (1 KiB).
 *   S7   the series the chart's alerts read were born at their first event (increase() missed it):
 *        now exposed at 0 from the start.
 * And the bump discipline: the cost constants are tied to the Yjs versions they were measured on.
 * The full-system variant of M-1 (RSS of the canvas under the chart's limit) is
 * e2e-system/adversarial-inflight.spec.ts; the process-level measurement server/test/inflight/flood.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { CALIBRATED_WITH, inflightConnBytes, loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { Room, WAL_MAX_DOCS, type Conn } from '../src/room.js';
import { WsServer } from '../src/ws.js';
import { startFakeCore, allowUser, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';
import { testCore } from './helpers/core.js';
import { syncMsg } from './fv9/craft.js';
import { CanvasDoc, DELETE_BATCH } from '../../client/src/model/doc';

const here = path.dirname(fileURLToPath(import.meta.url));
let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 30400;
const apps: App[] = [];
const silent = createLogger('silent');
const MiB = 1024 * 1024;
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
type MetricName = 'wsRejected' | 'strikes' | 'wsPaused' | 'walFull';
async function metric(app: App, name: MetricName, label?: string, value?: string): Promise<number> {
  const m = await (app.metrics[name] as unknown as { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }).get();
  return m.values.filter((v) => !label || v.labels[label] === value).reduce((a, v) => a + v.value, 0);
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
const geo = (id: string, j = 0) => ({ id, type: 'geo', geo: 'rectangle', x: j * 20, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
/** The server side of a client's connection. */
const serverConn = (app: App, key: string, user: string): Conn[] => [...(app.manager.get(key)?.conns.values() ?? [])].filter((c) => c.identity.id === user);

/** A room of `n` geo shapes written by `author` from ONE client id (one session), through the real stamper. */
function seedOneSession(n: number, author: string): { content: Uint8Array; ledger: Uint8Array } {
  const room = testCore(1000);
  const d = new Y.Doc();
  const origin = { identity: { id: author, name: author, anonymous: false, color: '#000' } };
  for (let b = 0; b < n; b += 500) {
    const sv = Y.encodeStateVector(d);
    d.transact(() => {
      const s = d.getMap('shapes');
      for (let i = b; i < Math.min(n, b + 500); i++) s.set(`f${i}`, mapOf(geo(`f${i}`, i)));
    });
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(d, sv), origin);
  }
  return room.save();
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv9r-static-'));
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
describe('M-1: client messages in flight are bounded', () => {
  it('a worker that never answers (the apply slot held): the flooding connections are no longer read at two max messages, big messages past WORKER_INFLIGHT_BYTES are refused 1013, the bytes held stay under the cap; an honest small edit is never refused and round-trips once the slot is free', async () => {
    // the chart's sizing: 4 MiB messages, so a connection or a principal is no longer read at 8 MiB
    const cap = 24 * MiB;
    const app = await startApp({ HEAP_LIMIT_MB: '1776', WORKER_INFLIGHT_BYTES: String(cap) });
    expect(app.manager.applySlots).toBeDefined();
    const perConn = inflightConnBytes(4 * MiB);
    expect(perConn).toBe(8 * MiB);
    const flood = 'u/m1-flood/index.html';
    const other = 'u/m1-other/index.html';
    share(flood, 'mallory');
    share(other, 'ana', 'bob');
    const ana = await join(app, other, 'sid=ana');
    const bob = await join(app, other, 'sid=bob');
    // MAX_CONNS_PER_USER (8): every connection one principal may have
    const m: TestClient[] = [];
    for (let i = 0; i < 8; i++) m.push(await join(app, flood, 'sid=mallory'));
    expect(m.every((c) => c.closeCode === null)).toBe(true);
    await waitFor(() => app.manager.inflightBytes === 0, 5000, 'joins processed');
    // nothing is processed from here on: every client message waits for the slot
    const release = await app.manager.applySlots.acquire();
    let released = false;
    try {
      ana.doc.getMap('shapes').set('a1', mapOf(geo('a1', 1)));
      await waitFor(() => app.manager.inflightBytes > 0, 3000, 'honest edit queued');
      // 4 MiB updates the guard never sees while the slot is held (what they hold is the point)
      const msg = syncMsg(new Uint8Array(4 * MiB - 16).fill(7));
      for (let k = 0; k < 10; k++) m[0].sendRaw(msg);
      await sleep(1000);
      const one = serverConn(app, flood, 'mallory@corp');
      const first = one.find((c) => c.inflight > 0)!;
      // the server read two messages (three when the third's last bytes came in the same chunk) and stopped
      expect(first.inflight).toBeGreaterThanOrEqual(perConn);
      expect(first.inflight).toBeLessThanOrEqual(perConn + msg.byteLength);
      expect(first.paused).toBe(true);
      // the rest waits on the client side: TCP backpressure
      expect(m[0].ws.bufferedAmount).toBeGreaterThan(8 * MiB);
      expect(await metric(app, 'wsPaused', 'why', 'connection')).toBe(1);
      // the other seven connections of the same principal: one message each at most before they are not
      // read either; past the server's cap the next big one is refused (1013, the client would retry)
      for (const c of m.slice(1)) for (let k = 0; k < 3; k++) c.sendRaw(msg);
      await sleep(1500);
      const held = app.manager.inflightBytes;
      expect(held).toBeLessThanOrEqual(cap);
      expect(await metric(app, 'wsRejected', 'reason', 'inflight')).toBeGreaterThanOrEqual(1);
      const closed = m.filter((c) => c.closeCode === 1013);
      const paused = serverConn(app, flood, 'mallory@corp').filter((c) => c.paused && !c.closing);
      expect(closed.length).toBeGreaterThanOrEqual(1);
      expect(closed.every((c) => c.notices.some((n) => n.kind === 'busy'))).toBe(true);
      // every flooding connection is either not read any more or closed
      expect(paused.length + closed.length).toBe(8);
      // an honest small edit while the server is over the cap: taken (never refused), its tab not read
      // until its edits are processed
      ana.doc.getMap('shapes').set('a2', mapOf(geo('a2', 2)));
      await sleep(300);
      expect(ana.closeCode).toBeNull();
      console.log('[M-1 slot held]', JSON.stringify({ inflightMiB: +(held / MiB).toFixed(2), capMiB: cap / MiB, firstConnMiB: +(first.inflight / MiB).toFixed(2), clientBufferedMiB: +(m[0].ws.bufferedAmount / MiB).toFixed(1), refused: closed.length, paused: paused.length }));
      release();
      released = true;
      // the garbage is refused one message per connection (4403), the rest of each is dropped
      await waitFor(() => app.manager.inflightBytes === 0, 30_000, 'everything in flight processed');
      await waitFor(() => bob.doc.getMap('shapes').has('a1') && bob.doc.getMap('shapes').has('a2'), 10_000, 'honest edits relayed');
      expect(ana.closeCode).toBeNull();
      expect(bob.closeCode).toBeNull();
      // read again: a third edit goes through at once
      ana.doc.getMap('shapes').set('a3', mapOf(geo('a3', 3)));
      await waitFor(() => bob.doc.getMap('shapes').has('a3'), 5000, 'edit after the flood');
      expect(serverConn(app, other, 'ana@corp').every((c) => !c.paused && c.inflight === 0)).toBe(true);
    } finally {
      if (!released) release();
    }
  }, 90_000);

  it('many principals sending tiny updates (a worker that never answers): every message counts at least 1 KiB in flight, so the server\'s cap bounds how many messages wait, not only their bytes; the counters return to 0 once processed', async () => {
    // review S6: counted by payload bytes only, a 4-byte update cost ~7 counted bytes and several hundred
    // bytes of live objects; 12 accounts x 8 connections could queue without a bound, the cap never reached
    const cap = 4 * MiB;
    const KiB = 1024;
    const app = await startApp({ HEAP_LIMIT_MB: '1776', WORKER_INFLIGHT_BYTES: String(cap) });
    const accounts = 12;
    const perAccount = 8; // MAX_CONNS_PER_USER
    const rounds = 200; // per connection, under MSG_BURST (240): nobody is rate limited
    expect(rounds).toBeLessThan(loadConfig({ ...BASE_ENV }).msgBurst);
    const keys: string[] = [];
    const clients: TestClient[] = [];
    for (let a = 0; a < accounts; a++) {
      const key = `u/s6-${a}/index.html`;
      keys.push(key);
      share(key, `w${a}`);
      for (let i = 0; i < perAccount; i++) clients.push(await join(app, key, `sid=w${a}`));
    }
    const n = clients.length;
    expect(clients.every((c) => c.closeCode === null)).toBe(true);
    await waitFor(() => app.manager.inflightBytes === 0, 10_000, 'joins processed');
    const conns = keys.flatMap((k, a) => serverConn(app, k, `w${a}@corp`));
    expect(conns.length).toBe(n);
    // the queued jobs: every update admitted calls Room.update, and none finishes while the slot is held
    const jobs = vi.spyOn(Room.prototype, 'update');
    // the server's own state (its principals' counters), read through the instance that admits
    const admit = vi.spyOn(WsServer.prototype as unknown as { admitInflight: (...a: unknown[]) => unknown }, 'admitInflight');
    const release = await app.manager.applySlots.acquire();
    let released = false;
    try {
      // a valid update of 4 bytes (no struct, an empty delete set entry): the guard accepts it, no strike
      const msg = syncMsg(new Uint8Array([0, 1, 0, 0]));
      expect(msg.byteLength).toBeLessThan(16);
      // one message per connection per read, as a paced sender (the rate limit allows 120/s per connection)
      for (let r = 0; r < rounds; r++) {
        for (const c of clients) c.sendRaw(msg);
        await sleep(2);
      }
      await sleep(500);
      const queued = jobs.mock.calls.length;
      const gauge = (await app.metrics.inflightBytes.get()).values[0]?.value ?? 0;
      const paused = conns.filter((c) => c.paused && !c.closing);
      console.log('[S6 tiny updates]', JSON.stringify({ connections: n, sent: n * rounds, queued, bound: cap / KiB + 2 * n, inflightKiB: +(gauge / KiB).toFixed(1), capKiB: cap / KiB, paused: paused.length }));
      expect(clients.every((c) => c.closeCode === null)).toBe(true);
      expect(gauge).toBe(app.manager.inflightBytes);
      // a small message is always taken (an honest edit is never refused): past the cap, one or two per connection
      expect(gauge).toBeLessThanOrEqual(cap + 2 * n * KiB);
      expect(await metric(app, 'wsRejected', 'reason', 'inflight')).toBe(0);
      // the cap is reached: every connection that kept sending is no longer read (TCP backpressure)
      expect(paused.length).toBe(n);
      expect(await metric(app, 'wsPaused', 'why', 'server')).toBe(n);
      expect(queued).toBeLessThanOrEqual(cap / KiB + 2 * n);
      release();
      released = true;
      // everything is processed, the paused connections are read again and their rest processed too
      await waitFor(() => jobs.mock.calls.length === n * rounds && app.manager.inflightBytes === 0, 90_000, 'every message processed');
      expect(clients.every((c) => c.closeCode === null)).toBe(true);
      expect(conns.every((c) => c.inflight === 0 && !c.paused)).toBe(true);
      const ws = admit.mock.contexts[0] as unknown as { principals: Map<string, { inflight: number }> };
      const ps = [...ws.principals.entries()].filter(([k]) => /^u:w\d+@corp$/.test(k));
      expect(ps.length).toBe(accounts);
      expect(ps.every(([, p]) => p.inflight === 0)).toBe(true);
      expect((await app.metrics.inflightBytes.get()).values[0]?.value).toBe(0);
    } finally {
      if (!released) release();
      jobs.mockRestore();
      admit.mockRestore();
    }
  }, 150_000);

  it('a reconnecting tab\'s step 2 of a full room and an image paste in flight together stay under the connection\'s cap (honest traffic is never paused)', () => {
    // the size cap is 5 MiB at the chart's sizing, a message 4 MiB: an honest tab has one step 2 and
    // an edit or two in flight, 8 MiB is never reached by it
    const cfg = loadConfig({ ...BASE_ENV, HEAP_LIMIT_MB: '1776' });
    expect(cfg.workerInflightBytes).toBe(64 * MiB);
    expect(cfg.maxDocBytes + 2 * 1024 * 1024).toBeLessThan(inflightConnBytes(cfg.maxMessageBytes));
    expect(inflightConnBytes(cfg.anonMaxMessageBytes)).toBe(2 * MiB);
    expect(() => loadConfig({ ...BASE_ENV, HEAP_LIMIT_MB: '1776', WORKER_INFLIGHT_BYTES: String(MiB) })).toThrow(/WORKER_INFLIGHT_BYTES/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F-1: an honest bulk delete is never struck', () => {
  it('5 000 of 10 400 shapes a co-writer wrote in one session: refused `too-costly` without a strike (three tries, no cooldown); the editor deletes them in parts and every part is accepted', async () => {
    const app = await startApp({ HEAP_LIMIT_MB: '1776' });
    const board = 'u/f1-shared-board/index.html';
    const own = 'u/f1-alice-own/index.html';
    share(board, 'alice', 'mallory');
    share(own, 'alice');
    const saved = seedOneSession(10_400, 'mallory@corp');
    expect(saved.content.byteLength + saved.ledger.byteLength).toBeLessThan(5 * MiB);
    await store.put(`_plugins/canvas/${board}.ydoc`, saved.content);
    await store.put(`_plugins/canvas/${board}.ydoc.ledger`, saved.ledger);
    // the verifier's PoC (e3-vandal-strike): the whole selection in one transaction, three times
    for (let attempt = 1; attempt <= 3; attempt++) {
      const alice = await join(app, board, 'sid=alice');
      await waitFor(() => alice.doc.getMap('shapes').size >= 10_400, 30_000, 'synced');
      alice.doc.transact(() => {
        const s = alice.doc.getMap('shapes');
        for (let i = 0; i < 5000; i++) s.delete(`f${i}`);
      });
      expect(await alice.closed).toBe(4413);
      expect(alice.notices.map((n) => n.kind)).toEqual(['too-costly']);
    }
    expect(await metric(app, 'wsRejected', 'reason', 'delete_too_costly')).toBe(3);
    expect(await metric(app, 'strikes', 'outcome', 'strike')).toBe(0);
    expect(await metric(app, 'strikes', 'outcome', 'cooldown')).toBe(0);
    // her own canvas opens (before: 1013 cooldown on every canvas, reads included)
    const mine = await join(app, own, 'sid=alice');
    expect(mine.closeCode).toBeNull();
    expect(mine.identity?.id).toBe('alice@corp');
    // the editor's delete (CanvasDoc.delete): DELETE_BATCH shapes per update, all accepted; mallory
    // watches the room
    const mallory = await join(app, board, 'sid=mallory');
    const alice = await join(app, board, 'sid=alice');
    await waitFor(() => alice.doc.getMap('shapes').size >= 10_400 && mallory.doc.getMap('shapes').size >= 10_400, 30_000, 'synced');
    const cd = new CanvasDoc(alice.doc);
    let updates = 0;
    alice.doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === cd.origin) updates++;
    });
    cd.delete(Array.from({ length: 5000 }, (_, i) => `f${i}`));
    cd.endGesture();
    expect(updates).toBe(Math.ceil(5000 / DELETE_BATCH));
    // one undo step for the user
    expect(cd.undoManager.undoStack.length).toBe(1);
    await waitFor(() => mallory.doc.getMap('shapes').size === 5400, 60_000, 'deleted in parts');
    const room = app.manager.get(board)!;
    expect((await room.inspect()).doc.getMap('shapes').size).toBe(5400);
    expect(alice.closeCode).toBeNull();
    expect(mallory.closeCode).toBeNull();
    expect(await metric(app, 'wsRejected', 'reason', 'delete_too_costly')).toBe(3);
    expect(await metric(app, 'strikes', 'outcome', 'strike')).toBe(0);
  }, 240_000);

  it('a costly update that writes (not only deletes) is still struck', async () => {
    const c = testCore(1000);
    const a = new Y.Doc();
    a.clientID = 11;
    a.transact(() => a.getMap('shapes').set('s', mapOf(geo('s'))));
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a), { identity: { id: 'a', name: 'a', anonymous: false, color: '#000' } });
    const del = new Y.Doc();
    Y.applyUpdate(del, Y.encodeStateAsUpdate(a));
    const sv = Y.encodeStateVector(del);
    del.getMap('shapes').delete('s');
    expect(c.check(Y.encodeStateAsUpdate(del, sv), 'a', new Set()).deletesOnly).toBe(true);
    const w = new Y.Doc();
    Y.applyUpdate(w, Y.encodeStateAsUpdate(a));
    const sv2 = Y.encodeStateVector(w);
    w.transact(() => w.getMap('shapes').set('t', mapOf(geo('t'))));
    expect(c.check(Y.encodeStateAsUpdate(w, sv2), 'a', new Set()).deletesOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F-4: a rebuild refills the resync budget of the tabs it asks', () => {
  it('a tab whose resync budget is used up gets it back when a rebuild sends it a step 1', async () => {
    const app = await startApp();
    const key = 'u/f4/index.html';
    share(key, 'ana');
    const ana = await join(app, key, 'sid=ana');
    ana.doc.getMap('shapes').set('a', mapOf(geo('a')));
    const room = app.manager.get(key)!;
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').has('a'), 5000, 'edit');
    const conn = serverConn(app, key, 'ana@corp')[0];
    while (conn.resync.take()) {
      /* used up, as a long-lived tab under constant rebuilds could */
    }
    expect(conn.resync.level()).toBeLessThan(1);
    const step1 = ana.step1Received;
    await room.restart();
    await waitFor(() => ana.step1Received > step1, 5000, 'step 1 of the rebuild');
    expect(conn.resync.level()).toBeGreaterThanOrEqual(19.9);
    expect(ana.closeCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('F-5: the process refuses to start where a room worker\'s heap limit would not hold', () => {
  it('--max-old-space-size in NODE_OPTIONS is refused with a clear error (it overrides every worker\'s limit)', () => {
    for (const flag of ['--max-old-space-size=1728', '--max_old_space_size=1728', '--trace-gc --max-old-space-size=4096']) {
      expect(() => loadConfig({ ...BASE_ENV, NODE_OPTIONS: flag })).toThrow(/max-old-space-size.*HEAP_LIMIT_MB/);
    }
    expect(() => loadConfig({ ...BASE_ENV, NODE_OPTIONS: '--no-warnings' })).not.toThrow();
  });
  it('the worker test hooks are refused under NODE_ENV=production unless the test stack says so', () => {
    expect(() => loadConfig({ ...BASE_ENV, WORKER_TEST_HOOKS: 'true', NODE_ENV: 'production' })).toThrow(/WORKER_TEST_HOOKS/);
    expect(loadConfig({ ...BASE_ENV, WORKER_TEST_HOOKS: 'true', NODE_ENV: 'production', WORKER_TEST_HOOKS_IN_PRODUCTION: 'true' }).workerTestHooks).toBe(true);
    expect(loadConfig({ ...BASE_ENV, WORKER_TEST_HOOKS: 'true' }).workerTestHooks).toBe(true);
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'production' }).workerTestHooks).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
class FlakyStore extends MemoryCanvasObjectStore {
  failing = false;
  override async put(objectKey: string, body: Uint8Array, tagging?: string): Promise<void> {
    if (this.failing) throw new Error('storage unavailable');
    return super.put(objectKey, body, tagging);
  }
}

describe('F-6: the write-ahead log is bounded while saves fail', () => {
  it('saves failing: the log grows to WAL_MAX_DOCS rooms, then writes are refused 1013 (nothing applied); the log counts in the memory budget; once storage is back the save is retried by itself and the refused edit lands from the tab', async () => {
    const flaky = new FlakyStore();
    store = flaky;
    const docCap = 128 * 1024;
    const app = await startApp({ MAX_DOC_BYTES: String(docCap), ANON_MAX_DOC_BYTES: String(docCap) });
    const key = 'u/f6/index.html';
    share(key, 'ana');
    const ana = await join(app, key, 'sid=ana');
    const shapes = ana.doc.getMap('shapes');
    shapes.set('keep', mapOf(geo('keep')));
    const room = app.manager.get(key)!;
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').has('keep'), 5000, 'shape');
    await waitFor(() => room.walBytes === 0, 5000, 'saved');
    flaky.failing = true;
    // churn: a note with 8 000 characters, created and deleted again; the room grows by its
    // tombstones and attribution (~150 B a cycle), the log by the whole note
    const text = 'x'.repeat(8000);
    let cycles = 0;
    for (; cycles < 200 && ana.closeCode === null; cycles++) {
      const id = `n${cycles}`;
      ana.doc.transact(() => {
        const m = mapOf({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, color: 'yellow', size: 'm', font: 'draw', align: 'middle', opacity: 1 });
        m.set('text', new Y.Text(text));
        shapes.set(id, m);
      });
      await sleep(10);
      shapes.delete(id);
      await sleep(10);
    }
    await waitFor(() => ana.closeCode !== null, 10_000, 'refused');
    expect(ana.closeCode).toBe(1013);
    expect(ana.notices.map((n) => n.kind)).toContain('busy');
    expect(await metric(app, 'wsRejected', 'reason', 'wal_full')).toBe(1);
    expect(await metric(app, 'walFull')).toBe(1);
    expect(room.walFull).toBe(true);
    expect(room.walBytes).toBeGreaterThan(WAL_MAX_DOCS * docCap);
    // bounded: one update past the cap at most
    expect(room.walBytes).toBeLessThan(WAL_MAX_DOCS * docCap + 64 * 1024);
    // what the log holds beyond the room counts in the memory budget
    expect(room.walExcess).toBeGreaterThan(0);
    expect(app.manager.memory().total).toBeGreaterThanOrEqual(room.cost + room.walExcess);
    // the refused edit (the tab's last) was not applied: the room and the tab differ by it
    const accepted = (await room.inspect()).doc.getMap('shapes').toJSON();
    expect(JSON.stringify(accepted)).not.toBe(JSON.stringify(shapes.toJSON()));
    // the room is idle now (its only tab was closed) but is not evicted with its changes unsaved
    await sleep(500);
    expect(app.manager.get(key)).toBe(room);
    expect(room.unsaved).toBe(true);
    // storage back: the failed save is retried by itself (nothing else changes in the room)
    flaky.failing = false;
    await waitFor(() => room.walBytes === 0, 40_000, 'saved again');
    const storedDoc = new Y.Doc();
    Y.applyUpdate(storedDoc, (await flaky.get(`_plugins/canvas/${key}.ydoc`))!);
    expect(storedDoc.getMap('shapes').toJSON()).toEqual(accepted);
    // the tab reconnects (a new socket with its document): its step 2 carries the refused edit
    const again = new TestClient(`${base(app)}/${key}`, 'sid=ana');
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(ana.doc));
    await again.connect();
    await waitFor(async () => JSON.stringify((await room.inspect()).doc.getMap('shapes').toJSON()) === JSON.stringify(ana.doc.getMap('shapes').toJSON()), 10_000, 'refused edit landed');
    expect(again.closeCode).toBeNull();
    console.log('[F-6]', JSON.stringify({ cycles, walCap: WAL_MAX_DOCS * docCap }));
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
describe('bump discipline: the cost constants are tied to the Yjs versions they were measured on', () => {
  it('the lockfile installs exactly the versions of CALIBRATED_WITH (a bump re-runs the fv8/fv9 suites first)', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of Object.entries(CALIBRATED_WITH)) {
      const installed = Object.entries(lock.packages).filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)).map(([, v]) => v.version);
      expect(installed.length, name).toBeGreaterThan(0);
      expect(new Set(installed), `${name}: re-run the fv8/fv9 adversarial suites before updating CALIBRATED_WITH`).toEqual(new Set([version]));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('alert series exposed at 0 (review S7)', () => {
  it('a fresh server\'s /metrics has every series the chart\'s alerts (and the optional signals) read, at 0: increase() over a series born at 1 is 0, so the first event after a start would not fire', async () => {
    const app = await startApp({ METRICS_PORT: String(++portSeq), METRICS_HOST: '127.0.0.1' });
    const mport = (app.metricsServer!.address() as { port: number }).port;
    const body = await (await fetch(`http://127.0.0.1:${mport}/metrics`)).text();
    const lines = new Set(body.split('\n'));
    // every series the chart's PrometheusRule reads (an `=~"a|b"` matcher is each of a and b)
    const rule = fs.readFileSync(path.join(here, '..', '..', 'chart', 'templates', 'prometheusrule.yaml'), 'utf8');
    const alerted: string[] = [];
    for (const [, name, selector] of rule.matchAll(/expr: increase\((canvas_[a-z_]+)(.*?)\[\w+\]\)/g)) {
      const matchers = [...selector.matchAll(/(\w+)=~?"([^"]*)"/g)];
      expect(matchers.length, name).toBeLessThanOrEqual(1);
      if (!matchers.length) alerted.push(name);
      else for (const v of matchers[0][2].split('|')) alerted.push(`${name}{${matchers[0][1]}="${v}"}`);
    }
    expect(alerted).toEqual([
      'canvas_strikes_total{outcome="cooldown"}',
      'canvas_worker_faults_total{kind="timeout"}',
      'canvas_worker_recoveries_total{outcome="failed"}',
      'canvas_worker_recoveries_total{outcome="differs"}',
      'canvas_ws_rejected_total{reason="inflight"}',
      'canvas_wal_full_total',
    ]);
    // the optional signals (early storage errors, an accepted flood, refused deletes)
    const optional = [
      'canvas_saves_total{outcome="error"}',
      'canvas_ws_paused_total{why="connection"}',
      'canvas_ws_paused_total{why="principal"}',
      'canvas_ws_rejected_total{reason="delete_too_costly"}',
    ];
    const missing = [...alerted, ...optional].filter((s) => !lines.has(`${s} 0`));
    expect(missing).toEqual([]);
    expect(lines.has('canvas_strikes_total{outcome="cooldown"} 0')).toBe(true);
  });
});
