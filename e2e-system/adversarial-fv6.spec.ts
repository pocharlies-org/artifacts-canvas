/**
 * FULL-SYSTEM regressions of the sixth independent verification (fv6), against the live compose
 * stack, whose canvas container runs under the chart's memory limit (compose.yml: mem_limit 2304m,
 * HEAP_LIMIT_MB=1776 since fv9, so the server derives a 1088 MiB loaded-room budget (872 MiB before);
 * fv7 F1: a third of it per user, rooms of 5 MiB at most):
 *   Q4  one ACL member opens R rooms and fills each to the size cap through raw sockets (the
 *       verifier's q4-multi-room-oom.spec.ts filled ~17 MB rooms; before: the pod OOM-killed in a
 *       loop) -> the fills past the user's share of the memory budget are refused 1013 busy, the
 *       container never restarts, an honest user in a loaded room joins and edits
 *   Q4b three ACL members fill two rooms each: each is stopped at its share, the third by the
 *       server-wide growth threshold; joins to the loaded rooms go on
 *   Q4c anonymous visitors fill ~14 pub/ rooms to the anonymous cap -> the anonymous visitors
 *       together stop at a third of the budget, no restart; a logged-in user still loads a room
 *       and edits
 * Rooms per test: FV6_ROOMS (default 5; the proof runs 10), FV6_ANON_ROOMS (default 14). The
 * sizes come from the server's startup log (sizing()).
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BASE, USERS, container, editorReady, newContext, openWithLogin, publish, waitFor, type UserName } from './lib';

/** the chart's default memory limit (fv9: 2304 MiB, a worker per loaded room; it was 2 GiB) */
const LIMIT_MIB = 2304;
test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv6] ${k}: ${JSON.stringify(v)}`);
const ctxs: BrowserContext[] = [];
const raws: Raw[] = [];
test.afterEach(async () => {
  for (const r of raws.splice(0)) r.ws.terminate();
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
  // every room of this test evicted before the next one (their holders are gone)
  await sleep(3000);
});

const ROOMS = Number(process.env.FV6_ROOMS ?? 5);
const ANON_ROOMS = Number(process.env.FV6_ANON_ROOMS ?? 14);
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
/** One metric of the canvas (internal port, read inside the container). */
function metric(name: string, label = ''): number {
  const out = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  let n = 0;
  for (const line of out.split('\n')) if (line.startsWith(name) && line.includes(label)) n += Number(line.split(' ').pop());
  return n;
}
const memoryRefusals = () => metric('canvas_ws_rejected_total', 'reason="room_memory');
/** The memory sizing the server logged at its last start (budget, shares, caps). */
function sizing(): Record<string, number> {
  const out = execFileSync('docker', ['logs', container('canvas')], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.split('\n').filter((l) => l.includes('"msg":"loaded-room memory budget"'));
  if (!lines.length) throw new Error('the canvas did not log its memory sizing');
  return JSON.parse(lines[lines.length - 1]);
}
/** Labelled shapes (~520 encoded bytes each, content + ledger) that fill most of a room of `capMiB`. */
const shapesFor = (capMiB: number) => Math.floor((0.85 * capMiB * MiB) / 520);

/** A raw y-websocket peer (no browser): what the verifier's q4 used. */
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
  /** Fill with `n` labelled geo shapes in batches; stops at the first close. */
  async fill(prefix: string, n: number, batch: number, pause: number): Promise<number> {
    let done = 0;
    for (let b = 0; b < n && this.closeCode === null; b += batch) {
      this.doc.transact(() => {
        const s = this.doc.getMap('shapes');
        for (let i = b; i < Math.min(n, b + batch); i++) {
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
      if (this.closeCode === null) done = Math.min(n, b + batch);
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
/** ms from `who` deleting shape `id` until `reader` no longer has it (a delete never grows the room) */
async function deleteRtt(who: Raw, reader: Raw, id: string): Promise<number> {
  const t = Date.now();
  expect(who.doc.getMap('shapes').has(id)).toBe(true);
  who.doc.getMap('shapes').delete(id);
  await waitFor(() => !reader.doc.getMap('shapes').has(id), 20_000, `delete ${id} relayed`);
  return Date.now() - t;
}
/** ms from an edit of `who` until `reader` has it (both raw peers in the same room) */
async function editRtt(who: Raw, reader: Raw, id: string): Promise<number> {
  const t = Date.now();
  who.doc.getMap('shapes').set(id, (() => {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(geo(id, 1))) m.set(k, v);
    return m;
  })());
  await waitFor(() => reader.doc.getMap('shapes').has(id), 20_000, `edit ${id} relayed`);
  return Date.now() - t;
}

test('Q4: one ACL member keeps R full rooms loaded: past its share of the memory budget the fills get 1013 busy, no OOM, no restart; an honest user in a loaded room is unaffected', async ({ browser }) => {
  test.setTimeout(900_000);
  expect(Number(inspect('{{.HostConfig.Memory}}'))).toBe(LIMIT_MIB * 1024 ** 2);
  const s0 = state();
  const refused0 = memoryRefusals();
  const run = Date.now().toString(36);
  const pubs = Array.from({ length: ROOMS }, (_, r) => publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv6-q4-${run}-${r}`));
  const c1 = await cookieOf(browser, pubs[0].canvas, 'user1');
  const c2 = await cookieOf(browser, pubs[0].canvas, 'user2');
  const held: Raw[] = [];
  const filled: number[] = [];
  const full = shapesFor(sizing().maxDocMiB);
  let peak = mem();
  for (let r = 0; r < ROOMS; r++) {
    const c = new Raw(wsUrl(pubs[r].canvas), c1);
    held.push(c);
    await c.ready();
    filled.push(await c.fill(`r${r}`, full, 1000, 900));
    peak = Math.max(peak, mem());
    log(`Q4 room ${r + 1}/${ROOMS}`, { filled: filled[r], close: c.closeCode, notices: c.notices, memMiB: mem(), state: state() });
  }
  // the first room is full; at least one fill past the share was refused with 1013 busy
  expect(filled[0]).toBe(full);
  const refused = held.filter((h) => h.closeCode === 1013);
  expect(refused.length).toBeGreaterThanOrEqual(1);
  expect(refused.every((h) => h.notices.includes('busy'))).toBe(true);
  expect(memoryRefusals() - refused0).toBeGreaterThanOrEqual(refused.length);
  // an honest user joins the loaded big room and edits: relayed to the holder
  const honest = new Raw(wsUrl(pubs[0].canvas), c2);
  expect(await honest.ready(60_000)).toBe(true);
  await waitFor(() => honest.doc.getMap('shapes').size >= full, 60_000, 'honest synced');
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) rtts.push(await editRtt(honest, held[0], `h${run}-${i}`));
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    peak = Math.max(peak, mem());
  }
  // everyone leaves, then everything is opened again: the loads past the budget get 1013
  for (const h of [...held, honest]) h.ws.close();
  await sleep(8000);
  const again: Raw[] = [];
  for (const p of pubs) {
    const a = new Raw(wsUrl(p.canvas), c1);
    again.push(a);
    await a.ready(60_000);
    peak = Math.max(peak, mem());
  }
  for (let i = 0; i < 4; i++) {
    await sleep(2500);
    peak = Math.max(peak, mem());
  }
  const rejoin = again.map((a) => (a.synced && a.closeCode === null ? 'joined' : String(a.closeCode)));
  const s1 = state();
  log('Q4', { rooms: ROOMS, full, filled, closes: held.map((h) => h.closeCode), honestRttMs: rtts, rejoin, peakMiB: peak, before: s0, after: s1 });
  expect(rejoin[0]).toBe('joined');
  expect(s1).toEqual(s0);
  expect(s1.oom).toBe('false');
  expect(peak).toBeLessThan(LIMIT_MIB);
  expect(Math.max(...rtts)).toBeLessThan(2000);
});

