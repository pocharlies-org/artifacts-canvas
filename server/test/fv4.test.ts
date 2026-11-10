/**
 * Regressions of the fourth independent verification (fv4), through the real server. Each
 * case is the verifier's PoC (/poc1..poc4 of the report) with the expectation turned around:
 * the attack is bounded or refused, and honest clients keep working.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, expectClose, waitFor } from './helpers/yclient.js';
import { checkClientUpdate, attachStamper } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger, pruneAttribution } from '@pocharlies/artifacts-canvas-shared/ledger';
import { sanitizeAwarenessUpdate } from '@pocharlies/artifacts-canvas-shared/awareness';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 24600;
const apps: App[] = [];
const silent = createLogger('silent');

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
const base = (app: App) => `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syncMsg = (syncType: number, payload: Uint8Array) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, syncType);
  encoding.writeVarUint8Array(e, payload);
  return encoding.toUint8Array(e);
};
const STEP1_EMPTY = syncMsg(0, new Uint8Array([0]));
const shapeMap = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
const geo = (id: string, j = 0) => ({
  id, type: 'geo', geo: 'rectangle', x: j, y: j, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false,
  color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1,
});
/** Fill a room through `c` with `n` shapes; returns the room's encoded content size. */
async function fill(app: App, key: string, c: TestClient, n: number, batch = 2000): Promise<number> {
  for (let i = 0; i < n; i += batch) {
    c.doc.transact(() => {
      const shapes = c.doc.getMap('shapes');
      for (let j = i; j < Math.min(n, i + batch); j++) shapes.set(`f${j}`, shapeMap(geo(`f${j}`, j)));
    });
    const want = Math.min(n, i + batch);
    await waitFor(() => (app.manager.get(key)?.doc.getMap('shapes').size ?? 0) >= want, 30_000, 'fill');
  }
  return Y.encodeStateAsUpdate(app.manager.get(key)!.doc).byteLength;
}
/** A raw socket as user `cookie` (no Y.Doc in this process); resolves once open. */
async function raw(app: App, key: string, cookie?: string): Promise<{ ws: WebSocket; bytes: () => number; closed: Promise<number> }> {
  const ws = new WebSocket(`${base(app)}/${key}`, { headers: { origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) } });
  let n = 0;
  ws.on('message', (d: Buffer) => (n += d.length));
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  return { ws, bytes: () => n, closed };
}
const serverConn = (app: App, key: string, user: string) =>
  [...(app.manager.get(key)?.conns.values() ?? [])].find((c) => c.identity.id === user);

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv4-static-'));
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

