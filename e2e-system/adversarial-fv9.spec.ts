/**
 * fv9 on the full system (the canvas under the chart's memory limit, the real core): the ninth
 * verification's PoCs, live. Before: one anonymous 183 KB message ran the canvas out of heap
 * (container restarted), one 0.72 MB anonymous message froze it 64 s. Now every room runs in a
 * worker thread of its own (fv9 isolation) and the known paths are counted and refused in the
 * guard. For every PoC: its sender is closed (4413/4403), a signed-in user in ANOTHER room sees
 * the canvas answer WebSocket pings within 200 ms the whole time, the canvas container never
 * restarts, and the attacked room keeps every honest edit (a fresh joiner gets exactly what an
 * honest participant holds). F: anonymous visitors cannot fill the memory budget with stored
 * pub/ rooms (one loads, the others wait), and a signed-in user's edit is accepted.
 * With SYSTEM_WORKER_TEST_HOOKS=1 (the stack started with CANVAS_WORKER_TEST_HOOKS=true) it also
 * makes a room's worker loop forever and allocate without bound: the worker is replaced, the
 * process lives on.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BASE, container, newContext, openWithLogin, publish, type UserName } from './lib';
import { alternating, chain, deleteRanges, formatting, lastId, mergePairs, mergeRun } from '../server/test/fv9/craft';

test.describe.configure({ mode: 'serial' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[fv9] ${k}: ${JSON.stringify(v)}`);
const ctxs: BrowserContext[] = [];
const raws: Raw[] = [];
test.afterEach(async () => {
  for (const r of raws.splice(0)) r.ws.terminate();
  for (const c of ctxs.splice(0)) await c.close().catch(() => undefined);
});
const inspect = (fmt: string) => execFileSync('docker', ['inspect', '-f', fmt, container('canvas')], { encoding: 'utf8' }).trim();
const restarts = () => Number(inspect('{{.RestartCount}}'));
const oomKilled = () => inspect('{{.State.OOMKilled}}');
const wsUrl = (canvas: string) => canvas.replace(/^http/, 'ws').replace('/_canvas/', '/_canvas/_/ws/');
const canvasLogs = (since: string) => execFileSync('docker', ['logs', '--since', since, container('canvas')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
function metric(name: string, label = ''): number {
  const out = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  let n = 0;
  for (const line of out.split('\n')) if (line.startsWith(name) && line.includes(label)) n += Number(line.split(' ').pop());
  return n;
}
const strikes = () => metric('canvas_strikes_total', 'outcome="strike"');

/** A raw y-websocket client (Node): answers the server's step 1, sends its own edits. */
class Raw {
  doc = new Y.Doc();
  ledger = new Y.Doc();
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
      if (t === 102) {
        Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), 'remote');
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
  async closed(ms = 60_000): Promise<number | null> {
    const t0 = Date.now();
    while (this.closeCode === null && Date.now() - t0 < ms) await sleep(50);
    return this.closeCode;
  }
}

/** WebSocket ping round trips of `peer` every 50 ms (the canvas's main event loop answers them). */
function pinger(peer: Raw) {
  const rtts: number[] = [];
  let maxGap = 0;
  let pending: number | null = null;
  peer.ws.on('pong', () => {
    if (pending !== null) rtts.push(Date.now() - pending);
    pending = null;
  });
  const t = setInterval(() => {
    if (pending !== null) maxGap = Math.max(maxGap, Date.now() - pending);
    else if (peer.ws.readyState === 1) {
      pending = Date.now();
      peer.ws.ping();
    }
  }, 50);
  return {
    stop: () => {
      clearInterval(t);
      const s = [...rtts].sort((a, b) => a - b);
      return { pings: s.length, p50: s[Math.floor(s.length / 2)] ?? null, p95: s[Math.floor(s.length * 0.95)] ?? null, max: Math.max(maxGap, s[s.length - 1] ?? 0) };
    },
  };
}

const cookies = new Map<UserName, string>();
async function cookieOf(browser: Parameters<typeof newContext>[0], user: UserName): Promise<string> {
  const hit = cookies.get(user);
  if (hit) return hit;
  const room = publish({ users: ['test@example.com', 'test2@example.com', 'test3@example.com'] }, `fv9-login-${user}-${Date.now()}`);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, room.canvas, user)).toBe(200);
  // the session cookie is set once the login chain is through (no need for the editor's socket:
  // user3 may be cooling down after an earlier run of this spec, WORKER_STRIKE_COOLDOWN_MS)
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await page.close();
  cookies.set(user, cookie);
  return cookie;
}