test('Q4b: three ACL members fill two rooms each: each is stopped at its share, the third by the server-wide growth threshold; joins to the loaded rooms go on, no restart', async ({ browser }) => {
  test.setTimeout(900_000);
  const s0 = state();
  const run = Date.now().toString(36);
  const who: UserName[] = ['user1', 'user2', 'user3'];
  const all = [USERS.user1.email, USERS.user2.email, USERS.user3.email];
  const pubs = Array.from({ length: 6 }, (_, r) => publish({ users: all }, `fv6-q4b-${run}-${r}`));
  const cookies = await Promise.all(who.map((u, r) => cookieOf(browser, pubs[r].canvas, u)));
  const full = shapesFor(sizing().maxDocMiB);
  const principal0 = metric('canvas_ws_rejected_total', 'reason="room_memory_principal"');
  const total0 = metric('canvas_ws_rejected_total', 'reason="room_memory"');
  const held: Raw[] = [];
  const keepers: Raw[] = [];
  const filled: number[] = [];
  let peak = mem();
  for (let r = 0; r < 6; r++) {
    // a reader socket of the same user keeps the room loaded once the writer is refused (a room
    // nobody is connected to is evicted, and its charge with it)
    const keep = new Raw(wsUrl(pubs[r].canvas), cookies[Math.floor(r / 2)]);
    keepers.push(keep);
    await keep.ready();
    const c = new Raw(wsUrl(pubs[r].canvas), cookies[Math.floor(r / 2)]);
    held.push(c);
    await c.ready();
    filled.push(await c.fill(`b${r}`, full, 1000, 900));
    peak = Math.max(peak, mem());
  }
  const principal = metric('canvas_ws_rejected_total', 'reason="room_memory_principal"') - principal0;
  const total = metric('canvas_ws_rejected_total', 'reason="room_memory"') - total0;
  // the first room of user1 and of user2 is full, their second one stopped at their share; user3
  // is stopped by the total before it reaches its share
  expect(filled[0]).toBe(full);
  expect(filled[2]).toBe(full);
  expect(held[1].closeCode).toBe(1013);
  expect(held[3].closeCode).toBe(1013);
  expect(principal).toBeGreaterThanOrEqual(2);
  expect(total).toBeGreaterThanOrEqual(1);
  expect([held[4].closeCode, held[5].closeCode]).toContain(1013);
  expect(metric('canvas_room_memory_bytes')).toBeLessThanOrEqual(0.8 * metric('canvas_room_memory_budget_bytes') * 1.01);
  // joins to the loaded rooms are never refused for memory: user3 joins user1's room and edits.
  // fv9: the loaded rooms may pass the 80% growth threshold through loads alone (each one is a
  // worker, 16 MiB, and loads go on to 85%), and an edit that adds anything is then refused 1013 by
  // design: the visitor's edit is a delete, which never grows the room and always passes
  const visitor = new Raw(wsUrl(pubs[0].canvas), cookies[2]);
  expect(await visitor.ready(60_000)).toBe(true);
  const rtt = await deleteRtt(visitor, held[0], 'b0s0');
  peak = Math.max(peak, mem());
  const s1 = state();
  log('Q4b', { full, filled, closes: held.map((h) => h.closeCode), keepersOpen: keepers.filter((k) => k.closeCode === null).length, refusedPrincipal: principal, refusedTotal: total, visitorRttMs: rtt, peakMiB: peak, before: s0, after: s1 });
  expect(keepers.every((k) => k.closeCode === null)).toBe(true);
  expect(s1).toEqual(s0);
  expect(peak).toBeLessThan(LIMIT_MIB);
});

