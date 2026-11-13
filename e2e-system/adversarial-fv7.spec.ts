/**
 * FULL-SYSTEM regressions of the seventh independent verification (fv7 F1), against the live
 * compose stack, whose canvas container runs under the chart's memory limit (compose.yml: 2304m and
 * HEAP_LIMIT_MB=1776 by default since fv9; CANVAS_MEM_LIMIT / CANVAS_HEAP_LIMIT_MB run it at 1 GiB
 * too). The sizes come from the server itself (its startup log and metrics), so the same spec
 * runs at any memory setting.
 *   DOS     one signed-in user fills pub/ rooms while anonymous visitors sit in each of them,
 *           keeps one socket per room open, and the visitors leave
 *   COVIEW  the same with signed-in co-viewers of the artifacts (honest users reading along)
 * Before (live, 2 GiB): the user was charged its growth divided by the principals present, kept
 * the rooms loaded alone once they left and held 856 MiB of the 920 MiB budget (share 600 MiB,
 * loads up to 828 MiB); a second user opening a NEW artifact got 1013 busy 13 times in a row.
 * Now: the user is charged what it wrote, in full, and stopped at its share (a third of the
 * budget); the second user opens a new artifact and draws; the container never restarts.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BASE, USERS, container, editorReady, newContext, openWithLogin, publish, waitFor, wsCloses, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv7] ${k}: ${JSON.stringify(v)}`);
const ctxs: BrowserContext[] = [];
const raws: Raw[] = [];
test.afterEach(async () => {
  for (const r of raws.splice(0)) r.ws.terminate();
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
  // every room of this test evicted before the next one (their holders are gone)
  await sleep(3000);
});

const ROOMS = Number(process.env.FV7_ROOMS ?? 4);
const SITTERS = Number(process.env.FV7_SITTERS ?? 3);
const MiB = 1024 * 1024;

/** canvas container memory (MiB, cgroup usage as docker stats reports it) */
const mem = () => {
  const raw = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container('canvas')], { encoding: 'utf8' }).trim();
  const m = /^([\d.]+)\s*([KMG]i?B)/.exec(raw)!;
  const mult: Record<string, number> = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  return Math.round(Number(m[1]) * mult[m[2]]);
};
const inspect = (fmt: string) => execFileSync('docker', ['inspect', '-f', fmt, container('canvas')], { encoding: 'utf8' }).trim();
const state = () => ({ restarts: inspect('{{.RestartCount}}'), oom: inspect('{{.State.OOMKilled}}'), started: inspect('{{.State.StartedAt}}') });
/** The canvas metrics (internal port, read inside the container): the sum of the matching lines. */
function metric(name: string, label = ''): number {
  const out = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  let n = 0;
  for (const line of out.split('\n')) if ((line.startsWith(`${name} `) || line.startsWith(`${name}{`)) && line.includes(label)) n += Number(line.split(' ').pop());
  return n;
}
/** The memory sizing the server logged at its last start (budget, shares, caps). */
function sizing(): Record<string, number> {
  const out = execFileSync('docker', ['logs', container('canvas')], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.split('\n').filter((l) => l.includes('"msg":"loaded-room memory budget"'));
  if (!lines.length) throw new Error('the canvas did not log its memory sizing');
  return JSON.parse(lines[lines.length - 1]);
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
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
  }
  async ready(ms = 30_000): Promise<boolean> {
    const t0 = Date.now();
    while (!this.synced && this.closeCode === null && Date.now() - t0 < ms) await sleep(100);
    return this.synced && this.closeCode === null;
  }
  /** Fill with labelled geo shapes in batches until closed (or `max`); the shapes accepted. */
  async fill(prefix: string, max: number, batch: number, pause: number): Promise<number> {
    let done = 0;
    for (let b = 0; b < max && this.closeCode === null; b += batch) {
      this.doc.transact(() => {
        const s = this.doc.getMap('shapes');
        for (let i = b; i < Math.min(max, b + batch); i++) {
          const id = `${prefix}s${i}`;
          const m = new Y.Map<unknown>();
          s.set(id, m);
          for (const [k, v] of Object.entries(geo(id, i))) m.set(k, v);
          const t = new Y.Text();
          m.set('text', t);
          t.insert(0, 'label ' + i);
        }
      });
      await sleep(pause);
      if (this.closeCode === null) done = Math.min(max, b + batch);
    }
    return done;
  }
}
const geo = (id: string, i: number) => ({ id, type: 'geo', geo: 'rectangle', x: i % 900, y: Math.floor(i / 900) * 20, w: 10, h: 10, rotation: 0, index: i, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const wsUrl = (canvas: string) => canvas.replace(/^http/, 'ws').replace('/_canvas/', '/_canvas/_/ws/');

async function cookieOf(browser: Parameters<typeof newContext>[0], url: string, user: UserName): Promise<string> {
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, url, user)).toBe(200);
  await editorReady(page);
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await page.close();
  return cookie;
}

