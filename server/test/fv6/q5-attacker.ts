// fv6 Q5 attacker (the verifier's q5-attacker.ts), run as a separate process by fv6.test.ts:
// unauthenticated, it tries to fill the server-wide outgoing budget with paused sockets. Cookies
// are minted with HEAD requests. In every pub/ room it keeps one "bumper" connection that makes a
// tiny edit before each join, and PER_ROOM paused sockets that never read; a paused socket that
// is dropped is replaced. env HTTP, BASE, KEYS (comma), PER_ROOM, DUR (s), ORIGIN, LIFETIME (ms)
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const HTTP = process.env.HTTP!, BASE = process.env.BASE!, KEYS = process.env.KEYS!.split(','), ORIGIN = process.env.ORIGIN!;
const PER_ROOM = Number(process.env.PER_ROOM ?? 9), DUR = Number(process.env.DUR ?? 60);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cookieN = 0;
async function cookie(key: string): Promise<string> {
  const r = await fetch(`${HTTP}/${key}`, { method: 'HEAD' });
  cookieN++;
  return r.headers.get('set-cookie')?.split(';')[0] ?? '';
}
const geo = (id: string) => ({ id, type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 });
const stats = { joins: 0, refused1013: 0, dropped: 0, bumps: 0, closes: {} as Record<string, number> };
class Bumper {
  doc = new Y.Doc();
  ws!: WebSocket;
  ready = false;
  id = 'zz' + Math.random().toString(36).slice(2, 8);
  x = 0;
  constructor(readonly key: string) {}
  async start() {
    const c = await cookie(this.key);
    this.ws = new WebSocket(`${BASE}/${this.key}`, { headers: { origin: ORIGIN, ...(c ? { cookie: c } : {}) }, maxPayload: 512 << 20 });
    this.ws.on('message', (d: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(d));
      if (decoding.readVarUint(dec) !== 0) return;
      const st = decoding.readVarUint(dec);
      if (st === 1 || st === 2) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'remote');
        this.ready = true;
      }
    });
    this.ws.on('error', () => undefined);
    this.doc.on('update', (u: Uint8Array, o: unknown) => {
      if (o === 'remote' || this.ws.readyState !== 1) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
    const t = Date.now();
    while (!this.ready && Date.now() - t < 10_000) await sleep(50);
    this.doc.transact(() => {
      const m = new Y.Map<unknown>();
      this.doc.getMap('shapes').set(this.id, m);
      for (const [k, v] of Object.entries(geo(this.id))) m.set(k, v);
    });
    await sleep(300);
  }
  bump() {
    if (this.ws.readyState !== 1) return;
    this.doc.transact(() => (this.doc.getMap('shapes').get(this.id) as Y.Map<unknown> | undefined)?.set('x', ++this.x));
    stats.bumps++;
  }
}
const live = new Map<string, number>();
async function pausedJoin(key: string, b: Bumper): Promise<void> {
  b.bump();
  await sleep(60);
  const c = await cookie(key);
  const ws = new WebSocket(`${BASE}/${key}`, { headers: { origin: ORIGIN, ...(c ? { cookie: c } : {}) } });
  stats.joins++;
  live.set(key, (live.get(key) ?? 0) + 1);
  let counted = true;
  const release = () => {
    if (counted) {
      counted = false;
      live.set(key, (live.get(key) ?? 0) - 1);
    }
  };
  ws.on('open', () => (ws as unknown as { _socket: { pause(): void } })._socket.pause());
  setTimeout(() => {
    release();
    ws.terminate();
  }, Number(process.env.LIFETIME ?? 50_000));
  ws.on('error', () => undefined);
  ws.on('close', (code) => {
    release();
    stats.closes[code] = (stats.closes[code] ?? 0) + 1;
    if (code === 1013) stats.refused1013++;
    else stats.dropped++;
  });
}
const bumpers = new Map<string, Bumper>();
for (const k of KEYS) {
  const b = new Bumper(k);
  await b.start();
  bumpers.set(k, b);
}
process.send?.({ ready: true });
await new Promise((r) => process.once('message', r));
const t0 = Date.now();
let lastReport = 0;
while (Date.now() - t0 < DUR * 1000) {
  for (const k of KEYS) if ((live.get(k) ?? 0) < PER_ROOM) await pausedJoin(k, bumpers.get(k)!);
  if (Date.now() - lastReport > 5000) {
    lastReport = Date.now();
    process.send?.({ progress: true, t: Math.round((Date.now() - t0) / 1000), live: [...live.values()].reduce((a, b) => a + b, 0), ...stats, cookies: cookieN });
  }
  await sleep(250);
}
process.send?.({ done: true, ...stats, cookies: cookieN });
await new Promise((r) => process.once('message', r));
process.exit(0);
