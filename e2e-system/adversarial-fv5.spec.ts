/**
 * FULL-SYSTEM regressions of the fifth independent verification (fv5), against the live
 * compose stack, whose canvas container runs under the chart's memory limit (compose.yml:
 * mem_limit 2g, NODE_OPTIONS --max-old-space-size=1536):
 *   P5  one ACL member, a ~20 MB room, dozens of paused sockets (before, at the old 1 GiB
 *       limit: +400-700 MiB and the container OOM-killed) -> 8 accepted, memory flat, dropped
 *       by the ping timeout, the container never restarts, honest users keep editing
 *   M-2 offline typing + a keystroke while the tab reconnects after a canvas restart
 *       (before: 4403, the offline work lost) -> accepted
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { BASE, USERS, container, editorReady, newContext, openWithLogin, publish, waitFor, wsCloses } from './lib';

test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv5] ${k}: ${JSON.stringify(v)}`);
const ctxs: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
});

async function join(browser: Parameters<typeof newContext>[0], url: string, user: keyof typeof USERS): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, url, user)).toBe(200);
  await editorReady(page);
  return { ctx, page };
}
/** canvas container memory (MiB, cgroup usage as docker stats reports it) */
const mem = () => {
  const raw = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container('canvas')], { encoding: 'utf8' }).trim();
  const m = /^([\d.]+)\s*([KMG]i?B)/.exec(raw)!;
  const mult: Record<string, number> = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  return Number(m[1]) * mult[m[2]];
};
const inspect = (fmt: string) => execFileSync('docker', ['inspect', '-f', fmt, container('canvas')], { encoding: 'utf8' }).trim();
/** One counter of the canvas metrics (internal port, read inside the container). */
function metric(name: string, label = ''): number {
  const out = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  let n = 0;
  for (const line of out.split('\n')) if (line.startsWith(name) && line.includes(label)) n += Number(line.split(' ').pop());
  return n;
}

test('P5: dozens of paused sockets of one ACL member on a ~20 MB room: memory flat under the chart limit, no restart, honest users unaffected', async ({ browser }) => {
  test.setTimeout(420_000);
  // the container runs with the chart's memory limit
  expect(Number(inspect('{{.HostConfig.Memory}}'))).toBe(2 * 1024 ** 3);
  const restarts0 = inspect('{{.RestartCount}}');
  const started0 = inspect('{{.State.StartedAt}}');
  const P = publish({ users: [USERS.user1.email, USERS.user2.email, USERS.user3.email] }, `fv5-p5-${Date.now().toString(36)}`);
  const owner = await join(browser, P.canvas, 'user1');
  // ~17 MB of content + ledger: a big room just under the 20 MiB cap (the cap counts an upper
  // bound until the next save, so 40 000 shapes can be refused near the end)
  const n = 34_000;
  for (let b = 0; b < n; b += 4000) {
    await owner.page.evaluate(([b, n]) => {
      const d = (window as any).__canvas.editor.doc;
      d.transact(() => {
        for (let i = b; i < Math.min(n, b + 4000); i++) d.create({ type: 'geo', geo: 'rectangle', x: i % 900, y: Math.floor(i / 900) * 20, w: 10, h: 10, text: 'label ' + i });
      });
    }, [b, n]);
    await sleep(1500);
  }
  await sleep(4000);
  expect((await wsCloses(owner.page)).filter((c) => c >= 4400 && c < 4500)).toEqual([]);
  const viewer = await join(browser, P.canvas, 'user3');
  const att = await join(browser, P.canvas, 'user2');
  const cookie = (await att.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await att.page.close();
  const wsUrl = P.canvas.replace(/^http/, 'ws').replace('/_canvas/', '/_canvas/_/ws/');
  // the join payload, read once by a normal socket
  const probe = new WebSocket(wsUrl, { headers: { cookie, origin: BASE }, maxPayload: 256 << 20 });
  let joinBytes = 0;
  probe.on('message', (d: Buffer) => (joinBytes += d.length));
  await new Promise((r) => probe.on('open', r));
  await sleep(4000);
  probe.close();
  await sleep(500);
  const idle0 = metric('canvas_ws_rejected_total', 'reason="idle"');
  const m0 = mem();
  const N = 30;
  const socks: WebSocket[] = [];
  let opened = 0;
  for (let i = 0; i < N; i++) {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: BASE } });
    ws.on('open', () => {
      opened++;
      (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    });
    ws.on('error', () => undefined);
    socks.push(ws);
    await sleep(100);
  }
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    peak = Math.max(peak, mem());
  }
  // an honest edit during the attack reaches the other user at once
  const t0 = Date.now();
  const id = await owner.page.evaluate(() => (window as any).__canvas.editor.doc.create({ type: 'note', x: 50, y: 50, w: 200, h: 200, text: 'during the attack' }));
  await waitFor(async () => (await viewer.page.evaluate((id) => !!(window as any).__canvas.editor.doc.get(id), id)), 10_000, 'viewer sees the edit');
  const editMs = Date.now() - t0;
  // the paused sockets answer no ping: dropped within two ping rounds (WS_PING_INTERVAL_MS 30 s)
  await waitFor(() => metric('canvas_ws_rejected_total', 'reason="idle"') - idle0 >= 8, 120_000, 'paused sockets dropped');
  const after = mem();
  for (const s of socks) s.terminate();
  const accepted = metric('canvas_ws_rejected_total', 'reason="idle"') - idle0;
  log('P5', { joinMB: Math.round(joinBytes / 1e4) / 100, opened, accepted, memBeforeMiB: Math.round(m0), memPeakMiB: Math.round(peak), memAfterDropMiB: Math.round(after), editMs });
  // before, at the old 1 GiB limit: 575.8 MiB -> 646.5 MiB (+71) with the room loaded, then the
  // container was OOM-killed (restarts=2); without a limit +400 MiB (960.9 MiB -> 1.353 GiB)
  expect(peak - m0).toBeLessThan(150);
  expect(accepted).toBe(8);
  expect(inspect('{{.RestartCount}}')).toBe(restarts0);
  expect(inspect('{{.State.StartedAt}}')).toBe(started0);
  expect(inspect('{{.State.OOMKilled}}')).toBe('false');
  expect(editMs).toBeLessThan(5000);
  expect(await owner.page.evaluate(() => (window as any).__canvas.editor.status)).toBe('synced');
  expect(await viewer.page.evaluate(() => (window as any).__canvas.editor.status)).toBe('synced');
});