/** A peer that joins and stays (retried while the server answers 1013, e.g. the anonymous mint rate). */
async function sitter(url: string, cookie: string): Promise<Raw> {
  for (let i = 0; ; i++) {
    const r = new Raw(url, cookie);
    if (await r.ready()) return r;
    if (r.closeCode !== 1013 || i >= 20) throw new Error(`sitter refused ${r.closeCode} ${r.notices.join(',')}`);
    await sleep(1500);
  }
}

/**
 * The attack: `attacker` (signed in) fills one room after the other while `sitters(room)` sit in
 * it; it keeps a reader socket in every room; then the sitters leave.
 */
async function attack(rooms: string[], attackerCookie: string, sitters: (url: string) => Promise<Raw[]>) {
  const cfg = sizing();
  // ~520 encoded bytes per labelled shape (content + ledger): batches of ~0.5 MB or less, so
  // that a batch is a fraction of the room cap at any memory setting
  const batch = Math.max(100, Math.min(1000, Math.floor((cfg.maxDocMiB * MiB) / 520 / 4)));
  const perRoom = Math.ceil((cfg.maxDocMiB * MiB) / 400);
  const refused0 = { principal: metric('canvas_ws_rejected_total', 'reason="room_memory_principal"'), total: metric('canvas_ws_rejected_total', 'reason="room_memory"') };
  const sat: Raw[] = [];
  const keepers: Raw[] = [];
  const result: { filled: number; close: number | null; notices: string[]; sitters: number }[] = [];
  let peak = mem();
  let maxCharged = 0;
  for (const [r, url] of rooms.entries()) {
    const s = await sitters(url);
    sat.push(...s);
    const keep = new Raw(url, attackerCookie);
    keepers.push(keep);
    await keep.ready();
    const w = new Raw(url, attackerCookie);
    await w.ready();
    const filled = await w.fill(`r${r}`, perRoom, batch, 900);
    await waitFor(() => w.closeCode !== null, 15_000, 'the writer is stopped').catch(() => undefined);
    peak = Math.max(peak, mem());
    maxCharged = Math.max(maxCharged, metric('canvas_room_memory_charged_bytes', 'who="user_max"'));
    result.push({ filled, close: w.closeCode, notices: w.notices, sitters: s.filter((x) => x.closeCode === null).length });
    log(`room ${r + 1}/${rooms.length}`, { ...result[r], memMiB: mem(), chargedMiB: Math.round(maxCharged / MiB) });
  }
  const sittersOpen = sat.filter((x) => x.closeCode === null).length;
  for (const x of sat) x.ws.close();
  await sleep(3000);
  peak = Math.max(peak, mem());
  const charged = metric('canvas_room_memory_charged_bytes', 'who="user_max"');
  maxCharged = Math.max(maxCharged, charged);
  return {
    cfg, batch, result, sittersOpen, keepers, peak, maxCharged,
    after: { loadedMiB: Math.round(metric('canvas_room_memory_bytes') / MiB), chargedMiB: Math.round(charged / MiB), keepersOpen: keepers.filter((k) => k.closeCode === null).length },
    refused: { principal: metric('canvas_ws_rejected_total', 'reason="room_memory_principal"') - refused0.principal, total: metric('canvas_ws_rejected_total', 'reason="room_memory"') - refused0.total },
  };
}

/** After the attack: `user` opens a NEW artifact in the browser, it syncs, and a shape it draws reaches the server. */
async function honestOpensNew(browser: Parameters<typeof newContext>[0], user: UserName, run: string) {
  const P = publish({ users: [USERS[user].email] }, run);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, P.canvas, user)).toBe(200);
  const t0 = Date.now();
  await editorReady(page);
  const syncedMs = Date.now() - t0;
  const id = await page.evaluate(() => (window as any).__canvas.editor.doc.create({ type: 'geo', geo: 'rectangle', x: 40, y: 40, w: 120, h: 80 }));
  // a second socket of the same user reads the room back from the server
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const reader = new Raw(wsUrl(P.canvas), cookie);
  expect(await reader.ready()).toBe(true);
  await waitFor(() => reader.doc.getMap('shapes').has(id), 20_000, `${user}'s shape on the server`);
  const closes = await wsCloses(page);
  return { syncedMs, closes, status: await page.evaluate(() => (window as any).__canvas.editor.status) };
}