const draw = (id: string) => ({ id, type: 'draw', x: 0, y: 0, w: 100, h: 100, rotation: 0, index: 0, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', opacity: 1, highlight: false, ow: 100, oh: 100, done: true, pen: false });
const note = { id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 200, rotation: 0, index: 0, groupId: '', locked: false, color: 'yellow', size: 'm', opacity: 1 };
const geo = (id: string, j: number) => ({ id, type: 'geo', geo: 'rectangle', x: j * 20, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
function stroke(d: Y.Doc, id: string): void {
  d.transact(() => {
    const m = mapOf(draw(id));
    const pts = new Y.Array<number>();
    m.set('points', pts);
    d.getMap('shapes').set(id, m);
  });
  ((d.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>).insert(0, [1, 2]);
}
const points = (d: Y.Doc, id: string) => (d.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>;
const view = (d: Y.Doc) => JSON.stringify(d.getMap('shapes').toJSON()) + JSON.stringify(d.getMap('assets').toJSON()) + JSON.stringify(d.getMap('meta').toJSON());

/**
 * One attack: `honest` (another room) pings the canvas meanwhile; `victim` (an honest participant
 * of the attacked room) edits before and after; a fresh joiner of the attacked room must get exactly
 * what `victim` holds.
 */
async function attack(name: string, o: { honest: Raw; victim: Raw; attacker: Raw; update: Uint8Array; joinUrl: string; joinCookie: string; want: number; strikes: number }) {
  const r0 = restarts();
  const k0 = strikes();
  const since = new Date().toISOString();
  for (let i = 0; i < 5; i++) o.victim.doc.getMap('shapes').set(`${name}-before${i}`, mapOf(geo(`${name}-before${i}`, i)));
  await sleep(500);
  const p = pinger(o.honest);
  await sleep(1000);
  const t0 = Date.now();
  o.attacker.send(o.update);
  const code = await o.attacker.closed(120_000);
  const closedMs = Date.now() - t0;
  await sleep(2000);
  const rtt = p.stop();
  for (let i = 0; i < 5; i++) o.victim.doc.getMap('shapes').set(`${name}-after${i}`, mapOf(geo(`${name}-after${i}`, i)));
  await sleep(1500);
  const fresh = new Raw(o.joinUrl, o.joinCookie);
  expect(await fresh.ready()).toBe(true);
  await sleep(1500);
  // the joiner integrates the room's frames on its own time: wait until it holds what the victim holds
  const t1 = Date.now();
  while (view(fresh.doc) !== view(o.victim.doc) && Date.now() - t1 < 20_000) await sleep(250);
  const same = view(fresh.doc) === view(o.victim.doc);
  if (!same) {
    const fv = fresh.doc.getMap('shapes');
    const vv = o.victim.doc.getMap('shapes');
    const differ = [...vv.keys()].filter((k) => JSON.stringify((fv.get(k) as Y.Map<unknown> | undefined)?.toJSON()) !== JSON.stringify((vv.get(k) as Y.Map<unknown>).toJSON()));
    log(`${name} differs`, { onlyVictim: [...vv.keys()].filter((k) => !fv.has(k)), onlyFresh: [...fv.keys()].filter((k) => !vv.has(k)), differ, lens: differ.slice(0, 3).map((k) => [JSON.stringify((fv.get(k) as Y.Map<unknown> | undefined)?.toJSON() ?? null).length, JSON.stringify((vv.get(k) as Y.Map<unknown>).toJSON()).length]) });
  }
  const attributed = [...o.victim.doc.getMap('shapes').keys()].filter((k) => k.startsWith(name)).every((k) => !!fresh.ledger.getMap('attribution').get(k));
  const out = { bytes: o.update.byteLength, code, closedMs, rtt, restarts: restarts() - r0, oomKilled: oomKilled(), victimClose: o.victim.closeCode, honestClose: o.honest.closeCode, freshEqualsVictim: same, attributed, workerFaults: (canvasLogs(since).match(/room worker fault/g) ?? []).length, faultKinds: [...canvasLogs(since).matchAll(/"kind":"(\w+)","err":"room worker/g)].map((m) => m[1]), strikes: strikes() - k0 };
  log(name, out);
  expect(code).toBe(o.want);
  expect(rtt.max).toBeLessThan(200);
  expect(out.restarts).toBe(0);
  expect(o.victim.closeCode).toBeNull();
  expect(o.honest.closeCode).toBeNull();
  expect(same).toBe(true);
  expect(attributed).toBe(true);
  expect(out.strikes).toBe(o.strikes);
  fresh.ws.terminate();
  return out;
}

test('fv9 A-E live: every PoC is refused in its room\'s worker; the canvas answers pings < 200 ms, never restarts, and the attacked rooms keep every honest edit', async ({ browser }) => {
  test.setTimeout(600_000);
  const c2 = await cookieOf(browser, 'user2');
  // the signed-in user who pings the canvas from another room
  const other = publish({ users: ['test2@example.com'] }, `fv9-other-${Date.now()}`);
  const honest = new Raw(wsUrl(other.canvas), c2);
  expect(await honest.ready()).toBe(true);
  const results: Record<string, unknown> = {};

  // A, D: cookieless visitors of a pub/ canvas (anonymous-sized messages); an anonymous visitor with
  // a cookie of its own is the honest participant
  const pubRoom = publish('pub', `fv9-pub-${Date.now()}`);
  const victimPub = new Raw(wsUrl(pubRoom.canvas), '');
  expect(await victimPub.ready()).toBe(true);
  stroke(victimPub.doc, 'd');
  victimPub.doc.transact(() => {
    const m = mapOf(note);
    m.set('text', new Y.Text('a'));
    victimPub.doc.getMap('shapes').set('n', m);
  });
  await sleep(1500);
  {
    const a = new Raw(wsUrl(pubRoom.canvas), '');
    expect(await a.ready()).toBe(true);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(victimPub.doc), 'remote');
    results.A = await attack('A', { honest, victim: victimPub, attacker: a, update: mergeRun(points(a.doc, 'd'), 900_001, 20_000), joinUrl: wsUrl(pubRoom.canvas), joinCookie: '', want: 4413, strikes: 1 });
  }
  {
    const a = new Raw(wsUrl(pubRoom.canvas), '');
    expect(await a.ready()).toBe(true);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(victimPub.doc), 'remote');
    const text = (a.doc.getMap('shapes').get('n') as Y.Map<unknown>).get('text') as Y.Text;
    results.D = await attack('D', { honest, victim: victimPub, attacker: a, update: formatting(text, 900_002, 60_000, 9_000), joinUrl: wsUrl(pubRoom.canvas), joinCookie: '', want: 4403, strikes: 0 });
  }

  // B, C, E: a signed-in member of the attacked room (user3: each refusal is a strike, and three
  // put it in a cooldown, so the users the other specs sign in with stay out of it; an ACL refusal
  // is answered before strikes are looked at); user2 is the honest participant there
  const c3 = await cookieOf(browser, 'user3');
  const userRoom = publish({ users: ['test3@example.com', 'test2@example.com'] }, `fv9-users-${Date.now()}`);
  const victim = new Raw(wsUrl(userRoom.canvas), c2);
  expect(await victim.ready()).toBe(true);
  stroke(victim.doc, 'd0');
  stroke(victim.doc, 'd1');
  await sleep(1500);
  const mallory = async () => {
    const a = new Raw(wsUrl(userRoom.canvas), c3);
    expect(await a.ready()).toBe(true);
    await sleep(500);
    return a;
  };
  {
    const a = await mallory();
    results.B = await attack('B', { honest, victim, attacker: a, update: mergePairs(points(a.doc, 'd0'), points(a.doc, 'd1'), 900_003, 100_000), joinUrl: wsUrl(userRoom.canvas), joinCookie: c2, want: 4413, strikes: 1 });
  }
  {
    const a = await mallory();
    results.E = await attack('E', { honest, victim, attacker: a, update: chain(points(a.doc, 'd0'), 900_100, 20_000, 20_000), joinUrl: wsUrl(userRoom.canvas), joinCookie: c2, want: 4413, strikes: 1 });
  }
  {
    // C: the attacker first fragments a stroke of its own room (two accepted updates of 180 000
    // alternating live / deleted items), then sends the delete-only update
    const cRoom = publish({ users: ['test3@example.com', 'test2@example.com'] }, `fv9-c-${Date.now()}`);
    const v = new Raw(wsUrl(cRoom.canvas), c2);
    expect(await v.ready()).toBe(true);
    const a = new Raw(wsUrl(cRoom.canvas), c3);
    expect(await a.ready()).toBe(true);
    stroke(a.doc, 'd');
    await sleep(1500);
    let origin = lastId(points(a.doc, 'd'));
    let clock = 0;
    for (let r = 0; r < 2; r++) {
      const b = alternating(origin, 900_004, clock, 180_000);
      origin = b.origin;
      clock += 180_000;
      a.send(b.update);
      await sleep(4000);
    }
    expect(a.closeCode).toBeNull();
    results.C = await attack('C', { honest, victim: v, attacker: a, update: deleteRanges(900_004, 360_000, 80_000), joinUrl: wsUrl(cRoom.canvas), joinCookie: c2, want: 4413, strikes: 1 });
  }
  // three strikes of user3 within the window: its joins wait out the cooldown (1013), user2's do not
  const after = new Raw(wsUrl(userRoom.canvas), c3);
  await after.ready(10_000);
  const coolCode = await after.closed(10_000);
  const other2 = new Raw(wsUrl(userRoom.canvas), c2);
  expect(await other2.ready()).toBe(true);
  log('A-E', { ...results, user3JoinAfterThreeStrikes: coolCode, cooldownRefusals: metric('canvas_ws_rejected_total', 'reason="cooldown"') });
  expect(coolCode).toBe(1013);
});

test('fv9 F live: anonymous visitors cannot fill the memory with stored pub/ rooms; a signed-in user\'s edit is accepted', async ({ browser }) => {
  test.setTimeout(600_000);
  const c1 = await cookieOf(browser, 'user1');
  // three pub/ canvases filled to ~4.8 MiB by a signed-in user (images), then left (saved, evicted)
  const pubs = [0, 1, 2].map((i) => publish('pub', `fv9-f${i}-${Date.now()}`));
  for (const [i, p] of pubs.entries()) {
    const w = new Raw(wsUrl(p.canvas), c1);
    expect(await w.ready()).toBe(true);
    for (let k = 0; k < 2; k++) {
      w.doc.transact(() => {
        w.doc.getMap('assets').set(`a${k}`, 'data:image/png;base64,' + String.fromCharCode(65 + i).repeat(Math.floor(2.35 * 1024 * 1024)));
        w.doc.getMap('shapes').set(`i${k}`, mapOf({ id: `i${k}`, type: 'image', assetId: `a${k}`, x: k * 100, y: 0, w: 60, h: 40, rotation: 0, index: k, groupId: '', locked: false, opacity: 1 }));
      });
      await sleep(3000);
    }
    expect(w.closeCode).toBeNull();
    w.ws.close();
    await sleep(2000);
  }
  // three cookieless visitors, one per canvas
  const visitors: Raw[] = [];
  for (const p of pubs) {
    const v = new Raw(wsUrl(p.canvas), '');
    await v.ready(60_000);
    visitors.push(v);
    await sleep(1000);
  }
  const closes = visitors.map((v) => v.closeCode);
  // a signed-in user grows a room of its own by a 0.9 MiB image
  const own = publish({ users: ['test@example.com'] }, `fv9-f-own-${Date.now()}`);
  const u = new Raw(wsUrl(own.canvas), c1);
  expect(await u.ready()).toBe(true);
  u.doc.transact(() => {
    u.doc.getMap('assets').set('a9', 'data:image/png;base64,' + 'B'.repeat(Math.floor(0.9 * 1024 * 1024)));
    u.doc.getMap('shapes').set('i9', mapOf({ id: 'i9', type: 'image', assetId: 'a9', x: 0, y: 0, w: 60, h: 40, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
  });
  await sleep(4000);
  log('F', { visitorsClose: closes, visitorsNotices: visitors.map((v) => v.notices), userEditClose: u.closeCode, userNotices: u.notices });
  // one visitor loads its room, the others wait (1013, they retry); the user's edit is accepted
  expect(closes.filter((c) => c === null).length).toBe(1);
  expect(closes.filter((c) => c === 1013).length).toBe(2);
  expect(u.closeCode).toBeNull();
});

test('fv9 unknown paths live (SYSTEM_WORKER_TEST_HOOKS=1): a worker that loops forever or allocates without bound is replaced; the canvas lives on', async ({ browser }) => {
  test.skip(process.env.SYSTEM_WORKER_TEST_HOOKS !== '1', 'the stack runs without WORKER_TEST_HOOKS');
  test.setTimeout(300_000);
  // the attacker is a cookieless visitor of a pub/ canvas (each hook is a strike: user3 is cooling
  // down after the A-E test, and user1 and user2 stay out of any cooldown for the other specs)
  const c2 = await cookieOf(browser, 'user2');
  const other = publish({ users: ['test2@example.com'] }, `fv9-hook-other-${Date.now()}`);
  const honest = new Raw(wsUrl(other.canvas), c2);
  expect(await honest.ready()).toBe(true);
  const room = publish('pub', `fv9-hook-${Date.now()}`);
  const victim = new Raw(wsUrl(room.canvas), c2);
  expect(await victim.ready()).toBe(true);
  const out: Record<string, unknown> = {};
  for (const hook of ['busy', 'alloc']) {
    const a = new Raw(wsUrl(room.canvas), '');
    expect(await a.ready()).toBe(true);
    const d = new Y.Doc();
    d.getMap('meta').set('k', `canvas-test-hook:${hook}`);
    out[hook] = await attack(`hook-${hook}`, { honest, victim, attacker: a, update: Y.encodeStateAsUpdate(d), joinUrl: wsUrl(room.canvas), joinCookie: c2, want: 4413, strikes: 1 });
    expect((out[hook] as { workerFaults: number }).workerFaults).toBe(1);
    // busy: the watchdog; alloc: the worker's heap limit (or the watchdog, whichever comes first)
    expect((out[hook] as { faultKinds: string[] }).faultKinds[0]).toMatch(hook === 'busy' ? /^timeout$/ : /^(oom|timeout)$/);
  }
  log('unknown paths', out);
});