describe('fv4 H1: sync step 1 is no amplifier', () => {
  it('poc1: 200 empty step 1 messages from a paused socket get one answer and a 4429; server memory stays flat', async () => {
    const app = await startApp();
    const key = 'u/h1/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    const roomBytes = await fill(app, key, ana, 8000);
    expect(roomBytes).toBeGreaterThan(2_500_000);
    const eve = await raw(app, key, 'sid=eve');
    await sleep(300);
    (eve.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // never reads again
    const rss0 = process.memoryUsage().rss;
    for (let i = 0; i < 200; i++) eve.ws.send(STEP1_EMPTY);
    await waitFor(() => serverConn(app, key, 'eve@corp')?.closing !== false, 5000, 'eve closed');
    await sleep(500);
    const grew = process.memoryUsage().rss - rss0;
    // before: every message was answered with the whole room (+3 030 MB for 200 messages on
    // a 15.5 MB room); now one answer (a diff against the join), then 4429
    expect(grew).toBeLessThan(100 * 1024 * 1024);
    expect(serverConn(app, key, 'eve@corp')?.step1Answers ?? 1).toBe(1);
    eve.ws.terminate();
    ana.close();
  });

  it('every answer is a diff against what the join sent: a forged state vector gets no copy of the room', async () => {
    const app = await startApp();
    const key = 'u/h1b/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    const roomBytes = await fill(app, key, ana, 3000);
    const eve = await raw(app, key, 'sid=eve');
    await sleep(300);
    const afterJoin = eve.bytes();
    expect(afterJoin).toBeGreaterThan(roomBytes); // the join: ledger + full content, once
    // a state vector naming an unknown client at clock 0 (it "has nothing"): answered with
    // what the room has beyond the join — nothing but the delete set
    const forged = encoding.createEncoder();
    encoding.writeVarUint(forged, 1);
    encoding.writeVarUint(forged, 987654);
    encoding.writeVarUint(forged, 0);
    for (let i = 0; i < 5; i++) eve.ws.send(syncMsg(0, encoding.toUint8Array(forged)));
    await sleep(300);
    expect(eve.bytes() - afterJoin).toBeLessThan(5_000);
    // an empty state vector after the first answer: 4429
    eve.ws.send(STEP1_EMPTY);
    expect(await eve.closed).toBe(4429);
    ana.close();
  });

  it('an honest y-websocket client joins a room bigger than the outgoing-buffer cap and syncs', async () => {
    const app = await startApp({ WS_MAX_BUFFERED_BYTES: String(64 * 1024) });
    const key = 'u/h1c/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    await fill(app, key, ana, 3000);
    class OriginWs extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { origin: TEST_ORIGIN, cookie: 'sid=bob' } });
      }
    }
    const doc = new Y.Doc();
    const prov = new WebsocketProvider(base(app), key, doc, { WebSocketPolyfill: OriginWs as never, disableBc: true, maxBackoffTime: 300 });
    prov.messageHandlers[102] = () => undefined;
    await waitFor(() => doc.getMap('shapes').size === 3000, 10_000, 'bob synced');
    doc.getMap('shapes').set('bob1', shapeMap(geo('bob1')));
    await waitFor(() => app.manager.get(key)!.doc.getMap('shapes').has('bob1'), 3000, 'bob wrote');
    prov.destroy();
    ana.close();
  });

  it('a peer that stops reading is dropped once the server holds more than the cap for it', async () => {
    const app = await startApp({ WS_MAX_BUFFERED_BYTES: String(256 * 1024) });
    const key = 'u/h1d/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    const eve = await raw(app, key, 'sid=eve');
    await sleep(200);
    (eve.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    for (let i = 0; i < 60; i++) {
      ana.doc.getMap('meta').set(`k${i}`, 'z'.repeat(40_000)); // broadcast to everyone
      await sleep(5);
    }
    await waitFor(() => serverConn(app, key, 'eve@corp') === undefined, 5000, 'eve dropped');
    expect(serverConn(app, key, 'ana@corp')).toBeDefined();
    ana.close();
  });

  it('joins are limited per principal (anonymous visitors stricter, per visitor and per room)', async () => {
    const app = await startApp({ JOIN_BURST: '3', JOIN_RATE_PER_MIN: '1', ANON_JOIN_BURST: '2', ANON_JOIN_RATE_PER_MIN: '1', ANON_ROOM_JOIN_BURST: '3', ANON_ROOM_JOIN_RATE_PER_MIN: '1' });
    const key = 'u/joins/index.html';
    users(key);
    const codes: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const c = new TestClient(`${base(app)}/${key}`, 'sid=eve');
      await c.connect();
      codes.push(await Promise.race([c.closed, sleep(300).then(() => null)]));
      c.close();
    }
    expect(codes.slice(0, 3)).toEqual([null, null, null]);
    expect(codes.slice(3)).toEqual([4429, 4429]);
    // another user is not affected
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    expect(await Promise.race([bob.closed, sleep(300).then(() => null)])).toBeNull();
    bob.close();
    // anonymous: per visitor, and dropping the cookie does not reset the room's bucket
    core.rules.set('pub/joins.html', allowAnon());
    const anonCodes: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new TestClient(`${base(app)}/pub/joins.html`); // a new visitor each time
      await c.connect();
      anonCodes.push(await Promise.race([c.closed, sleep(300).then(() => null)]));
      c.close();
    }
    expect(anonCodes.filter((c) => c === 4429).length).toBe(1);
  });
});

