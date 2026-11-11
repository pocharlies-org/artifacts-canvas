// fv6 Q2 attacker (the verifier's q2-attacker.ts), run as a separate process by fv6.test.ts so
// its own CPU does not count against the server's: unauthenticated, it
//  1) mints M anonymous principals with HEAD requests to the wrapper page;
//  2) keeps one "bumper" connection that makes a tiny edit before each join (a new room version);
//  3) joins the big pub/ room with the minted cookies, CONC joins at a time, closing each as soon
//     as anything arrived (EARLY=1) or the content arrived.
// Before the fix every join after a version change re-encoded the whole room (82 ms for 3.3 MiB).
// env HTTP (http base incl. /_canvas), BASE (ws base), KEY, M, CONC, DUR (s), ORIGIN, EARLY, XFF
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const HTTP = process.env.HTTP!, BASE = process.env.BASE!, KEY = process.env.KEY!, ORIGIN = process.env.ORIGIN!;
const M = Number(process.env.M ?? 200), CONC = Number(process.env.CONC ?? 8), DUR = Number(process.env.DUR ?? 20);
const XFF = process.env.XFF === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookies: string[] = [];
const tMint = Date.now();
let mintRefused = 0;
for (let i = 0; i < M; i++) {
  const r = await fetch(`${HTTP}/${KEY}`, { method: 'HEAD', headers: XFF ? { 'x-forwarded-for': `10.9.${(i >> 8) & 255}.${i & 255}` } : {} });
  const sc = r.headers.get('set-cookie');
  if (sc) cookies.push(sc.split(';')[0]);
  else mintRefused++;
}
const mintMs = Date.now() - tMint;
if (cookies.length === 0) cookies.push(''); // nothing minted: cookieless joins (the ws mints, or refuses)
// the bumper: an anonymous writer, holding one tiny shape it moves
const bump = new WebSocket(`${BASE}/${KEY}`, { headers: { origin: ORIGIN, ...(cookies[0] ? { cookie: cookies[0] } : {}) } });
const bdoc = new Y.Doc();
let joinedBump = false;
bump.on('message', (d: Buffer) => {
  const dec = decoding.createDecoder(new Uint8Array(d));
  const t = decoding.readVarUint(dec);
  if (t === 0) {
    const st = decoding.readVarUint(dec);
    if (st === 1 || st === 2) {
      Y.applyUpdate(bdoc, decoding.readVarUint8Array(dec), 'remote');
      joinedBump = true;
    }
  }
});
bdoc.on('update', (u: Uint8Array, origin: unknown) => {
  if (origin === 'remote' || bump.readyState !== bump.OPEN) return;
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, u);
  bump.send(encoding.toUint8Array(e));
});
const bumpCodes: number[] = [];
bump.on('close', (c) => bumpCodes.push(c));
bump.on('error', () => undefined);
const tb = Date.now();
while (!joinedBump && Date.now() - tb < 10_000) await sleep(50);
const id = 'zz' + Math.random().toString(36).slice(2, 8);
const geo = { id, type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1 };
bdoc.transact(() => {
  const m = new Y.Map<unknown>();
  bdoc.getMap('shapes').set(id, m);
  for (const [k, v] of Object.entries(geo)) m.set(k, v);
});
await sleep(500);
let x = 0;
let lastBump = 0;
process.send?.({ ready: true, minted: cookies.filter((c) => c).length, mintRefused, mintMs });
await new Promise((r) => process.once('message', r));
const codes = new Map<string, number>();
let joins = 0, contentFrames = 0, ci = 1, inflight = 0, bytesIn = 0;
const t0 = Date.now();
async function oneJoin(cookie: string) {
  inflight++;
  if (bump.readyState === bump.OPEN && Date.now() - lastBump >= Number(process.env.BUMP_MS ?? 40)) {
    lastBump = Date.now();
    bdoc.transact(() => (bdoc.getMap('shapes').get(id) as Y.Map<unknown> | undefined)?.set('x', ++x));
  }
  await new Promise<void>((res) => {
    const ws = new WebSocket(`${BASE}/${KEY}`, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(XFF ? { 'x-forwarded-for': `10.9.${(ci >> 8) & 255}.${ci & 255}` } : {}) } });
    joins++;
    const to = setTimeout(() => ws.terminate(), 5000);
    ws.on('message', (d: Buffer) => {
      bytesIn += d.byteLength;
      if (process.env.EARLY === '1') {
        ws.terminate();
        return;
      }
      if (d.byteLength > 100_000) {
        contentFrames++;
        ws.terminate();
      }
    });
    ws.on('close', (c) => {
      clearTimeout(to);
      codes.set(String(c), (codes.get(String(c)) ?? 0) + 1);
      res();
    });
    ws.on('error', () => undefined);
  });
  inflight--;
}
const running: Promise<void>[] = [];
while (Date.now() - t0 < DUR * 1000) {
  while (inflight < CONC && Date.now() - t0 < DUR * 1000) {
    running.push(oneJoin(cookies[ci % cookies.length]));
    ci++;
  }
  await sleep(5);
}
await Promise.all(running);
process.send?.({ bumps: x, joins, contentFrames, codes: [...codes], bumpCodes, bytesInMB: +(bytesIn / 1048576).toFixed(1) });
await new Promise((r) => process.once('message', r));
process.exit(0);
