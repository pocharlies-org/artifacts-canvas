/**
 * Review M-1 on the full system (the canvas under the chart's memory limit, the real core): client
 * messages wait for their room and the one apply slot, and nothing bounded what one writer could
 * make the canvas hold while they waited (on main the one thread did not read the socket meanwhile).
 * A signed-in member floods its own room with 4 MiB updates the guard accepts (re-sends of an image
 * the room holds), 100 of them from one connection and then 100 from each of 8 (MAX_CONNS_PER_USER),
 * each connection sending as fast as the canvas reads. The canvas must stop reading (TCP
 * backpressure), keep canvas_ws_inflight_bytes under WORKER_INFLIGHT_BYTES (64 MiB), its resident
 * memory within baseline + that cap + one message per connection + a margin, never restart; and a
 * signed-in user in another room keeps relaying edits to a second one.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BASE, container, newContext, openWithLogin, publish, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });
const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) => console.log(`[inflight] ${k}: ${JSON.stringify(v)}`);
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
function metrics(): Map<string, number> {
  const out = new Map<string, number>();
  const text = execFileSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8', maxBuffer: 16 << 20 });
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return out;
}
const sum = (m: Map<string, number>, prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
/** the canvas container's memory as its cgroup counts it (what the OOM killer compares with the limit) */
const cgroupMiB = () => Number(execFileSync('docker', ['exec', container('canvas'), 'cat', '/sys/fs/cgroup/memory.current'], { encoding: 'utf8' }).trim()) / MiB;

/** A raw y-websocket client (Node): answers the server's step 1, sends its own edits. */
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
      this.ws.send(syncMsg(u));
    });
  }
  async ready(ms = 30_000): Promise<boolean> {
    const t0 = Date.now();
    while (!this.synced && this.closeCode === null && Date.now() - t0 < ms) await sleep(100);
    return this.synced && this.closeCode === null;
  }
}
function syncMsg(u: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, u);
  return encoding.toUint8Array(e);
}
const mapOf = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
const geo = (id: string, j: number) => ({ id, type: 'geo', geo: 'rectangle', x: j * 20, y: 0, w: 10, h: 10, rotation: 0, index: j, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });

const cookies = new Map<UserName, string>();
async function cookieOf(browser: Parameters<typeof newContext>[0], user: UserName): Promise<string> {
  const hit = cookies.get(user);
  if (hit) return hit;
  const room = publish({ users: ['test@example.com', 'test2@example.com', 'test3@example.com'] }, `inflight-login-${user}-${Date.now()}`);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  expect(await openWithLogin(page, room.canvas, user)).toBe(200);
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await page.close();
  cookies.set(user, cookie);
  return cookie;
}

/** An honest pair in another room: ana's edit every 200 ms, the time until bob has it. */
function relay(ana: Raw, bob: Raw) {
  const lat: number[] = [];
  const sentAt = new Map<string, number>();
  bob.doc.getMap('shapes').observe((e) => {
    for (const k of e.keysChanged) {
      const t = sentAt.get(k);
      if (t !== undefined && bob.doc.getMap('shapes').has(k)) lat.push(Date.now() - t), sentAt.delete(k);
    }
  });
  let n = 0;
  const timer = setInterval(() => {
    const id = `h${Date.now()}-${n++}`;
    sentAt.set(id, Date.now());
    ana.doc.getMap('shapes').set(id, mapOf(geo(id, n)));
  }, 200);
  return {
    stop: () => {
      clearInterval(timer);
      const s = [...lat].sort((a, b) => a - b);
      return { edits: n, relayed: s.length, lost: sentAt.size, p50: s[Math.floor(s.length / 2)] ?? null, p95: s[Math.floor(s.length * 0.95)] ?? null, max: s[s.length - 1] ?? null };
    },
  };
}

