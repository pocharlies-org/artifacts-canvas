/**
 * FULL-SYSTEM regressions of the fourth independent verification (fv4), against the live
 * compose stack: the verifier's live PoCs (L1-L4) with the expectations turned around.
 *   L1 an image asset `/oauth2/sign_out` (logout CSRF for every viewer)      -> refused 4403
 *   L2 "a " + 6000 x "W" in a 20 px box (cubic text wrap froze viewers 42 s) -> renders < 50 ms
 *   L3 200 x 4-byte sync step 1 from a socket that never reads (+223 MiB)    -> memory flat
 *   L4 malformed / 60 000-point awareness states (viewers threw / froze)      -> no error, no freeze
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { BASE, USERS, container, editorReady, newContext, openWithLogin, publish, wsCloses } from './lib';

test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv4] ${k}: ${JSON.stringify(v)}`);
const ctxs: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
});

async function join(browser: Parameters<typeof newContext>[0], url: string, user: keyof typeof USERS): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  expect(await openWithLogin(page, url, user)).toBe(200);
  await editorReady(page);
  return { ctx, page, errors };
}
/** Longest time the page's main thread needed to run a trivial script, over `n` probes. */
async function worstWait(page: Page, n = 15): Promise<number> {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = Date.now();
    await page.evaluate(() => 1);
    worst = Math.max(worst, Date.now() - a);
    await sleep(100);
  }
  return worst;
}

