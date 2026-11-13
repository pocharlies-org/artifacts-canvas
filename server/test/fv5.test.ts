/**
 * Regressions of the fifth independent verification (fv5), through the real server. Each case
 * is one of the verifier's PoCs (poc/p1..p12 and the honest-edit fuzz of the report) with the
 * expectation turned around: the attack is bounded or refused, and honest clients keep working.
 * The numbers in the comments are the verifier's (before) and this suite's (after) measurements.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { clientIp } from '../src/ws.js';
import { TAIL_MAX_MESSAGES, limitBuffered } from '../src/room.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, expectClose, waitFor, roomDocs, roomOrStored } from './helpers/yclient.js';
import { checkClientUpdate, deleteSetCanonical, applyGuarded, shapeValueProblem } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import { MAX_POINTS, MAX_TEXT_LENGTH } from '@pocharlies/artifacts-canvas-shared/model';
import { CanvasDoc, readShape } from '../../client/src/model/doc';
import { Connection } from '../../client/src/collab/connection';
import { runHonestFuzz } from './fuzz/honest-fuzz.js';
import { seededRoom, copyRoom } from './fuzz/guard-fuzz.js';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 25600;
const apps: App[] = [];
const silent = createLogger('silent');

/**
 * The size caps these regressions were written for (fv5: rooms of 20 MiB, messages of 8 MiB):
 * since fv7 F1 the defaults are lower (what a third of the chart's 2 GiB budget holds) and the
 * caps are clamped to the memory budget's share, so the tests set them, with a budget whose share
 * holds them (the budget is only an estimate: nothing here loads that much).
 */
const FV5_LIMITS = {
  ROOM_MEMORY_BUDGET_BYTES: String(4 * 1024 ** 3),
  MAX_DOC_BYTES: String(20 * 1024 * 1024), ANON_MAX_DOC_BYTES: String(5 * 1024 * 1024),
  MAX_MESSAGE_BYTES: String(8 * 1024 * 1024), ANON_MAX_MESSAGE_BYTES: String(2 * 1024 * 1024),
};

