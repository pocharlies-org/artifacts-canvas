/**
 * The anonymous-drawing switch (ANON_ENABLED; chart `anon.enabled`, default false).
 *
 * Off must mean off whatever ANON_ALLOWED_PREFIXES holds: the list is a defence in depth for when
 * anonymous drawing is on, and it cannot express "nobody" (an empty value is treated as unset, so
 * the default `pub/` applies). With the switch off a visitor who brings no credential is refused
 * before the core is asked, an anonymous answer of the core is refused too, and no visitor cookie
 * is minted; signed-in visitors are not affected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { AuthzClient, anonAllowed } from '../src/authz.js';
import { bringsCredentials } from '../src/anon.js';
import { Metrics } from '../src/metrics.js';
import { createLogger } from '../src/logging.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { startFakeCore, allowAnon, allowUser, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, expectClose } from './helpers/yclient.js';

const silent = createLogger('silent');
const BASE_ENV = { GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz', ARTIFACT_BASE_URL: 'http://core', S3_BUCKET: 'b', METRICS_PORT: '0' };

/** The core's answers: anonymous inside pub/ (the gate's anonymous-pub flag on), a user for sid=ana. */
function fakeFetch(): { fetch: typeof fetch; calls: { cookie: string; authorization: string }[] } {
  const calls: { cookie: string; authorization: string }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    calls.push({ cookie: h.cookie ?? '', authorization: h.authorization ?? '' });
    const key = (JSON.parse(String(init.body)) as { artifact: string }).artifact.replace('/artifacts/', '');
    const user = h.cookie === 'sid=ana' ? { id: 'ana@corp', name: 'Ana', anonymous: false } : { id: null, name: 'anonymous', anonymous: true };
    const body = { allowed: true, reason: user.anonymous ? 'pub: anonymous (anonymous-pub enabled)' : 'owner', user, artifact: { key } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

async function denials(m: Metrics, reason: string): Promise<number> {
  return (await m.authzDeny.get()).values.filter((v) => v.labels.reason === reason).reduce((a, v) => a + v.value, 0);
}

describe('ANON_ENABLED: off means off, whatever ANON_ALLOWED_PREFIXES holds', () => {
  // `undefined` = the variable is not set at all; '' = set and empty (list() treats it as unset)
  const offCases: [string, string | undefined][] = [
    ['an empty list', ''],
    ['an unset list', undefined],
    ['pub/ in the list', 'pub/'],
    ['a list that parses to nothing', ' , '],
  ];

  it.each(offCases)('off with %s: a visitor without credentials is refused before the core is asked; an anonymous answer of the core is refused; a signed-in user is not affected', async (_what, prefixes) => {
    const env: Record<string, string> = { ...BASE_ENV, ANON_ENABLED: 'false' };
    if (prefixes !== undefined) env.ANON_ALLOWED_PREFIXES = prefixes;
    const cfg = loadConfig(env);
    expect(cfg.anonEnabled).toBe(false);
    const metrics = new Metrics();
    const core = fakeFetch();
    const authz = new AuthzClient(cfg, silent, metrics, core.fetch);

    // no cookie, no bearer; the canvas's own visitor cookie is not a credential either
    for (const cookie of ['', 'canvas_anon=AAAAAAAAAAAAAAAAAAAAAA.1234.BBBBBBBBBBBBBBBBBBBBBBBBBBB']) {
      const r = await authz.authorize(cookie, 'pub/doc.html');
      expect(r).toMatchObject({ allowed: false, reason: 'anon_disabled' });
      expect(r.identity).toBeUndefined();
    }
    expect(core.calls).toHaveLength(0);
    expect(await denials(metrics, 'anon_disabled')).toBe(2);
    // nothing was asked: canvas_authz_total counts calls to the core
    expect((await metrics.authz.get()).values.reduce((a, v) => a + v.value, 0)).toBe(0);

    // a cookie the core does not accept as a session: it answers anonymous, still refused
    const stale = await authz.authorize('sid=expired', 'pub/doc.html');
    expect(stale).toMatchObject({ allowed: false, reason: 'anon_disabled' });
    expect(core.calls).toHaveLength(1);

    // a signed-in visitor draws as before
    const ana = await authz.authorize('sid=ana', 'pub/doc.html');
    expect(ana.allowed).toBe(true);
    expect(ana.identity).toMatchObject({ id: 'ana@corp', anonymous: false });
    expect(core.calls).toHaveLength(2);
  });

  it('on with pub/: anonymous is accepted inside pub/ only (the core is asked)', async () => {
    const cfg = loadConfig({ ...BASE_ENV, ANON_ENABLED: 'true', ANON_ALLOWED_PREFIXES: 'pub/' });
    expect(cfg.anonEnabled).toBe(true);
    const core = fakeFetch();
    const authz = new AuthzClient(cfg, silent, new Metrics(), core.fetch);
    const r = await authz.authorize('', 'pub/doc.html');
    expect(r.allowed).toBe(true);
    expect(r.identity).toBeUndefined(); // the server composes anon:<visitor id> itself
    expect(core.calls).toHaveLength(1);
    expect(await authz.authorize('', 'runs/private.html')).toMatchObject({ allowed: false, reason: 'anon_outside_pub' });
  });

  it('the server\'s own default, when the variable is not set, is on (the chart always renders it)', () => {
    expect(loadConfig(BASE_ENV).anonEnabled).toBe(true);
    expect(loadConfig({ ...BASE_ENV, ANON_ENABLED: '' }).anonEnabled).toBe(true);
    for (const v of ['false', '0', 'FALSE', 'no', 'off', 'flase']) expect(loadConfig({ ...BASE_ENV, ANON_ENABLED: v }).anonEnabled).toBe(false);
    for (const v of ['true', '1', 'TRUE']) expect(loadConfig({ ...BASE_ENV, ANON_ENABLED: v }).anonEnabled).toBe(true);
  });

  it('a prefix list that parses to nothing accepts anonymous nowhere (it used to accept every key)', () => {
    expect(anonAllowed('pub/doc.html', [])).toBe(false);
    expect(anonAllowed('runs/x.html', [])).toBe(false);
    expect(anonAllowed('pub/doc.html', [''])).toBe(false);
    expect(anonAllowed('pub/doc.html', ['pub/'])).toBe(true);
    expect(anonAllowed('runs/x.html', ['pub/'])).toBe(false);
    expect(loadConfig({ ...BASE_ENV, ANON_ALLOWED_PREFIXES: ' , ' }).anonAllowedPrefixes).toEqual([]);
  });

  it('what counts as a credential: a bearer, or any cookie other than the canvas\'s own visitor cookie', () => {
    expect(bringsCredentials('', '')).toBe(false);
    expect(bringsCredentials(' ; ', '')).toBe(false);
    expect(bringsCredentials('canvas_anon=x.1234.y', '')).toBe(false);
    expect(bringsCredentials('canvas_anon=a; canvas_anon=b', '')).toBe(false);
    expect(bringsCredentials('canvas_anon=x; _oauth2_proxy=s', '')).toBe(true);
    expect(bringsCredentials('sid=1', '')).toBe(true);
    expect(bringsCredentials('flag', '')).toBe(true); // a cookie without a value is still the core's to judge
    expect(bringsCredentials('', 'Bearer t')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The running server: WebSocket, wrapper page and frame route, against the fake core.

let core: FakeCore;
let staticDir: string;
let portSeq = 31400;
const apps: App[] = [];

async function startApp(env: Record<string, string>): Promise<App> {
  for (;;) {
    const cfg = loadConfig({
      GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
      STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '300', SAVE_DEBOUNCE_MS: '50',
      READYZ_CACHE_MS: '10', PORT: String(++portSeq), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0', ...env,
    });
    const app = createApp({ config: cfg, store: new MemoryCanvasObjectStore(), logger: silent });
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
const wsUrl = (app: App, key: string) => `ws://127.0.0.1:${port(app)}/_canvas/_/ws/${key}`;
const get = (app: App, p: string, cookie?: string) =>
  fetch(`http://127.0.0.1:${port(app)}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function counter(app: App, name: 'anonMinted' | 'wsRejected', label: string, value: string): Promise<number> {
  const m = await (app.metrics[name] as unknown as { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }).get();
  return m.values.filter((v) => v.labels[label] === value).reduce((a, v) => a + v.value, 0);
}

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-switch-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>c</title>');
});
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await core.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});
beforeEach(() => {
  core.rules.clear();
  core.rulesByCookie.clear();
  core.artifacts.clear();
  core.calls.length = 0;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

describe('the server with ANON_ENABLED=false', () => {
  it('a cookieless WebSocket to a pub/ canvas is closed 4403 without asking the core, with no visitor cookie; a signed-in user joins and draws', async () => {
    const key = 'pub/switch/index.html';
    core.rules.set(key, allowAnon()); // the core itself opens pub/ to anonymous visitors
    core.rulesByCookie.set(`sid=ana|${key}`, allowUser('ana@corp', 'Ana'));
    const app = await startApp({ ANON_ENABLED: 'false' });

    for (const cookie of [undefined, 'canvas_anon=AAAAAAAAAAAAAAAAAAAAAA.1234.BBBBBBBBBBBBBBBBBBBBBBBBBBB']) {
      const c = new TestClient(`${wsUrl(app, key)}?anon=4321`, cookie);
      await c.connect();
      await expectClose(c, 4403);
      expect(c.identities).toHaveLength(0);
      expect(c.setCookie).toBeNull();
    }
    expect(core.calls).toHaveLength(0);
    expect(await counter(app, 'wsRejected', 'reason', 'authz_anon_disabled')).toBe(2);
    expect(await counter(app, 'anonMinted', 'outcome', 'minted')).toBe(0);
    expect(app.manager.get(key)).toBeUndefined(); // the room was not even loaded

    // a session the core does not accept: asked once, answered anonymous, refused all the same
    const stale = new TestClient(wsUrl(app, key), 'sid=expired');
    await stale.connect();
    await expectClose(stale, 4403);
    expect(core.calls).toHaveLength(1);
    expect(stale.setCookie).toBeNull();

    const ana = new TestClient(wsUrl(app, key), 'sid=ana');
    await ana.connect();
    expect(ana.closeCode).toBeNull();
    expect(ana.identity).toMatchObject({ id: 'ana@corp', anonymous: false });
    expect(await counter(app, 'anonMinted', 'outcome', 'minted')).toBe(0);
    ana.ws.close();
  });

  it('the wrapper page sends a visitor without a session to the login (no visitor cookie), the frame answers 403; with ANON_ENABLED=true the same visitor gets the page and a visitor cookie', async () => {
    const key = 'pub/switch-page/index.html';
    core.rules.set(key, allowAnon());
    core.artifacts.set(key, '<!doctype html><html><head></head><body>pub</body></html>');
    const off = await startApp({ ANON_ENABLED: 'false', LOGIN_URL: '/oauth2/sign_in?rd={rd}' });
    const page = await get(off, `/_canvas/${key}`);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(`/oauth2/sign_in?rd=${encodeURIComponent(`/_canvas/${key}`)}`);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect((await get(off, `/_canvas/_/frame/${key}`)).status).toBe(403);
    expect(core.calls).toHaveLength(0);
    expect(await counter(off, 'anonMinted', 'outcome', 'minted')).toBe(0);
    // no LOGIN_URL: the plain 403, like the gate
    const offNoLogin = await startApp({ ANON_ENABLED: 'false' });
    expect((await get(offNoLogin, `/_canvas/${key}`)).status).toBe(403);

    const on = await startApp({ ANON_ENABLED: 'true', LOGIN_URL: '/oauth2/sign_in?rd={rd}' });
    const open = await get(on, `/_canvas/${key}`);
    expect(open.status).toBe(200);
    expect(open.headers.get('set-cookie')).toMatch(/^canvas_anon=/);
    expect(await counter(on, 'anonMinted', 'outcome', 'minted')).toBe(1);
  });
});
