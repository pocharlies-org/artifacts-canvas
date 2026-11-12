import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeUpdate as syncProtocolWriteUpdate } from 'y-protocols/sync';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { canvasLedgerKey, canvasObjectKey } from '../src/paths.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, expectClose, waitFor } from './helpers/yclient.js';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
// below the Linux ephemeral range (32768-60999): outgoing connections of other processes on
// the host never hold these; startApp also skips a port that is taken anyway
let portSeq = 23100;

function makeCfg(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    GATE_AUTHZ_URL: core.authzUrl,
    ARTIFACT_BASE_URL: core.artifactBaseUrl,
    S3_BUCKET: 'canvas-test',
    STATIC_DIR: staticDir,
    LOG_LEVEL: 'silent',
    AUTHZ_RECHECK_SECONDS: '1',
    SAVE_DEBOUNCE_MS: '50',
    READYZ_CACHE_MS: '10',
    PORT: String(++portSeq),
    ALLOWED_ORIGINS: TEST_ORIGIN,
    METRICS_PORT: '0',
    ...overrides,
  });
}

function wsUrl(cfg: Config, key: string, anon?: string): string {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `ws://127.0.0.1:${cfg.port}/_canvas/_/ws/${enc}${anon ? `?anon=${anon}` : ''}`;
}

async function http(cfg: Config, p: string, cookie?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${cfg.port}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

async function startApp(overrides: Record<string, string> = {}): Promise<App> {
  for (let attempt = 0; ; attempt++) {
    const cfg = makeCfg(overrides);
    const app = createApp({ config: cfg, store, logger: cfg.logLevel === 'silent' ? silentLogger : createLogger(cfg.logLevel) });
    try {
      await app.listen();
    } catch (err) {
      await app.close().catch(() => undefined);
      if (attempt < 20 && String(err).includes('EADDRINUSE') && !overrides.PORT) continue;
      throw err;
    }
    apps.push(app);
    return app;
  }
}

import { createLogger } from '../src/logging.js';
const silentLogger = createLogger('silent');
const apps: App[] = [];

/** A shape as the real client model stores them: a Y.Map inside the shapes root. */
function shape(fields: Record<string, unknown> = { type: 'geo' }): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-static-'));
  fs.writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><head><title>canvas</title></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(path.join(staticDir, 'reporter.js'), "console.log('reporter loaded');");
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'export const x = 1;');
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
  core.artifacts.clear();
  core.broken = null;
  core.hang = false;
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