/** `conns` connections of the flooder send `perConn` messages each, as fast as the canvas reads. */
async function flood(url: string, cookie: string, msg: Uint8Array, conns: number, perConn: number) {
  const cs: Raw[] = [];
  for (let i = 0; i < conns; i++) {
    const c = new Raw(url, cookie);
    expect(await c.ready()).toBe(true);
    cs.push(c);
  }
  const t0 = Date.now();
  const r0 = restarts();
  const base = cgroupMiB();
  const baseRss = metrics().get('process_resident_memory_bytes')! / MiB;
  let peak = { cgroup: base, rss: baseRss, inflight: 0, external: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const m = metrics();
        peak = {
          cgroup: Math.max(peak.cgroup, cgroupMiB()),
          rss: Math.max(peak.rss, (m.get('process_resident_memory_bytes') ?? 0) / MiB),
          inflight: Math.max(peak.inflight, (m.get('canvas_ws_inflight_bytes') ?? 0) / MiB),
          external: Math.max(peak.external, (m.get('nodejs_external_memory_bytes') ?? 0) / MiB),
        };
      } catch {
        /* restarting: counted below */
      }
      await sleep(200);
    }
  })();
  const sent = cs.map(() => 0);
  await Promise.all(
    cs.map(async (c, i) => {
      while (sent[i] < perConn && c.closeCode === null && Date.now() - t0 < 120_000) {
        if (c.ws.bufferedAmount < 8 * MiB) {
          c.ws.send(msg);
          sent[i]++;
        } else await sleep(2);
      }
    }),
  );
  for (let i = 0; i < 150 && (metrics().get('canvas_ws_inflight_bytes') ?? 0) > 0; i++) await sleep(200);
  await sleep(2000);
  sampling = false;
  await sampler;
  const m = metrics();
  const out = {
    conns, sent: sent.reduce((a, b) => a + b, 0), floodMs: Date.now() - t0, closes: cs.map((c) => c.closeCode),
    baseCgroupMiB: Math.round(base), peakCgroupMiB: Math.round(peak.cgroup), baseRssMiB: Math.round(baseRss), peakRssMiB: Math.round(peak.rss),
    peakInflightMiB: Math.round(peak.inflight * 10) / 10, peakExternalMiB: Math.round(peak.external),
    paused: sum(m, 'canvas_ws_paused_total'), refusedInflight: sum(m, 'canvas_ws_rejected_total{reason="inflight"}'), cpuPrecharge: sum(m, 'canvas_ws_rejected_total{reason="cpu_precharge"}'),
    restarts: restarts() - r0, oomKilled: oomKilled(),
  };
  for (const c of cs) c.ws.terminate();
  return out;
}

test('M-1 live: a writer flooding 4 MiB updates from one and from 8 connections: the canvas stops reading, holds at most WORKER_INFLIGHT_BYTES in flight, its memory stays bounded, it never restarts, and another room keeps relaying', async ({ browser }) => {
  test.setTimeout(900_000);
  // user1 floods (no strike is involved: what stops it is the backpressure, the in-flight cap and its
  // CPU budget, 1013); user2 is the honest pair
  const c1 = await cookieOf(browser, 'user1');
  const c2 = await cookieOf(browser, 'user2');
  const other = publish({ users: ['test2@example.com'] }, `inflight-other-${Date.now()}`);
  const ana = new Raw(wsUrl(other.canvas), c2);
  const bob = new Raw(wsUrl(other.canvas), c2);
  expect(await ana.ready()).toBe(true);
  expect(await bob.ready()).toBe(true);
  // the flooder's own room holds one 3.9 MiB image (under the 5 MiB room and 4 MiB message caps)
  const room = publish({ users: ['test@example.com'] }, `inflight-flood-${Date.now()}`);
  const w = new Raw(wsUrl(room.canvas), c1);
  expect(await w.ready()).toBe(true);
  w.doc.transact(() => {
    w.doc.getMap('assets').set('a0', 'data:image/png;base64,' + 'A'.repeat(Math.floor(3.9 * MiB)));
    w.doc.getMap('shapes').set('i0', mapOf({ id: 'i0', type: 'image', assetId: 'a0', x: 0, y: 0, w: 60, h: 40, rotation: 0, index: 0, groupId: '', locked: false, opacity: 1 }));
  });
  await sleep(4000);
  expect(w.closeCode).toBeNull();
  const msg = syncMsg(Y.encodeStateAsUpdate(w.doc));
  w.ws.close();
  await sleep(1000);
  const results: Record<string, unknown> = { messageMiB: Math.round((msg.byteLength / MiB) * 100) / 100 };
  for (const conns of [1, 8]) {
    const h = relay(ana, bob);
    const r = await flood(wsUrl(room.canvas), c1, msg, conns, 100);
    await sleep(1500);
    const honest = h.stop();
    results[`conns${conns}`] = { ...r, honest };
    log(`${conns} connection(s)`, results[`conns${conns}`]);
    // bounded: the in-flight cap, and the memory within baseline + the cap + one message being read
    // per connection + 192 MiB (the guard's and the apply's heap for a 4 MiB message, GC timing)
    expect(r.peakInflightMiB).toBeLessThanOrEqual(64);
    expect(r.peakCgroupMiB - r.baseCgroupMiB).toBeLessThanOrEqual(64 + conns * 4 + 192);
    expect(r.restarts).toBe(0);
    expect(r.oomKilled).toBe('false');
    // the canvas stopped reading (or closed) the flooding connections instead of buffering them
    expect(r.paused + r.refusedInflight + r.cpuPrecharge).toBeGreaterThan(0);
    // the honest pair: never closed, every edit relayed
    expect(ana.closeCode).toBeNull();
    expect(bob.closeCode).toBeNull();
    expect(honest.relayed).toBeGreaterThan(0);
    // every edit relayed but the last one or two, still on their way when the count stopped
    expect(honest.lost).toBeLessThanOrEqual(2);
    // CPU budget of the flooder: let it refill before the next round (its joins wait while in debt)
    await sleep(25_000);
  }
  log('M-1', results);
});