describe('fv4 H2: the guard is O(update), never O(room)', () => {
  it('poc2: the 46-byte "type set twice" update is refused in < 10 ms on a big room; the event loop never blocks', async () => {
    const app = await startApp();
    const key = 'u/h2/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    await fill(app, key, ana, 8000);
    const room = app.manager.get(key)!;
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(room.doc));
    const craft = (id: string) => {
      let upd: Uint8Array | null = null;
      const on = (u: Uint8Array, o: unknown) => {
        if (o === 'x') upd = u;
      };
      probe.on('update', on);
      probe.transact(() => {
        const m = probe.getMap('shapes').get(id) as Y.Map<unknown>;
        m.set('type', 'geo');
        m.set('type', 'geo');
      }, 'x');
      probe.off('update', on);
      return upd!;
    };
    const u = craft('f1');
    expect(u.byteLength).toBeLessThan(100);
    const t0 = performance.now();
    expect(checkClientUpdate(room.doc, u).bad).toBe('shapes-schema');
    expect(performance.now() - t0).toBeLessThan(10); // before: 424-966 ms (slow path)
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const eve = await raw(app, key, 'sid=eve');
      await sleep(200);
      const hist = monitorEventLoopDelay({ resolution: 1 });
      hist.enable();
      eve.ws.send(syncMsg(2, craft(`f${i + 2}`)));
      expect(await eve.closed).toBe(4403);
      hist.disable();
      worst = Math.max(worst, hist.max / 1e6);
    }
    expect(worst).toBeLessThan(100); // before: 19.5 s for 20 messages, no break
    expect((room.doc.getMap('shapes').get('f2') as Y.Map<unknown>).get('type')).toBe('geo');
    ana.close();
  }, 60_000);

  it('origin chains of any length resolve in one pass (the old fast path gave up at depth 64)', () => {
    const room = materializeContent(new Y.Doc());
    const c = new Y.Doc();
    c.clientID = 5150;
    Y.applyUpdate(c, Y.encodeStateAsUpdate(room));
    c.transact(() => c.getMap('shapes').set('s', shapeMap(geo('s'))));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(c));
    const sv = Y.encodeStateVector(c);
    // 20 000 interleaved overwrites (x, y, x, y, ...): every new item's origin is the previous
    // one at its key, so the update is one 10 000-long origin chain per key
    const m = c.getMap('shapes').get('s') as Y.Map<unknown>;
    for (let i = 0; i < 10_000; i++) {
      m.set('x', i);
      m.set('y', i);
    }
    const u = Y.encodeStateAsUpdate(c, sv);
    const t0 = performance.now();
    expect(checkClientUpdate(room, u).bad).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    // the same chain with a forbidden value at its end is still refused
    m.set('x', 'not a number' as never);
    expect(checkClientUpdate(room, Y.encodeStateAsUpdate(c, sv)).bad).toBe('shapes-schema');
  });

  it('a connection that keeps the event loop busy is closed by its CPU budget', async () => {
    const app = await startApp({ CPU_MS_PER_SEC: '1', CPU_BURST_MS: '30' });
    const key = 'u/cpu/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    let n = 0;
    for (let i = 0; i < 40 && ana.closeCode === null; i++) {
      ana.doc.transact(() => {
        for (let j = 0; j < 500; j++) ana.doc.getMap('shapes').set(`c${n}`, shapeMap(geo(`c${n++}`)));
      });
      const code = await Promise.race([ana.closed, sleep(50).then(() => null)]);
      if (code !== null) {
        expect(code).toBe(4429);
        expect(ana.notices.some((x) => x.kind === 'rate-limited')).toBe(true);
        return;
      }
    }
    throw new Error('the CPU budget never closed the sender');
  });
});