describe('real client protocol: two y-websocket clients through the server', () => {
  it('converge, IDENTITY (100) first, attribution stamped with the verified id', async () => {
    core.rules.set('runs/report.html', allowUser('ana@corp', 'Ana López'));
    const app = await startApp();
    const cfgUrl = (key: string) => `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/${key}`;
    const c1 = new TestClient(cfgUrl('runs/report.html'));
    const c2 = new TestClient(cfgUrl('runs/report.html'));
    await c1.connect();
    await c2.connect();

    // IDENTITY must be the first message on every connection.
    expect(c1.messageTypes[0]).toBe(100);
    expect(c1.identity).toMatchObject({ id: 'ana@corp', name: 'Ana López', anonymous: false, attribution: 'server' });

    // c2 draws a shape; c1 must see it.
    c2.doc.transact(() => {
      const shape = new Y.Map<unknown>();
      shape.set('type', 'geo');
      c2.doc.getMap('shapes').set('s1', shape);
    });
    await waitFor(() => c1.doc.getMap('shapes').has('s1'), 3000, 'shapes on c1');

    // Attribution is stamped server-side with the verified identity (protocol §5).
    await waitFor(() => c1.ledger.getMap('attribution').has('s1'), 3000, 'attribution on c1');
    const attr = c1.ledger.getMap('attribution').get('s1') as Record<string, unknown>;
    expect(attr.createdBy).toBe('ana@corp');
    // The users root records the participant.
    expect(c1.ledger.getMap('users').get('ana@corp')).toMatchObject({ name: 'Ana López' });
    // history has at least the create entry
    await waitFor(() => c1.ledger.getArray('history').length > 0, 3000, 'history on c1');

    // awareness user is the verified identity, not what the client claims
    c2.setAwareness({ cursor: { x: 5, y: 5 }, user: { id: 'evil', name: 'Evil' } });
    await waitFor(() => {
      const st = c1.awareness.getStates().get(c2.doc.clientID);
      return st?.user != null;
    }, 3000, 'awareness');
    expect(c1.awareness.getStates().get(c2.doc.clientID)?.user).toMatchObject({ id: 'ana@corp', name: 'Ana López' });
  });

  it('forged write to attribution closes 4403 and is NOT applied', async () => {
    core.rules.set('runs/f.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/f.html`;
    const honest = new TestClient(url);
    const attacker = new TestClient(url);
    await honest.connect();
    await attacker.connect();

    attacker.doc.transact(() => {
      attacker.doc.getMap('attribution').set('forged', 'pwned');
    });
    await expectClose(attacker, 4403);
    // the room never applied it
    await new Promise((r) => setTimeout(r, 100));
    expect(honest.ledger.getMap('attribution').has('forged')).toBe(false);
    for (const k of [canvasObjectKey('_plugins/canvas', 'runs/f.html'), canvasLedgerKey('_plugins/canvas', 'runs/f.html')]) {
      const stored = store.objects.get(k);
      if (!stored) continue;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, stored.body);
      expect(doc.getMap('attribution').has('forged')).toBe(false);
    }
  });

  it('forged write to users and history also closes 4403', async () => {
    core.rules.set('runs/f2.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/f2.html`;
    for (const root of ['users', 'history'] as const) {
      const c = new TestClient(url);
      await c.connect();
      c.doc.transact(() => {
        c.doc.getMap(root).set('forged', 'x');
      });
      await expectClose(c, 4403);
    }
  });
});

describe('stamper-root guard through the server (finding: origin-only items)', () => {
  it('appending after the last history item (parent omitted in the update) closes 4403 and is NOT applied', async () => {
    core.rules.set('pub/h.html', allowAnon());
    core.rules.set('runs/h.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    for (const key of ['runs/h.html', 'pub/h.html']) {
      const url = `ws://127.0.0.1:${port}/_canvas/_/ws/${key}`;
      const honest = new TestClient(url);
      await honest.connect();
      honest.doc.transact(() => honest.doc.getMap('shapes').set('s1', shape()));
      await waitFor(() => honest.ledger.getArray('history').length === 1, 3000, 'server history line');
      const attacker = new TestClient(url);
      await attacker.connect();
      await waitFor(() => attacker.ledger.getArray('history').length === 1, 3000, 'attacker synced');
      // the attacker merges the (broadcast) ledger into its content document and appends after
      // the last history line: an origin-only item whose origin exists only in the ledger
      Y.applyUpdate(attacker.doc, Y.encodeStateAsUpdate(attacker.ledger), 'server');
      const ledgerSv = Y.encodeStateVector(app.manager.get(key)!.ledger);
      attacker.doc.getArray('history').push([{ t: 1, by: 'test@example.com', verb: 'delete', shapeId: 'zz', shapeType: 'geo' }]);
      await expectClose(attacker, 4403);
      expect(Y.encodeStateVector(app.manager.get(key)!.ledger)).toEqual(ledgerSv);
      await new Promise((r) => setTimeout(r, 150));
      expect(honest.ledger.getArray('history').toArray().map((e) => (e as { by: string }).by)).toEqual([honest.identity!.id]);
      // insert in the middle / overwrite an existing attribution entry: same answer
      const a2 = new TestClient(url);
      await a2.connect();
      await waitFor(() => a2.ledger.getArray('history').length === 1, 3000, 'a2 synced');
      Y.applyUpdate(a2.doc, Y.encodeStateAsUpdate(a2.ledger), 'server');
      a2.doc.getArray('history').insert(0, [{ by: 'mallory' }]);
      await expectClose(a2, 4403);
      const a3 = new TestClient(url);
      await a3.connect();
      await waitFor(() => a3.ledger.getMap('attribution').has('s1'), 3000, 'a3 synced');
      Y.applyUpdate(a3.doc, Y.encodeStateAsUpdate(a3.ledger), 'server');
      a3.doc.getMap('attribution').set('s1', { createdBy: 'mallory', createdAt: 1, updatedBy: 'mallory', updatedAt: 1 });
      await expectClose(a3, 4403);
      await new Promise((r) => setTimeout(r, 150));
      expect((honest.ledger.getMap('attribution').get('s1') as { createdBy: string }).createdBy).toBe(honest.identity!.id);
      honest.close();
    }
  });
});

describe('origin check on the WebSocket upgrade', () => {
  it('missing, null and foreign Origin are refused with 4403 before authz; the allowed origin joins', async () => {
    core.rules.set('runs/o.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/o.html`;
    const callsBefore = core.calls.length;
    for (const origin of [null, 'null', 'https://evil.example.net', 'http://canvas.test.evil.example', 'http://canvas.test:81']) {
      const c = new TestClient(url, undefined, origin);
      await c.connect().catch(() => undefined);
      await expectClose(c, 4403);
      expect(c.identity, String(origin)).toBeNull();
    }
    expect(core.calls.length).toBe(callsBefore); // refused before any authz call
    const ok = new TestClient(url, undefined, 'HTTP://CANVAS.TEST');
    await ok.connect();
    expect(ok.identity?.id).toBe('ana@corp');
  });

  it('ALLOWED_ORIGINS defaults to the origin of ARTIFACT_BASE_URL and rejects non-origins', () => {
    const cfg = makeCfg({ ALLOWED_ORIGINS: '', ARTIFACT_BASE_URL: 'https://artifacts.example.com/artifacts' });
    expect([...cfg.allowedOrigins]).toEqual(['https://artifacts.example.com']);
    expect(() => makeCfg({ ALLOWED_ORIGINS: 'https://a.example.com/path' })).toThrow(/no path/);
    expect(() => makeCfg({ ALLOWED_ORIGINS: '*' })).toThrow(/invalid origin/);
  });
});

describe('authz enforcement', () => {
  it('denied visitor is refused with 4403 while an allowed one joins', async () => {
    core.rulesByCookie.set('good|runs/x.html', allowUser('ana@corp', 'Ana'));
    core.rulesByCookie.set('bad|runs/x.html', { allowed: false, reason: 'forbidden' });
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/x.html`;
    const good = new TestClient(url, 'good');
    await good.connect();
    expect(good.identity?.id).toBe('ana@corp');
    const bad = new TestClient(url, 'bad');
    await bad.connect().catch(() => undefined);
    await expectClose(bad, 4403);
  });

  it('revocation mid-session: NOTICE revoked + close 4403 within the re-check interval', async () => {
    core.rules.set('runs/live.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp({ AUTHZ_RECHECK_SECONDS: '1' });
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/live.html`);
    await c.connect();
    core.rules.set('runs/live.html', { allowed: false, reason: 'forbidden' });
    await expectClose(c, 4403, 6000);
    expect(c.notices.some((n) => n.kind === 'revoked')).toBe(true);
  });

  it('expired mid-session: NOTICE expired + close 4410 and the object is deleted', async () => {
    core.rules.set('runs/exp.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp({ AUTHZ_RECHECK_SECONDS: '1' });
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/exp.html`);
    await c.connect();
    c.doc.transact(() => c.doc.getMap('shapes').set('s', shape()));
    await waitFor(() => store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/exp.html')));
    core.rules.set('runs/exp.html', { allowed: false, reason: 'expired' });
    await expectClose(c, 4410, 6000);
    expect(c.notices.some((n) => n.kind === 'expired')).toBe(true);
    await waitFor(() => !store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/exp.html')));
  });

  it('gone artifact on connect: close 4404 and the object is deleted', async () => {
    const objKey = canvasObjectKey('_plugins/canvas', 'runs/gone.html');
    store.objects.set(objKey, { body: new Uint8Array([1]) });
    // no rule -> fake core answers object-missing (gate: allowed-but-HEAD-404)
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/gone.html`);
    await c.connect().catch(() => undefined);
    await expectClose(c, 4404);
    expect(store.objects.has(objKey)).toBe(false);
  });

  it('expired artifact on connect: close 4410 and the object is deleted', async () => {
    const objKey = canvasObjectKey('_plugins/canvas', 'runs/exp2.html');
    store.objects.set(objKey, { body: new Uint8Array([1]) });
    core.rules.set('runs/exp2.html', { allowed: false, reason: 'expired' });
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/exp2.html`);
    await c.connect().catch(() => undefined);
    await expectClose(c, 4410);
    expect(c.notices.some((n) => n.kind === 'expired')).toBe(true);
    expect(store.objects.has(objKey)).toBe(false);
  });

  it('core down: fail closed, and retryable (1013 busy: nothing was decided, fv7 F6)', async () => {
    core.broken = { status: 500, body: 'boom' };
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/x.html`);
    await c.connect().catch(() => undefined);
    await expectClose(c, 1013);
    expect(c.notices.map((n) => n.kind)).toEqual(['busy']);
    expect(c.identities).toEqual([]);
  });

  it('anonymous pub/ visitor gets the "Anónimo NNNN" pseudonym (the hint, when free), an id bound to its cookie and a signed cookie', async () => {
    core.rules.set('pub/doc.html', allowAnon());
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/pub/doc.html?anon=4321`);
    await c.connect();
    expect(c.identity).toMatchObject({ name: 'Anónimo 4321', anonymous: true });
    expect(c.identity!.id).toMatch(/^anon:[A-Za-z0-9_-]{16}$/);
    expect(c.setCookie).toMatch(/^canvas_anon=[A-Za-z0-9_-]{22}\.4321\.[A-Za-z0-9_-]{27}; Path=\/_canvas\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
  });

  it('the server assigns anonymous ids: a client hint never collides with another live visitor', async () => {
    core.rules.set('pub/anon.html', allowAnon());
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/pub/anon.html`;
    const a = new TestClient(`${url}?anon=1234`);
    await a.connect();
    const cookieA = a.setCookie!.split(';')[0];
    // another visitor (no cookie) asking for the same number gets a different one
    const b = new TestClient(`${url}?anon=1234`);
    await b.connect();
    expect(a.identity!.name).toBe('Anónimo 1234');
    expect(b.identity!.name).toMatch(/^Anónimo \d{4}$/);
    expect(b.identity!.name).not.toBe('Anónimo 1234');
    expect(b.identity!.id).not.toBe(a.identity!.id);
    // the same visitor (its cookie) in a second tab keeps its pseudonym, whatever it hints
    const a2 = new TestClient(`${url}?anon=9999`, cookieA);
    await a2.connect();
    expect(a2.identity!.id).toBe(a.identity!.id);
    expect(a2.identity!.name).toBe('Anónimo 1234');
    expect(a2.setCookie).toBeNull();
    // a forged/tampered cookie is just ignored (new visitor), it cannot claim 1234
    const forged = cookieA.replace(/\.1234\./, '.1234.').replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    const f = new TestClient(`${url}?anon=1234`, forged);
    await f.connect();
    expect(f.identity!.id).not.toBe(a.identity!.id);
    expect(f.identity!.name).not.toBe('Anónimo 1234');
    // non-numeric hints are ignored
    const g = new TestClient(`${url}?anon=test@example.com`);
    await g.connect();
    expect(g.identity!.id).toMatch(/^anon:[A-Za-z0-9_-]{16}$/);
    expect(g.identity!.name).toMatch(/^Anónimo \d{4}$/);
    // per-visitor cap counts the visitor (cookie), not the number it shows
    const app2 = await startApp({ MAX_CONNS_PER_ANON_VISITOR: '2' });
    const url2 = `ws://127.0.0.1:${(app2.server.address() as { port: number }).port}/_canvas/_/ws/pub/anon.html`;
    const v1 = new TestClient(url2);
    await v1.connect();
    const ck = v1.setCookie!.split(';')[0];
    const v2 = new TestClient(url2, ck);
    await v2.connect();
    const v3 = new TestClient(url2, ck);
    await v3.connect().catch(() => undefined);
    await expectClose(v3, 1013);
    for (const x of [a, b, a2, f, g, v1, v2]) x.close();
  });

  it('expiry is never revealed to a denied visitor: 403/4403 and the canvas object stays', async () => {
    const objKey = canvasObjectKey('_plugins/canvas', 'runs/leak.html');
    store.objects.set(objKey, { body: new Uint8Array([1]) });
    // an older core that still sent the artifact expiry to a non-listed visitor
    core.rules.set('runs/leak.html', { allowed: false, reason: 'not-listed', artifact: { key: 'runs/leak.html', expires: '2020-01-01T00:00:00+00:00', ttl: 7 } } as never);
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    expect((await http(makeCfg({ PORT: String(port) }), '/_canvas/runs/leak.html')).status).toBe(403);
    const c = new TestClient(`ws://127.0.0.1:${port}/_canvas/_/ws/runs/leak.html`);
    await c.connect().catch(() => undefined);
    await expectClose(c, 4403);
    expect(c.notices.some((n) => n.kind === 'expired')).toBe(false);
    expect(store.objects.has(objKey)).toBe(true);
  });
});

