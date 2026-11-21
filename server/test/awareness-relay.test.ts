/**
 * Awareness relay (protocol §4.2), through the real server:
 *   - an update goes once to every other member of the room, never back to its sender, except a
 *     renewal (the same state at a newer clock), which keeps a lone stock client's socket alive;
 *   - a member that sends back what the room relayed to it (the stock y-websocket 3.1.0 client
 *     does, for every state it receives) is not charged for it: the room's traffic must not close
 *     the members it was sent to. Before, every tab paid for every other tab's updates, so a
 *     presentation of 10 tabs closed every tab 4429;
 *   - that allowance is bounded by what the room relayed: echoes beyond it are charged as usual.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, waitFor } from './helpers/yclient.js';

let core: FakeCore;
let staticDir: string;
let portSeq = 27300;
const apps: App[] = [];
const clients: TestClient[] = [];

async function startApp(env: Record<string, string> = {}): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '30', SAVE_DEBOUNCE_MS: '50',
      READYZ_CACHE_MS: '10', PORT: String(++portSeq), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0', ...env,
    });
    const app = createApp({ config: cfg, store: new MemoryCanvasObjectStore(), logger: createLogger('silent') });
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

async function join(app: App, key: string, cookie: string | undefined, echo: boolean): Promise<TestClient> {
  const c = new TestClient(`${base(app)}/${key}`, cookie);
  c.echoRemoteAwareness = echo;
  clients.push(c);
  await c.connect();
  expect(c.closeCode).toBeNull();
  return c;
}
const counter = async (app: App, name: 'awarenessEchoes') => (await app.metrics[name].get()).values[0]?.value ?? 0;
const rateLimited = async (app: App) =>
  (await app.metrics.wsRejected.get()).values.filter((v) => v.labels.reason === 'rate_limited').reduce((a, v) => a + v.value, 0);
/** Messages received by `c` since index `from` that carry `id`. */
const carrying = (c: TestClient, id: number, from = 0) => c.awarenessIn.slice(from).filter((ids) => ids.includes(id)).length;

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>c</title>');
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});
afterAll(async () => {
  await core.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});

function users(key: string) {
  core.rules.set(key, allowUser('ana@corp', 'Ana'));
  core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
  core.rulesByCookie.set(`sid=eve|${key}`, allowUser('eve@corp', 'Eve'));
}

describe('an awareness update goes once to every other member', () => {
  it('the others get each change once; its sender gets none of its changes back, only its renewals', async () => {
    const app = await startApp();
    const key = 'u/aw-relay/index.html';
    users(key);
    const ana = await join(app, key, undefined, false);
    const bob = await join(app, key, 'sid=bob', false);
    const eve = await join(app, key, 'sid=eve', false);
    const id = ana.awareness.clientID;
    const marks = [ana, bob, eve].map((c) => c.awarenessIn.length);
    for (let i = 1; i <= 10; i++) ana.setAwareness({ cursor: { x: i, y: i } });
    const seen = (c: TestClient) => (c.awareness.getStates().get(id) as { cursor?: { x: number } } | undefined)?.cursor?.x === 10;
    await waitFor(() => seen(bob) && seen(eve), 3000, 'the others see the last cursor');
    await sleep(200);
    expect(carrying(bob, id, marks[1])).toBe(10);
    expect(carrying(eve, id, marks[2])).toBe(10);
    expect(carrying(ana, id, marks[0])).toBe(0);
    // a renewal (the state unchanged, its clock raised; y-protocols sends one every 15 s): to everyone,
    // its sender too (a lone stock client hears nothing else and y-websocket closes after 30 s of silence)
    ana.setAwareness(ana.awareness.getLocalState()!);
    await waitFor(() => carrying(ana, id, marks[0]) === 1 && carrying(bob, id, marks[1]) === 11 && carrying(eve, id, marks[2]) === 11, 3000, 'renewal');
    // the canvas client and this one send only their own state: nothing was echoed
    expect([ana, bob, eve].flatMap((c) => c.awarenessOut.filter((ids) => ids.some((x) => x !== c.awareness.clientID)))).toEqual([]);
    expect(await counter(app, 'awarenessEchoes')).toBe(0);
  });
});

describe('what the room relayed is not charged to the members it was sent to', () => {
  it('a stock client that echoes every update it gets stays connected under a message rate the echoes alone exceed', async () => {
    // Bob (signed in) may send 1 message/s, 5 at once; Ana (anonymous) moves her cursor 60 times
    const app = await startApp({ MSG_RATE_PER_SEC: '1', MSG_BURST: '5', ANON_MSG_RATE_PER_SEC: '1000', ANON_MSG_BURST: '1000' });
    const key = 'pub/aw-echo/index.html';
    core.rules.set(key, allowAnon());
    core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
    const ana = await join(app, key, undefined, false);
    const bob = await join(app, key, 'sid=bob', true);
    const id = ana.awareness.clientID;
    for (let i = 1; i <= 60; i++) {
      ana.setAwareness({ cursor: { x: i, y: 0 } });
      await sleep(5);
    }
    await waitFor(() => (bob.awareness.getStates().get(id) as { cursor?: { x: number } } | undefined)?.cursor?.x === 60, 5000, 'bob got the last cursor');
    await sleep(300);
    // Bob sent every one of them back (the stock client), and the server dropped them unpaid
    const echoed = bob.awarenessOut.filter((ids) => ids.includes(id)).length;
    expect(echoed).toBeGreaterThanOrEqual(60);
    expect(await counter(app, 'awarenessEchoes')).toBeGreaterThanOrEqual(60);
    expect(bob.closeCode).toBeNull();
    expect(await rateLimited(app)).toBe(0);
    // nothing of the echoes reached the room: Ana's state is hers, not Bob's
    const room = app.manager.get(key)!;
    expect((room.awareness.getStates().get(id) as { user?: { anonymous?: boolean } }).user?.anonymous).toBe(true);
    // Bob's own state still goes through, and is charged
    bob.setAwareness({ cursor: { x: 7, y: 7 } });
    await waitFor(() => (ana.awareness.getStates().get(bob.awareness.clientID) as { cursor?: { x: number } } | undefined)?.cursor?.x === 7, 3000, 'ana sees bob');
  });

  it('echo-shaped messages beyond what the room relayed are charged: the connection is closed 4429 as before', async () => {
    const app = await startApp({ MSG_RATE_PER_SEC: '1', MSG_BURST: '5' });
    const key = 'u/aw-forged/index.html';
    users(key);
    const ana = await join(app, key, undefined, false);
    ana.setAwareness({ cursor: { x: 1, y: 1 } });
    const bob = await join(app, key, 'sid=bob', false);
    await waitFor(() => bob.awareness.getStates().has(ana.awareness.clientID), 3000, 'bob sees ana');
    // Bob repeats Ana's state (a known client id, a clock the room has) 30 times; the room relayed
    // one update to him (the states at his join)
    const msg = (() => {
      const st = app.manager.get(key)!.awareness;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(st, [ana.awareness.clientID]));
      return encoding.toUint8Array(e);
    })();
    for (let i = 0; i < 30 && bob.closeCode === null; i++) bob.sendRaw(msg);
    expect(await bob.closed).toBe(4429);
    expect(await counter(app, 'awarenessEchoes')).toBe(1);
    expect(ana.closeCode).toBeNull();
  });
});
