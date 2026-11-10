/**
 * FULL-SYSTEM end-to-end: artifacts-canvas as a plugin of the real artifacts core, all of it
 * running from deploy/compose/compose.yml (MinIO + Dex + oauth2-proxy + gate + Caddy +
 * canvas). Run against the live stack:
 *
 *   (cd deploy/compose && docker compose up -d --build --wait)
 *   npm run e2e:system
 *
 * The cases run in order and share the published artifacts (serial suite).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';
import {
  ACL_CACHE_SECONDS, BASE, CORE_DIR, RECHECK_SECONDS, USERS, container, editorReady, mc, mcBytes, me,
  newContext, openWithLogin, publish, shapes, waitFor, wsCloseCode, wsCloses, type Published,
} from './lib';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
let priv: Published; // u/ artifact, ACL = user1 + user2
let pub: Published; // pub/ artifact
const ctxs: BrowserContext[] = [];
let p1: Page; // user1 on the u/ canvas
let p2: Page; // user2 on the u/ canvas

const canvasPath = (p: Published) => p.canvas.slice(BASE.length);
const wsPath = (p: Published) => `/_canvas/_/ws/artifacts/${p.key}`;

async function draw(page: Page, from: [number, number], n = 16, release = true): Promise<void> {
  await page.keyboard.press('d');
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) await page.mouse.move(from[0] + i * 14, from[1] + Math.sin(i / 2) * 30, { steps: 2 });
  if (release) await page.mouse.up();
}

test.beforeAll(() => {
  priv = publish({ users: [USERS.user1.email, USERS.user2.email] }, `sys-u-${stamp}`);
  pub = publish('pub', `sys-pub-${stamp}`);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
});

test('stack: plugin route, readiness and the prefix-scoped plugin-canvas S3 user', async ({ request }) => {
  expect(priv.canvas).toBe(`${BASE}/_canvas/artifacts/${priv.key}`);
  expect(priv.key).toMatch(/^u\/sys-u-[a-z0-9]+\/index\.html$/);
  expect(pub.key).toMatch(/^pub\/sys-pub-[a-z0-9]+\/index\.html$/);
  expect((await request.get(`${BASE}/_canvas/healthz`)).status()).toBe(200);
  const ready = await request.get(`${BASE}/_canvas/readyz`);
  expect(await ready.json()).toEqual({ ready: true });
  // plugin-canvas (created by the core bootstrap) can use its prefix and nothing else
  const probe = mc(`mc alias set e2e-canvas http://localhost:9000 plugin-canvas plugin-canvas-dev-password >/dev/null
echo probe | mc pipe e2e-canvas/artifacts/_plugins/canvas/_e2e-probe.bin >/dev/null && echo own-prefix-write-ok
mc rm e2e-canvas/artifacts/_plugins/canvas/_e2e-probe.bin >/dev/null && echo own-prefix-delete-ok
mc cat e2e-canvas/artifacts/${priv.key} >/dev/null 2>&1 && echo ARTIFACT-READ || echo artifact-read-denied
mc cat e2e-canvas/artifacts/${priv.key.replace(/index\.html$/, '.acl.json')} >/dev/null 2>&1 && echo ACL-READ || echo acl-read-denied
echo x | mc pipe e2e-canvas/artifacts/_plugins/other/x.bin >/dev/null 2>&1 && echo OTHER-PLUGIN-WRITE || echo other-plugin-denied
mc alias rm e2e-canvas >/dev/null`);
  expect(probe.out.trim().split('\n')).toEqual([
    'own-prefix-write-ok', 'own-prefix-delete-ok', 'artifact-read-denied', 'acl-read-denied', 'other-plugin-denied',
  ]);
});

test('a. user1 + user2 log in through oauth2-proxy -> Dex and collaborate live with verified identities', async ({ browser }) => {
  const c1 = await newContext(browser);
  const c2 = await newContext(browser);
  ctxs.push(c1, c2);
  p1 = await c1.newPage();
  p2 = await c2.newPage();
  // the canvas link the CLI printed: no session -> redirected to the real login, then back
  expect(await openWithLogin(p1, priv.canvas, 'user1')).toBe(200);
  expect(await openWithLogin(p2, priv.canvas, 'user2')).toBe(200);
  expect(new URL(p1.url()).pathname).toBe(canvasPath(priv));
  await editorReady(p1);
  await editorReady(p2);
  expect(await me(p1)).toEqual({ id: USERS.user1.email, name: USERS.user1.email, anonymous: false });
  expect(await me(p2)).toEqual({ id: USERS.user2.email, name: USERS.user2.email, anonymous: false });

  // live: user2 sees user1's stroke while the mouse button is still down
  await draw(p1, [420, 380], 18, false);
  await waitFor(async () => {
    const s = await shapes(p2);
    return s.length === 1 && (s[0].points?.length ?? 0) >= 9;
  }, 8_000, 'user1 stroke visible to user2 before mouse-up');
  const before = (await shapes(p2))[0].points!.length;
  for (let i = 1; i <= 6; i++) await p1.mouse.move(700 + i * 12, 420, { steps: 2 });
  await waitFor(async () => ((await shapes(p2))[0].points?.length ?? 0) > before, 8_000, 'stroke keeps growing live');
  await p1.mouse.up();

  // attribution = the identity the gate verified
  const [s1] = await shapes(p2);
  const attr1 = await p2.evaluate((id) => (window as any).__canvas.editor.doc.attribution.get(id), s1.id);
  expect(attr1).toMatchObject({ createdBy: USERS.user1.email, updatedBy: USERS.user1.email });

  await draw(p2, [420, 560]);
  await waitFor(async () => (await shapes(p1)).length === 2, 8_000, 'user2 stroke at user1');
  const s2 = (await shapes(p1)).find((s) => s.id !== s1.id)!;
  const attr2 = await p1.evaluate((id) => (window as any).__canvas.editor.doc.attribution.get(id), s2.id);
  expect(attr2).toMatchObject({ createdBy: USERS.user2.email });
  const users = await p1.evaluate(() => (window as any).__canvas.editor.doc.users.toJSON());
  expect(users[USERS.user1.email]).toMatchObject({ name: USERS.user1.email, anonymous: false });
  expect(users[USERS.user2.email]).toMatchObject({ name: USERS.user2.email, anonymous: false });

  // live cursors labelled with the Dex identity (name = e-mail from the gate)
  await p2.mouse.move(760, 300, { steps: 4 });
  await expect(p1.locator('.cursors .cursor .lbl', { hasText: USERS.user2.email })).toBeVisible({ timeout: 8_000 });
  await p1.mouse.move(820, 340, { steps: 4 });
  await expect(p2.locator('.cursors .cursor .lbl', { hasText: USERS.user1.email })).toBeVisible({ timeout: 8_000 });
});

test('b. user3 (not in the ACL) is refused the canvas page and the WebSocket', async ({ browser }) => {
  const c3 = await newContext(browser);
  ctxs.push(c3);
  const p3 = await c3.newPage();
  // logs in for real, comes back to the canvas link and gets the gate's denial
  expect(await openWithLogin(p3, priv.canvas, 'user3')).toBe(403);
  expect(await p3.evaluate(() => (window as any).__canvas ?? null)).toBeNull();
  // the frame route is refused too (no artifact bytes through the plugin)
  expect((await p3.request.get(`${BASE}/_canvas/_/frame/artifacts/${priv.key}`)).status()).toBe(403);
  // the WebSocket from user3's browser (session cookie attached) closes 4403
  const code = await p3.evaluate((url) => new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
    ws.onclose = (e) => resolve(e.code);
  }), `${BASE.replace(/^http/, 'ws')}${wsPath(priv)}`);
  expect(code).toBe(4403);
  // and user3 never shows up in the room
  const users = await p1.evaluate(() => Object.keys((window as any).__canvas.editor.doc.users.toJSON()));
  expect(users).not.toContain(USERS.user3.email);
});

test('c. anonymous draws on a pub/ canvas as "Anónimo NNNN"; anonymous is refused on u/', async ({ browser }) => {
  const ca = await newContext(browser);
  ctxs.push(ca);
  const pa = await ca.newPage();
  const res = await pa.goto(pub.canvas);
  expect(res?.status()).toBe(200);
  await editorReady(pa);
  const anon = await me(pa);
  expect(anon.anonymous).toBe(true);
  expect(anon.name).toMatch(/^Anónimo \d{4}$/);
  expect(anon.id).toBe(`anon:${anon.name.slice('Anónimo '.length)}`);
  await draw(pa, [420, 400]);
  await waitFor(async () => (await shapes(pa)).length === 1, 8_000, 'anonymous stroke applied');
  const [s] = await shapes(pa);
  const attr = await pa.evaluate((id) => (window as any).__canvas.editor.doc.attribution.get(id), s.id);
  expect(attr).toMatchObject({ createdBy: anon.id });
  // a second anonymous visitor sees the stroke and the label
  const cb = await newContext(browser);
  ctxs.push(cb);
  const pb = await cb.newPage();
  await pb.goto(pub.canvas);
  await editorReady(pb);
  await waitFor(async () => (await shapes(pb)).length === 1, 8_000, 'stroke at the second anonymous visitor');
  await pa.mouse.move(700, 300, { steps: 4 });
  await expect(pb.locator('.cursors .cursor .lbl', { hasText: anon.name })).toBeVisible({ timeout: 8_000 });

  // anonymous on the u/ artifact: the wrapper sends to login (never serves the page)...
  const r = await pa.request.get(priv.canvas, { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  expect(r.headers()['location']).toBe(`/oauth2/sign_in?rd=${encodeURIComponent(canvasPath(priv))}`);
  const nav = await pa.goto(priv.canvas);
  expect(new URL(pa.url()).pathname).toMatch(/\/dex\//);
  expect(nav?.status()).toBe(200); // Dex's login form
  // ...and the room refuses the socket: 4403, with or without an anon pseudonym
  expect(await wsCloseCode(wsPath(priv))).toBe(4403);
  expect(await wsCloseCode(`${wsPath(priv)}?anon=1234`)).toBe(4403);
  expect((await pa.request.get(`${BASE}/_canvas/_/frame/artifacts/${priv.key}`, { maxRedirects: 0 })).status()).toBe(403);
});

test('d. drawings persist in MinIO (_plugins/canvas/<key>.ydoc): reload and canvas restart', async ({ browser }) => {
  const objectPath = `artifacts/_plugins/canvas/${priv.key}.ydoc`;
  await waitFor(() => mc(`mc stat "local/${objectPath}" >/dev/null`).code === 0, 10_000, 'canvas object in MinIO');
  const stat = mc(`mc stat --json "local/${objectPath}"`);
  const st = JSON.parse(stat.out) as { status: string; name: string; size: number };
  expect(st).toMatchObject({ status: 'success', name: 'index.html.ydoc' });
  expect(st.size).toBeGreaterThan(0);
  // the object carries the artifact's ttl tag (dies with the artifact)
  const tags = mc(`mc tag list --json "local/${objectPath}"`);
  expect(JSON.parse(tags.out).tagset).toMatchObject({ ttl: '7' });

  await p1.reload();
  await editorReady(p1);
  await waitFor(async () => (await shapes(p1)).length === 2, 10_000, 'shapes after reload');

  // restart the canvas container: the server flushes on SIGTERM and loads from MinIO
  const id = container('canvas');
  expect(spawnSync('docker', ['restart', id]).status).toBe(0);
  await waitFor(async () => {
    try {
      const r = await fetch(`${BASE}/_canvas/readyz`);
      return r.ok;
    } catch {
      return false;
    }
  }, 60_000, 'canvas ready after restart');
  const bytes = mcBytes(objectPath);
  expect(bytes).not.toBeNull();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(bytes!));
  expect(doc.getMap('shapes').size).toBe(2);

  const cr = await newContext(browser);
  ctxs.push(cr);
  const pr = await cr.newPage();
  expect(await openWithLogin(pr, priv.canvas, 'user1')).toBe(200);
  await editorReady(pr);
  await waitFor(async () => (await shapes(pr)).length === 2, 10_000, 'shapes restored after the restart');
  await cr.close();
  // the pages open before the restart reconnect by themselves (close 4503 = restarting)
  await editorReady(p1);
  await editorReady(p2);
});

test(`e. revocation: user2 removed from the ACL is dropped within the re-check interval (${RECHECK_SECONDS}s + ${ACL_CACHE_SECONDS}s cache)`, async () => {
  await waitFor(async () => (await shapes(p2)).length === 2, 10_000, 'user2 live before revocation');
  expect(await wsCloses(p2)).not.toContain(4403);
  const aclPath = `artifacts/${priv.key.replace(/index\.html$/, '.acl.json')}`;
  const acl = JSON.parse(mc(`mc cat "local/${aclPath}"`).out) as { users: string[] };
  expect(acl.users).toEqual(expect.arrayContaining([USERS.user1.email, USERS.user2.email]));
  const next = { ...acl, users: acl.users.filter((u) => u !== USERS.user2.email) };
  const t0 = Date.now();
  expect(mc(`mc pipe "local/${aclPath}" >/dev/null`, JSON.stringify(next)).code).toBe(0);
  const budgetMs = (RECHECK_SECONDS + ACL_CACHE_SECONDS) * 1000 + 3_000;
  await waitFor(async () => (await wsCloses(p2)).includes(4403), budgetMs, 'user2 dropped with 4403');
  const elapsed = Date.now() - t0;
  console.log(`[system-e2e] user2 dropped ${elapsed} ms after the ACL edit (budget ${budgetMs} ms)`);
  expect(elapsed).toBeLessThanOrEqual(budgetMs);
  // the client tells the user and stays closed
  expect(await p2.evaluate(() => (window as any).__canvas.editor.status)).not.toBe('synced');
  // user1 is untouched and still collaborating
  expect(await wsCloses(p1)).not.toContain(4403);
  await draw(p1, [420, 700]);
  await waitFor(async () => (await shapes(p1)).length === 3, 8_000, 'user1 keeps drawing');
  // user2 cannot come back
  expect((await p2.request.get(priv.canvas, { maxRedirects: 0 })).status()).toBe(403);
});

test('f. the artifact iframe is isolated (opaque origin) and the core e2e passes with the plugin enabled', async () => {
  test.setTimeout(300_000);
  const sandbox = await p1.locator('iframe.artifact-frame').getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  const frame = p1.frames().find((f) => f.url().includes('/_canvas/_/frame/'));
  expect(frame, 'artifact frame present').toBeTruthy();
  const probe = await frame!.evaluate(() => {
    const out: Record<string, string> = { origin: String(window.origin) };
    try { out.cookie = String(document.cookie); } catch (e) { out.cookie = (e as Error).name; }
    try { out.parent = String(window.parent.document.title); } catch (e) { out.parent = (e as Error).name; }
    try { out.storage = String(window.localStorage.length); } catch (e) { out.storage = (e as Error).name; }
    return out;
  });
  expect(probe).toEqual({ origin: 'null', cookie: 'SecurityError', parent: 'SecurityError', storage: 'SecurityError' });
  const fr = await p1.request.get(`${BASE}/_canvas/_/frame/artifacts/${priv.key}`);
  expect(fr.status()).toBe(200);
  expect(fr.headers()['content-security-policy']).toBe('sandbox allow-scripts');
  expect(await fr.text()).toContain('artifacts-canvas-reporter');
  // the wrapper page keeps its own strict CSP
  const wr = await p1.request.get(priv.canvas);
  expect(wr.headers()['content-security-policy']).toContain("frame-ancestors 'self'");

  // the core's own end-to-end, unchanged, against this same stack with the plugin enabled
  const e2e = spawnSync('bash', [path.join(CORE_DIR, 'deploy', 'compose', 'e2e.sh')], { encoding: 'utf8', timeout: 280_000 });
  const out = `${e2e.stdout}\n${e2e.stderr}`;
  const passes = (out.match(/^PASS: /gm) ?? []).length;
  const fails = (out.match(/^FAIL: /gm) ?? []).length;
  console.log(`[system-e2e] core deploy/compose/e2e.sh: ${passes} PASS, ${fails} FAIL, exit ${e2e.status}`);
  expect(fails, out).toBe(0);
  expect(out).toContain('E2E: ALL CHECKS PASSED');
  expect(e2e.status).toBe(0);
});