test('Q4c: anonymous visitors fill pub/ rooms at the anonymous cap: they stop at a third of the budget together, no restart; a logged-in user still loads and edits', async ({ browser }) => {
  test.setTimeout(900_000);
  const s0 = state();
  const run = Date.now().toString(36);
  const pubs = Array.from({ length: ANON_ROOMS }, (_, r) => publish('pub', `fv6-q4c-${run}-${r}`));
  const anon0 = metric('canvas_ws_rejected_total', 'reason="room_memory_anon"');
  const anons: Raw[] = [];
  const filled: number[] = [];
  const full = shapesFor(sizing().anonMaxDocMiB);
  let peak = mem();
  const keepers: Raw[] = [];
  for (let r = 0; r < ANON_ROOMS; r++) {
    // fresh anonymous visitors (cookies minted by the joins themselves): one keeps the room
    // loaded (a reader that never writes), one fills it
    const keeper = new Raw(wsUrl(pubs[r].canvas), '');
    keepers.push(keeper);
    const c = new Raw(wsUrl(pubs[r].canvas), '');
    anons.push(c);
    if (!(await keeper.ready()) || !(await c.ready())) {
      filled.push(-1);
      log(`Q4c room ${r + 1}/${ANON_ROOMS}`, { refusedAtJoin: [keeper.closeCode, c.closeCode], memMiB: mem() });
      continue;
    }
    // just under the anonymous cap (content + ledger)
    filled.push(await c.fill(`a${r}`, full, 500, 1500));
    peak = Math.max(peak, mem());
    log(`Q4c room ${r + 1}/${ANON_ROOMS}`, { filled: filled[r], close: c.closeCode, notices: c.notices, memMiB: mem() });
  }
  const anonRefused = metric('canvas_ws_rejected_total', 'reason="room_memory_anon"') - anon0;
  // a logged-in user loads a room of its own and edits in it
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv6-q4c-${run}-team`);
  const c1 = await cookieOf(browser, P.canvas, 'user1');
  const c2 = await cookieOf(browser, P.canvas, 'user2');
  const owner = new Raw(wsUrl(P.canvas), c1);
  expect(await owner.ready()).toBe(true);
  const team = Math.floor(shapesFor(sizing().maxDocMiB) / 2);
  expect(await owner.fill('t', team, 1000, 900)).toBe(team);
  const other = new Raw(wsUrl(P.canvas), c2);
  expect(await other.ready()).toBe(true);
  await waitFor(() => other.doc.getMap('shapes').size >= team, 30_000, 'team synced');
  const rtt = await editRtt(owner, other, `t${run}`);
  for (let i = 0; i < 4; i++) {
    await sleep(2500);
    peak = Math.max(peak, mem());
  }
  const s1 = state();
  log('Q4c', { rooms: ANON_ROOMS, full, filled, closes: anons.map((a) => a.closeCode), keepers: keepers.map((k) => (k.synced ? k.closeCode : `refused ${k.closeCode}`)), anonRefused, teamRttMs: rtt, peakMiB: peak, before: s0, after: s1 });
  // the first rooms fill up; then the anonymous third of the budget is used: later rooms are
  // refused (at the join that would load them, or at the fill)
  expect(filled.filter((f) => f === full).length).toBeGreaterThanOrEqual(2);
  expect(anonRefused).toBeGreaterThanOrEqual(1);
  expect(filled.filter((f) => f === full).length).toBeLessThan(ANON_ROOMS);
  // the rooms already loaded keep their readers
  expect(keepers.filter((k) => k.synced).every((k) => k.closeCode === null)).toBe(true);
  expect(s1).toEqual(s0);
  expect(peak).toBeLessThan(LIMIT_MIB);
  expect(owner.closeCode).toBeNull();
});