test('M-2: offline typing and a keystroke while the tab reconnects after a canvas restart: accepted, nothing refused', async ({ browser }) => {
  test.setTimeout(180_000);
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv5-m2-${Date.now().toString(36)}`);
  const a = await join(browser, P.canvas, 'user1');
  await a.page.evaluate(() => {
    const W = window as any;
    const ed = W.__canvas.editor;
    W.__noteId = ed.doc.create({ type: 'note', x: 200, y: 200, w: 200, h: 200, text: 'online' });
    ed.doc.endGesture();
    const prov = ed.conn.provider;
    const orig = prov.messageHandlers[0];
    W.__armed = false;
    W.__injected = 0;
    prov.messageHandlers[0] = (enc: unknown, dec: { arr: Uint8Array; pos: number }, p: unknown, s: boolean, mt: number) => {
      if (W.__armed && dec.arr[dec.pos] === 0) {
        W.__armed = false;
        W.__injected++;
        ed.doc.update(W.__noteId, { text: ed.doc.get(W.__noteId).text + 'K' });
      }
      return orig(enc, dec, p, s, mt);
    };
    W.__typedOffline = 0;
    ed.conn.onStatus((st: string) => {
      if (st === 'disconnected' && !W.__typedOffline) {
        W.__typedOffline++;
        ed.doc.update(W.__noteId, { text: ed.doc.get(W.__noteId).text + ' typed offline' });
        W.__armed = true;
      }
    });
  });
  await sleep(1500); // saved (SAVE_DEBOUNCE_MS 300)
  expect(spawnSync('docker', ['restart', container('canvas')]).status).toBe(0);
  await waitFor(async () => (await a.page.evaluate(() => (window as any).__typedOffline)) > 0, 60_000, 'offline edit');
  await waitFor(async () => (await a.page.evaluate(() => (window as any).__canvas.editor.status)) === 'synced', 90_000, 'resynced');
  const b = await join(browser, P.canvas, 'user2');
  const want = 'online typed offlineK';
  await waitFor(async () => (await b.page.evaluate(() => (window as any).__canvas.editor.doc.all().find((x: any) => x.type === 'note')?.text)) === want, 20_000, 'room has every edit');
  const closes = await wsCloses(a.page);
  log('M-2', { closes, injected: await a.page.evaluate(() => (window as any).__injected) });
  expect(closes.filter((c) => c >= 4400 && c < 4500)).toEqual([]);
  expect(await a.page.evaluate(() => (window as any).__injected)).toBe(1);
});