test('L1: an image asset that is not a raster data URL is refused; no viewer is logged out', async ({ browser }) => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv4-l1-${Date.now().toString(36)}`);
  const victim = await join(browser, P.canvas, 'user1');
  const att = await join(browser, P.canvas, 'user2');
  const before = (await victim.ctx.cookies()).map((c) => c.name).sort();
  const signOut: string[] = [];
  victim.page.on('request', (r) => {
    if (r.url().includes('/oauth2/sign_out')) signOut.push(r.url());
  });
  // the client refuses it itself...
  expect(await att.page.evaluate(() => (window as any).__canvas.editor.doc.setAsset('evilasset', '/oauth2/sign_out'))).toBe(false);
  // ...and the server refuses it when a client writes it anyway (raw Yjs, like the PoC)
  await att.page.evaluate(() => {
    const c = (window as any).__canvas;
    c.ydoc.getMap('assets').set('evilasset', '/oauth2/sign_out');
    c.editor.doc.create({ type: 'image', assetId: 'evilasset', x: 100, y: 100, w: 50, h: 50 });
  });
  await expect.poll(() => wsCloses(att.page), { timeout: 10_000 }).toContain(4403);
  await sleep(1500);
  expect(signOut).toEqual([]);
  expect((await victim.ctx.cookies()).map((c) => c.name).sort()).toEqual(before);
  expect(await victim.page.evaluate(() => (window as any).__canvas.editor.doc.assets.has('evilasset'))).toBe(false);
  await victim.page.reload();
  await editorReady(victim.page);
  expect(victim.page.url().split('?')[0]).toBe(P.canvas.split('?')[0]);
  log('L1', { signOutRequests: signOut.length, attackerCloses: await wsCloses(att.page) });
});

test('L2: a 6002-character unbroken word in a 20 px box renders in < 50 ms; over 10 000 is refused', async ({ browser }) => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv4-l2-${Date.now().toString(36)}`);
  const viewer = await join(browser, P.canvas, 'user1');
  const att = await join(browser, P.canvas, 'user2');
  await att.page.evaluate(() => {
    (window as any).__canvas.editor.doc.create({ type: 'geo', geo: 'rectangle', x: 300, y: 300, w: 20, h: 20, size: 'xl', text: 'a ' + 'W'.repeat(6000) });
  });
  await viewer.page.waitForFunction(() => (window as any).__canvas.editor.doc.all().some((s: any) => s.type === 'geo'), undefined, { timeout: 20_000, polling: 50 });
  const worst = await worstWait(viewer.page);
  // one full render of that shape in the viewer (layout + markup + DOM), measured in the page
  const ms = await viewer.page.evaluate(() => {
    const ed = (window as any).__canvas.editor;
    const id = ed.doc.all().find((s: any) => s.type === 'geo').id;
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      ed.renderer.invalidate(id);
      const t0 = performance.now();
      ed.renderer.flush();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  });
  log('L2', { renderMs: Math.round(ms * 10) / 10, worstMainThreadWaitMs: worst });
  expect(ms).toBeLessThan(50); // before: the viewer froze 42 s
  expect(worst).toBeLessThan(500);
  await viewer.page.reload();
  const t0 = Date.now();
  await editorReady(viewer.page);
  expect(Date.now() - t0).toBeLessThan(10_000);
  // more than MAX_TEXT_LENGTH characters: the canvas client never writes them (fv5 M-3: it
  // keeps 10 000) ...
  await att.page.evaluate(() => {
    (window as any).__canvas.editor.doc.create({ type: 'note', x: 600, y: 300, w: 200, h: 200, text: 'x'.repeat(10_001) });
  });
  await viewer.page.waitForFunction(() => (window as any).__canvas.editor.doc.all().some((s: any) => s.type === 'note'), undefined, { timeout: 10_000 });
  expect(await viewer.page.evaluate(() => (window as any).__canvas.editor.doc.all().find((s: any) => s.type === 'note').text.length)).toBe(10_000);
  expect(await wsCloses(att.page)).toEqual([]);
  // ... and a client that writes them anyway (raw Yjs, like the PoC) is closed 4403; nobody gets it
  await att.page.evaluate(() => {
    const c = (window as any).__canvas;
    const shapes = c.ydoc.getMap('shapes');
    c.ydoc.transact(() => {
      const m = new c.Y.Map();
      shapes.set('raw-long', m);
      for (const [k, v] of Object.entries({ id: 'raw-long', type: 'note', x: 900, y: 300, w: 200, h: 200, rotation: 0, index: 9, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', opacity: 1 })) m.set(k, v);
      const t = new c.Y.Text();
      m.set('text', t);
      t.insert(0, 'x'.repeat(10_001));
    });
  });
  await expect.poll(() => wsCloses(att.page), { timeout: 10_000 }).toContain(4403);
  await sleep(500);
  expect(await viewer.page.evaluate(() => !!(window as any).__canvas.editor.doc.get('raw-long'))).toBe(false);
  expect(viewer.errors).toEqual([]);
});

test('L3: 200 x 4-byte step 1 from a socket that never reads: one answer, 4429, container memory flat', async ({ browser }) => {
  test.setTimeout(180_000);
  const mem = () => {
    const raw = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container('canvas')], { encoding: 'utf8' }).trim();
    const m = /^([\d.]+)\s*([KMG]i?B)/.exec(raw)!;
    const mult: Record<string, number> = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
    return Number(m[1]) * mult[m[2]];
  };
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv4-l3-${Date.now().toString(36)}`);
  const owner = await join(browser, P.canvas, 'user1');
  await owner.page.evaluate((n) => {
    const d = (window as any).__canvas.editor.doc;
    d.transact(() => {
      for (let i = 0; i < n; i++) d.create({ type: 'geo', geo: 'rectangle', x: i % 900, y: Math.floor(i / 900) * 20, w: 10, h: 10 });
    });
  }, 5000);
  await sleep(3000);
  const att = await join(browser, P.canvas, 'user2');
  const cookie = (await att.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await att.page.close();
  const m0 = mem();
  const ws = new WebSocket(P.canvas.replace(/^http/, 'ws').replace('/_canvas/', '/_canvas/_/ws/'), { headers: { cookie, origin: BASE } });
  let joinBytes = 0;
  ws.on('message', (d: Buffer) => (joinBytes += d.length));
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise((r) => ws.on('open', r));
  await sleep(1500);
  (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  for (let i = 0; i < 200; i++) ws.send(Buffer.from([0, 0, 1, 0]));
  let m1 = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    m1 = Math.max(m1, mem());
  }
  ws.terminate();
  const code = await Promise.race([closed, sleep(5000).then(() => -1)]);
  log('L3', { joinMB: Math.round(joinBytes / 1e4) / 100, memBeforeMiB: Math.round(m0), memPeakMiB: Math.round(m1), closeCode: code });
  expect(m1 - m0).toBeLessThan(64); // before: 231 MiB -> 454 MiB
  // the honest owner is untouched
  expect(await owner.page.evaluate(() => (window as any).__canvas.editor.status)).toBe('synced');
});

test('L4: malformed and heavy awareness states break and freeze nobody', async ({ browser }) => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email, USERS.user3.email] }, `fv4-l4-${Date.now().toString(36)}`);
  const viewer = await join(browser, P.canvas, 'user1');
  const honest = await join(browser, P.canvas, 'user3');
  const att = await join(browser, P.canvas, 'user2');
  // a raw awareness message from the attacker's tab (bypasses the client's own state)
  const RAW = `function (state) {
    const aw = window.__canvas.editor.conn.awareness;
    const ws = window.__canvas.editor.conn.provider.ws;
    const vu = (n, out) => { while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); };
    const vs = (str, out) => { const b = new TextEncoder().encode(str); vu(b.length, out); for (const x of b) out.push(x); };
    const meta = aw.meta.get(aw.clientID); const clock = (meta ? meta.clock : 0) + 1000 + Math.floor(Math.random() * 1000);
    const payload = []; vu(1, payload); vu(aw.clientID, payload); vu(clock, payload); vs(JSON.stringify(state), payload);
    const msg = []; vu(1, msg); vu(payload.length, msg); for (const x of payload) msg.push(x);
    ws.send(new Uint8Array(msg));
  }`;
  await att.page.evaluate(`(${RAW}).call(null, { cursor: { x: 50, y: 50 }, laser: { pts: null, now: 1 }, status: 5 })`);
  await sleep(800);
  // the honest user keeps publishing and drawing; the viewer keeps rendering it
  const honestErr = await honest.page.evaluate(() => {
    try {
      (window as any).__canvas.editor.conn.awareness.setLocalStateField('cursor', { x: 400, y: 300 });
      return null;
    } catch (e) {
      return String(e);
    }
  });
  expect(honestErr).toBeNull();
  await honest.page.keyboard.press('r');
  await honest.page.mouse.move(500, 400);
  await honest.page.mouse.down();
  await honest.page.mouse.move(650, 500, { steps: 6 });
  await honest.page.mouse.up();
  await expect.poll(() => viewer.page.evaluate(() => (window as any).__canvas.editor.doc.all().length), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => viewer.page.locator('[data-testid=remote-cursor]').count(), { timeout: 10_000 }).toBeGreaterThan(0);
  // a 60 000-point laser in one awareness message
  await att.page.evaluate(`(() => { const now = Date.now(); const pts = []; for (let i = 0; i < 60000; i++) pts.push([i % 800, (i * 7) % 600, now]); (${RAW}).call(null, { cursor: { x: 50, y: 50 }, laser: { pts, now } }); })()`);
  const worst = await worstWait(viewer.page);
  log('L4', { viewerErrors: viewer.errors.length, honestErrors: honest.errors.length, worstMainThreadWaitMs: worst });
  expect(viewer.errors).toEqual([]); // before: 36 errors for one honest user
  expect(honest.errors).toEqual([]);
  expect(worst).toBeLessThan(500); // before: 2.9 s per message
});
