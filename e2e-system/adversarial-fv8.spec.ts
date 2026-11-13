/**
 * FULL-SYSTEM regressions of the eighth independent verification (fv8), against the live compose
 * stack (the canvas container under the chart's memory limit: 2 GiB, --max-old-space-size=1536 by
 * default). Sizes come from the server's own startup log, so the spec runs at any memory setting.
 *   P1+P2  one ACL writer sends ONE update of 200 000 inserts between the points of two strokes
 *          (3.97 MB). Before: accepted (estimated 4.28 MiB < 5 MiB), the event loop stood 53-65 s,
 *          the room was stored at 7.5 MiB and refused 4413 to everyone, for good (also after a
 *          restart). Now: refused 4413 in the guard, honest edits elsewhere keep p95 < 100 ms,
 *          nobody else is dropped, the room loads for everyone, also after a canvas restart.
 *   P2     2 000 forged items whose right origin is far away (14 KB, no cut): before, Yjs scanned
 *          for ~20 s; now refused 4413 in the guard.
 *   P1     a room stored past every share (by an earlier version) opens, charged one share.
 *   U1     screenshots pasted through the real editor: stored as WebP at most 1600 px (before: 11
 *          Full HD PNGs filled a room, 4 for an anonymous visitor); a full canvas says so and the
 *          socket stays open.
 *   U2     a user who opened a big room and left it to a colleague opens a second big room
 *          (before: 1013 until the first one was evicted).
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BASE, container, editorReady, gotoRetrying, mc, mcBytes, newContext, openWithLogin, publish, waitFor, wsCloses, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv8] ${k}: ${JSON.stringify(v)}`);
const MiB = 1024 * 1024;
const ctxs: BrowserContext[] = [];
const raws: Raw[] = [];
test.afterEach(async () => {
  for (const r of raws.splice(0)) r.ws.terminate();
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
  await sleep(3000);
});

const inspect = (fmt: string) => execFileSync('docker', ['inspect', '-f', fmt, container('canvas')], { encoding: 'utf8' }).trim();
const state = () => ({ restarts: inspect('{{.RestartCount}}'), oom: inspect('{{.State.OOMKilled}}') });
function logs(since = '15m'): string[] {
  return execFileSync('docker', ['logs', '--since', since, container('canvas')], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n');
}
/** The memory sizing the server logged at its last start (budget, shares, caps). */
function sizing(): Record<string, number> {
  const out = execFileSync('docker', ['logs', container('canvas')], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.split('\n').filter((l) => l.includes('"msg":"loaded-room memory budget"'));
  if (!lines.length) throw new Error('the canvas did not log its memory sizing');
  return JSON.parse(lines[lines.length - 1]);
}
function metric(name: string, label = ''): number {
  const out = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  let n = 0;
  for (const line of out.split('\n')) if ((line.startsWith(`${name} `) || line.startsWith(`${name}{`)) && line.includes(label)) n += Number(line.split(' ').pop());
  return n;
}
async function restartCanvas() {
  execFileSync('docker', ['restart', container('canvas')]);
  await waitFor(() => {
    try {
      return inspect('{{.State.Health.Status}}') === 'healthy';
    } catch {
      return false;
    }
  }, 120_000, 'canvas healthy');
}

/** A raw y-websocket peer (no browser), like the verifier's attackers. */
class Raw {
  doc = new Y.Doc();
  ws: WebSocket;
  closeCode: number | null = null;
  synced = false;
  notices: string[] = [];
  constructor(url: string, cookie: string) {
    this.ws = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), origin: BASE }, maxPayload: 512 << 20 });
    raws.push(this);
    this.ws.on('message', (d: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(d));
      const t = decoding.readVarUint(dec);
      if (t === 101) {
        try {
          this.notices.push(JSON.parse(decoding.readVarString(dec)).kind);
        } catch {
          /* ignore */
        }
        return;
      }
      if (t !== 0) return;
      const st = decoding.readVarUint(dec);
      if (st === 0) {
        const sv = decoding.readVarUint8Array(dec);
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(this.doc, sv));
        this.ws.send(encoding.toUint8Array(e));
        this.synced = true;
      } else Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'remote');
    });
    this.ws.on('close', (c) => (this.closeCode = c));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (u: Uint8Array, o: unknown) => {
      if (o === 'remote' || this.ws.readyState !== 1) return;
      this.send(u);
    });
  }
  /** One sync update message with `u` (the server's guard sees exactly this update). */
  send(u: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, u);
    this.ws.send(encoding.toUint8Array(e));
  }
  async ready(ms = 30_000): Promise<boolean> {
    const t0 = Date.now();
    while (!this.synced && this.closeCode === null && Date.now() - t0 < ms) await sleep(100);
    return this.synced && this.closeCode === null;
  }
}
const wsUrl = (canvas: string) => canvas.replace(/^http/, 'ws').replace('/_canvas/', '/_canvas/_/ws/');
const draw = (id: string, j: number) => ({ id, type: 'draw', x: j, y: 0, w: 100, h: 100, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false });
const geo = (id: string, i: number) => ({ id, type: 'geo', geo: 'rectangle', x: i % 900, y: 0, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
const pointsOf = (doc: Y.Doc, id: string) => (doc.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>;
/** The first item of a Y.Array (the stroke's long run of points). */
const firstItem = (arr: Y.Array<number>) => arr._start!;
/** `count` new points of client `client`, the i-th inserted between points i and i+1 of `into` (each one cuts it). */
function insertsBetween(targets: { into: Y.Item; count: number }[], client: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, targets.reduce((a, t) => a + t.count, 0));
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, 0);
  for (const { into, count } of targets) {
    for (let i = 0; i < count; i++) {
      encoding.writeUint8(e, 8 | 0x80 | 0x40);
      encoding.writeVarUint(e, into.id.client);
      encoding.writeVarUint(e, into.id.clock + i);
      encoding.writeVarUint(e, into.id.client);
      encoding.writeVarUint(e, into.id.clock + i + 1);
      encoding.writeVarUint(e, 1);
      encoding.writeAny(e, 7);
    }
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}
async function login(browser: Parameters<typeof newContext>[0], url: string, user: UserName) {
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, url, user)).toBe(200);
  await editorReady(page);
  return { ctx, page, cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ') };
}
/** Honest edits from `w`, read back by `r`, every ~100 ms until stop(); their latencies. */
function honestEdits(w: Raw, r: Raw) {
  const lat: number[] = [];
  let stop = false;
  const done = (async () => {
    for (let i = 0; !stop; i++) {
      const id = `h${Date.now()}-${i}`;
      const t = Date.now();
      w.doc.getMap('shapes').set(id, mapOf(geo(id, i)));
      while (!r.doc.getMap('shapes').has(id) && Date.now() - t < 120_000) await sleep(5);
      lat.push(Date.now() - t);
      await sleep(100);
    }
  })();
  return {
    async stop() {
      stop = true;
      await done;
      const s = [...lat].sort((a, b) => a - b);
      return { n: s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
    },
  };
}

test('P1+P2: one ACL writer\'s 3.97 MB update of 200 000 cuts is refused 4413 in the guard; honest edits elsewhere keep p95 < 100 ms; nobody else drops; the room loads for everyone, also after a restart', async ({ browser }) => {
  test.setTimeout(600_000);
  const s0 = state();
  const stamp = Date.now();
  const A = publish({ users: ['test@example.com', 'test2@example.com'] }, `fv8-p1a-${stamp}`);
  const B = publish({ users: ['test@example.com'] }, `fv8-p1b-${stamp}`);
  const owner = await login(browser, A.canvas, 'user1');
  for (let i = 0; i < 5; i++) await owner.page.evaluate((i) => (window as any).__canvas.editor.doc.create({ type: 'geo', geo: 'rectangle', x: 40 + i * 130, y: 40, w: 120, h: 80 }), i);
  // the owner also edits ANOTHER room B (a raw writer and reader): their latency shows any freeze
  const bw = new Raw(wsUrl(B.canvas), owner.cookie);
  const br = new Raw(wsUrl(B.canvas), owner.cookie);
  expect(await bw.ready()).toBe(true);
  expect(await br.ready()).toBe(true);
  // the attacker, in A's ACL, on a raw socket with its browser cookie
  const att = await login(browser, A.canvas, 'user2');
  await att.page.close();
  const m = new Raw(wsUrl(A.canvas), att.cookie);
  expect(await m.ready()).toBe(true);
  await waitFor(() => m.doc.getMap('shapes').size >= 5, 20_000, 'owner shapes synced');
  const N = 100_000;
  m.doc.clientID = 4294967000;
  m.doc.transact(() => {
    for (let s = 0; s < 2; s++) {
      const sm = mapOf(draw(`m${s}`, s));
      sm.set('points', new Y.Array<number>());
      m.doc.getMap('shapes').set(`m${s}`, sm);
    }
  });
  for (let s = 0; s < 2; s++) {
    const arr = pointsOf(m.doc, `m${s}`);
    m.doc.transact(() => {
      arr.insert(0, [1]);
      arr.insert(0, Array.from({ length: N + 1 }, (_, i) => i % 100));
    });
  }
  await sleep(3000);
  expect(m.closeCode).toBeNull();
  const attack = insertsBetween([0, 1].map((s) => ({ into: firstItem(pointsOf(m.doc, `m${s}`)), count: N })), 4294967001);
  expect(attack.byteLength).toBe(3967169);
  const honest = honestEdits(bw, br);
  await sleep(2000);
  const t0 = Date.now();
  m.send(attack);
  await waitFor(() => m.closeCode !== null, 60_000, 'the attacker is closed');
  const refusedMs = Date.now() - t0;
  await sleep(3000);
  const lat = await honest.stop();
  const honestB = { writer: bw.closeCode, reader: br.closeCode };
  const ownerTab = { closes: await wsCloses(owner.page), status: await owner.page.evaluate(() => (window as any).__canvas.editor.status) };
  const refusals = logs('5m').filter((l) => l.includes('update refused: too many cuts')).length;
  // everyone leaves A; it is saved and evicted; the owner comes back in the browser, the attacker
  // on a raw socket, and again after a canvas restart
  m.ws.close();
  await owner.page.close();
  await sleep(6000);
  const stored = (mcBytes(`artifacts/_plugins/canvas/${A.key}.ydoc`) ?? Buffer.alloc(0)).byteLength + (mcBytes(`artifacts/_plugins/canvas/${A.key}.ydoc.ledger`) ?? Buffer.alloc(0)).byteLength;
  const page = await owner.ctx.newPage();
  await gotoRetrying(page, A.canvas);
  await editorReady(page);
  const reopened = { closes: await wsCloses(page), shapes: await page.evaluate(() => (window as any).__canvas.editor.doc.all().length) };
  await page.close();
  const s1 = state();
  await restartCanvas();
  const o2 = new Raw(wsUrl(A.canvas), owner.cookie);
  const a2 = new Raw(wsUrl(A.canvas), att.cookie);
  const afterRestart = { owner: await o2.ready(), attacker: await a2.ready() };
  const result = { updateBytes: attack.byteLength, attackerClose: m.closeCode, attackerNotices: m.notices, refusedMs, refusals, honestLatencyMs: lat, honestB, ownerTab, storedMiB: +(stored / MiB).toFixed(2), reopened, afterRestart, state: s1 };
  log('P1+P2 live', result);
  expect(m.closeCode).toBe(4413);
  expect(m.notices).toContain('too-large');
  expect(refusals).toBeGreaterThanOrEqual(1);
  expect(refusedMs).toBeLessThan(5000);
  expect(lat.p95).toBeLessThan(100);
  expect(honestB).toEqual({ writer: null, reader: null });
  expect(ownerTab).toEqual({ closes: [], status: 'synced' });
  expect(stored).toBeLessThan(sizing().maxDocMiB * MiB);
  expect(reopened.closes).toEqual([]);
  expect(reopened.shapes).toBe(7);
  expect(afterRestart).toEqual({ owner: true, attacker: true });
  expect(s1).toEqual(s0);
  expect(s1).toEqual({ restarts: '0', oom: 'false' });
});

test('P2: 2 000 forged items whose right origin is far away (14 KB, no cut) are refused 4413; honest edits elsewhere keep p95 < 100 ms', async ({ browser }) => {
  test.setTimeout(300_000);
  const s0 = state();
  const stamp = Date.now();
  const A = publish({ users: ['test@example.com'] }, `fv8-p2a-${stamp}`);
  const B = publish({ users: ['test@example.com'] }, `fv8-p2b-${stamp}`);
  const u = await login(browser, A.canvas, 'user1');
  await u.page.close();
  const bw = new Raw(wsUrl(B.canvas), u.cookie);
  const br = new Raw(wsUrl(B.canvas), u.cookie);
  const m = new Raw(wsUrl(A.canvas), u.cookie);
  for (const r of [bw, br, m]) expect(await r.ready()).toBe(true);
  // a stroke of 50 000 separate points (two client ids alternating), in batches of 1 000
  m.doc.transact(() => {
    const sm = mapOf(draw('s', 0));
    sm.set('points', new Y.Array<number>());
    m.doc.getMap('shapes').set('s', sm);
  });
  await sleep(1000);
  // built in a helper doc (one transaction per point, two client ids: no item merges) and sent
  // as one update per 1 000 points
  const helper = new Y.Doc();
  Y.applyUpdate(helper, Y.encodeStateAsUpdate(m.doc));
  const hp = pointsOf(helper, 's');
  for (let b = 0; b < 50; b++) {
    const sv = Y.encodeStateVector(helper);
    for (let i = 0; i < 1000; i++) {
      helper.clientID = 3000 + (i % 2);
      hp.push([i % 100]);
    }
    const u = Y.encodeStateAsUpdate(helper, sv);
    Y.applyUpdate(m.doc, u, 'remote');
    m.send(u);
    await sleep(150);
  }
  await sleep(2000);
  expect(m.closeCode).toBeNull();
  const pts = pointsOf(m.doc, 's');
  expect(pts.length).toBe(50_000);
  const first = pts._start!;
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
  const honest = honestEdits(bw, br);
  await sleep(2000);
  const t0 = Date.now();
  m.send(forged);
  await waitFor(() => m.closeCode !== null, 60_000, 'the attacker is closed');
  const refusedMs = Date.now() - t0;
  await sleep(3000);
  const lat = await honest.stop();
  log('P2 placement live', { bytes: forged.byteLength, close: m.closeCode, notices: m.notices, refusedMs, honestLatencyMs: lat });
  expect(m.closeCode).toBe(4413);
  expect(refusedMs).toBeLessThan(5000);
  expect(lat.p95).toBeLessThan(100);
  expect([bw.closeCode, br.closeCode]).toEqual([null, null]);
  expect(state()).toEqual(s0);
});

test('P1: a room stored past every share (by an earlier version) opens for its owner in the browser, charged one share, with a warning in the log', async ({ browser }) => {
  test.setTimeout(300_000);
  const cfg = sizing();
  const P = publish({ users: ['test@example.com'] }, `fv8-big-${Date.now()}`);
  // the stored room: an image whose room costs 10% more than a user's share
  const bytes = Math.ceil(((cfg.userShareMiB * MiB) / cfg.costFactor) * 1.1);
  const d = new Y.Doc();
  d.transact(() => {
    // as the editor leaves a room (its page width written on first use)
    d.getMap('meta').set('pageWidth', 980);
    d.getMap('assets').set('a1', 'data:image/png;base64,' + 'A'.repeat(bytes - 2048));
    d.getMap('shapes').set('img', mapOf({ id: 'img', type: 'image', assetId: 'a1', x: 0, y: 0, w: 600, h: 400, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
  });
  const content = Buffer.from(Y.encodeStateAsUpdate(d));
  const put = mc(`mc pipe "local/artifacts/_plugins/canvas/${P.key}.ydoc"`, content);
  expect(put.code, put.err).toBe(0);
  const s0 = state();
  const u = await login(browser, P.canvas, 'user1');
  const assets = await u.page.evaluate(() => (window as any).__canvas.editor.doc.assets.size);
  await sleep(1000);
  const closes = await wsCloses(u.page);
  const warned = logs('5m').some((l) => l.includes('stored room costs more than a share'));
  const charged = metric('canvas_room_memory_charged_bytes', 'who="user_max"');
  // the owner deletes the image (a delete always passes): the room shrinks at the next save
  await u.page.evaluate(() => (window as any).__canvas.editor.doc.delete(['img']));
  await sleep(1500);
  const afterDelete = { closes: await wsCloses(u.page), shapes: await u.page.evaluate(() => (window as any).__canvas.editor.doc.all().length) };
  log('P1 oversized stored room', { storedMiB: +(content.byteLength / MiB).toFixed(2), userShareMiB: cfg.userShareMiB, costFactor: cfg.costFactor, assets, closes, warned, chargedMiB: Math.round(charged / MiB), afterDelete });
  expect(assets).toBe(1);
  expect(closes).toEqual([]);
  expect(afterDelete).toEqual({ closes: [], shapes: 0 });
  expect(warned).toBe(true);
  expect(charged).toBeLessThanOrEqual(cfg.userShareMiB * MiB * 1.001);
  expect(state()).toEqual(s0);
});

/** Screenshot-like pages: text, tables, charts and a photo region, all different (rendered locally, no network). */
async function screenshots(browser: Parameters<typeof newContext>[0], viewport: { width: number; height: number }, dpr: number, n: number): Promise<Buffer[]> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const out: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    await page.setContent(`<!doctype html><html><body style="margin:0;font:15px system-ui,sans-serif;color:#222">
      <div style="height:56px;background:hsl(${k * 47},55%,35%);color:#fff;display:flex;align-items:center;padding:0 24px;font-size:20px">Dashboard ${k} — quarterly report</div>
      <div style="display:flex"><div style="width:240px;background:#f3f4f6;min-height:1100px;padding:16px">${Array.from({ length: 24 }, (_, i) => `<div style="padding:6px 0">Menu item ${k}.${i}</div>`).join('')}</div>
      <div style="flex:1;padding:24px"><canvas id="c" width="900" height="300" style="border:1px solid #ddd"></canvas><canvas id="p" width="420" height="300" style="margin-left:16px"></canvas>
      <table style="border-collapse:collapse;margin-top:16px;width:100%">${Array.from({ length: 14 }, (_, r) => `<tr>${Array.from({ length: 7 }, (_, c) => `<td style="border:1px solid #ddd;padding:6px">${(r * 7 + c) * (k + 3)} units</td>`).join('')}</tr>`).join('')}</table>
      ${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} of page ${k}: the canvas stores pasted screenshots as WebP at most 1600 px wide; a Full HD PNG was ~450 KiB of base64 and eleven filled a room. Collaborative annotation over published artifacts, with attribution per shape.</p>`).join('')}
      </div></div><script>
      const c = document.getElementById('c').getContext('2d'); let s = ${k + 1};
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 40; i++) { c.fillStyle = 'hsl(' + Math.floor(rnd() * 360) + ',60%,55%)'; const h = rnd() * 280; c.fillRect(10 + i * 22, 290 - h, 18, h); }
      const p = document.getElementById('p').getContext('2d'); const img = p.createImageData(420, 300);
      for (let y = 0; y < 300; y++) for (let x = 0; x < 420; x++) { const o = (y * 420 + x) * 4; const v = 120 + 60 * Math.sin(x / 23 + ${k}) * Math.cos(y / 17) + 25 * Math.sin((x + y) / 7) + rnd() * 8; img.data[o] = v; img.data[o + 1] = v * 0.8 + 20 * Math.cos(x / 11); img.data[o + 2] = 200 - v * 0.5; img.data[o + 3] = 255; }
      p.putImageData(img, 0, 0);
      </script></body></html>`);
    out.push(await page.screenshot({ type: 'png' }));
  }
  await ctx.close();
  return out;
}
/** Paste every screenshot (round after round) through the real editor until it says the canvas is full. */
async function pasteUntilFull(page: Page, shots: Buffer[]) {
  const b64 = shots.map((s) => s.toString('base64'));
  let accepted = 0;
  for (let i = 0; i < 400; i++) {
    const r = await page.evaluate(async (data) => {
      const ed = (window as any).__canvas.editor;
      const before = { assets: ed.doc.assets.size, full: ed.canvasFullRefusals };
      const bin = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
      await ed.insertImageFile(new File([bin], 'shot.png', { type: 'image/png' }));
      return { added: ed.doc.assets.size - before.assets, full: ed.canvasFullRefusals - before.full, toast: document.querySelector('[data-testid="toast"]')?.textContent ?? '' };
    }, b64[i % b64.length]);
    if (r.full) return { accepted, toast: r.toast };
    accepted += r.added;
    await sleep(300);
  }
  return { accepted, toast: '' };
}

test('U1: screenshots pasted through the editor are stored small (at least 3 x as many fit as PNG, signed-in and anonymous); a full canvas says so and the socket stays open', async ({ browser }) => {
  test.setTimeout(900_000);
  const cfg = sizing();
  const fullhd = await screenshots(browser, { width: 1920, height: 1080 }, 1, 6);
  const retina = await screenshots(browser, { width: 1440, height: 900 }, 2, 4);
  const summary: Record<string, unknown> = { fullhdPngKiB: fullhd.map((b) => Math.round(b.byteLength / 1024)), retinaPngKiB: retina.map((b) => Math.round(b.byteLength / 1024)) };
  /** how many of these PNGs, as data URLs, a room of `cap` held before (the editor stored PNG as it came) */
  const pngFit = (shots: Buffer[], cap: number) => {
    let used = 0;
    let n = 0;
    for (let i = 0; ; i++) {
      const add = Math.ceil((shots[i % shots.length].byteLength * 4) / 3) + 4096;
      if (used + add > cap) return n;
      used += add;
      n++;
    }
  };
  for (const [label, shots, who] of [['user-fullhd', fullhd, 'user1'], ['anon-fullhd', fullhd, 'anon'], ['user-retina', retina, 'user1']] as const) {
    const P = who === 'anon' ? publish('pub', `fv8-u1-${label}-${Date.now()}`) : publish({ users: ['test@example.com'] }, `fv8-u1-${label}-${Date.now()}`);
    const ctx = await newContext(browser);
    ctxs.push(ctx);
    const page = await ctx.newPage();
    if (who === 'anon') await gotoRetrying(page, P.canvas);
    else expect(await openWithLogin(page, P.canvas, 'user1')).toBe(200);
    await editorReady(page);
    const cap = await page.evaluate(() => (window as any).__canvas.editor.cfg.maxDocBytes);
    // the visitor's cap (the server logs it in MiB with two decimals)
    expect(Math.abs(cap - (who === 'anon' ? cfg.anonMaxDocMiB : cfg.maxDocMiB) * MiB)).toBeLessThan(0.01 * MiB);
    const r = await pasteUntilFull(page, shots);
    await sleep(2500);
    const closes = await wsCloses(page);
    const status = await page.evaluate(() => (window as any).__canvas.editor.status);
    // the server has every image the editor accepted
    const reader = new Raw(wsUrl(P.canvas), (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; '));
    expect(await reader.ready()).toBe(true);
    await waitFor(() => reader.doc.getMap('assets').size === r.accepted, 30_000, 'images on the server');
    const kinds = [...reader.doc.getMap('assets').values()].map((v) => String(v).slice(5, String(v).indexOf(';')));
    const before = pngFit(shots, cap);
    summary[label] = { capMiB: +(cap / MiB).toFixed(2), pngFitBefore: before, fitNow: r.accepted, ratio: +(r.accepted / Math.max(1, before)).toFixed(1), storedAs: [...new Set(kinds)], toast: r.toast, closes, status };
    expect(r.toast).toMatch(/maximum size|tamaño máximo/);
    expect(closes).toEqual([]);
    expect(status).toBe('synced');
    // Full HD shots were stored as they came; Retina ones (> 2000 px) the old editor re-encoded as
    // a 1600 px PNG, so their "before" here is only a lower bound: not asserted
    if (label.endsWith('fullhd')) expect(r.accepted).toBeGreaterThanOrEqual(3 * Math.max(1, before));
  }
  log('U1 screenshots', summary);
});

test('U2: a user who opened a big room and left it to a colleague opens a second big room (before: 1013 while the colleague kept the first open)', async ({ browser }) => {
  test.setTimeout(600_000);
  const cfg = sizing();
  const stamp = Date.now();
  const R1 = publish({ users: ['test@example.com', 'test2@example.com'] }, `fv8-u2a-${stamp}`);
  const R2 = publish({ users: ['test@example.com', 'test2@example.com'] }, `fv8-u2b-${stamp}`);
  const ana = await login(browser, R1.canvas, 'user1');
  await ana.page.close();
  const carl = await login(browser, R2.canvas, 'user2');
  await carl.page.close();
  await sleep(4000);
  // two stored rooms whose loads together pass a share: 72% and 33% of it (images, in messages
  // of at most a fifth of the message cap)
  const shareBytes = cfg.userShareMiB * MiB;
  const fill = async (url: string, fraction: number) => {
    const w = new Raw(url, ana.cookie);
    expect(await w.ready()).toBe(true);
    let left = Math.floor((shareBytes * fraction) / cfg.costFactor) - 64 * 1024;
    const chunk = Math.floor((cfg.maxMessageMiB * MiB) / 5);
    for (let i = 0; left > 0; i++) {
      const n = Math.min(chunk, left);
      w.doc.transact(() => {
        w.doc.getMap('assets').set(`a${i}`, 'data:image/png;base64,' + 'A'.repeat(n - n % 4));
        w.doc.getMap('shapes').set(`i${i}`, mapOf({ id: `i${i}`, type: 'image', assetId: `a${i}`, x: i * 10, y: 0, w: 100, h: 100, rotation: 0, index: i, groupId: '', locked: false, opacity: 1 }));
      });
      left -= n;
      await sleep(1500);
    }
    await sleep(2000);
    expect(w.closeCode).toBeNull();
    w.ws.close();
  };
  await fill(wsUrl(R1.canvas), 0.72);
  await fill(wsUrl(R2.canvas), 0.33);
  await sleep(8000); // saved and evicted
  // ana opens R1 (her join loads it), carl joins, ana leaves; ana opens R2
  const a1 = new Raw(wsUrl(R1.canvas), ana.cookie);
  expect(await a1.ready()).toBe(true);
  const c1 = new Raw(wsUrl(R1.canvas), carl.cookie);
  expect(await c1.ready()).toBe(true);
  const chargedBefore = metric('canvas_room_memory_charged_bytes', 'who="user_max"');
  a1.ws.close();
  await sleep(2000);
  let a2: Raw | null = null;
  const codes: (number | null)[] = [];
  for (let i = 0; i < 3; i++) {
    a2 = new Raw(wsUrl(R2.canvas), ana.cookie);
    if (await a2.ready(20_000)) break;
    codes.push(a2.closeCode);
    await sleep(2000);
  }
  log('U2 live', { userShareMiB: cfg.userShareMiB, chargedBeforeLeavingMiB: Math.round(chargedBefore / MiB), refusedFirst: codes, anaOpensR2: a2!.closeCode === null && a2!.synced });
  expect(codes).toEqual([]);
  expect(a2!.synced).toBe(true);
  expect(c1.closeCode).toBeNull();
});

