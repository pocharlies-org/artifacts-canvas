/**
 * Regressions of the seventh independent verification (fv7), through the real server. The
 * numbers in the comments are the verifier's (before).
 *   F1  the loaded-room memory budget: one user who grew rooms while other principals sat in them
 *       was charged a fraction of each (growth / principals present), kept them loaded alone once
 *       the others left and held the whole budget; every NEW room load, for everybody, was then
 *       refused 1013 (live, 2 GiB: user1 held 856 MiB against a 600 MiB share and an 828 MiB load
 *       cap; user2 got 13 x 1013 opening a new artifact). Now every room's cost is charged to the
 *       principals that loaded and wrote it, in full, and kept after they leave; growth stops
 *       below the load threshold; the per-principal share is a real third of the budget and the
 *       size caps are clamped to what a share holds.
 *   F2  the cost factors cover the worst shapes measured (server/test/fv7/ratio.ts, guardcost.ts)
 *   F6  a core that cannot answer the periodic re-check (timeout, 5xx) closes 1013 (the client
 *       reconnects), not 4403 `revoked`
 * The live variants (the real core, the chart's memory limit) are e2e-system/adversarial-fv7.spec.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { pino } from 'pino';
import {
  ANON_VISITOR_SHARE_RATIO, FULL_ROOM_MARGIN, GROWTH_FRACTION, LOAD_FRACTION, MESSAGE_COST_FACTOR, ROOM_BASE_COST_BYTES,
  ROOM_COST_FACTOR, RUNTIME_RESERVE_BYTES, deriveRoomLimits, loadConfig, roomCost,
} from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { Metrics } from '../src/metrics.js';
import { Room } from '../src/room.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 27600;
const apps: App[] = [];
const silent = createLogger('silent');
const MiB = 1024 * 1024;
const mib = (b: number) => Math.round((b / MiB) * 100) / 100;
const BASE_ENV = { GATE_AUTHZ_URL: 'http://c/', ARTIFACT_BASE_URL: 'http://c/', S3_BUCKET: 'b', METRICS_PORT: '0' };

async function startApp(env: Record<string, string> = {}, logger = silent): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '300', SAVE_DEBOUNCE_MS: '50',
      READYZ_CACHE_MS: '10', PORT: String(++portSeq), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0', ...env,
    });
    const app = createApp({ config: cfg, store, logger });
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
const geo = (id: string, j = 0) => ({
  id, type: 'geo', geo: 'rectangle', x: j % 900, y: Math.floor(j / 900) * 20, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false,
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

/** Stored rooms made like a client makes them (geo shapes stamped by the real Room). */
const seedCache = new Map<string, { content: Uint8Array; ledger: Uint8Array }>();
async function seed(key: string, shapes: number, author = 'bob@corp'): Promise<number> {
  const id = `${shapes}|${author}`;
  let objs = seedCache.get(id);
  if (!objs) {
    const tmp = new MemoryCanvasObjectStore();
    const cfg = loadConfig(BASE_ENV);
    const room = new Room('seed', { cfg, store: tmp, log: silent, metrics: new Metrics(), onEmpty: () => undefined });
    const d = new Y.Doc();
    const origin = { identity: { id: author, name: author, anonymous: false, color: '#000' } };
    for (let b = 0; b < shapes; b += 500) {
      const sv = Y.encodeStateVector(d);
      d.transact(() => {
        const s = d.getMap('shapes');
        for (let i = b; i < Math.min(shapes, b + 500); i++) s.set(`f${i}`, shapeMap(geo(`f${i}`, i)));
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
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv7-static-'));
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
  core.broken = null;
  core.hang = false;
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
/** Joined and synced (the server's step 1 arrived), or closed: the close code (null = open). */
async function joined(c: TestClient, ms = 10_000): Promise<number | null> {
  await waitFor(() => c.step1Received > 0 || c.closeCode !== null, ms, 'join settled').catch(() => undefined);
  return c.closeCode;
}
/** One more shape from `c`, applied by the server (or `c` was closed): true when it is in the room. */
async function addShape(app: App, c: TestClient, key: string, id: string): Promise<boolean> {
  c.doc.getMap('shapes').set(id, shapeMap(geo(id, 1)));
  await waitFor(() => app.manager.get(key)?.doc.getMap('shapes').has(id) === true || c.closeCode !== null, 5000, `${id} applied`).catch(() => undefined);
  return app.manager.get(key)?.doc.getMap('shapes').has(id) === true;
}
/** Wait until no room has unsaved changes (every pending debounced save ran: charges settled). */
async function saved(app: App): Promise<void> {
  await sleep(60);
  await Promise.all([...app.manager.rooms.values()].map((r) => r.flush()));
}

// ---------------------------------------------------------------------------------------------
describe('fv7 F1: the memory budget charges whoever loaded and wrote, in full', () => {
  /**
   * The verifier's dos-unit at test scale (64 MiB budget, a third of it per user: rooms of
   * ~1 MiB at most): ONE logged-in user fills four pub/ rooms while `sitters` other principals
   * sit in each (anonymous visitors, or signed-in co-viewers of the same artifacts), keeps one
   * socket per room open, and the sitters leave. Then honest users open NEW artifacts.
   */
  async function attack(sitterKind: 'none' | 'anon' | 'user') {
    const ROOMS = 4;
    const SITTERS = sitterKind === 'none' ? 0 : 3;
    const app = await startApp({
      ROOM_MEMORY_BUDGET_BYTES: String(64 * MiB), MAX_DOC_BYTES: String(1 * MiB), ANON_MAX_DOC_BYTES: String(256 * 1024),
      MAX_MESSAGE_BYTES: String(512 * 1024), ANON_MAX_MESSAGE_BYTES: String(256 * 1024),
      // the fill below is fast: no CPU or message-rate refusal may stop it before the budget does
      MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000', CPU_MS_PER_SEC: '100000', CPU_BURST_MS: '100000', CPU_TOTAL_MS_PER_SEC: '100000', CPU_TOTAL_BURST_MS: '100000',
      ANON_MINT_BURST: '400', JOIN_BURST: '1000', JOIN_RATE_PER_MIN: '60000', AUTHZ_RECHECK_SECONDS: '3600',
    });
    const mgr = app.manager;
    const cfg = cfgOf(app);
    const keys = Array.from({ length: ROOMS }, (_, i) => `pub/r${i}/index.html`);
    const coViewers = ['ana', 'carl', 'dora'];
    for (const k of keys) {
      share(k, 'mallory', ...coViewers);
      core.rules.set(k, allowAnon());
    }
    share('u/alice/new.html', 'alice');
    share('u/bob/team.html', 'bob');
    const M = 'u:mallory@corp';
    let maxHeld = 0;
    let maxTotal = 0;
    const sample = () => {
      maxHeld = Math.max(maxHeld, mgr.held(M));
      maxTotal = Math.max(maxTotal, mgr.memory().total);
    };
    const keepers: TestClient[] = [];
    const sitters: TestClient[] = [];
    const writerCloses: (number | null)[] = [];
    for (const k of keys) {
      for (let s = 0; s < SITTERS; s++) {
        const c = await join(app, k, sitterKind === 'user' ? `sid=${coViewers[s]}` : undefined);
        expect(await joined(c)).toBeNull();
        sitters.push(c);
      }
      // mallory: a keeper socket (never writes) and a writer socket that fills the room
      const keep = await join(app, k, 'sid=mallory');
      keepers.push(keep);
      const w = await join(app, k, 'sid=mallory');
      expect(await joined(w)).toBeNull();
      let n = 0;
      while (w.closeCode === null && n < 50_000) {
        w.doc.transact(() => {
          const s = w.doc.getMap('shapes');
          for (let i = 0; i < 100; i++, n++) s.set(`${k.slice(4, 6)}-${n}`, shapeMap(geo(`${k.slice(4, 6)}-${n}`, n)));
        });
        await sleep(15);
        sample();
      }
      await waitFor(() => w.closeCode !== null, 10_000, 'writer stopped').catch(() => undefined);
      writerCloses.push(w.closeCode);
      sample();
    }
    const sittersOpen = sitters.filter((c) => c.closeCode === null).length;
    for (const c of sitters) c.close();
    await sleep(300);
    await saved(app);
    sample();
    const after = { loadedMiB: mib(mgr.memory().total), malloryHeldMiB: mib(mgr.held(M)), keepersOpen: keepers.filter((c) => c.closeCode === null).length };
    // honest users open NEW artifacts and draw; so does an anonymous visitor
    const honest: Record<string, number | string | null> = {};
    for (const [who, k] of [['alice', 'u/alice/new.html'], ['bob', 'u/bob/team.html']] as const) {
      const c = await join(app, k, `sid=${who}`);
      const code = await joined(c);
      honest[who] = code === null && (await addShape(app, c, k, `${who}-1`)) ? 'joined+drew' : `closed ${c.closeCode}`;
      c.close();
    }
    core.rules.set('pub/fresh/index.html', allowAnon());
    const v = await join(app, 'pub/fresh/index.html');
    honest.anonymous = (await joined(v)) === null && (await addShape(app, v, 'pub/fresh/index.html', 'visitor-1')) ? 'joined+drew' : `closed ${v.closeCode}`;
    v.close();
    const result = {
      sitters: `${SITTERS} ${sitterKind}`, budgetMiB: mib(cfg.roomMemoryBudgetBytes), userShareMiB: mib(mgr.share(false)),
      loadsUpToMiB: mib(cfg.roomMemoryBudgetBytes * LOAD_FRACTION), maxHeldMiB: mib(maxHeld), maxLoadedMiB: mib(maxTotal),
      writerCloses, sittersOpenWhileFilling: sittersOpen, after, honest,
      refused: { principal: await rejected(app, 'room_memory_principal'), total: await rejected(app, 'room_memory'), docCap: await rejected(app, 'doc_too_large') },
    };
    console.log(`[fv7 F1 dos] ${JSON.stringify(result)}`);
    for (const c of keepers) c.close();
    return { app, result, maxHeld, sittersOpen, SITTERS };
  }

  for (const kind of ['none', 'anon', 'user'] as const) {
    it(`dos (${kind === 'none' ? 'no sitters' : kind === 'anon' ? 'anonymous sitters' : 'signed-in co-viewers'}): one user filling rooms holds at most its share, and after the sitters leave honest users still open new rooms and draw`, async () => {
      const { app, result, maxHeld, sittersOpen, SITTERS } = await attack(kind);
      // the sitters really sat there while the rooms grew
      expect(sittersOpen).toBe(4 * SITTERS);
      // the attacker was stopped by its share (1013 busy), never by the size cap first
      expect(result.writerCloses.some((c) => c === 1013)).toBe(true);
      expect(result.refused.principal).toBeGreaterThanOrEqual(1);
      // charged in full: never more than its share (plus one update's estimate error), sitters or not
      expect(maxHeld).toBeLessThanOrEqual(app.manager.share(false) * 1.01);
      expect(result.after.malloryHeldMiB).toBeGreaterThan(result.userShareMiB * 0.8);
      // before: user2 got 1013 on every attempt to open a new artifact
      expect(result.honest).toEqual({ alice: 'joined+drew', bob: 'joined+drew', anonymous: 'joined+drew' });
    }, 120_000);
  }

  it('a charge stays with the room after its principal leaves, until the room is evicted; readers pay nothing; growth is charged in full to its writer', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(256 * MiB) });
    const mgr = app.manager;
    const key = 'u/d/index.html';
    const bytes = await seed(key, 1000);
    share(key, 'mallory', 'ana', 'carl');
    const m = await join(app, key, 'sid=mallory');
    expect(await joined(m)).toBeNull();
    const loaded = roomCost(cfgOf(app), bytes);
    expect(mgr.held('u:mallory@corp')).toBe(loaded);
    const a = await join(app, key, 'sid=ana');
    const c = await join(app, key, 'sid=carl');
    expect(await joined(a)).toBeNull();
    expect(await joined(c)).toBeNull();
    // readers that joined a loaded room pay nothing
    expect(mgr.held('u:ana@corp')).toBe(0);
    expect(mgr.held('u:carl@corp')).toBe(0);
    // ana writes: her growth is hers alone (before: divided by the 3 principals present)
    const room = mgr.get(key)!;
    const cost0 = room.cost;
    a.doc.transact(() => {
      for (let i = 0; i < 200; i++) a.doc.getMap('shapes').set(`a${i}`, shapeMap(geo(`a${i}`, i)));
    });
    await waitFor(() => room.doc.getMap('shapes').has('a199'), 5000, 'applied');
    expect(mgr.held('u:ana@corp')).toBeCloseTo(room.cost - cost0, 0);
    expect(mgr.held('u:mallory@corp')).toBe(loaded);
    expect(mgr.held('u:carl@corp')).toBe(0);
    await saved(app);
    // the save measured the room: the charges add up to its cost, mallory's did not move
    expect(mgr.held('u:mallory@corp') + mgr.held('u:ana@corp') + mgr.held('u:carl@corp')).toBeCloseTo(room.cost, 0);
    expect(mgr.held('u:mallory@corp')).toBe(loaded);
    // mallory and ana leave: carl keeps the room loaded, their charges stay (nothing became free)
    m.close();
    a.close();
    await waitFor(() => room.principals.size === 1, 5000, 'left');
    expect(mgr.held('u:mallory@corp')).toBe(loaded);
    expect(mgr.held('u:ana@corp')).toBeGreaterThan(0);
    expect(mgr.held('u:carl@corp')).toBe(0);
    // the last reader leaves: the room is evicted and so are its charges
    c.close();
    await waitFor(() => !mgr.get(key), 5000, 'evicted');
    expect(mgr.held('u:mallory@corp')).toBe(0);
    expect(mgr.held('u:ana@corp')).toBe(0);
  });

  it('an honest session is charged what the room measures, not the sum of its estimates (moves, create/delete cycles); a principal that wrote nothing since is never moved', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(256 * MiB) });
    const mgr = app.manager;
    const key = 'u/long/index.html';
    share(key, 'mallory', 'ana');
    const m = await join(app, key, 'sid=mallory');
    expect(await joined(m)).toBeNull();
    const room = mgr.get(key)!;
    m.doc.transact(() => {
      for (let i = 0; i < 300; i++) m.doc.getMap('shapes').set(`m${i}`, shapeMap(geo(`m${i}`, i)));
    });
    await waitFor(() => room.doc.getMap('shapes').size === 300, 5000, 'applied');
    await saved(app);
    const mallory = mgr.held('u:mallory@corp');
    expect(mallory).toBeCloseTo(room.cost, 0);
    // ana edits a lot: moves (every overwrite charged at its estimate), then create/delete cycles
    const a = await join(app, key, 'sid=ana');
    expect(await joined(a)).toBeNull();
    let estimates = 0;
    const charge0 = () => mgr.held('u:ana@corp');
    for (let round = 0; round < 30; round++) {
      const before = charge0();
      a.doc.transact(() => {
        for (let i = 0; i < 100; i++) (a.doc.getMap('shapes').get(`m${i}`) as Y.Map<unknown>).set('x', round * 1000 + i);
      });
      await waitFor(() => (room.doc.getMap('shapes').get('m99') as Y.Map<unknown>).get('x') === round * 1000 + 99, 5000, 'move');
      estimates += charge0() - before;
      if (round % 3 === 0) await saved(app);
    }
    for (let cycle = 0; cycle < 6; cycle++) {
      const before = charge0();
      a.doc.transact(() => {
        for (let i = 0; i < 200; i++) a.doc.getMap('shapes').set(`c${cycle}-${i}`, shapeMap(geo(`c${cycle}-${i}`, i)));
      });
      await waitFor(() => room.doc.getMap('shapes').has(`c${cycle}-199`), 5000, 'create');
      estimates += charge0() - before;
      await saved(app);
      a.doc.transact(() => {
        for (let i = 0; i < 200; i++) a.doc.getMap('shapes').delete(`c${cycle}-${i}`);
      });
      await waitFor(() => !room.doc.getMap('shapes').has(`c${cycle}-199`), 5000, 'delete');
      await saved(app);
    }
    const ana = mgr.held('u:ana@corp');
    console.log(`[fv7 F1 settle] mallory ${mib(mallory)} MiB (unchanged: ${mgr.held('u:mallory@corp') === mallory}); ana charged ${mib(ana)} MiB after the saves, her updates were estimated at ${mib(estimates)} MiB; room ${mib(room.cost)} MiB`);
    // everything the room costs is charged, and nothing more
    expect(mgr.held('u:mallory@corp') + ana).toBeCloseTo(room.cost, 0);
    // mallory wrote nothing meanwhile: not one byte of hers moved
    expect(mgr.held('u:mallory@corp')).toBe(mallory);
    // ana pays what the room grew by, far less than the estimates of every update she sent
    expect(ana).toBeLessThan(estimates / 2);
    for (const c of [m, a]) c.close();
  });

  it('growth stops at 80% of the budget, loads at 85%: past the growth threshold a new room still opens', async () => {
    // four principals load a stored room each: together 82% of the budget
    const keys = Array.from({ length: 4 }, (_, i) => `u/t${i}/index.html`);
    let bytes = 0;
    for (const k of keys) bytes = await seed(k, 300);
    const perRoom = ROOM_BASE_COST_BYTES + ROOM_COST_FACTOR * bytes;
    const budget = Math.ceil((4 * perRoom) / 0.82);
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(budget) });
    const who = ['p1', 'p2', 'p3', 'p4'];
    keys.forEach((k, i) => share(k, who[i]));
    share('u/p5a/index.html', 'p5');
    share('u/p5b/index.html', 'p5');
    share('u/p6/index.html', 'p6');
    const held: TestClient[] = [];
    const keepers: TestClient[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await join(app, keys[i], `sid=${who[i]}`);
      expect(await joined(c)).toBeNull();
      held.push(c);
      // a second socket keeps the room loaded when the first one is closed
      keepers.push(await join(app, keys[i], `sid=${who[i]}`));
    }
    const total = app.manager.memory().total;
    expect(total).toBeGreaterThan(budget * GROWTH_FRACTION);
    expect(total).toBeLessThan(budget * LOAD_FRACTION - 64 * 1024);
    // p1 grows its room: refused, nothing applied
    expect(await addShape(app, held[0], keys[0], 'grow')).toBe(false);
    expect(held[0].closeCode).toBe(1013);
    expect(held[0].notices.map((n) => n.kind)).toContain('busy');
    expect(await rejected(app, 'room_memory')).toBe(1);
    // p5 opens a new room (a load: allowed up to 85%) but cannot grow it either
    const p5 = await join(app, 'u/p5a/index.html', 'sid=p5');
    expect(await joined(p5)).toBeNull();
    expect(await addShape(app, p5, 'u/p5a/index.html', 'grow')).toBe(false);
    expect(p5.closeCode).toBe(1013);
    // and another principal still opens a new room: the 5% between the thresholds is for loads
    const p6 = await join(app, 'u/p6/index.html', 'sid=p6');
    expect(await joined(p6)).toBeNull();
    await sleep(200);
    expect(p6.closeCode).toBeNull();
    for (const c of [...held, ...keepers, p6]) c.close();
  });

  it('a stored room that costs more than the loader\'s whole share is refused 4413 too-large (it can never load for it); smaller rooms load', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(64 * MiB) });
    const big = 'u/big/index.html';
    const small = 'u/small/index.html';
    const bytes = await seed(big, 2000);
    await seed(small, 100);
    share(big, 'mallory');
    share(small, 'mallory');
    expect(roomCost(cfgOf(app), bytes)).toBeGreaterThan(app.manager.share(false));
    const c = await join(app, big, 'sid=mallory');
    expect(await c.closed).toBe(4413);
    expect(c.notices.map((n) => n.kind)).toContain('too-large');
    expect(await rejected(app, 'room_too_large')).toBe(1);
    expect(app.manager.get(big)).toBeUndefined();
    const s = await join(app, small, 'sid=mallory');
    expect(await joined(s)).toBeNull();
    s.close();
  });

  it('the ledger an update adds is counted ahead by the shapes it touches: one big image in a new room fits a share (fv6 counted 2.6 x its size), a move of thousands of shapes counts their attribution', async () => {
    // a 256 MiB budget: a share of 85 MiB, rooms clamped to ~1.5 MiB
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(256 * MiB), MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const cfg = cfgOf(app);
    share('u/img/index.html', 'ana');
    const a = await join(app, 'u/img/index.html', 'sid=ana');
    expect(await joined(a)).toBeNull();
    // an image as big as a message may be (a data URL in `assets`, one image shape)
    const data = `data:image/png;base64,${'A'.repeat(Math.floor(cfg.maxMessageBytes * 0.9))}`;
    a.doc.transact(() => {
      a.doc.getMap('assets').set('img1', data);
      a.doc.getMap('shapes').set('i1', shapeMap({ id: 'i1', type: 'image', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 1, groupId: '', locked: false, opacity: 1, assetId: 'img1' }));
    });
    await waitFor(() => app.manager.get('u/img/index.html')?.doc.getMap('assets').has('img1') === true || a.closeCode !== null, 5000, 'image applied');
    expect(a.closeCode).toBeNull();
    // fv6's estimate: 44 x size x 2.6 for a room under 64 KiB, more than the share
    expect(ROOM_COST_FACTOR * data.length * 2.6).toBeGreaterThan(app.manager.share(false));
    expect(app.manager.held('u:ana@corp')).toBeLessThanOrEqual(app.manager.share(false));
    a.close();

    // two users create 1000 shapes each; a third moves all 2000 in one small update: the
    // stamper rewrites 2000 attribution entries (~0.2 MB of ledger for a ~30 KB update)
    const key = 'u/mass/index.html';
    share(key, 'p1', 'p2', 'p3');
    const p1 = await join(app, key, 'sid=p1');
    const p2 = await join(app, key, 'sid=p2');
    const p3 = await join(app, key, 'sid=p3');
    for (const c of [p1, p2, p3]) expect(await joined(c)).toBeNull();
    const room = app.manager.get(key)!;
    for (const [c, tag] of [[p1, 'a'], [p2, 'b']] as const) {
      c.doc.transact(() => {
        for (let i = 0; i < 1000; i++) c.doc.getMap('shapes').set(`${tag}${i}`, shapeMap(geo(`${tag}${i}`, i)));
      });
    }
    await waitFor(() => (room.doc.getMap('shapes').size === 2000 && p3.doc.getMap('shapes').size === 2000) || p1.closeCode !== null || p2.closeCode !== null, 10_000, 'created');
    expect([p1.closeCode, p2.closeCode, room.doc.getMap('shapes').size]).toEqual([null, null, 2000]);
    await saved(app);
    const ledger0 = room.ledgerApproxBytes;
    const sv = Y.encodeStateVector(p3.doc);
    p3.doc.transact(() => {
      for (const id of p3.doc.getMap('shapes').keys()) (p3.doc.getMap('shapes').get(id) as Y.Map<unknown>).set('x', 7);
    });
    const moveBytes = Y.encodeStateAsUpdate(p3.doc, sv).byteLength;
    await waitFor(() => (room.doc.getMap('shapes').get('b999') as Y.Map<unknown>).get('x') === 7 || p3.closeCode !== null, 10_000, 'moved');
    const ledgerAdded = room.ledgerApproxBytes - ledger0;
    console.log(`[fv7 F1 ledger] a move of 2000 shapes: ${moveBytes} B of update, ${ledgerAdded} B of ledger; p3 charged ${mib(app.manager.held('u:p3@corp'))} MiB`);
    expect(p3.closeCode).toBeNull();
    // the ledger is many times the update (fv6 counted it at most 1.6 x)
    expect(ledgerAdded).toBeGreaterThan(5 * moveBytes);
    // and all of it is charged to the mover
    expect(app.manager.held('u:p3@corp')).toBeGreaterThanOrEqual(ROOM_COST_FACTOR * (moveBytes + ledgerAdded) * 0.99);
    for (const c of [p1, p2, p3]) c.close();
  });

  it('an update that only repeats deletions the room has adds nothing to the estimate (before: counted at its size, with no save to correct it)', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(256 * MiB), MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/nop/index.html';
    share(key, 'mallory');
    const m = await join(app, key, 'sid=mallory');
    expect(await joined(m)).toBeNull();
    const room = app.manager.get(key)!;
    // 2000 shapes, every other one deleted: a delete set of 1000 ranges
    m.doc.transact(() => {
      for (let i = 0; i < 2000; i++) m.doc.getMap('shapes').set(`s${i}`, shapeMap(geo(`s${i}`, i)));
    });
    await waitFor(() => room.doc.getMap('shapes').size === 2000, 5000, 'created');
    m.doc.transact(() => {
      for (let i = 0; i < 2000; i += 2) m.doc.getMap('shapes').delete(`s${i}`);
    });
    await waitFor(() => room.doc.getMap('shapes').size === 1000, 5000, 'deleted');
    await saved(app);
    const before = { approx: room.approxBytes, total: app.manager.memory().total, held: app.manager.held('u:mallory@corp') };
    // the client's step 2 against the room's state: no struct, the whole delete set
    const upd = Y.encodeStateAsUpdate(m.doc, Y.encodeStateVector(room.doc));
    expect(upd.byteLength).toBeGreaterThan(1000);
    for (let i = 0; i < 50; i++) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, upd);
      m.ws.send(encoding.toUint8Array(e));
    }
    await sleep(500);
    expect(m.closeCode).toBeNull();
    const after = { approx: room.approxBytes, total: app.manager.memory().total, held: app.manager.held('u:mallory@corp') };
    console.log(`[fv7 F1 no-op deletes] 50 x ${upd.byteLength} B: estimate ${mib(before.total)} -> ${mib(after.total)} MiB (before the fix: +${mib(50 * upd.byteLength * ROOM_COST_FACTOR)} MiB)`);
    expect(after).toEqual(before);
    m.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv7 F1: the share is a real fraction of the budget; the size caps follow it', () => {
  it('shares: a third of the budget per user, a twelfth per anonymous visitor, a third for all of them; no floor above the share', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(64 * MiB) });
    expect(app.manager.share(false)).toBeCloseTo((64 * MiB) / 3, 0);
    expect(app.manager.share(true)).toBeCloseTo((64 * MiB) / 12, 0);
    expect(ANON_VISITOR_SHARE_RATIO).toBe(0.25);
    expect(app.manager.anonShare()).toBeCloseTo((64 * MiB) / 3, 0);
    // the thresholds: growth strictly below loads
    expect(GROWTH_FRACTION).toBeLessThan(LOAD_FRACTION);
    expect([GROWTH_FRACTION, LOAD_FRACTION]).toEqual([0.8, 0.85]);
    // one user and every anonymous visitor together must leave room for the others to grow
    expect(() => loadConfig({ ...BASE_ENV, ROOM_MEMORY_PRINCIPAL_SHARE: '0.5', ROOM_MEMORY_ANON_SHARE: '0.5' })).toThrow(/must be <= 0.8/);
  });

  it('the chart default (2 GiB, heap limit 1560 MiB): 872 MiB budget, a full room fits a share, nothing lowered, no warning', () => {
    const cfg = loadConfig(BASE_ENV);
    deriveRoomLimits(cfg, 1560 * MiB, null);
    expect(cfg.roomMemoryBudgetBytes).toBe(872 * MiB);
    expect(cfg.memoryWarnings).toEqual([]);
    expect([cfg.maxDocBytes, cfg.anonMaxDocBytes, cfg.maxMessageBytes, cfg.anonMaxMessageBytes]).toEqual([5 * MiB, 1280 * 1024, 4 * MiB, 1 * MiB]);
    const userShare = cfg.roomMemoryBudgetBytes / 3;
    expect(roomCost(cfg, FULL_ROOM_MARGIN * cfg.maxDocBytes)).toBeLessThanOrEqual(userShare);
    expect(roomCost(cfg, FULL_ROOM_MARGIN * cfg.anonMaxDocBytes)).toBeLessThanOrEqual(userShare * ANON_VISITOR_SHARE_RATIO);
  });

  it('1 GiB (heap limit 792 MiB): the caps are lowered to what a share holds, the budget follows the lowered message cap, warnings say so', () => {
    const cfg = loadConfig(BASE_ENV);
    deriveRoomLimits(cfg, 792 * MiB, null);
    const userShare = cfg.roomMemoryBudgetBytes / 3;
    console.log(`[fv7 F1 1 GiB] budget ${mib(cfg.roomMemoryBudgetBytes)} MiB, user share ${mib(userShare)} MiB, MAX_DOC ${mib(cfg.maxDocBytes)} MiB, ANON_MAX_DOC ${mib(cfg.anonMaxDocBytes)} MiB, MAX_MESSAGE ${mib(cfg.maxMessageBytes)} MiB, ANON_MAX_MESSAGE ${mib(cfg.anonMaxMessageBytes)} MiB; ${cfg.memoryWarnings.length} warnings`);
    expect(cfg.maxDocBytes).toBeLessThan(5 * MiB);
    expect(cfg.maxDocBytes).toBeGreaterThan(1 * MiB);
    expect(roomCost(cfg, FULL_ROOM_MARGIN * cfg.maxDocBytes)).toBeLessThanOrEqual(userShare);
    expect(roomCost(cfg, FULL_ROOM_MARGIN * cfg.anonMaxDocBytes)).toBeLessThanOrEqual(userShare * ANON_VISITOR_SHARE_RATIO);
    expect(cfg.maxMessageBytes).toBeLessThanOrEqual(cfg.maxDocBytes);
    expect(cfg.anonMaxMessageBytes).toBeLessThanOrEqual(cfg.anonMaxDocBytes);
    expect(cfg.maxImageBytes).toBeLessThanOrEqual(0.7 * cfg.maxMessageBytes);
    // the budget reserves one message of the cap that results (not the configured 4 MiB)
    expect(cfg.roomMemoryBudgetBytes).toBe(Math.floor(792 * MiB - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - MESSAGE_COST_FACTOR * cfg.maxMessageBytes));
    expect(cfg.memoryWarnings.some((w) => w.startsWith('MAX_DOC_BYTES lowered'))).toBe(true);
    expect(cfg.memoryWarnings.some((w) => w.startsWith('ANON_MAX_DOC_BYTES lowered'))).toBe(true);
    expect(cfg.configuredLimits.maxDocBytes).toBe(5 * MiB);
  });

  it('a budget smaller than one full room: the caps are clamped and the server warns at start', async () => {
    const lines: { level: number; msg: string }[] = [];
    const logger = pino({ level: 'warn' }, new Writable({ write(chunk, _e, cb) { for (const l of String(chunk).split('\n')) if (l) lines.push(JSON.parse(l)); cb(); } }));
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(64 * MiB), MAX_DOC_BYTES: String(20 * MiB) }, logger);
    const cfg = cfgOf(app);
    // a 20 MiB room costs 880 MiB: more than the whole 64 MiB budget
    expect(cfg.memoryWarnings.some((w) => w.includes('smaller than one full room'))).toBe(true);
    expect(cfg.maxDocBytes).toBeLessThan(1 * MiB);
    expect(roomCost(cfg, FULL_ROOM_MARGIN * cfg.maxDocBytes)).toBeLessThanOrEqual(app.manager.share(false));
    const warned = lines.filter((l) => l.level === 40 && l.msg.startsWith('memory sizing: ')).map((l) => l.msg);
    expect(warned.length).toBe(cfg.memoryWarnings.length);
    expect(warned.some((w) => w.includes('MAX_DOC_BYTES lowered from 20.00 MiB'))).toBe(true);
    expect(warned.some((w) => w.includes('smaller than one full room'))).toBe(true);
    // the room cap really is the clamped one: an update past it is refused 4413
    share('u/cap/index.html', 'mallory');
    const m = await join(app, 'u/cap/index.html', 'sid=mallory');
    expect(await joined(m)).toBeNull();
    const keeper = await join(app, 'u/cap/index.html', 'sid=mallory');
    let n = 0;
    while (m.closeCode === null && n < 20_000) {
      m.doc.transact(() => {
        for (let i = 0; i < 100; i++, n++) m.doc.getMap('shapes').set(`c${n}`, shapeMap(geo(`c${n}`, n)));
      });
      await sleep(10);
    }
    expect(await m.closed).toBe(4413);
    // the ledger of each update is counted ahead against the cap: the room never passes it
    expect(app.manager.get('u/cap/index.html')!.bytes).toBeLessThanOrEqual(cfg.maxDocBytes);
    expect(app.manager.get('u/cap/index.html')!.bytes).toBeGreaterThan(cfg.maxDocBytes * 0.5);
    keeper.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv7 F6: a core that cannot answer closes 1013 (the client reconnects), never 4403', () => {
  for (const failure of ['5xx', 'timeout'] as const) {
    it(`re-check with the core ${failure === '5xx' ? 'answering 500' : 'not answering'}: closed 1013 busy (before: 4403 revoked); once the core is back the user joins again`, async () => {
      const app = await startApp({ AUTHZ_RECHECK_SECONDS: '1', AUTHZ_TIMEOUT_MS: '300' });
      const key = 'u/f6/index.html';
      share(key, 'ana');
      const a = await join(app, key, 'sid=ana');
      expect(await joined(a)).toBeNull();
      if (failure === '5xx') core.broken = { status: 503, body: 'upstream down' };
      else core.hang = true;
      const code = await Promise.race([a.closed, sleep(8000).then(() => -1)]);
      expect(code).toBe(1013);
      expect(a.notices.map((n) => n.kind)).toContain('busy');
      expect(a.notices.map((n) => n.kind)).not.toContain('revoked');
      expect(await rejected(app, 'revoked')).toBe(0);
      // still down: a reconnect is refused 1013 too (it keeps retrying), never let in unverified
      const b = new TestClient(`${base(app)}/${key}`, 'sid=ana');
      await b.connect().catch(() => undefined);
      expect(await b.closed).toBe(1013);
      // the core is back: the client's reconnect gets in
      core.broken = null;
      core.hang = false;
      const c = await join(app, key, 'sid=ana');
      expect(await joined(c)).toBeNull();
      c.close();
    }, 30_000);
  }

  it('a real revocation still closes 4403 revoked', async () => {
    const app = await startApp({ AUTHZ_RECHECK_SECONDS: '1' });
    const key = 'u/f6r/index.html';
    share(key, 'ana');
    const a = await join(app, key, 'sid=ana');
    expect(await joined(a)).toBeNull();
    core.rulesByCookie.set(`sid=ana|${key}`, { allowed: false, reason: 'not-in-acl' });
    expect(await Promise.race([a.closed, sleep(8000).then(() => -1)])).toBe(4403);
    expect(a.notices.map((n) => n.kind)).toContain('revoked');
  });
});