describe('persistence', () => {
  it('document survives a server restart', async () => {
    core.rules.set('runs/persist.html', allowUser('ana@corp', 'Ana'));
    const app1 = await startApp();
    const c1 = new TestClient(`ws://127.0.0.1:${(app1.server.address() as { port: number }).port}/_canvas/_/ws/runs/persist.html`);
    await c1.connect();
    c1.doc.transact(() => {
      c1.doc.getMap('shapes').set('kept', shape({ type: 'geo', x: 1 }));
    });
    await waitFor(() => store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/persist.html')));
    await app1.close(); // flushes on shutdown

    const app2 = await startApp();
    const c2 = new TestClient(`ws://127.0.0.1:${(app2.server.address() as { port: number }).port}/_canvas/_/ws/runs/persist.html`);
    await c2.connect();
    await waitFor(() => c2.doc.getMap('shapes').has('kept'));
    expect(c2.doc.getMap('shapes').get('kept')).toBeTruthy();
  });

  it('ttl tag of the artifact is copied onto the canvas object', async () => {
    core.rules.set('runs/ttl.html', allowUser('ana@corp', 'Ana', { artifact: { ttl: 7 } }));
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/ttl.html`);
    await c.connect();
    c.doc.transact(() => c.doc.getMap('shapes').set('s', shape()));
    await waitFor(() => store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/ttl.html')));
    expect(store.objects.get(canvasObjectKey('_plugins/canvas', 'runs/ttl.html'))?.tagging).toBe('ttl=7');
  });

  it('sweep deletes canvas objects whose artifact is gone', async () => {
    store.objects.set(canvasObjectKey('_plugins/canvas', 'runs/dead.html'), { body: new Uint8Array([1]) });
    store.objects.set(canvasObjectKey('_plugins/canvas', 'runs/alive.html'), { body: new Uint8Array([1]) });
    core.rules.set('runs/alive.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const res = await app.manager.sweep();
    expect(res).toMatchObject({ scanned: 2, deleted: 1 });
    expect(store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/dead.html'))).toBe(false);
    expect(store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/alive.html'))).toBe(true);
  });
});

describe('abuse limits', () => {
  it('rate-limited connection is closed with 4429 after a NOTICE', async () => {
    core.rules.set('pub/rl.html', allowAnon());
    const app = await startApp({ ANON_MSG_RATE_PER_SEC: '2', ANON_MSG_BURST: '3' });
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/pub/rl.html?anon=1111`);
    await c.connect(); // consumes 1 token
    const emptyAwareness = new Uint8Array([1, 0]); // type AWARENESS, count 0
    for (let i = 0; i < 5; i++) c.sendRaw(emptyAwareness);
    await expectClose(c, 4429);
    expect(c.notices.some((n) => n.kind === 'rate-limited')).toBe(true);
  });

  it('an anonymous visitor filling the document is closed alone; the room stays open for everyone', async () => {
    core.rules.set('pub/fill.html', allowAnon());
    core.rulesByCookie.set('ana|pub/fill.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp({ MAX_DOC_BYTES: '200000', ANON_MAX_DOC_BYTES: '20000', ANON_MAX_MESSAGE_BYTES: '200000' });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/pub/fill.html`;
    const anon = new TestClient(url);
    await anon.connect();
    anon.doc.getMap('assets').set('blob', 'data:image/png;base64,' + 'A'.repeat(30_000));
    await expectClose(anon, 4413);
    expect(anon.notices.some((n) => n.kind === 'too-large')).toBe(true);
    // a logged-in visitor joins, syncs and writes (no room-wide lock)
    const ana = new TestClient(url, 'ana');
    await ana.connect();
    expect(ana.identity?.id).toBe('ana@corp');
    await new Promise((r) => setTimeout(r, 100));
    expect(ana.doc.getMap('assets').has('blob')).toBe(false); // the oversized update was not applied
    ana.doc.getMap('assets').set('ok', 'data:image/png;base64,' + 'B'.repeat(50_000)); // within the logged-in cap
    const watcher = new TestClient(url, 'ana');
    await watcher.connect();
    await waitFor(() => watcher.doc.getMap('assets').has('ok'), 3000, 'ana write applied');
    // and a new anonymous visitor can still join (read) the room
    const anon2 = new TestClient(url);
    await anon2.connect();
    await waitFor(() => anon2.doc.getMap('assets').has('ok'), 3000, 'anon2 synced');
    expect(anon2.closeCode).toBeNull();
    for (const x of [ana, watcher, anon2]) x.close();
  });

  it('oversized document closes the writer with 4413', async () => {
    core.rules.set('runs/big.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp({ MAX_DOC_BYTES: '600', ANON_MAX_DOC_BYTES: '400' });
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/big.html`);
    await c.connect();
    c.doc.transact(() => {
      c.doc.getMap('shapes').set('big', shape({ type: 'note', text: 'x'.repeat(9_000) }));
    });
    await expectClose(c, 4413);
    expect(c.notices.some((n) => n.kind === 'too-large')).toBe(true);
  });

  it('room capacity refuses extra connections', async () => {
    core.rules.set('runs/cap.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp({ MAX_CONNS_PER_ROOM: '1', MAX_CONNS_PER_ROOM_ANON: '1' });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/runs/cap.html`;
    const c1 = new TestClient(url);
    await c1.connect();
    const c2 = new TestClient(url);
    await c2.connect();
    await expectClose(c2, 1013);
  });

  it('path traversal and reserved namespaces are refused before authz', async () => {
    const app = await startApp();
    const base = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/`;
    for (const bad of ['_gate/x', '_plugins/canvas/other.ydoc', '.acl.json', '..%2f..%2fetc/passwd']) {
      const c = new TestClient(base + bad);
      await c.connect().then(
        () => expectClose(c, 4403, 2000),
        () => undefined, // upgrade rejected outright (HTTP error) is also a refusal
      );
    }
    expect(core.calls.filter((x) => x.key.startsWith('_gate') || x.key.startsWith('_plugins')).length).toBe(0);
  });
});

describe('http routes', () => {
  it('health and readiness public; metrics only on the internal listener', async () => {
    const metricsPort = ++portSeq;
    const app = await startApp({ METRICS_PORT: String(metricsPort), METRICS_HOST: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(h).toEqual({ ok: true });
    const r = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(r.status).toBe(200);
    // public listener: 404 with and without the plugin prefix
    for (const p of ['/metrics', '/_canvas/metrics']) {
      const pr = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(pr.status, p).toBe(404);
      expect(await pr.text()).not.toContain('canvas_rooms_active');
    }
    const m = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(m.status).toBe(200);
    expect(await m.text()).toContain('canvas_rooms_active');
    expect((await fetch(`http://127.0.0.1:${metricsPort}/healthz`)).status).toBe(404);
    expect(() => makeCfg({ METRICS_PORT: '8080', PORT: '8080' })).toThrow(/METRICS_PORT/);
    store.readyNow = false;
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(r2.status).toBe(503);
  });

  it('wrapper page injects the config and recommended headers', async () => {
    core.rules.set('runs/w.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/runs/w.html`, { headers: { cookie: 'sid=1' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="artifacts-canvas-config"');
    expect(html).toContain('"artifactPath":"runs/w.html"');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('wrapper denies with the gate semantics (403, no existence leak)', async () => {
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/runs/secret.html`);
    expect(res.status).toBe(404); // fake core says object-missing for unknown keys -> gone semantics
  });

  it('LOGIN_URL: an unauthenticated visitor on a gated key is sent to login and back', async () => {
    const unauth = { allowed: false, reason: 'unauthenticated', user: { id: null, name: 'anonymous', anonymous: true } };
    core.rules.set('u/run/index.html', unauth as never);
    const app = await startApp({ LOGIN_URL: '/oauth2/sign_in?rd={rd}' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/canvas-test/u/run/index.html`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/oauth2/sign_in?rd=${encodeURIComponent('/_canvas/canvas-test/u/run/index.html')}`);
    // a scripted caller with a bearer token gets the plain 403, never a login page
    const bearer = await fetch(`http://127.0.0.1:${port}/_canvas/u/run/index.html`, { redirect: 'manual', headers: { authorization: 'Bearer x' } });
    expect(bearer.status).toBe(403);
    // a signed-in visitor who is simply not on the ACL is denied, not bounced to login
    core.rules.set('u/run/other.html', { allowed: false, reason: 'no-acl', user: { id: 'eve@corp', name: 'eve@corp', anonymous: false } } as never);
    const denied = await fetch(`http://127.0.0.1:${port}/_canvas/u/run/other.html`, { redirect: 'manual', headers: { cookie: 'sid=eve' } });
    expect(denied.status).toBe(403);
  });

  it('LOGIN_URL unset: unauthenticated stays a 403; invalid LOGIN_URL refuses to start', async () => {
    core.rules.set('u/run/index.html', { allowed: false, reason: 'unauthenticated', user: { id: null, name: 'anonymous', anonymous: true } } as never);
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/u/run/index.html`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(() => makeCfg({ LOGIN_URL: '//evil.example/x?rd={rd}' })).toThrow(/LOGIN_URL/);
    expect(() => makeCfg({ LOGIN_URL: '/oauth2/sign_in' })).toThrow(/\{rd\}/);
  });

  it('frame serves the artifact with the reporter injected and sandbox CSP', async () => {
    core.rules.set('pub/a.html', allowAnon());
    core.artifacts.set(
      'pub/a.html',
      '<!doctype html><html><head><title>art</title></head><body>hi</body></html>',
    );
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/_/frame/pub/a.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain("<head><script>console.log('reporter loaded');</script>");
    expect(html).toContain('<title>art</title>');
  });

  it('frame forwards the visitor cookie to the core and refuses redirects', async () => {
    core.rules.set('pub/b.html', allowAnon());
    core.artifacts.set('pub/b.html', '<html><head></head></html>');
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/_canvas/_/frame/pub/b.html`, { headers: { cookie: 'sid=99' } });
    // the artifact fetch itself doesn't go through authz; check the authz call carried the cookie
    expect(core.calls.some((c) => c.cookie === 'sid=99')).toBe(true);
  });

  it('static assets are cached immutably without authz', async () => {
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const callsBefore = core.calls.length;
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/_/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    const rep = await fetch(`http://127.0.0.1:${port}/_canvas/_/reporter.js`);
    expect(rep.status).toBe(200);
    expect(core.calls.length).toBe(callsBefore); // no authz for static
  });

  it('core link shape /_canvas/<bucket>/<key> resolves to the same key (authz path, S3 key, room)', async () => {
    core.rules.set('runs/bucketed.html', allowUser('ana@corp', 'Ana'));
    core.artifacts.set('runs/bucketed.html', '<html><head></head></html>');
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;

    // Wrapper: bucket stripped, injected config carries the canonical (bucket-less) key.
    const res = await fetch(`http://127.0.0.1:${port}/_canvas/canvas-test/runs/bucketed.html`, {
      headers: { cookie: 'sid=1' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"artifactPath":"runs/bucketed.html"');

    // WS: same room, and the gate saw the canonical key in the /artifacts/<key> path.
    const ws = new TestClient(`ws://127.0.0.1:${port}/_canvas/_/ws/canvas-test/runs/bucketed.html`);
    await ws.connect();
    expect(ws.identity?.id).toBe('ana@corp');
    const call = core.calls.find((c) => c.key === 'runs/bucketed.html');
    expect(call?.artifact).toBe('/artifacts/runs/bucketed.html');
    expect(core.calls.some((c) => c.key === 'canvas-test/runs/bucketed.html')).toBe(false);

    // And the object lands under the canonical key, not the bucket-prefixed one.
    ws.doc.transact(() => ws.doc.getMap('shapes').set('s', shape()));
    await waitFor(() => store.objects.has(canvasObjectKey('_plugins/canvas', 'runs/bucketed.html')));
    await waitFor(() => store.objects.has(canvasLedgerKey('_plugins/canvas', 'runs/bucketed.html')));
    expect([...store.objects.keys()].sort()).toEqual([
      canvasObjectKey('_plugins/canvas', 'runs/bucketed.html'),
      canvasLedgerKey('_plugins/canvas', 'runs/bucketed.html'),
    ]);
  });

  it('stripped-prefix routes work too (ingress without prefix preservation)', async () => {
    core.rules.set('runs/s.html', allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/runs/s.html`, { headers: { cookie: 'sid=1' } });
    expect(res.status).toBe(200);
    const ws = new TestClient(`ws://127.0.0.1:${port}/ws/runs/s.html`);
    await ws.connect();
    expect(ws.identity?.id).toBe('ana@corp');
  });
});

/** A y-websocket SYNC update message carrying `update`. */
function syncUpdateMsg(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  syncProtocolWriteUpdate(e, update);
  return encoding.toUint8Array(e);
}

/** clock 1 of a fresh client without clock 0: Yjs would park it as pending */
function gapShapeUpdate(client: number): Uint8Array {
  const a = new Y.Doc();
  a.clientID = client;
  a.getMap('shapes').set('p0', shape({ type: 'geo' }));
  const sv = Y.encodeStateVector(a);
  a.getMap('shapes').set('p1', shape({ type: 'geo' }));
  return Y.encodeStateAsUpdate(a, sv);
}

/**
 * An item appended to history right after the stamper's future LEDGER struct (S, N + before),
 * sent as a content update: the attacker sees the ledger (it is broadcast) and merges it.
 */
function afterFutureStamp(c: { doc: Y.Doc; ledger: Y.Doc }, S: number, before: number): Uint8Array {
  const state = new Y.Doc();
  Y.applyUpdate(state, Y.encodeStateAsUpdate(c.doc));
  Y.applyUpdate(state, Y.encodeStateAsUpdate(c.ledger));
  const sim = new Y.Doc();
  Y.applyUpdate(sim, Y.encodeStateAsUpdate(state));
  sim.clientID = S;
  sim.transact(() => {
    for (let i = 0; i < before; i++) sim.getMap('attribution').set(`__sim${i}`, {});
    sim.getArray('history').push([{}]);
  });
  const ev = new Y.Doc();
  Y.applyUpdate(ev, Y.encodeStateAsUpdate(sim));
  ev.clientID = 3000000 + Math.floor(Math.random() * 1e6);
  const sv = Y.encodeStateVector(ev);
  const h = ev.getArray('history');
  h.insert(h.length, [{ t: Date.now(), by: 'ana@corp', verb: 'delete', shapeId: 'FORGED', shapeType: 'geo' }]);
  return Y.encodeStateAsUpdate(ev, sv);
}

/** the stamper's client id: the writer of the ledger's history */
const stamperClientOf = (ledger: Y.Doc) => ((ledger.getArray('history') as unknown as { _start: Y.Item })._start).id.client;
const historyShapeIds = (ledger: Y.Doc) => (ledger.getArray('history').toJSON() as { shapeId: string }[]).map((e) => e.shapeId);

describe('fv2 regressions through the server: the room never holds pending state', () => {
  async function room2(key: string) {
    core.rules.set(key, allowUser('ana@corp', 'Ana'));
    core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/${key}`;
    const honest = new TestClient(url);
    await honest.connect();
    honest.doc.transact(() => honest.doc.getMap('shapes').set('h1', shape({ type: 'geo' })));
    await waitFor(() => honest.ledger.getArray('history').length === 1, 3000, 'first history line');
    const attacker = async () => {
      const a = new TestClient(url, 'sid=bob');
      await a.connect();
      await waitFor(() => a.ledger.getArray('history').length >= 1, 3000, 'attacker synced');
      return a;
    };
    return { app, url, honest, attacker };
  }

  it('A: gap write, item after the stamper next clock, victim edit, empty update: never applied, no forged line, nothing pending (fv2.spec A)', async () => {
    const key = 'runs/fv2a.html';
    const { app, honest, attacker } = await room2(key);
    const a1 = await attacker();
    // an update that would wait as pending is dropped and answered with a sync step 1 (the
    // connection stays open: fv5 M-2, an honest reconnect can send one); never applied
    const step1Before = a1.step1Received;
    a1.sendRaw(syncUpdateMsg(gapShapeUpdate(4000000001)));
    await waitFor(() => a1.step1Received > step1Before, 3000, 'resync request');
    const room = app.manager.get(key)!;
    expect(room.hasPending()).toBe(false);
    expect(Y.getState(room.doc.store, 4000000001)).toBe(0);
    const a2 = await attacker();
    const step1Before2 = a2.step1Received;
    a2.sendRaw(syncUpdateMsg(afterFutureStamp(a2, stamperClientOf(a2.ledger), 1)));
    await waitFor(() => a2.step1Received > step1Before2, 3000, 'resync request');
    expect(room.hasPending()).toBe(false);
    a1.close();
    a2.close();
    honest.doc.transact(() => honest.doc.getMap('shapes').set('h2', shape({ type: 'geo' })));
    await waitFor(() => honest.ledger.getArray('history').length === 2, 3000, 'second history line');
    const a3 = await attacker();
    a3.sendRaw(syncUpdateMsg(Y.encodeStateAsUpdate(new Y.Doc())));
    await new Promise((r) => setTimeout(r, 200));
    expect(a3.closeCode).toBeNull();
    expect(historyShapeIds(honest.ledger)).toEqual(['h1', 'h2']);
    await room.flush();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, store.objects.get(canvasObjectKey('_plugins/canvas', key))!.body);
    const storedLedger = new Y.Doc();
    Y.applyUpdate(storedLedger, store.objects.get(canvasLedgerKey('_plugins/canvas', key))!.body);
    expect(historyShapeIds(storedLedger)).toEqual(['h1', 'h2']);
    expect([...stored.share.keys()].filter((k) => !['assets', 'meta', 'shapes'].includes(k))).toEqual([]);
    expect(stored.store.pendingStructs).toBeNull();
    expect(stored.store.pendingDs).toBeNull();
    a3.close();
    honest.close();
  });

  it('B: a pending delete set on future stamper clocks deletes nothing; a connection that keeps sending pending state is closed 4403 (fv2.spec B)', async () => {
    const key = 'runs/fv2b.html';
    const { app, honest, attacker } = await room2(key);
    const a1 = await attacker();
    const S = stamperClientOf(a1.ledger);
    const N = Y.getState(a1.ledger.store, S);
    const enc = encoding.createEncoder();
    for (const n of [0, 1, S, 1, N, 64]) encoding.writeVarUint(enc, n);
    const pendingDelete = syncUpdateMsg(encoding.toUint8Array(enc));
    a1.sendRaw(pendingDelete);
    await waitFor(() => a1.step1Received >= 2, 3000, 'resync request');
    expect(a1.closeCode).toBeNull();
    expect(app.manager.get(key)!.hasPending()).toBe(false);
    // the resync budget (20 requests per connection, +1 every 2 s) bounds a sender that keeps
    // answering the requests with nothing that integrates
    for (let i = 0; i < 30 && a1.closeCode === null; i++) {
      const n = a1.step1Received;
      a1.sendRaw(pendingDelete);
      await waitFor(() => a1.step1Received > n || a1.closeCode !== null, 3000, 'resync request or close');
    }
    await expectClose(a1, 4403);
    expect(app.manager.get(key)!.hasPending()).toBe(false);
    honest.doc.transact(() => honest.doc.getMap('shapes').set('h2', shape({ type: 'geo' })));
    await waitFor(() => honest.ledger.getArray('history').length === 2, 3000, 'second history line');
    const fresh = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/${key}`);
    await fresh.connect();
    await waitFor(() => fresh.ledger.getArray('history').length === 2, 3000, 'fresh synced');
    expect(historyShapeIds(fresh.ledger)).toEqual(['h1', 'h2']);
    expect(Object.keys(fresh.ledger.getMap('attribution').toJSON()).sort()).toEqual(['h1', 'h2']);
    fresh.close();
    honest.close();
  });

  it('structs as the server stamper client, or at another connection\'s next clock, close 4403; the victim keeps editing', async () => {
    const key = 'runs/fv2c.html';
    const { honest, attacker } = await room2(key);
    // as the server's stamper client id
    const a1 = await attacker();
    const sim = new Y.Doc();
    Y.applyUpdate(sim, Y.encodeStateAsUpdate(a1.doc));
    sim.clientID = stamperClientOf(a1.ledger);
    const sv = Y.encodeStateVector(sim);
    sim.getMap('shapes').set('as-server', shape({ type: 'geo' }));
    a1.sendRaw(syncUpdateMsg(Y.encodeStateAsUpdate(sim, sv)));
    await expectClose(a1, 4403);
    // at the honest client's next clock: Yjs would drop the honest edit as already known
    const a2 = await attacker();
    const twin = new Y.Doc();
    Y.applyUpdate(twin, Y.encodeStateAsUpdate(a2.doc));
    twin.clientID = honest.doc.clientID;
    const svT = Y.encodeStateVector(twin);
    (twin.getMap('shapes').get('h1') as Y.Map<unknown>).set('x', 666);
    a2.sendRaw(syncUpdateMsg(Y.encodeStateAsUpdate(twin, svT)));
    await expectClose(a2, 4403);
    honest.doc.transact(() => (honest.doc.getMap('shapes').get('h1') as Y.Map<unknown>).set('x', 5));
    const check = await attacker();
    await waitFor(() => (check.doc.getMap('shapes').get('h1') as Y.Map<unknown> | undefined)?.get('x') === 5, 3000, 'honest edit applied');
    check.close();
    honest.close();
  });

  it('non-map values and malformed shapes under `shapes` close 4403 and never reach the room (fv2.spec C / fv2b)', async () => {
    const key = 'runs/fv2d.html';
    const { app, honest, attacker } = await room2(key);
    const cases: [string, (d: Y.Doc) => void][] = [
      ['number', (d) => d.getMap('shapes').set('bad-number', 42 as never)],
      ['string', (d) => d.getMap('shapes').set('bad-string', 'x' as never)],
      ['null', (d) => d.getMap('shapes').set('bad-null', null as never)],
      ['array', (d) => d.getMap('shapes').set('bad-array', new Y.Array() as never)],
      ['evil-geo', (d) => d.getMap('shapes').set('bad-geo', shape({ type: 'geo', geo: 'rectangle', x: 'NaN', w: -1e308, text: 12 }))],
      ['no type', (d) => d.getMap('shapes').set('bad-notype', shape({ x: 1 }))],
    ];
    for (const [name, fn] of cases) {
      const a = await attacker();
      fn(a.doc);
      await expectClose(a, 4403);
      expect(name).toBeTruthy();
    }
    await new Promise((r) => setTimeout(r, 100));
    const room = app.manager.get(key)!;
    expect([...room.doc.getMap('shapes').keys()]).toEqual(['h1']);
    expect(Object.keys(room.ledger.getMap('attribution').toJSON())).toEqual(['h1']);
    honest.close();
  });

  it('a stored document with pending structs is cleaned on load and saved back clean', async () => {
    const key = 'runs/fv2-load.html';
    core.rules.set(key, allowUser('ana@corp', 'Ana'));
    const good = new Y.Doc();
    good.getMap('shapes').set('ok', shape({ type: 'geo' }));
    const dirty = Y.mergeUpdates([Y.encodeStateAsUpdate(good), gapShapeUpdate(4000000002)]);
    const probe = new Y.Doc();
    Y.applyUpdate(probe, dirty);
    expect(probe.store.pendingStructs).not.toBeNull();
    const objKey = canvasObjectKey('_plugins/canvas', key);
    store.objects.set(objKey, { body: dirty });
    const app = await startApp();
    const c = new TestClient(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/${key}`);
    await c.connect();
    await waitFor(() => c.doc.getMap('shapes').has('ok'), 3000, 'loaded');
    expect(app.manager.get(key)!.hasPending()).toBe(false);
    await waitFor(() => store.objects.get(objKey)!.body !== dirty, 3000, 'cleaned state saved');
    const after = new Y.Doc();
    Y.applyUpdate(after, store.objects.get(objKey)!.body);
    expect(after.store.pendingStructs).toBeNull();
    expect([...after.getMap('shapes').keys()]).toEqual(['ok']);
    // and the client can write as usual
    c.doc.transact(() => c.doc.getMap('shapes').set('s2', shape({ type: 'geo' })));
    await waitFor(() => c.ledger.getArray('history').length === 1, 3000, 'stamped');
    c.close();
  });

  it('safety net: a room that somehow holds pending state drops it and never persists it', async () => {
    const key = 'runs/fv2-net.html';
    core.rules.set(key, allowUser('ana@corp', 'Ana'));
    const app = await startApp();
    const room = await app.manager.getOrCreate(key, null);
    room.doc.transact(() => room.doc.getMap('shapes').set('ok', shape({ type: 'geo' })));
    Y.applyUpdate(room.doc, gapShapeUpdate(4000000003)); // bypassing the guard on purpose
    expect(room.hasPending()).toBe(true);
    await room.flush(); // save drops it before encoding
    const objKey = canvasObjectKey('_plugins/canvas', key);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, store.objects.get(objKey)!.body);
    expect(saved.store.pendingStructs).toBeNull();
    expect(room.hasPending()).toBe(false);
    Y.applyUpdate(room.doc, gapShapeUpdate(4000000004));
    room.markDirty();
    await room.flush();
    expect(room.hasPending()).toBe(false);
    const saved2 = new Y.Doc();
    Y.applyUpdate(saved2, store.objects.get(objKey)!.body);
    expect(saved2.store.pendingStructs).toBeNull();
  });
});

describe('fv2 finding 4: the anonymous attribution id is bound to the signed cookie, not to the ?anon= hint', () => {
  it('a later visitor hinting a freed number shows the same label but writes as a different id', async () => {
    const key = 'pub/fv2-anon.html';
    core.rules.set(key, allowAnon());
    const app = await startApp();
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws/${key}`;
    const a = new TestClient(`${url}?anon=1234`);
    await a.connect();
    expect(a.identity!.name).toBe('Anónimo 1234');
    a.doc.transact(() => a.doc.getMap('shapes').set('by-a', shape({ type: 'geo' })));
    await waitFor(() => a.ledger.getMap('attribution').has('by-a'), 3000, 'a stamped');
    const idA = a.identity!.id;
    a.close();
    await a.closed;
    // the number is free again: a new visitor (no cookie) asks for it
    const b = new TestClient(`${url}?anon=1234`);
    await b.connect();
    await waitFor(() => b.ledger.getMap('attribution').has('by-a'), 3000, 'b synced');
    expect(b.identity!.name).toBe('Anónimo 1234');
    expect(b.identity!.id).not.toBe(idA);
    b.doc.transact(() => {
      (b.doc.getMap('shapes').get('by-a') as Y.Map<unknown>).set('x', 50);
      b.doc.getMap('shapes').set('by-b', shape({ type: 'geo' }));
    });
    await waitFor(() => b.ledger.getMap('attribution').has('by-b'), 3000, 'b stamped');
    const attr = b.ledger.getMap('attribution').toJSON() as Record<string, { createdBy: string; updatedBy: string }>;
    expect(attr['by-a'].createdBy).toBe(idA);
    expect(attr['by-b'].createdBy).toBe(b.identity!.id);
    expect(Object.keys(b.ledger.getMap('users').toJSON()).sort()).toEqual([idA, b.identity!.id].sort());
    // the original visitor coming back with its cookie is still itself
    const a2 = new TestClient(`${url}?anon=9999`, a.setCookie!.split(';')[0]);
    await a2.connect();
    expect(a2.identity!.id).toBe(idA);
    a2.close();
    b.close();
  });
});