function check(r: Awaited<ReturnType<typeof attack>>, s0: ReturnType<typeof state>, limitMiB: number) {
  const shareBytes = metric('canvas_room_memory_share_bytes', 'who="user"');
  // the sitters sat in every room while it grew
  expect(r.sittersOpen).toBe(ROOMS * SITTERS);
  // the attacker was stopped by its share: a 1013 busy, counted as room_memory_principal
  expect(r.result.some((x) => x.close === 1013 && x.notices.includes('busy'))).toBe(true);
  expect(r.refused.principal).toBeGreaterThanOrEqual(1);
  // charged in full, never past its share (plus one update's estimate error), sitters or not
  expect(r.maxCharged).toBeLessThanOrEqual(shareBytes * 1.01);
  expect(r.maxCharged).toBeGreaterThan(shareBytes * 0.5);
  expect(r.after.keepersOpen).toBe(ROOMS);
  // no OOM, no restart, under the container's limit
  const s1 = state();
  expect(s1).toEqual(s0);
  expect(s1.restarts).toBe('0');
  expect(s1.oom).toBe('false');
  expect(r.peak).toBeLessThan(limitMiB);
}

test('DOS: one user fills rooms while anonymous visitors sit in them, the visitors leave: the user holds at most its share, a second user opens a new artifact and draws, no restart', async ({ browser }) => {
  test.setTimeout(900_000);
  const limitMiB = Number(inspect('{{.HostConfig.Memory}}')) / MiB;
  const s0 = state();
  const run = Date.now().toString(36);
  // the attacker's session (a login through an artifact of its own), then pub/ rooms
  const own = publish({ users: [USERS.user1.email] }, `fv7-dos-${run}-login`);
  const c1 = await cookieOf(browser, own.canvas, 'user1');
  const pubs = Array.from({ length: ROOMS }, (_, r) => publish('pub', `fv7-dos-${run}-${r}`));
  const r = await attack(pubs.map((p) => wsUrl(p.canvas)), c1, async (url) => {
    const out: Raw[] = [];
    for (let i = 0; i < SITTERS; i++) out.push(await sitter(url, ''));
    return out;
  });
  const honest = await honestOpensNew(browser, 'user2', `fv7-dos-${run}-new`);
  log('DOS', { limitMiB, sizing: r.cfg, batch: r.batch, rooms: r.result, sittersOpenWhileFilling: r.sittersOpen, maxChargedMiB: Math.round(r.maxCharged / MiB), after: r.after, refused: r.refused, peakMiB: r.peak, honest, before: s0, after_: state() });
  expect(honest.status).toBe('synced');
  expect(honest.closes.filter((c) => c === 1013 || (c >= 4400 && c < 4500))).toEqual([]);
  check(r, s0, limitMiB);
});

test('COVIEW: one user fills rooms while signed-in co-viewers read along, they leave: the user holds at most its share, a co-viewer opens a new artifact and draws, no restart', async ({ browser }) => {
  test.setTimeout(900_000);
  const limitMiB = Number(inspect('{{.HostConfig.Memory}}')) / MiB;
  const s0 = state();
  const run = Date.now().toString(36);
  const all = [USERS.user1.email, USERS.user2.email, USERS.user3.email];
  const arts = Array.from({ length: ROOMS }, (_, r) => publish({ users: all }, `fv7-coview-${run}-${r}`));
  const c1 = await cookieOf(browser, arts[0].canvas, 'user1');
  const c2 = await cookieOf(browser, arts[0].canvas, 'user2');
  const c3 = await cookieOf(browser, arts[0].canvas, 'user3');
  // the co-viewers: user2 and user3 in every room (two sockets each per room would pass their
  // 8-connection limit with 4 rooms; one each), plus anonymous-free u/ artifacts
  const cookies = [c2, c3, c2].slice(0, Math.min(SITTERS, 2));
  const r = await attack(arts.map((p) => wsUrl(p.canvas)), c1, async (url) => {
    const out: Raw[] = [];
    for (const c of cookies) out.push(await sitter(url, c));
    return out;
  });
  const honest = await honestOpensNew(browser, 'user2', `fv7-coview-${run}-new`);
  log('COVIEW', { limitMiB, sizing: r.cfg, batch: r.batch, rooms: r.result, sittersOpenWhileFilling: r.sittersOpen, maxChargedMiB: Math.round(r.maxCharged / MiB), after: r.after, refused: r.refused, peakMiB: r.peak, honest, before: s0, after_: state() });
  expect(honest.status).toBe('synced');
  expect(honest.closes.filter((c) => c === 1013 || (c >= 4400 && c < 4500))).toEqual([]);
  // the co-viewers only read: they are charged nothing (the largest charge is the attacker's)
  expect(r.sittersOpen).toBe(ROOMS * cookies.length);
  expect(r.result.some((x) => x.close === 1013 && x.notices.includes('busy'))).toBe(true);
  expect(r.refused.principal).toBeGreaterThanOrEqual(1);
  const shareBytes = metric('canvas_room_memory_share_bytes', 'who="user"');
  expect(r.maxCharged).toBeLessThanOrEqual(shareBytes * 1.01);
  expect(r.after.keepersOpen).toBe(ROOMS);
  const s1 = state();
  expect(s1).toEqual(s0);
  expect(s1.restarts).toBe('0');
  expect(s1.oom).toBe('false');
  expect(r.peak).toBeLessThan(limitMiB);
});