async function startApp(env: Record<string, string> = {}): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '30', SAVE_DEBOUNCE_MS: '50',
      READYZ_CACHE_MS: '10', PORT: String(++portSeq), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0', ...FV5_LIMITS, ...env,
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
const syncMsg = (syncType: number, payload: Uint8Array) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, syncType);
  encoding.writeVarUint8Array(e, payload);
  return encoding.toUint8Array(e);
};
const NOTE = { type: 'note', x: 0, y: 0, w: 200, h: 200, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', opacity: 1 };
const geo = (id: string, j = 0) => ({
  id, type: 'geo', geo: 'rectangle', x: j, y: j, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false,
  color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1,
});
const shapeMap = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
function noteWithText(doc: Y.Doc, id: string, text: string) {
  doc.transact(() => {
    const m = shapeMap({ id, ...NOTE });
    doc.getMap('shapes').set(id, m);
    const t = new Y.Text();
    m.set('text', t);
    t.insert(0, text);
  });
}
async function fill(app: App, key: string, c: TestClient, n: number, batch = 2000): Promise<number> {
  for (let i = 0; i < n; i += batch) {
    c.doc.transact(() => {
      const shapes = c.doc.getMap('shapes');
      for (let j = i; j < Math.min(n, i + batch); j++) shapes.set(`f${j}`, shapeMap(geo(`f${j}`, j)));
    });
    const want = Math.min(n, i + batch);
    await waitFor(async () => ((await roomDocs(app, key))?.doc.getMap('shapes').size ?? 0) >= want, 30_000, 'fill');
  }
  return Y.encodeStateAsUpdate((await roomDocs(app, key))!.doc).byteLength;
}
/** A raw socket (no Y.Doc in this process). `pause`: stop reading right after the upgrade. */
async function raw(app: App, key: string, cookie?: string, pause = false, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${base(app)}/${key}`, { headers: { origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}), ...headers }, maxPayload: 256 << 20 });
  let n = 0;
  ws.on('message', (d: Buffer) => (n += d.length));
  ws.on('error', () => undefined);
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise<void>((r, j) => {
    ws.on('open', () => {
      if (pause) (ws as unknown as { _socket: { pause(): void } })._socket.pause();
      r();
    });
    ws.on('unexpected-response', () => j(new Error('unexpected response')));
  });
  return { ws, bytes: () => n, closed };
}
const serverConns = (app: App, key: string, user: string) =>
  [...(app.manager.get(key)?.conns.values() ?? [])].filter((c) => c.identity.id === user);
/** Bytes of a join payload of `room` (ledger and content frames: snapshots + tails). */
const frameBytes = async (room: { ledgerFrames(): Promise<Uint8Array[]>; contentFrames(): Promise<{ frames: Uint8Array[] }> }) =>
  [...(await room.ledgerFrames()), ...(await room.contentFrames()).frames].reduce((a, f) => a + f.byteLength, 0);
async function rejected(app: App, reason: string): Promise<number> {
  const m = await app.metrics.wsRejected.get();
  return m.values.filter((v) => v.labels.reason === reason).reduce((a, v) => a + v.value, 0);
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv5-static-'));
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

function users(key: string) {
  core.rules.set(key, allowUser('ana@corp', 'Ana'));
  core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
  core.rulesByCookie.set(`sid=eve|${key}`, allowUser('eve@corp', 'Eve'));
}

// ---------------------------------------------------------------------------------------------
describe('fv5 H-1: slow readers cannot hold the server memory', () => {
  it('p5: one user opens 20 paused sockets on a big room: 8 are accepted, they share one copy of the join payload, and the ping timeout drops them; Ana keeps editing', async () => {
    const app = await startApp({ WS_PING_INTERVAL_MS: '1500' });
    const key = 'u/p5/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    const roomBytes = await fill(app, key, ana, 12_000);
    expect(roomBytes).toBeGreaterThan(3_500_000);
    const room = app.manager.get(key)!;
    const F = await frameBytes(room);
    const socks = [];
    for (let i = 0; i < 20; i++) socks.push(await raw(app, key, 'sid=eve', true).catch(() => null));
    await sleep(150);
    // the per-principal cap (MAX_CONNS_PER_USER 8): before, all 20 were accepted
    expect(serverConns(app, key, 'eve@corp').length).toBe(8);
    expect(await rejected(app, 'principal_conns')).toBe(12);
    // what the server holds for them: the paused sockets' buffers reference ONE copy of the
    // frames of the room version (before: every join encoded its own copy — 20 joins on a
    // 15.5 MB room held 392 MB in ws.bufferedAmount, RSS +700 MB; after, measured with the
    // verifier's p5: RSS +7 MB, 33 MB buffered)
    await sleep(1100); // one sweep
    const held = (await app.metrics.outgoingBytes.get()).values[0].value;
    expect(held).toBeLessThan(1.5 * F);
    // no pong for two ping rounds and nothing drained: dropped (before: kept forever)
    await waitFor(async () => serverConns(app, key, 'eve@corp').length === 0, 8000, 'paused sockets dropped');
    expect(await rejected(app, 'idle')).toBe(8);
    ana.doc.getMap('meta').set('after', 1);
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.doc.getMap('meta').get('after') === 1, 5000, 'bob synced');
    for (const s of socks) s?.ws.terminate();
    bob.close();
    ana.close();
  }, 120_000);

  it('a peer over its cap is dropped by the timer, with no further send to trigger it', async () => {
    const app = await startApp({ WS_SLOW_CONSUMER_MS: '300', WS_PING_INTERVAL_MS: '600000' });
    const key = 'u/slow/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    const eve = await raw(app, key, 'sid=eve');
    await waitFor(async () => serverConns(app, key, 'eve@corp')[0]?.joining === false, 5000, 'eve joined');
    (eve.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const conn = serverConns(app, key, 'eve@corp')[0];
    // broadcasts until the kernel's socket buffers are full and the server queues for Eve
    // (Linux loopback auto-tunes them to several MB: the amount depends on the host)
    for (let i = 0; i < 60 && conn.ws.bufferedAmount < 1024 * 1024; i++) {
      ana.doc.getMap('meta').set('k', `${i}`.padEnd(512 * 1024, 'z'));
      await sleep(30);
    }
    expect(conn.ws.bufferedAmount).toBeGreaterThan(1024 * 1024);
    // then her cap drops below what is queued, and NOTHING is sent any more: before, only the
    // next send checked the cap, so a paused socket in a quiet room was kept forever
    limitBuffered(conn.ws, 512 * 1024, () => undefined);
    const t0 = Date.now();
    await waitFor(async () => serverConns(app, key, 'eve@corp').length === 0, 5000, 'eve dropped by the timer');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await rejected(app, 'slow_consumer')).toBeGreaterThanOrEqual(1);
    expect(serverConns(app, key, 'ana@corp').length).toBe(1);
    eve.ws.terminate();
    ana.close();
  }, 60_000);

  it('the outgoing budget: a join that would pass it is refused with 1013 + busy (retryable); while it is passed the peer holding most is dropped; then joins succeed', async () => {
    // the 40 000-shape fill must not run into the per-principal CPU budget (tested apart)
    // fv6 L-A: a stalled peer is dropped to make room for a join (adversarial-fv6 / fv6.test.ts);
    // here no peer counts as stalled, so the budget refuses
    // (no authorization re-check: the fill below takes ~20 s of a busy event loop, and a re-check
    // that times out fails closed and revokes Ana mid-fill, 4403)
    const app = await startApp({ WS_PING_INTERVAL_MS: '600000', WS_SLOW_CONSUMER_MS: '600000', WS_STALL_MS: '600000', MSG_RATE_PER_SEC: '1000', MSG_BURST: '1000', CPU_MS_PER_SEC: '100000', CPU_BURST_MS: '100000', CPU_TOTAL_MS_PER_SEC: '100000', CPU_TOTAL_BURST_MS: '100000', AUTHZ_RECHECK_SECONDS: '3600' });
    const cfg = (app.manager as unknown as { deps: { cfg: { wsOutgoingBudgetBytes: number } } }).deps.cfg;
    const key = 'u/budget/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    await fill(app, key, ana, 40_000, 4000); // bigger than the kernel's socket buffers on any host
    expect(ana.closeCode).toBeNull();
    const room = app.manager.get(key)!;
    const F = await frameBytes(room);
    cfg.wsOutgoingBudgetBytes = Math.round(1.2 * F);
    const eve = await raw(app, key, 'sid=eve', true); // holds her join payload unread
    await waitFor(async () => (serverConns(app, key, 'eve@corp')[0]?.ws.bufferedAmount ?? 0) > 1024 * 1024, 10_000, 'eve holds her join');
    // new join frames: the next join needs them, more than the budget has left (fv6: a join
    // shares the snapshot until the updates since outgrow it, TAIL_MAX_MESSAGES)
    for (let v = 1; v <= TAIL_MAX_MESSAGES + 1; v++) ana.doc.getMap('meta').set('v', v);
    await waitFor(async () => (await room.inspect()).doc.getMap('meta').get('v') === TAIL_MAX_MESSAGES + 1, 3000, 'edit');
    // The budget just above what eve holds. How much that is depends on the kernel: the join goes
    // out piece by piece, each once the previous one drained, so eve holds the first piece (the
    // 4 MB content) if her paused socket's buffers could not take it, or the ledger (15 MB) queued
    // behind it if they could (right at the limit of a Linux socket buffer). Either way the join
    // bob needs, 19.6 MB of new frames, is more than the 25% slack leaves. The held-bytes gauge
    // is refreshed by the sweep, once a second.
    await sleep(1100);
    const heldByEve = (await app.metrics.outgoingBytes.get()).values[0]?.value ?? 0;
    expect(heldByEve).toBeGreaterThan(1024 * 1024);
    cfg.wsOutgoingBudgetBytes = heldByEve + 256 * 1024;
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    expect(await bob.closed).toBe(1013);
    expect(bob.notices.map((n) => n.kind)).toContain('busy');
    // while the budget is passed the sweep drops the peer holding most
    cfg.wsOutgoingBudgetBytes = 512 * 1024;
    await waitFor(async () => serverConns(app, key, 'eve@corp').length === 0, 5000, 'eve dropped');
    expect(await rejected(app, 'outgoing_budget')).toBe(2);
    // nothing held any more: the retry gets in and syncs (its own join stays within 1.2 F)
    cfg.wsOutgoingBudgetBytes = Math.round(1.2 * F);
    const bob2 = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob2.connect();
    await waitFor(async () => bob2.doc.getMap('shapes').size === 40_000, 30_000, 'bob synced');
    expect(bob2.closeCode).toBeNull();
    eve.ws.terminate();
    bob2.close();
    ana.close();
  }, 120_000);

  it('connections per principal over the whole process: user 8, anonymous visitor 2 (1013, retryable); others unaffected', async () => {
    const app = await startApp();
    const keys = ['u/c1/index.html', 'u/c2/index.html', 'u/c3/index.html'];
    for (const k of keys) users(k);
    const eves: TestClient[] = [];
    for (let i = 0; i < 9; i++) {
      const c = new TestClient(`${base(app)}/${keys[i % 3]}`, 'sid=eve');
      await c.connect();
      eves.push(c);
    }
    await sleep(200);
    expect(eves.slice(0, 8).every((c) => c.closeCode === null)).toBe(true);
    expect(eves[8].closeCode).toBe(1013);
    const bob = new TestClient(`${base(app)}/${keys[0]}`, 'sid=bob');
    await bob.connect();
    expect(bob.closeCode).toBeNull();
    // one anonymous visitor (one cookie) in three pub/ rooms
    for (const k of ['pub/a1.html', 'pub/a2.html', 'pub/a3.html']) core.rules.set(k, allowAnon());
    const first = new TestClient(`${base(app)}/pub/a1.html`);
    await first.connect();
    const cookie = first.setCookie!.split(';')[0];
    const second = new TestClient(`${base(app)}/pub/a2.html`, cookie);
    await second.connect();
    const third = new TestClient(`${base(app)}/pub/a3.html`, cookie);
    await third.connect();
    await sleep(200);
    expect([first.closeCode, second.closeCode, third.closeCode]).toEqual([null, null, 1013]);
    // a closed connection frees its slot
    first.close();
    await sleep(200);
    const again = new TestClient(`${base(app)}/pub/a3.html`, cookie);
    await again.connect();
    await sleep(200);
    expect(again.closeCode).toBeNull();
    for (const c of [...eves, bob, second, again]) c.close();
  });

  it('an evicted room releases its documents (the awareness interval kept every evicted room alive)', async () => {
    const app = await startApp();
    const key = 'u/evict/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    await waitFor(async () => app.manager.get(key) !== undefined, 3000, 'room');
    const room = app.manager.get(key)!;
    ana.close();
    await waitFor(async () => app.manager.get(key) === undefined, 3000, 'evicted');
    expect(room.disposed).toBe(true);
    expect((room.awareness as unknown as { _checkInterval: { _destroyed?: boolean } })._checkInterval._destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv5 M-1: the text cap counts the resulting length', () => {
  function offline(scenario: 'paste-undo-paste' | 'type-and-backspace' | 'points') {
    const room = materializeContent(new Y.Doc());
    const tab = new CanvasDoc(new Y.Doc(), new Y.Doc());
    const id = scenario === 'points'
      ? tab.create({ type: 'draw', x: 0, y: 0, w: 10, h: 10, points: [0, 0, 0.5] } as never)
      : tab.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'hello' } as never);
    tab.endGesture();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(tab.doc)); // online: the room has the shape
    const sv = Y.encodeStateVector(room);
    if (scenario === 'paste-undo-paste') {
      tab.update(id, { text: 'hello' + 'x'.repeat(6000) } as never);
      tab.endGesture();
      tab.undo();
      tab.update(id, { text: 'hello' + 'y'.repeat(6000) } as never);
      tab.endGesture();
    } else if (scenario === 'type-and-backspace') {
      for (let i = 0; i < 6000; i++) {
        const cur = (tab.get(id) as unknown as { text: string }).text;
        tab.update(id, { text: cur + 'a' } as never);
        if (i % 2) tab.update(id, { text: (tab.get(id) as unknown as { text: string }).text.slice(0, -2) } as never);
        if (i % 50 === 0) tab.endGesture();
      }
    } else {
      // a stroke's points replaced over and over offline: 40 x 9 000 numbers inserted, 9 000 alive
      for (let i = 0; i < 40; i++) tab.update(id, { points: Array.from({ length: 9000 }, (_, k) => (k + i) % 97) } as never);
    }
    return { room, answer: Y.encodeStateAsUpdate(tab.doc, sv), tab, id };
  }

  it('p10: offline paste 6 000, undo, paste 6 000 again: the reconnect answer is accepted (before: shapes-schema, 4403)', () => {
    const { room, answer, tab, id } = offline('paste-undo-paste');
    expect((tab.get(id) as unknown as { text: string }).text.length).toBe(6005);
    expect(checkClientUpdate(room, answer).bad).toBeNull();
  });

  it('p10: offline type-and-backspace churn is accepted', () => {
    const { room, answer } = offline('type-and-backspace');
    expect(checkClientUpdate(room, answer).bad).toBeNull();
  });

  it('points replaced offline many times: accepted when the result fits (MAX_POINTS counts the alive ones)', () => {
    const { room, answer } = offline('points');
    expect(40 * 9000).toBeGreaterThan(MAX_POINTS);
    expect(checkClientUpdate(room, answer).bad).toBeNull();
  });

  it('a result over the cap is still refused (room text + new text, and new text minus nothing)', () => {
    const room = materializeContent(new Y.Doc());
    const a = new Y.Doc();
    noteWithText(a, 'n1', 'x'.repeat(9000));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
    const sv = Y.encodeStateVector(a);
    const t = (a.getMap('shapes').get('n1') as Y.Map<unknown>).get('text') as Y.Text;
    t.delete(0, 500);
    t.insert(0, 'y'.repeat(1600)); // 10 100
    expect(checkClientUpdate(room, Y.encodeStateAsUpdate(a, sv)).bad).toBe('shapes-schema');
    t.delete(0, 100); // 10 000: fits
    expect(checkClientUpdate(room, Y.encodeStateAsUpdate(a, sv)).bad).toBeNull();
    expect(t.length).toBe(MAX_TEXT_LENGTH);
  });
});

// ---------------------------------------------------------------------------------------------
/** Replace the delete set (the suffix of a v1 update) of `upd` with `ranges` per client, as given. */
function withDeleteSet(upd: Uint8Array, ds: [number, [number, number][]][]): Uint8Array {
  const dec = Y.decodeUpdate(upd);
  const honest = encoding.createEncoder();
  encoding.writeVarUint(honest, dec.ds.clients.size);
  for (const [c, rs] of dec.ds.clients) {
    encoding.writeVarUint(honest, c);
    encoding.writeVarUint(honest, rs.length);
    for (const r of rs) {
      encoding.writeVarUint(honest, r.clock);
      encoding.writeVarUint(honest, r.len);
    }
  }
  const suffix = encoding.toUint8Array(honest);
  if (Buffer.compare(Buffer.from(upd.slice(upd.length - suffix.length)), Buffer.from(suffix))) throw new Error('ds suffix mismatch');
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, ds.length);
  for (const [c, rs] of ds) {
    encoding.writeVarUint(e, c);
    encoding.writeVarUint(e, rs.length);
    for (const [clock, len] of rs) {
      encoding.writeVarUint(e, clock);
      encoding.writeVarUint(e, len);
    }
  }
  return new Uint8Array([...upd.slice(0, upd.length - suffix.length), ...encoding.toUint8Array(e)]);
}

describe('fv5 M-4: delete sets must be canonical (sorted, disjoint, one entry per client)', () => {
  it('p12: an unsorted delete set that also deletes the update\'s own new `type` closes 4403; the shape keeps its type', async () => {
    const app = await startApp();
    const key = 'u/p12/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    ana.doc.transact(() => ana.doc.getMap('shapes').set('A1', shapeMap(geo('A1'))));
    const room = await (async () => {
      await waitFor(async () => (await roomDocs(app, key))?.doc.getMap('shapes').has('A1') === true, 5000, 'A1');
      return app.manager.get(key)!;
    })();
    const eve = new TestClient(`${base(app)}/${key}`, 'sid=eve');
    await eve.connect();
    await waitFor(async () => eve.doc.getMap('shapes').has('A1'), 5000, 'eve synced');
    // Eve writes from a second Yjs client of hers: two throwaway clocks (then deleted)
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate((await room.inspect()).doc));
    let upd: Uint8Array | null = null;
    scratch.on('update', (u: Uint8Array) => (upd = u));
    scratch.transact(() => {
      scratch.getMap('meta').set('k', 1);
      scratch.getMap('meta').set('k', 2);
    });
    eve.sendRaw(syncMsg(2, upd!));
    scratch.transact(() => scratch.getMap('meta').delete('k'));
    eve.sendRaw(syncMsg(2, upd!));
    await waitFor(async () => Y.getState((await room.inspect()).doc.store, scratch.clientID) >= 2 && !(await room.inspect()).doc.getMap('meta').has('k'), 5000, 'throwaways');
    scratch.transact(() => (scratch.getMap('shapes').get('A1') as Y.Map<unknown>).set('type', 'geo'));
    const dec = Y.decodeUpdate(upd!);
    const N = (dec.structs as Y.Item[]).find((s) => s.content instanceof Y.ContentAny)!.id.clock;
    const honestDs = [...dec.ds.clients].map(([c, rs]) => [c, rs.map((r) => [r.clock, r.len])] as [number, [number, number][]]);
    const unsorted = withDeleteSet(upd!, [...honestDs, [scratch.clientID, [[N, 1], [0, 1], [1, 1]]]]);
    const sorted = withDeleteSet(upd!, [...honestDs, [scratch.clientID, [[0, 1], [1, 1], [N, 1]]]]);
    // before: the unsorted one passed (null) while the same ranges sorted were refused
    expect(checkClientUpdate((await room.inspect()).doc, unsorted).bad).toBe('malformed');
    expect(checkClientUpdate((await room.inspect()).doc, sorted).bad).toBe('shapes-schema');
    eve.sendRaw(syncMsg(2, unsorted));
    await expectClose(eve, 4403);
    const a1 = (await room.inspect()).doc.getMap('shapes').get('A1') as Y.Map<unknown>;
    expect(a1.get('type')).toBe('geo');
    await sleep(200);
    expect(readShape(ana.doc.getMap('shapes').get('A1'), 'A1')).not.toBeNull();
    ana.close();
  });

  it('p1: one 1-character delete range repeated 60 000 times closes 4403; the text stays under the cap (before: 68 998 characters)', async () => {
    const app = await startApp();
    const key = 'u/p1/index.html';
    users(key);
    const eve = new TestClient(`${base(app)}/${key}`, 'sid=eve');
    await eve.connect();
    noteWithText(eve.doc, 'n1', 'x'.repeat(9000));
    await waitFor(async () => ((((await roomDocs(app, key))?.doc.getMap('shapes').get('n1') as Y.Map<unknown> | undefined)?.get('text') as Y.Text | undefined)?.length ?? 0) === 9000, 5000, 'note');
    const room = app.manager.get(key)!;
    const scratch = new Y.Doc();
    scratch.clientID = eve.doc.clientID;
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(eve.doc));
    let upd: Uint8Array | null = null;
    scratch.on('update', (u: Uint8Array) => (upd = u));
    const R = 60_000;
    scratch.transact(() => {
      const t = (scratch.getMap('shapes').get('n1') as Y.Map<unknown>).get('text') as Y.Text;
      t.delete(0, 1);
      t.insert(8999, 'y'.repeat(R - 1));
    });
    const [[client, ranges]] = [...Y.decodeUpdate(upd!).ds.clients];
    const forged = withDeleteSet(upd!, [[client, Array.from({ length: R }, () => [ranges[0].clock, 1] as [number, number])]]);
    expect(checkClientUpdate((await room.inspect()).doc, upd!).bad).toBe('shapes-schema');
    expect(checkClientUpdate((await room.inspect()).doc, forged).bad).toBe('malformed'); // before: null
    eve.sendRaw(syncMsg(2, forged));
    await expectClose(eve, 4403);
    // eve was the room's only connection: the room was saved and evicted
    await waitFor(async () => !app.manager.get(key), 5000, 'evicted');
    expect((((await roomOrStored(app, store, key)).doc.getMap('shapes').get('n1') as Y.Map<unknown>).get('text') as Y.Text).length).toBe(9000);
  });

  it('p8: the guard-fuzz finding (seed 271828 #83865) is refused; the shape keeps its type', () => {
    const u = new Uint8Array(Buffer.from('0101662988651201770367656f026601290166021b032001', 'hex'));
    const clock = { t: 1_000_000 };
    const room = seededRoom(clock);
    expect(shapeValueProblem(room.content.getMap('shapes'), 's4')).toBeNull();
    expect(checkClientUpdate(room.content, u, { serverClient: room.content.clientID, mayWriteClient: () => true }).bad).toBe('malformed');
    // what it did before (applied): s4 lost its `type`
    const sc = copyRoom(room, clock);
    applyGuarded(sc.content, u, 'mallory');
    expect(shapeValueProblem(sc.content.getMap('shapes'), 's4')).toBe('shapes-schema');
  });

  it('honest updates are canonical; duplicate clients, overlaps, unsorted or empty ranges and trailing bytes are not', () => {
    const d = new Y.Doc();
    d.clientID = 77;
    const updates: Uint8Array[] = [];
    d.on('update', (u: Uint8Array) => updates.push(u));
    noteWithText(d, 'n', 'abcdefghij'.repeat(50));
    const t = (d.getMap('shapes').get('n') as Y.Map<unknown>).get('text') as Y.Text;
    for (let i = 0; i < 40; i++) d.transact(() => {
      t.delete(i * 3, 1);
      t.delete(i * 3 + 7, 2);
      t.insert(i, 'é😀');
    });
    d.getMap('shapes').delete('n');
    for (const u of [...updates, Y.encodeStateAsUpdate(d), Y.mergeUpdates(updates)]) expect(deleteSetCanonical(u)).toBe(true);
    const base0 = Y.encodeStateAsUpdate(new Y.Doc());
    expect(deleteSetCanonical(withDeleteSet(base0, [[5, [[0, 1], [2, 3]]]]))).toBe(true);
    expect(deleteSetCanonical(withDeleteSet(base0, [[5, [[2, 3], [0, 1]]]]))).toBe(false); // unsorted
    expect(deleteSetCanonical(withDeleteSet(base0, [[5, [[0, 3], [2, 3]]]]))).toBe(false); // overlap
    expect(deleteSetCanonical(withDeleteSet(base0, [[5, [[0, 1]]], [5, [[4, 1]]]]))).toBe(false); // client twice
    expect(deleteSetCanonical(withDeleteSet(base0, [[5, [[0, 0]]]]))).toBe(false); // empty range
    expect(deleteSetCanonical(new Uint8Array([...Y.encodeStateAsUpdate(d), 0]))).toBe(false); // trailing
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv5 L-2: deletes that split items count against the size cap', () => {
  it('p11: an anonymous visitor fills a room, then deletes every other character: closed 4413 near the cap (before: the room grew 8x past it)', async () => {
    const CAP = 1024 * 1024;
    const app = await startApp({ ANON_MAX_DOC_BYTES: String(CAP), ANON_MAX_MESSAGE_BYTES: String(2 * 1024 * 1024), SAVE_DEBOUNCE_MS: '100', ANON_MSG_RATE_PER_SEC: '1000', ANON_MSG_BURST: '1000', ANON_CPU_MS_PER_SEC: '100000', ANON_CPU_BURST_MS: '100000', ANON_CPU_TOTAL_MS_PER_SEC: '100000', ANON_CPU_TOTAL_BURST_MS: '100000', CPU_TOTAL_MS_PER_SEC: '100000', CPU_TOTAL_BURST_MS: '100000' });
    const key = 'pub/inflate/index.html';
    core.rules.set(key, allowAnon());
    const anon = new TestClient(`${base(app)}/${key}`);
    await anon.connect();
    const NOTES = 80;
    anon.doc.transact(() => {
      for (let i = 0; i < NOTES; i++) noteWithText(anon.doc, `n${i}`, 'a'.repeat(10_000));
    });
    await waitFor(async () => (await roomDocs(app, key))?.doc.getMap('shapes').size === NOTES, 10_000, 'filled');
    const room = app.manager.get(key)!;
    await sleep(300); // saved: the size estimate is exact again
    const size0 = Y.encodeStateAsUpdate((await room.inspect()).doc).byteLength;
    expect(size0).toBeLessThan(CAP);
    for (let b = 0; b < NOTES && anon.closeCode === null; b += 4) {
      anon.doc.transact(() => {
        for (let i = b; i < b + 4; i++) {
          const t = (anon.doc.getMap('shapes').get(`n${i}`) as Y.Map<unknown>).get('text') as Y.Text;
          for (let c = t.length - 2; c >= 0; c -= 2) t.delete(c, 1);
        }
      });
      await sleep(30);
    }
    await expectClose(anon, 4413);
    await sleep(300);
    const size1 = Y.encodeStateAsUpdate((await room.inspect()).doc).byteLength;
    // before: 8x the starting size; the estimate (update + 24 B per split) stops it near the cap
    expect(size1).toBeLessThan(CAP * 1.5);
  }, 60_000);

  it('deleting whole shapes is never counted (a full room can always be emptied)', () => {
    const room = materializeContent(new Y.Doc());
    const a = new Y.Doc();
    noteWithText(a, 'n1', 'x'.repeat(5000));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(a));
    const sv = Y.encodeStateVector(a);
    a.getMap('shapes').delete('n1');
    const r = checkClientUpdate(room, Y.encodeStateAsUpdate(a, sv));
    expect(r).toMatchObject({ bad: null, grows: false, splits: 0 });
    const b = new Y.Doc();
    noteWithText(b, 'n2', 'y'.repeat(100));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(b));
    const svb = Y.encodeStateVector(b);
    ((b.getMap('shapes').get('n2') as Y.Map<unknown>).get('text') as Y.Text).delete(10, 5);
    expect(checkClientUpdate(room, Y.encodeStateAsUpdate(b, svb))).toMatchObject({ bad: null, grows: true, splits: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv5 M-2: an honest reconnect is never refused', () => {
  /** Offline edit, server restart, a keystroke while the server's join is still arriving. */
  async function reconnectWithKeystroke(useConnection: boolean) {
    const s1 = await startApp();
    const key = `u/m2-${useConnection}/index.html`;
    users(key);
    class OriginWs extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { origin: TEST_ORIGIN } });
      }
    }
    const doc = new Y.Doc();
    const cd = new CanvasDoc(doc, new Y.Doc());
    let wsUrl = base(s1);
    const closes: number[] = [];
    const make = () => {
      if (useConnection) {
        const c = new Connection(doc, { wsUrl, room: key, params: {}, devIdentity: null, WebSocketPolyfill: OriginWs as never });
        return c.provider;
      }
      const p = new WebsocketProvider(wsUrl, key, doc, { WebSocketPolyfill: OriginWs as never, disableBc: true, maxBackoffTime: 200 });
      for (const k of [100, 101, 102]) p.messageHandlers[k] = () => undefined;
      return p;
    };
    let provider = make();
    provider.on('connection-close', (e: { code: number } | null) => e && closes.push(e.code));
    await waitFor(async () => provider.synced, 5000, 'synced');
    const id = cd.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'online' } as never);
    cd.endGesture();
    await waitFor(async () => (await roomDocs(s1, key))?.doc.getMap('shapes').has(id) === true, 3000, 'note');
    await s1.manager.get(key)!.flush();
    // the server goes away; the tab edits offline (a new struct of its client id)
    provider.destroy();
    await s1.close();
    cd.update(id, { text: 'online typed offline' } as never);
    const s2 = await startApp();
    wsUrl = base(s2);
    provider = make();
    provider.on('connection-close', (e: { code: number } | null) => e && closes.push(e.code));
    // one keystroke right before the server's sync step 1 is handled: it depends on the offline
    // struct, which the server only gets with the step-2 answer to that step 1
    const orig = provider.messageHandlers[0];
    let injected = 0;
    provider.messageHandlers[0] = (enc, dec, p, emitSynced, mt) => {
      if (!injected && decoding.peekVarUint(dec) === 0) {
        injected++;
        cd.update(id, { text: (cd.get(id) as unknown as { text: string }).text + 'K' } as never);
      }
      return orig(enc, dec, p, emitSynced, mt);
    };
    await waitFor(async () => injected > 0, 5000, 'keystroke injected');
    const want = 'online typed offlineK';
    await waitFor(async () => ((((await roomDocs(s2, key))?.doc.getMap('shapes').get(id) as Y.Map<unknown> | undefined)?.get('text') as Y.Text | undefined)?.toString() ?? '') === want, 5000, 'server has both edits');
    await sleep(300);
    expect(closes.filter((c) => c >= 4000)).toEqual([]);
    expect(provider.wsconnected).toBe(true);
    const resync = (await s2.metrics.pendingResync.get()).values[0]?.value ?? 0;
    provider.destroy();
    return resync;
  }

  it('stock y-websocket order (local update before the step-2 answer): the server asks again instead of closing 4403', async () => {
    expect(await reconnectWithKeystroke(false)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('the canvas client holds local sends until it answered the server\'s step 1: nothing pending reaches the server', async () => {
    expect(await reconnectWithKeystroke(true)).toBe(0);
  }, 30_000);

  it('honest-edit fuzz (CI slice): real y-websocket and the canvas client, offline, undo/redo, 2-3 tabs: 0 refusals, 0 divergence', async () => {
    for (const mode of ['ywebsocket', 'client'] as const) {
      const r = await runHonestFuzz(60, 11, 400, mode);
      expect(r.refusals).toEqual({});
      expect(r.refused + r.diverged).toBe(0);
      expect(r.updates).toBeGreaterThan(500);
      if (mode === 'ywebsocket') expect(r.resyncs).toBeGreaterThan(0);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
describe('fv5 M-5: CPU is budgeted per principal and server-wide', () => {
  it('p2: one user\'s connections share one CPU budget: O(room) step 1s from 8 sockets close them; Bob in another room stays responsive', async () => {
    const key = 'u/p2/index.html';
    users(key);
    {
      // the big room, stored (filled under the default budgets)
      const filler = await startApp();
      const ana0 = new TestClient(`${base(filler)}/${key}`);
      await ana0.connect();
      await fill(filler, key, ana0, 12_000);
      ana0.doc.transact(() => {
        for (let i = 0; i < 2000; i++) ana0.doc.getMap('shapes').delete(`f${i}`);
      });
      await waitFor(async () => (await roomDocs(filler, key))!.doc.getMap('shapes').size === 10_000, 10_000, 'deletes');
      ana0.close();
      await waitFor(async () => filler.manager.get(key) === undefined, 5000, 'flushed');
      await filler.close();
    }
    const app = await startApp({ CPU_MS_PER_SEC: '10', CPU_BURST_MS: '100', SYNC_BYTES_PER_SEC: '100000000', SYNC_BURST_BYTES: '100000000' });
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    await waitFor(async () => ana.doc.getMap('shapes').size === 10_000, 10_000, 'ana synced');
    const key2 = 'u/p2-other/index.html';
    users(key2);
    const bob = new TestClient(`${base(app)}/${key2}`, 'sid=bob');
    await bob.connect();
    // Eve's 8 sockets. Her joins are charged to the same budget the attack below uses up, and the
    // server charges wall time: on a slow or busy host a few joins alone put her in debt, and a
    // principal in debt joins nobody (1013) until it refilled. So a refused socket is retried.
    const socks: Awaited<ReturnType<typeof raw>>[] = [];
    for (let tries = 0; socks.length < 8 && tries < 80; tries++) {
      const s = await raw(app, key, 'sid=eve');
      if ((await Promise.race([s.closed, sleep(250).then(() => null)])) === null) socks.push(s);
      else await sleep(500);
    }
    expect(socks).toHaveLength(8);
    const sv = encoding.createEncoder();
    encoding.writeVarUint(sv, 1);
    encoding.writeVarUint(sv, 123456);
    encoding.writeVarUint(sv, 1);
    const step1 = syncMsg(0, encoding.toUint8Array(sv));
    // The cost of one answer (a diff against the join: O(room) for the delete set), as the server
    // charges it. A local timing of the encode, or one answer at a time on an idle CPU (efficiency
    // cores, cold JIT), is off by the factor that decides whether 8 sockets reach 4x the budget
    // within the 6 s below: it was the reason this test failed on slow and on loaded hosts (0 of 8
    // closed). A principal of its own (the budget is per principal) gets bursts of 3 answers, until
    // 15 or until half its bucket is gone; what the bucket lost plus what it refilled meanwhile
    // (CPU_MS_PER_SEC) is the price of a burst. The cheapest burst counts: a price too high makes
    // the attack too slow, too low only makes it faster.
    core.rulesByCookie.set(`sid=frank|${key}`, allowUser('frank@corp', 'Frank'));
    const frank = await raw(app, key, 'sid=frank');
    await waitFor(async () => serverConns(app, key, 'frank@corp')[0]?.joining === false, 10_000, 'frank joined');
    const fc = serverConns(app, key, 'frank@corp')[0];
    const level0 = fc.cpu.level();
    let answered = 0;
    let cost = Infinity;
    while (answered < 15 && fc.cpu.level() > level0 / 2) {
      const before = fc.cpu.level();
      const tBurst = Date.now();
      for (let i = 0; i < 3; i++) frank.ws.send(step1);
      answered += 3;
      await waitFor(async () => fc.step1Answers >= answered, 10_000, 'frank answered');
      cost = Math.min(cost, (before - fc.cpu.level() + (10 * (Date.now() - tBurst)) / 1000) / 3);
    }
    cost = Math.max(0.2, cost);
    frank.ws.close();
    // each socket alone stays at HALF the budget (10 ms/s): never closed by a per-connection
    // budget; the 8 together use 4x it
    const perSec = Math.min(100, 5 / cost);
    const timers = socks.map((s) => setInterval(() => s.ws.readyState === 1 && s.ws.send(step1), 1000 / perSec));
    const rtts: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const s = performance.now();
      const want = Math.random();
      bob.doc.getMap('meta').set('p', want);
      await waitFor(async () => (await roomDocs(app, key2))!.doc.getMap('meta').get('p') === want, 10_000, 'rtt');
      rtts.push(performance.now() - s);
      await sleep(100);
    }
    timers.forEach(clearInterval);
    const codes = await Promise.all(socks.map((s) => Promise.race([s.closed, sleep(100).then(() => null)])));
    // before (per-connection budgets): none of the 20 was ever closed
    expect(codes.filter((c) => c === 4429).length).toBe(8);
    expect(await rejected(app, 'cpu_budget')).toBeGreaterThanOrEqual(8);
    rtts.sort((a, b) => a - b);
    expect(rtts[Math.floor(rtts.length * 0.95)]).toBeLessThan(500);
    bob.close();
    ana.close();
  }, 60_000);

  it('p3/p4: while the server-wide budget is used up, big messages are refused with 1013 + busy (retryable); small ones still pass', async () => {
    const app = await startApp({ CPU_TOTAL_MS_PER_SEC: '1', CPU_TOTAL_BURST_MS: '50', ANON_CPU_TOTAL_MS_PER_SEC: '1', ANON_CPU_TOTAL_BURST_MS: '1' });
    const key = 'u/shed/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    // an expensive message spends the whole server-wide burst
    ana.doc.transact(() => {
      for (let i = 0; i < 3000; i++) ana.doc.getMap('shapes').set(`s${i}`, shapeMap(geo(`s${i}`, i)));
    });
    await waitFor(async () => (await roomDocs(app, key))?.doc.getMap('shapes').size === 3000, 10_000, 'big write');
    // a small edit still goes through
    ana.doc.getMap('meta').set('small', 1);
    await waitFor(async () => (await roomDocs(app, key))!.doc.getMap('meta').get('small') === 1, 3000, 'small write');
    // the next big one is shed: 1013 (y-websocket reconnects and resends what the room lacks)
    ana.doc.getMap('meta').set('big', 'q'.repeat(64 * 1024));
    expect(await ana.closed).toBe(1013);
    expect(ana.notices.map((n) => n.kind)).toContain('busy');
    expect(await rejected(app, 'cpu_shed')).toBe(1);
  });

  it('p4: anonymous visitors share one server-wide CPU share; a logged-in user is not shed by it', async () => {
    // the burst covers the first write's estimate (fv8 P2: an update the budget cannot cover is
    // refused before it is applied), which then spends it
    const app = await startApp({ ANON_CPU_TOTAL_MS_PER_SEC: '1', ANON_CPU_TOTAL_BURST_MS: '50' });
    const key = 'pub/p4/index.html';
    core.rules.set(key, allowAnon());
    core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
    const a1 = new TestClient(`${base(app)}/${key}`);
    await a1.connect();
    a1.doc.transact(() => {
      for (let i = 0; i < 2000; i++) a1.doc.getMap('shapes').set(`s${i}`, shapeMap(geo(`s${i}`, i)));
    });
    await waitFor(async () => (await roomDocs(app, key))?.doc.getMap('shapes').size === 2000, 10_000, 'anon write');
    // a fresh anonymous visitor (new cookie, fresh per-visitor budget) is shed all the same
    const a2 = new TestClient(`${base(app)}/${key}`);
    await a2.connect();
    a2.doc.getMap('meta').set('big', 'q'.repeat(64 * 1024));
    expect(await a2.closed).toBe(1013);
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    bob.doc.getMap('meta').set('bob', 'q'.repeat(64 * 1024));
    await waitFor(async () => ((await roomDocs(app, key))!.doc.getMap('meta').get('bob') as string | undefined)?.length === 64 * 1024, 3000, 'bob write');
    expect(bob.closeCode).toBeNull();
    bob.close();
    a1.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv5 M-6: anonymous joins cannot lock other visitors out', () => {
  it('p6: a cookieless client draining the room\'s join bucket does not lock out visitors with a cookie; a first join is never refused with 4429', async () => {
    // the cookie of a refused cookieless join is minted within the WebSocket mint rate (fv6
    // M-A, tested in fv6.test.ts); here the rate is out of the way
    const app = await startApp({ ANON_ROOM_JOIN_BURST: '5', ANON_ROOM_JOIN_RATE_PER_MIN: '1', ANON_MINT_BURST: '100000' });
    const key = 'pub/talk/index.html';
    core.rules.set(key, allowAnon());
    const codes: number[] = [];
    let stop = false;
    const attack = (async () => {
      while (!stop) {
        const ws = new WebSocket(`${base(app)}/${key}`, { headers: { origin: TEST_ORIGIN } });
        ws.on('error', () => undefined);
        ws.on('open', () => setTimeout(() => ws.close(), 30));
        await new Promise<void>((r) => ws.on('close', (c) => (codes.push(c), r())));
      }
    })();
    await waitFor(async () => codes.includes(1013), 5000, 'room bucket drained');
    // honest visitors: the wrapper page gave them a cookie before the socket opened
    const results: (number | null)[] = [];
    for (let v = 0; v < 6; v++) {
      const page = await fetch(`http://127.0.0.1:${port(app)}/_canvas/${key}`);
      const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
      expect(cookie).toMatch(/^canvas_anon=/);
      const c = new TestClient(`${base(app)}/${key}`, cookie);
      await c.connect();
      await sleep(150);
      results.push(c.closeCode);
      c.close();
    }
    // a visitor without a cookie that is refused gets one with the refusal and gets in on retry
    const lost = new TestClient(`${base(app)}/${key}`);
    await lost.connect();
    expect(await lost.closed).toBe(1013); // retryable: y-websocket reconnects
    const retry = new TestClient(`${base(app)}/${key}`, lost.setCookie!.split(';')[0]);
    await retry.connect();
    await sleep(150);
    stop = true;
    await attack;
    // before: ["joined","4429","4429","4429","4429","4429","4429","4429"] (4429 is terminal)
    expect(results).toEqual([null, null, null, null, null, null]);
    expect(retry.closeCode).toBeNull();
    expect(codes.includes(4429)).toBe(false);
    retry.close();
  }, 30_000);

  it('with a known client IP (CLIENT_IP_HOPS), anonymous joins are also limited per IP', async () => {
    const app = await startApp({ CLIENT_IP_HOPS: '1', ANON_IP_JOIN_BURST: '3', ANON_IP_JOIN_RATE_PER_MIN: '1', ANON_JOIN_BURST: '100' });
    const key = 'pub/ip/index.html';
    core.rules.set(key, allowAnon());
    const join = async (ip: string) => {
      const page = await fetch(`http://127.0.0.1:${port(app)}/_canvas/${key}`);
      const s = await raw(app, key, (page.headers.get('set-cookie') ?? '').split(';')[0], false, { 'x-forwarded-for': `10.0.0.9, ${ip}` });
      const code = await Promise.race([s.closed, sleep(200).then(() => null)]);
      s.ws.close();
      return code;
    };
    const one = [];
    for (let i = 0; i < 4; i++) one.push(await join('192.0.2.1'));
    expect(one).toEqual([null, null, null, 1013]);
    expect(await join('192.0.2.2')).toBeNull();
    const req = { headers: { 'x-forwarded-for': 'a, b, c' }, socket: { remoteAddress: 'peer' } } as never;
    expect([clientIp(req, -1), clientIp(req, 0), clientIp(req, 1), clientIp(req, 3), clientIp(req, 4)]).toEqual([null, 'peer', 'c', 'a', 'peer']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fv5 M-7: awareness states are capped per connection and per room', () => {
  it('p7: one 2 MiB awareness message with 72 000 client ids leaves ONE state in the room (before: 72 313, relayed to every viewer)', async () => {
    const app = await startApp();
    const key = 'pub/aw/index.html';
    core.rules.set(key, allowAnon());
    const viewer = new TestClient(`${base(app)}/${key}`);
    await viewer.connect();
    const s = await raw(app, key);
    const state = JSON.stringify({ cursor: { x: 1, y: 2 } });
    const entries: Uint8Array[] = [];
    let size = 8;
    for (let k = 0; ; k++) {
      const ee = encoding.createEncoder();
      encoding.writeVarUint(ee, 1_000_000 + k);
      encoding.writeVarUint(ee, 1);
      encoding.writeVarString(ee, state);
      const b = encoding.toUint8Array(ee);
      if (size + b.byteLength > 2 * 1024 * 1024 - 64) break;
      entries.push(b);
      size += b.byteLength;
    }
    expect(entries.length).toBeGreaterThan(70_000);
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, entries.length);
    for (const b of entries) encoding.writeUint8Array(inner, b);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint8Array(e, encoding.toUint8Array(inner));
    s.ws.send(encoding.toUint8Array(e));
    await sleep(500);
    const room = app.manager.get(key)!;
    const conn = [...room.conns.values()].find((c) => c.clientIds.has(1_000_000));
    expect(conn?.clientIds.size).toBe(1);
    expect(room.awareness.getStates().size).toBeLessThanOrEqual(2);
    expect(viewer.awareness.getStates().size).toBeLessThanOrEqual(3);
    const late = new TestClient(`${base(app)}/${key}`);
    await late.connect();
    await sleep(200);
    expect(late.awareness.getStates().size).toBeLessThanOrEqual(3);
    // its own state still moves, a second id of the same connection is dropped
    const move = (id: number, clock: number) => {
      const i2 = encoding.createEncoder();
      encoding.writeVarUint(i2, 1);
      encoding.writeVarUint(i2, id);
      encoding.writeVarUint(i2, clock);
      encoding.writeVarString(i2, JSON.stringify({ cursor: { x: 9, y: 9 } }));
      const m = encoding.createEncoder();
      encoding.writeVarUint(m, 1);
      encoding.writeVarUint8Array(m, encoding.toUint8Array(i2));
      s.ws.send(encoding.toUint8Array(m));
    };
    move(1_000_000, 2);
    move(5, 1);
    await sleep(300);
    expect((room.awareness.getStates().get(1_000_000) as { cursor: { x: number } }).cursor.x).toBe(9);
    expect(room.awareness.getStates().has(5)).toBe(false);
    s.ws.close();
    viewer.close();
    late.close();
  });

  it('a room relays at most MAX_AWARENESS_PER_ROOM states', async () => {
    const app = await startApp({ MAX_AWARENESS_PER_ROOM: '3' });
    const key = 'u/awroom/index.html';
    users(key);
    const cs: TestClient[] = [];
    for (const cookie of [undefined, 'sid=bob', 'sid=eve', 'sid=bob']) {
      const c = new TestClient(`${base(app)}/${key}`, cookie);
      await c.connect();
      c.awareness.setLocalState({ cursor: { x: 1, y: 1 } });
      cs.push(c);
      await sleep(100);
    }
    await sleep(300);
    expect(app.manager.get(key)!.awareness.getStates().size).toBe(3);
    for (const c of cs) c.close();
  });
});
