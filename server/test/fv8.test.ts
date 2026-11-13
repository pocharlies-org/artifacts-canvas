/**
 * Regressions of the eighth independent verification (fv8), through the real server. The numbers
 * in the comments are the verifier's (before); its PoCs are server/test/fv8/*.
 *   P1  inserts that cut live items were not counted (only delete ranges were): one 3.97 MB update
 *       of 200 000 inserts between the points of two strokes was estimated at 4.28 MiB (< 5 MiB) and
 *       stored at 7.5 MiB, past what a user's share holds, and a stored room past a share was refused
 *       4413 to EVERYONE, for good (also after a restart). Every cut is counted now (origins, right
 *       origins, structs the room has, delete ranges, the update's own items), at SPLIT_COST_BYTES;
 *       an update may make MAX_SPLITS_PER_MESSAGE cuts; and a room the server stored always loads.
 *   P2  the same update held the event loop 53-65 s (Yjs copies an item on every cut), and 4 000
 *       forged items whose right origin is far away (28 KB, no cut) held it 40 s (placement scans):
 *       both are bounded in the guard (MAX_APPLY_MS) and the apply is charged to the CPU budgets
 *       before it runs.
 *   U2  the principal whose join loaded a room kept paying for it after it left while others kept
 *       it open: an honest user could not open a second room (1013 forever). Its load charge now
 *       moves to who keeps the room open, within their shares.
 * The live variants (the real core, the chart's memory limit) are e2e-system/adversarial-fv8.spec.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { pino } from 'pino';
import { SCAN_WORK_NS, SPLIT_WORK_NS, applyEstimateMs, loadConfig, roomCost } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { Metrics } from '../src/metrics.js';
import { Room } from '../src/room.js';
import { ledgerBound } from '../src/rooms.js';
import { SPLIT_COST_BYTES, applyGuarded, checkClientUpdate, encodeIntegratedState } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';
import { insertsBetween, itemAt, knownCuts, syncUpdate } from './fv8/craft.js';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 29600;
const apps: App[] = [];
const silent = createLogger('silent');
const MiB = 1024 * 1024;
const mib = (b: number) => Math.round((b / MiB) * 100) / 100;
/** the chart's sizing: 2 GiB pod, --max-old-space-size=1536 -> 872 MiB of loaded rooms */
const CHART = { ROOM_MEMORY_BUDGET_BYTES: String(872 * MiB) };
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
const cfgOf = (app: App) => (app.manager as unknown as { deps: { cfg: ReturnType<typeof loadConfig> } }).deps.cfg;
async function rejected(app: App, reason: string): Promise<number> {
  const m = await app.metrics.wsRejected.get();
  return m.values.filter((v) => v.labels.reason === reason).reduce((a, v) => a + v.value, 0);
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

/** `strokes` strokes of `len` points (one item each, with a right origin: the verifier's construction) written by `d`. */
function strokes(d: Y.Doc, n: number, len: number, prefix = 'm'): Y.Array<number>[] {
  const out: Y.Array<number>[] = [];
  d.transact(() => {
    for (let s = 0; s < n; s++) {
      const m = mapOf(draw(`${prefix}${s}`, s));
      const arr = new Y.Array<number>();
      m.set('points', arr);
      d.getMap('shapes').set(`${prefix}${s}`, m);
      out.push(arr);
    }
  });
  for (const arr of out) {
    d.transact(() => {
      arr.insert(0, [1]);
      arr.insert(0, Array.from({ length: len }, (_, i) => i % 100));
    });
  }
  return out;
}
const pointsOf = (doc: Y.Doc, id: string) => ((doc.getMap('shapes').get(id) as Y.Map<unknown> | undefined)?.get('points') as Y.Array<number> | undefined);

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv8-static-'));
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
describe('fv8 P1: every cut of an item counts; a room the server stored always loads', () => {
  /** a content doc holding client 1000's stroke of `len` points, and the item of its points */
  function roomWithStroke(len: number) {
    const a = new Y.Doc();
    a.clientID = 1000;
    strokes(a, 1, len, 's');
    const room = materializeContent(new Y.Doc());
    applyGuarded(room, Y.encodeStateAsUpdate(a), { identity: { id: 'a' } });
    return { a, room, item: itemAt(pointsOf(room, 's0')!, 0) };
  }

  it('the guard counts every kind of cut, once per boundary: origins, right origins, structs the room has, delete ranges, the update\'s own new items', () => {
    // inserts between two points: origin and right origin name the same boundary (one cut each)
    let r = roomWithStroke(200);
    expect(checkClientUpdate(r.room, insertsBetween([{ into: r.item, count: 50 }], 2000, 0))).toMatchObject({ bad: null, grows: true, splits: 50 });
    // two inserts at the same boundary, from either side: one cut
    r = roomWithStroke(200);
    const both = Y.mergeUpdates([insertsBetween([{ into: r.item, count: 1, at: 9 }], 2000, 0), insertsBetween([{ into: r.item, count: 1, at: 9 }], 2001, 0)]);
    expect(checkClientUpdate(r.room, both).splits).toBe(1);
    // delete every other point: two cuts per deleted point (fv5 L-2 counted these already)
    r = roomWithStroke(201);
    const sv = Y.encodeStateVector(r.a);
    r.a.clientID = 2000;
    r.a.transact(() => {
      for (let i = 199; i >= 1; i -= 2) pointsOf(r.a, 's0')!.delete(i, 1);
    });
    expect(checkClientUpdate(r.room, Y.encodeStateAsUpdate(r.a, sv)).splits).toBe(200);
    // structs the room has, re-sent with origins inside the stroke: Yjs cuts it to resolve them
    r = roomWithStroke(200);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(r.room));
    b.clientID = 1500;
    for (let i = 0; i < 30; i++) b.transact(() => pointsOf(b, 's0')!.insert(pointsOf(b, 's0')!.length, [9]));
    applyGuarded(r.room, Y.encodeStateAsUpdate(b, Y.encodeStateVector(r.room)), { identity: { id: 'b' } });
    expect(checkClientUpdate(r.room, knownCuts(r.item, 1500, 0, 30))).toMatchObject({ bad: null, grows: true, splits: 30 });
    // the update's own new run, cut by its own inserts (two updates merged into one)
    r = roomWithStroke(1);
    const u1 = (() => {
      const sv1 = Y.encodeStateVector(r.a);
      r.a.clientID = 2000;
      r.a.transact(() => pointsOf(r.a, 's0')!.insert(1, Array.from({ length: 101 }, () => 5)));
      return Y.encodeStateAsUpdate(r.a, sv1);
    })();
    const u2 = (() => {
      const sv2 = Y.encodeStateVector(r.a);
      r.a.clientID = 2001;
      r.a.transact(() => {
        for (let i = 100; i >= 1; i -= 10) pointsOf(r.a, 's0')!.insert(1 + i, [7]);
      });
      return Y.encodeStateAsUpdate(r.a, sv2);
    })();
    expect(checkClientUpdate(r.room, Y.mergeUpdates([u1, u2])).splits).toBe(10);
    // an update that only appends (an honest stroke growing) cuts nothing
    r = roomWithStroke(200);
    const sv3 = Y.encodeStateVector(r.a);
    r.a.clientID = 2000;
    r.a.transact(() => pointsOf(r.a, 's0')!.push([1, 2, 3]));
    expect(checkClientUpdate(r.room, Y.encodeStateAsUpdate(r.a, sv3))).toMatchObject({ bad: null, splits: 0, scanWork: 0 });
  });

  it('the encoded room grows by at most the update plus SPLIT_COST_BYTES per cut, for every kind of cut (worst measured: 22 B with 5-byte client ids and clocks)', () => {
    const worst: Record<string, number> = {};
    const check = (name: string, room: Y.Doc, update: Uint8Array) => {
      const before = encodeIntegratedState(room).byteLength;
      const chk = checkClientUpdate(room, update);
      expect(chk.bad).toBeNull();
      expect(chk.splits).toBeGreaterThan(0);
      expect(applyGuarded(room, update, { identity: { id: 'x' } })).toEqual({ threw: null, droppedPending: false });
      const growth = encodeIntegratedState(room).byteLength - before;
      worst[name] = +((growth - update.byteLength) / chk.splits).toFixed(2);
      expect(growth).toBeLessThanOrEqual(update.byteLength + chk.splits * SPLIT_COST_BYTES);
    };
    for (const big of [false, true]) {
      // big: client ids of 5 bytes and clocks past 2^28 (a GC run first: an update the guard accepts)
      const c = big ? 4294967000 : 1000;
      const mk = () => {
        const a = new Y.Doc();
        const room = materializeContent(new Y.Doc());
        if (big) {
          const gc = new Uint8Array([1, 1, ...varuint(c), 0, 0, ...varuint(2 ** 28 + 7), 0]);
          Y.applyUpdate(a, gc);
          Y.applyUpdate(room, gc);
        }
        a.clientID = c;
        strokes(a, 1, 1001, 's');
        const t = mapOf(note('n1'));
        t.set('text', new Y.Text());
        a.transact(() => a.getMap('shapes').set('n1', t));
        a.transact(() => (t.get('text') as Y.Text).insert(0, 'a'.repeat(1001) + 'z'));
        applyGuarded(room, Y.encodeStateAsUpdate(a, Y.encodeStateVector(room)), { identity: { id: 'a' } });
        return { a, room };
      };
      const edit = (a: Y.Doc, fn: () => void) => {
        const sv = Y.encodeStateVector(a);
        a.clientID = c + 1;
        a.transact(fn);
        return Y.encodeStateAsUpdate(a, sv);
      };
      let x = mk();
      check(`points${big ? '-big' : ''}`, x.room, edit(x.a, () => { for (let i = 1000; i >= 1; i--) pointsOf(x.a, 's0')!.insert(i, [7]); }));
      x = mk();
      const txt = () => (x.a.getMap('shapes').get('n1') as Y.Map<unknown>).get('text') as Y.Text;
      check(`text${big ? '-big' : ''}`, x.room, edit(x.a, () => { for (let i = 1000; i >= 1; i--) txt().insert(i, 'x'); }));
      x = mk();
      check(`delete${big ? '-big' : ''}`, x.room, edit(x.a, () => { for (let i = 999; i >= 1; i -= 2) pointsOf(x.a, 's0')!.delete(i, 1); }));
    }
    console.log(`[fv8 P1 bytes per cut] ${JSON.stringify(worst)} (SPLIT_COST_BYTES ${SPLIT_COST_BYTES})`);
  });

  it('below the cut cap, cuts count against the size cap: an update the old estimate let through (the stored room past the cap) is refused 4413, nothing applied', async () => {
    // offline dry run of the same construction to size the cap between the old estimate and
    // what the room really becomes (the verifier: estimated 4.28 MiB, stored 7.5 MiB)
    const N = 1000;
    const dry = new Y.Doc();
    dry.clientID = 4294967000;
    strokes(dry, 1, 2 * N + 1);
    const dryRoom = materializeContent(new Y.Doc());
    applyGuarded(dryRoom, Y.encodeStateAsUpdate(dry), { identity: { id: 'm' } });
    const dryAttack = insertsBetween([{ into: itemAt(pointsOf(dryRoom, 'm0')!, 0), count: N, at: 0 }], 4294967001, 0);
    const before = encodeIntegratedState(dryRoom).byteLength;
    applyGuarded(dryRoom, dryAttack, { identity: { id: 'm' } });
    const after = encodeIntegratedState(dryRoom).byteLength;
    const ledgerRoom = 4096; // the ledger of a one-shape room, generously
    const cap = Math.round(before + ledgerRoom + dryAttack.byteLength + ledgerBound(1, 2, 16) + (after - before - dryAttack.byteLength) / 2);
    const app = await startApp({ MAX_DOC_BYTES: String(cap), ANON_MAX_DOC_BYTES: String(cap), MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/p1small/index.html';
    share(key, 'mallory');
    const m = await join(app, key, 'sid=mallory');
    expect(m.closeCode).toBeNull();
    m.doc.clientID = 4294967000;
    strokes(m.doc, 1, 2 * N + 1);
    const room = app.manager.get(key)!;
    await waitFor(() => pointsOf(room.doc, 'm0')?.length === 2 * N + 2, 5000, 'stroke');
    await room.flush();
    const attack = insertsBetween([{ into: itemAt(pointsOf(m.doc, 'm0')!, 0), count: N, at: 0 }], 4294967001, 0);
    // what the server estimated before fv8 (no cut counted): under the cap
    const oldEstimate = room.approxBytes + room.ledgerApproxBytes + attack.byteLength + ledgerBound(1, 2, 16);
    expect(oldEstimate).toBeLessThan(cfgOf(app).maxDocBytes);
    // what the room would have become: past the cap
    expect(room.approxBytes + after - before + room.ledgerApproxBytes).toBeGreaterThan(cfgOf(app).maxDocBytes);
    const chk = checkClientUpdate(room.doc, attack);
    expect(chk.splits).toBe(N);
    m.sendRaw(syncUpdate(attack));
    expect(await m.closed).toBe(4413);
    expect(m.notices.map((n) => n.kind)).toContain('too-large');
    expect(await rejected(app, 'doc_too_large')).toBe(1);
    expect(pointsOf(room.doc, 'm0')!.length).toBe(2 * N + 2);
    await room.flush();
    expect(room.bytes).toBeLessThanOrEqual(cfgOf(app).maxDocBytes);
    console.log(`[fv8 P1 cap] cap ${cap} B; old estimate ${oldEstimate} B; would have stored ${room.approxBytes + after - before + room.ledgerApproxBytes} B; new estimate ${room.bytes + attack.byteLength + N * SPLIT_COST_BYTES} B: refused`);
  });

  it('verifier P1 (chart sizing): one ACL writer\'s 3.97 MB update of 200 000 cuts is refused 4413 too-large, nothing applied; everyone loads the room, also after a restart', async () => {
    const key = 'u/team/index.html';
    share(key, 'bob', 'alice', 'mallory');
    const app = await startApp(CHART);
    const bob = await join(app, key, 'sid=bob');
    const alice = await join(app, key, 'sid=alice');
    bob.doc.transact(() => { for (let i = 0; i < 40; i++) bob.doc.getMap('shapes').set(`bob${i}`, mapOf(geo(`bob${i}`, i))); });
    alice.doc.transact(() => { for (let i = 0; i < 40; i++) alice.doc.getMap('shapes').set(`alice${i}`, mapOf(geo(`alice${i}`, i))); });
    const room = app.manager.get(key)!;
    await waitFor(() => room.doc.getMap('shapes').size === 80, 5000, 'honest');
    const m = await join(app, key, 'sid=mallory');
    const N = 100_000;
    m.doc.clientID = 4294967000;
    strokes(m.doc, 2, N + 1);
    await waitFor(() => pointsOf(room.doc, 'm1')?.length === N + 2 || m.closeCode !== null, 20_000, 'base');
    await room.flush();
    const bytesBefore = room.bytes;
    const attack = insertsBetween([0, 1].map((s) => ({ into: itemAt(pointsOf(m.doc, `m${s}`)!, 0), count: N })), 4294967001, 0);
    expect(attack.byteLength).toBe(3967169);
    const t0 = performance.now();
    m.sendRaw(syncUpdate(attack));
    expect(await m.closed).toBe(4413);
    const ms = Math.round(performance.now() - t0);
    expect(m.notices.map((n) => n.kind)).toContain('too-large');
    expect(await rejected(app, 'too_many_splits')).toBe(1);
    expect(pointsOf(room.doc, 'm0')!.length).toBe(N + 2);
    expect(pointsOf(room.doc, 'm1')!.length).toBe(N + 2);
    await room.flush();
    expect(room.bytes).toBe(bytesBefore);
    // everyone leaves; the room is saved and evicted; it loads for everyone, also after a restart
    for (const c of [bob, alice]) c.close();
    await waitFor(() => !app.manager.get(key), 20_000, 'evicted');
    const codes: Record<string, number | null> = {};
    for (const who of ['bob', 'alice', 'mallory']) {
      const c = await join(app, key, `sid=${who}`);
      codes[who] = c.closeCode;
      c.close();
    }
    const app2 = await startApp(CHART);
    const b2 = await join(app2, key, 'sid=bob');
    codes.bobAfterRestart = b2.closeCode;
    expect(b2.doc.getMap('shapes').size).toBe(82);
    b2.close();
    console.log(`[fv8 P1] ${JSON.stringify({ updateBytes: attack.byteLength, refusedAfterMs: ms, storedMiB: mib(bytesBefore), rejoin: codes })}`);
    expect(codes).toEqual({ bob: null, alice: null, mallory: null, bobAfterRestart: null });
  }, 120_000);

  it('verifier P1b: one anonymous visitor\'s 40 000-cut update on a public canvas is refused; every anonymous visitor still loads it', async () => {
    const app = await startApp(CHART);
    const key = 'pub/talk/index.html';
    core.rules.set(key, allowAnon());
    const v = await join(app, key);
    v.doc.transact(() => v.doc.getMap('shapes').set('v1', mapOf(geo('v1', 1))));
    const room = app.manager.get(key)!;
    await waitFor(() => room.doc.getMap('shapes').has('v1'), 5000, 'honest');
    const a = await join(app, key);
    const N = 20_000;
    a.doc.clientID = 4294967000;
    strokes(a.doc, 2, N + 1, 'a');
    await waitFor(() => pointsOf(room.doc, 'a1')?.length === N + 2 || a.closeCode !== null, 20_000, 'base');
    expect(a.closeCode).toBeNull();
    const attack = insertsBetween([0, 1].map((s) => ({ into: itemAt(pointsOf(a.doc, `a${s}`)!, 0), count: N })), 4294967001, 0);
    a.sendRaw(syncUpdate(attack));
    expect(await a.closed).toBe(4413);
    expect(await rejected(app, 'too_many_splits')).toBe(1);
    for (const c of [v]) c.ws.terminate();
    await waitFor(() => !app.manager.get(key), 20_000, 'evicted');
    const anon1 = await join(app, key);
    const anon2 = await join(app, key);
    expect([anon1.closeCode, anon2.closeCode]).toEqual([null, null]);
    anon1.close();
    anon2.close();
  }, 120_000);

  it('a stored room past the cap and past a share (stored before fv8) loads for its owner and for anonymous visitors, each charged one share at most, with a warning; growth stays refused 4413, deletes pass', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: 'warn' }, new Writable({ write(chunk, _e, cb) { for (const l of String(chunk).split('\n')) if (l) lines.push(JSON.parse(l)); cb(); } }));
    const big = 'u/big/index.html';
    const pubKey = 'pub/big/index.html';
    // a 7 MiB user room (the verifier's 7.5) and a 1.9 MiB public one (anonymous cap 1.25 MiB)
    const userBytes = await seedImage(big, Math.floor(7 * MiB));
    const pubBytes = await seedImage(pubKey, Math.floor(1.9 * MiB));
    share(big, 'owner');
    core.rules.set(pubKey, allowAnon());
    const app = await startApp(CHART, logger as never);
    const cfg = cfgOf(app);
    expect(roomCost(cfg, userBytes)).toBeGreaterThan(app.manager.share(false));
    expect(roomCost(cfg, pubBytes)).toBeGreaterThan(app.manager.share(true));
    const o = await join(app, big, 'sid=owner');
    expect(o.closeCode).toBeNull();
    expect(o.doc.getMap('assets').has('a1')).toBe(true);
    expect(app.manager.held('u:owner@corp')).toBeCloseTo(app.manager.share(false), 0);
    const v = await join(app, pubKey);
    expect(v.closeCode).toBeNull();
    const vp = [...app.manager.get(pubKey)!.conns.values()][0].principal;
    expect(app.manager.held(vp)).toBeCloseTo(app.manager.share(true), 0);
    expect(lines.filter((l) => String(l.msg).startsWith('stored room costs more than a share')).length).toBe(2);
    // a second anonymous visitor joins the loaded room
    const v2 = await join(app, pubKey);
    expect(v2.closeCode).toBeNull();
    // growth: refused (the room is past the size cap); a delete passes and shrinks it
    o.doc.getMap('shapes').set('more', mapOf(geo('more', 1)));
    expect(await o.closed).toBe(4413);
    const o2 = await join(app, big, 'sid=owner');
    o2.doc.transact(() => {
      o2.doc.getMap('shapes').delete('img');
      o2.doc.getMap('assets').delete('a1');
    });
    const room = app.manager.get(big)!;
    await waitFor(() => !room.doc.getMap('assets').has('a1'), 5000, 'deleted');
    expect(o2.closeCode).toBeNull();
    await room.flush();
    expect(room.bytes).toBeLessThan(64 * 1024);
    for (const c of [o2, v, v2]) c.close();
  }, 60_000);
});