describe('fv4 M2-M4', () => {
  it('M2: assets accept only raster data URLs (live L1: /oauth2/sign_out as an image asset)', () => {
    const room = materializeContent(new Y.Doc());
    const edit = (v: unknown) => {
      const c = new Y.Doc();
      c.getMap('assets').set('a', v);
      return Y.encodeStateAsUpdate(c);
    };
    for (const bad of ['/oauth2/sign_out', 'https://x.example/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:x', 'data:image/png;base64,AA AA', 'data:text/html;base64,AAAA']) {
      expect(checkClientUpdate(room, edit(bad)).bad, bad).toBe('assets-schema');
    }
    for (const ok of ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,/9j/', 'data:image/gif;base64,R0lG', 'data:image/webp;base64,UklG']) {
      expect(checkClientUpdate(room, edit(ok)).bad, ok).toBeNull();
    }
  });

  it('M3: awareness states are schema-checked before they are relayed (live L4)', () => {
    const room = new awarenessProtocol.Awareness(new Y.Doc());
    room.setLocalState(null);
    const identity = { id: 'eve@corp', name: 'Eve', anonymous: false, attribution: 'server' as const };
    const srcDoc = new Y.Doc();
    srcDoc.clientID = 77;
    const src = new awarenessProtocol.Awareness(srcDoc);
    const send = (state: unknown) => {
      src.setLocalState(state as Record<string, unknown>);
      const out = sanitizeAwarenessUpdate(awarenessProtocol.encodeAwarenessUpdate(src, [77]), new Set([77]), room, identity);
      if (out) awarenessProtocol.applyAwarenessUpdate(room, out, null);
      return room.getStates().get(77) as Record<string, unknown> | undefined;
    };
    expect(send({ cursor: { x: 50, y: 50 }, laser: { pts: null, now: 1 }, status: 5, junk: 'x'.repeat(100) })).toEqual({
      cursor: { x: 50, y: 50 }, laser: null, status: null, user: { id: 'eve@corp', name: 'Eve', anonymous: false },
    });
    const now = Date.now();
    expect(send({ laser: { pts: Array.from({ length: 61 }, () => [1, 2, now]), now } })?.laser).toBeNull();
    expect(send({ laser: { pts: Array.from({ length: 60 }, () => [1, 2, now]), now } })?.laser).toMatchObject({ now });
    // a state bigger than the cap is dropped unread (the previous one stays)
    const before = room.getStates().get(77);
    send({ cursor: { x: 1, y: 1 }, pad: 'p'.repeat(20_000) });
    expect(room.getStates().get(77)).toEqual(before);
  });

  it('M4: the ledger counts against the size cap (poc3: create/delete cycles)', async () => {
    const app = await startApp({ MAX_DOC_BYTES: String(400 * 1024), ANON_MAX_DOC_BYTES: String(200 * 1024) });
    const key = 'u/m4/index.html';
    users(key);
    const ana = new TestClient(`${base(app)}/${key}`); // keeps the room loaded
    await ana.connect();
    const eve = new TestClient(`${base(app)}/${key}`, 'sid=eve');
    await eve.connect();
    const room = app.manager.get(key)!;
    let n = 0;
    for (let cycle = 0; cycle < 40; cycle++) {
      const ids: string[] = [];
      eve.doc.transact(() => {
        for (let i = 0; i < 500; i++) {
          const k = (n++).toString(36);
          ids.push(k);
          eve.doc.getMap('shapes').set(k, shapeMap(geo(k)));
        }
      });
      if ((await Promise.race([eve.closed, sleep(150).then(() => null)])) !== null) break;
      eve.doc.transact(() => {
        for (const k of ids) eve.doc.getMap('shapes').delete(k);
      });
      if ((await Promise.race([eve.closed, sleep(150).then(() => null)])) !== null) break;
    }
    expect(await Promise.race([eve.closed, sleep(2000).then(() => null)])).toBe(4413);
    await sleep(200);
    const total = Y.encodeStateAsUpdate(room.doc).byteLength + Y.encodeStateAsUpdate(room.ledger).byteLength;
    // before: the ledger alone reached 7x the content cap and kept growing
    expect(total).toBeLessThan(400 * 1024 + 64 * 1024);
    ana.close();
  });

  it('M4: attribution of shapes deleted longer ago than the retention is pruned', () => {
    const content = materializeContent(new Y.Doc());
    const ledger = materializeLedger(new Y.Doc());
    let now = 1_000_000;
    attachStamper(content, ledger, { userOf: (o) => (o === 'ana' ? { id: 'ana', info: { name: 'Ana', anonymous: false } } : null), now: () => now });
    content.transact(() => {
      for (const id of ['keep', 'old', 'recent']) content.getMap('shapes').set(id, shapeMap(geo(id)));
    }, 'ana');
    content.transact(() => content.getMap('shapes').delete('old'), 'ana');
    const att = ledger.getMap<{ deletedAt?: number }>('attribution');
    expect(att.get('old')?.deletedAt).toBe(now);
    now += 20 * 86400_000;
    content.transact(() => content.getMap('shapes').delete('recent'), 'ana');
    now += 15 * 86400_000; // old: deleted 35 days ago, recent: 15 days ago
    expect(pruneAttribution(content, ledger, now, 30 * 86400_000)).toBe(1);
    expect([...att.keys()].sort()).toEqual(['keep', 'recent']);
    // an undo of the delete (the shape comes back) clears deletedAt and keeps the author
    content.transact(() => content.getMap('shapes').set('recent', shapeMap(geo('recent'))), 'ana');
    expect(att.get('recent')?.deletedAt).toBeUndefined();
    // an entry for a missing shape stored before deletedAt existed starts its clock now
    ledger.getMap('attribution').set('legacy', { createdBy: 'x', createdAt: 1, updatedBy: 'x', updatedAt: 1 });
    expect(pruneAttribution(content, ledger, now, 30 * 86400_000)).toBe(0);
    expect(att.get('legacy')?.deletedAt).toBe(now);
  });
});

// keep the decoder import used (raw message inspection helpers above use encoding only)
void decoding;