/** A stored room of ~`target` encoded bytes: one image asset (a data URL) and its shape, stamped by the real Room. */
async function seedImage(key: string, target: number): Promise<number> {
  const cfg = loadConfig(BASE_ENV);
  const tmp = new MemoryCanvasObjectStore();
  const room = new Room('seed', { cfg, store: tmp, log: silent, metrics: new Metrics(), onEmpty: () => undefined });
  const d = new Y.Doc();
  d.transact(() => {
    d.getMap('assets').set('a1', 'data:image/png;base64,' + 'A'.repeat(target - 2048));
    d.getMap('shapes').set('img', mapOf({ id: 'img', type: 'image', assetId: 'a1', x: 0, y: 0, w: 600, h: 400, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
  });
  Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(d), { identity: { id: 'bob@corp', name: 'bob', anonymous: false, color: '#000' } });
  room.markDirty();
  await room.save();
  const c = tmp.objects.get(room.objectKey)!.body;
  const l = tmp.objects.get(room.ledgerKey)!.body;
  await store.put(`_plugins/canvas/${key}.ydoc`, c);
  await store.put(`_plugins/canvas/${key}.ydoc.ledger`, l);
  room.dispose();
  return c.byteLength + l.byteLength;
}

function varuint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

// ---------------------------------------------------------------------------------------------
describe('fv8 P2: one update cannot hold the server', () => {
  it('the 3.97 MB update is refused in the guard; honest edits in another room keep p95 < 100 ms (before: the event loop stood 53-65 s)', async () => {
    const app = await startApp({ ...CHART, MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const A = 'u/attack/index.html';
    const B = 'u/honest/index.html';
    share(A, 'mallory');
    share(B, 'bob');
    const m = await join(app, A, 'sid=mallory');
    const N = 100_000;
    m.doc.clientID = 4294967000;
    strokes(m.doc, 2, N + 1);
    const ra = app.manager.get(A)!;
    await waitFor(() => pointsOf(ra.doc, 'm1')?.length === N + 2, 20_000, 'base');
    const bw = await join(app, B, 'sid=bob');
    const br = await join(app, B, 'sid=bob');
    const lat: number[] = [];
    let stop = false;
    const honest = (async () => {
      for (let i = 0; !stop; i++) {
        const t = performance.now();
        bw.doc.getMap('shapes').set(`h${i}`, mapOf(geo(`h${i}`, i)));
        await waitFor(() => br.doc.getMap('shapes').has(`h${i}`), 30_000, 'honest edit');
        lat.push(performance.now() - t);
        await sleep(40);
      }
    })();
    await sleep(500);
    const attack = insertsBetween([0, 1].map((s) => ({ into: itemAt(pointsOf(m.doc, `m${s}`)!, 0), count: N })), 4294967001, 0);
    const t0 = performance.now();
    m.sendRaw(syncUpdate(attack));
    expect(await m.closed).toBe(4413);
    const refusedMs = performance.now() - t0;
    await sleep(1500);
    stop = true;
    await honest;
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    console.log(`[fv8 P2] refused after ${Math.round(refusedMs)} ms; honest edits in another room: n ${lat.length}, p95 ${Math.round(p95)} ms, max ${Math.round(lat[lat.length - 1])} ms`);
    expect(refusedMs).toBeLessThan(2000);
    expect(p95).toBeLessThan(100);
    expect([bw.closeCode, br.closeCode]).toEqual([null, null]);
    for (const c of [bw, br]) c.close();
  }, 120_000);

  it('placement: 2 000 forged items whose right origin is far away (14 KB, no cut) are refused 4413 (before: 20 s of Yjs); honest edits count no scan', async () => {
    const app = await startApp({ MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/scan/index.html';
    share(key, 'mallory');
    const m = await join(app, key, 'sid=mallory');
    const room = app.manager.get(key)!;
    // a points list of 50 000 separate items: two client ids of mallory's, alternating
    m.doc.transact(() => {
      const sm = mapOf(draw('s'));
      sm.set('points', new Y.Array<number>());
      m.doc.getMap('shapes').set('s', sm);
    });
    await waitFor(() => !!pointsOf(room.doc, 's'), 5000, 'stroke');
    const pts = pointsOf(m.doc, 's')!;
    const helper = new Y.Doc();
    Y.applyUpdate(helper, Y.encodeStateAsUpdate(m.doc));
    const hp = pointsOf(helper, 's')!;
    for (let b = 0; b < 50; b++) {
      const sv = Y.encodeStateVector(helper);
      for (let i = 0; i < 1000; i++) {
        helper.clientID = 3000 + (i % 2);
        hp.push([i % 100]);
      }
      m.sendRaw(syncUpdate(Y.encodeStateAsUpdate(helper, sv)));
    }
    await waitFor(() => pointsOf(room.doc, 's')!.length === 50_000 || m.closeCode !== null, 20_000, 'chain');
    expect(m.closeCode).toBeNull();
    Y.applyUpdate(m.doc, Y.encodeStateAsUpdate(helper, Y.encodeStateVector(m.doc)), 'server');
    const first = itemAt(pts, 0);
    // 2 000 items of a new client, all after the first point, with no right origin
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint(e, 2000);
    encoding.writeVarUint(e, 5000);
    encoding.writeVarUint(e, 0);
    for (let i = 0; i < 2000; i++) {
      encoding.writeUint8(e, 8 | 0x80);
      encoding.writeVarUint(e, first.id.client);
      encoding.writeVarUint(e, first.id.clock);
      encoding.writeVarUint(e, 1);
      encoding.writeAny(e, 5);
    }
    encoding.writeVarUint(e, 0);
    const forged = encoding.toUint8Array(e);
    const chk = checkClientUpdate(room.doc, forged);
    expect(chk.splits).toBe(0);
    expect(applyEstimateMs(0, chk.splitWork, chk.scanWork)).toBeGreaterThan(cfgOf(app).maxApplyMs * 100);
    const t0 = performance.now();
    m.sendRaw(syncUpdate(forged));
    expect(await m.closed).toBe(4413);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(await rejected(app, 'too_many_splits')).toBe(1);
    expect(pointsOf(room.doc, 's')!.length).toBe(50_000);
    // honest: typing into a text in the middle, a growing stroke, a move: no scan, no cut beyond one
    const b = materializeContent(new Y.Doc());
    const a = new Y.Doc();
    a.clientID = 10;
    const t = mapOf(note('n'));
    t.set('text', new Y.Text());
    a.transact(() => a.getMap('shapes').set('n', t));
    a.transact(() => (t.get('text') as Y.Text).insert(0, 'hello world'));
    applyGuarded(b, Y.encodeStateAsUpdate(a), { identity: { id: 'a' } });
    const sv = Y.encodeStateVector(a);
    a.clientID = 11;
    a.transact(() => (t.get('text') as Y.Text).insert(5, ' there'));
    a.transact(() => (a.getMap('shapes').get('n') as Y.Map<unknown>).set('x', 50));
    expect(checkClientUpdate(b, Y.encodeStateAsUpdate(a, sv))).toMatchObject({ bad: null, splits: 1, scanWork: 0 });
  }, 60_000);

  it('the apply is charged before it runs: an update whose estimate the sender\'s budget cannot cover is refused 1013 busy, nothing applied; covered, it is applied and charged once', async () => {
    const app = await startApp({ MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const key = 'u/pre/index.html';
    share(key, 'mallory');
    const m = await join(app, key, 'sid=mallory');
    const room = app.manager.get(key)!;
    const conn = [...room.conns.values()][0];
    const payload = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024);
    const estimate = applyEstimateMs(payload.length, 0, 0);
    expect(estimate).toBeGreaterThan(50);
    // covered: applied, the budget charged what it took (not the estimate twice)
    const level0 = conn.cpu.level();
    m.doc.getMap('assets').set('img1', payload);
    await waitFor(() => room.doc.getMap('assets').has('img1') || m.closeCode !== null, 5000, 'applied');
    expect(m.closeCode).toBeNull();
    expect(level0 - conn.cpu.level()).toBeLessThan(estimate + 200);
    // the principal's budget is nearly used up: the next one is refused before it runs
    conn.cpu.charge(conn.cpu.level() - 5);
    m.doc.getMap('assets').set('img2', payload);
    expect(await m.closed).toBe(1013);
    expect(m.notices.map((n) => n.kind)).toContain('busy');
    expect(await rejected(app, 'cpu_precharge')).toBe(1);
    expect(room.doc.getMap('assets').has('img2')).toBe(false);
  });

  it('the caps: MAX_SPLITS_PER_MESSAGE (5 000) counts cuts; MAX_APPLY_MS (50) bounds their estimated work, and the most short cuts it lets through apply within it', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.maxSplitsPerMessage).toBe(5000);
    expect(cfg.maxApplyMs).toBe(50);
    const a = new Y.Doc();
    a.clientID = 1000;
    strokes(a, 51, 100, 'q');
    const room = materializeContent(new Y.Doc());
    applyGuarded(room, Y.encodeStateAsUpdate(a), { identity: { id: 'a' } });
    const items = Array.from({ length: 51 }, (_, s) => itemAt(pointsOf(room, `q${s}`)!, 0));
    const cuts = (n: number) => insertsBetween(items.map((into, i) => ({ into, count: Math.max(0, Math.min(99, n - 99 * i)) })).filter((t) => t.count > 0), 2000, 0);
    // the count: 5 000 pass, 5 001 do not
    expect(checkClientUpdate(room, cuts(5000), { maxSplits: 5000 })).toMatchObject({ bad: null, splits: 5000 });
    expect(checkClientUpdate(room, cuts(5001), { maxSplits: 5000 }).bad).toBe('splits');
    // the work: with the server's caps, 4 000 short cuts pass (estimated under 50 ms) and apply
    // within it on x86 (a generous bound here for slow CI hosts); 5 000 are over the work cap
    const opts = { maxSplits: cfg.maxSplitsPerMessage, maxSplitWork: (cfg.maxApplyMs * 1e6) / SPLIT_WORK_NS, maxScanWork: (cfg.maxApplyMs * 1e6) / SCAN_WORK_NS };
    const ok = checkClientUpdate(room, cuts(4000), opts);
    expect(ok).toMatchObject({ bad: null, splits: 4000 });
    const est = applyEstimateMs(0, ok.splitWork, ok.scanWork);
    expect(est).toBeLessThanOrEqual(cfg.maxApplyMs);
    const t0 = performance.now();
    applyGuarded(materializeFrom(room), cuts(4000), { identity: { id: 'x' } });
    const took = performance.now() - t0;
    console.log(`[fv8 P2 cap] 4 000 cuts: estimated ${est.toFixed(1)} ms, applied in ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(250);
    expect(checkClientUpdate(room, cuts(5000), opts).bad).toBe('splits');
  });
});

function materializeFrom(doc: Y.Doc): Y.Doc {
  const d = materializeContent(new Y.Doc());
  Y.applyUpdate(d, Y.encodeStateAsUpdate(doc));
  return d;
}

// ---------------------------------------------------------------------------------------------
describe('fv8 U2: a loader that left no longer pays for what others keep open', () => {
  it('verifier U2 (chart sizing): ana opens a second room after leaving her first one to carl (before: 1013 until it was evicted); an anonymous visitor too', async () => {
    const app = await startApp(CHART);
    const out: Record<string, unknown> = { userShareMiB: mib(app.manager.share(false)), anonShareMiB: mib(app.manager.share(true)) };
    const R1 = 'u/meeting1/index.html';
    const R2 = 'u/meeting2/index.html';
    for (const k of [R1, R2]) share(k, 'ana', 'carl');
    out.r1MiB = mib(await seedImage(R1, Math.floor(4.9 * MiB)));
    out.r2MiB = mib(await seedImage(R2, Math.floor(1.8 * MiB)));
    const a1 = await join(app, R1, 'sid=ana');
    const c1 = await join(app, R1, 'sid=carl');
    expect([a1.closeCode, c1.closeCode]).toEqual([null, null]);
    const r1cost = app.manager.get(R1)!.cost;
    expect(app.manager.held('u:ana@corp')).toBeCloseTo(r1cost, 0);
    a1.ws.terminate();
    await waitFor(() => app.manager.get(R1)!.principals.size === 1, 15_000, 'ana left');
    out.anaHeldAfterLeavingMiB = mib(app.manager.held('u:ana@corp'));
    out.carlHeldMiB = mib(app.manager.held('u:carl@corp'));
    expect(app.manager.held('u:ana@corp')).toBe(0);
    expect(app.manager.held('u:carl@corp')).toBeCloseTo(r1cost, 0);
    const a2 = await join(app, R2, 'sid=ana');
    out.anaOpensR2 = a2.closeCode;
    expect(a2.closeCode).toBeNull();
    for (const c of [c1, a2]) c.ws.terminate();
    await waitFor(() => !app.manager.get(R1) && !app.manager.get(R2), 20_000, 'evicted');
    // anonymous: V opens a 1 MiB public canvas, W joins, V leaves; V opens a 0.7 MiB one
    const P1 = 'pub/a/index.html';
    const P2 = 'pub/b/index.html';
    core.rules.set(P1, allowAnon());
    core.rules.set(P2, allowAnon());
    await seedImage(P1, Math.floor(1.0 * MiB));
    await seedImage(P2, Math.floor(0.7 * MiB));
    const v1 = await join(app, P1);
    const vCookie = (v1.setCookie ?? '').split(';')[0];
    const w1 = await join(app, P1);
    v1.ws.terminate();
    await waitFor(() => app.manager.get(P1)!.principals.size === 1, 15_000, 'visitor left');
    const v2 = await join(app, P2, vCookie);
    out.visitorOpensP2 = v2.closeCode;
    console.log(`[fv8 U2] ${JSON.stringify(out)}`);
    expect(v2.closeCode).toBeNull();
    for (const c of [w1, v2]) c.close();
  }, 60_000);

  it('the handover stays within the takers\' shares and never moves what a principal wrote (fv7 F1 stays closed): a writer that leaves keeps paying for its growth; a visitor takes at most its share', async () => {
    const app = await startApp({ ROOM_MEMORY_BUDGET_BYTES: String(256 * MiB), MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000' });
    const mgr = app.manager;
    const key = 'pub/hand/index.html';
    core.rules.set(key, allowAnon());
    share(key, 'mallory');
    // a stored room that costs more than an anonymous visitor's share (256 MiB / 12 = 21 MiB)
    const bytes = await seedImage(key, Math.floor(0.7 * MiB));
    const cost = roomCost(cfgOf(app), bytes);
    expect(cost).toBeGreaterThan(mgr.share(true));
    const m = await join(app, key, 'sid=mallory');
    expect(m.closeCode).toBeNull();
    // mallory writes (growth, hers alone) and an anonymous visitor reads along
    m.doc.transact(() => { for (let i = 0; i < 200; i++) m.doc.getMap('shapes').set(`g${i}`, mapOf(geo(`g${i}`, i))); });
    const room = mgr.get(key)!;
    await waitFor(() => room.doc.getMap('shapes').size === 201, 5000, 'written');
    await room.flush();
    const wrote = mgr.held('u:mallory@corp') - room.loadChargeOf('u:mallory@corp');
    expect(wrote).toBeGreaterThan(0);
    const v = await join(app, key);
    const vp = [...room.conns.values()].find((c) => c.identity.anonymous)!.principal;
    m.close();
    await waitFor(() => room.principals.size === 1, 5000, 'mallory left');
    // the visitor took the load charge up to its share; mallory keeps the rest and what she wrote
    expect(mgr.held(vp)).toBeLessThanOrEqual(mgr.share(true) + 1);
    expect(mgr.held(vp)).toBeGreaterThan(mgr.share(true) * 0.99);
    expect(mgr.held('u:mallory@corp')).toBeGreaterThanOrEqual(wrote - 1);
    expect(mgr.held(vp) + mgr.held('u:mallory@corp')).toBeCloseTo(room.cost, 0);
    v.close();
    await waitFor(() => !mgr.get(key), 5000, 'evicted');
    expect(mgr.held('u:mallory@corp')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv8 U1: the editor knows the room cap', () => {
  it('the wrapper page tells the editor its size cap (users MAX_DOC_BYTES, anonymous visitors ANON_MAX_DOC_BYTES): it says the canvas is full before the server would refuse', async () => {
    core.rules.set('u/w/index.html', allowUser('ana@corp', 'Ana'));
    core.rules.set('pub/w/index.html', allowAnon());
    const app = await startApp();
    const cfg = cfgOf(app);
    const page = async (key: string, cookie?: string) => (await (await fetch(`http://127.0.0.1:${port(app)}/_canvas/${key}`, { headers: cookie ? { cookie } : {} })).text());
    expect(await page('u/w/index.html', 'sid=1')).toContain(`"maxDocBytes":${cfg.maxDocBytes}`);
    // the anonymous caps (before: an anonymous visitor's page carried the signed-in image cap)
    expect(await page('pub/w/index.html')).toContain(`"maxImageBytes":${cfg.anonMaxImageBytes},"maxDocBytes":${cfg.anonMaxDocBytes}`);
  });
});
