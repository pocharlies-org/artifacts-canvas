/**
 * FULL-SYSTEM regressions of the second independent verification (fv2), against the live
 * compose stack (see system.spec.ts):
 *   A  parked ("pending") Yjs structs released into history after the guard
 *   B  a pending delete set on the stamper's future clocks
 * Since fv5 (M-2) an update that would wait as pending is not applied and is answered with a sync
 * step 1 instead of closing 4403 (an honest reconnect can send one); the room still never holds it.
 *   C  non-map / malformed values under `shapes` vs a live browser, and a stored document
 *      that already holds bad values (recovery)
 *   D  anonymous pseudonym reuse through a free ?anon= hint
 */
import { spawnSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { BASE, USERS, container, editorReady, mc, mcBytes, newContext, openWithLogin, publish, shapes, waitFor, type Published, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const WSB = BASE.replace(/^http/, 'ws');
const cookies: Partial<Record<UserName, string>> = {};
const ctxs: BrowserContext[] = [];
let U: Published; // u/, ACL user1 + user2
let PUB: Published; // pub/
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const d = Date.now() + ms;
  while (!fn() && Date.now() < d) await sleep(50);
  return fn();
}
const wsUrl = (key: string, q = '') => `${WSB}/_canvas/_/ws/artifacts/${key}${q}`;

class Raw {
  /** the room's content document (shapes, assets, meta) */
  doc = new Y.Doc();
  /** the room's ledger document (attribution, users, history), from LEDGER (102) messages */
  ledger = new Y.Doc();
  ws!: WebSocket;
  ident: { id: string; name: string; anonymous: boolean } | null = null;
  code: number | null = null;
  synced = false;
  /** sync step 1 messages from the server (the join's, then any resync request) */
  step1s = 0;
  setCookie: string | null = null;
  closed: Promise<number>;
  private res!: (n: number) => void;
  constructor(public url: string, public headers: Record<string, string | undefined> = {}) {
    this.closed = new Promise((r) => (this.res = r));
  }
  open(): Promise<void> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries({ origin: BASE, ...this.headers })) if (v !== undefined) h[k] = v;
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url, { headers: h, maxPayload: 64 << 20 });
      this.ws = ws;
      ws.on('upgrade', (r) => (this.setCookie = (r.headers['set-cookie'] ?? []).join('\n') || null));
      ws.on('open', () => resolve());
      ws.on('unexpected-response', (_q, r) => { this.code = r.statusCode ?? -1; this.res(this.code); resolve(); });
      ws.on('error', () => undefined);
      ws.on('close', (c) => { this.code = c; this.res(c); resolve(); });
      ws.on('message', (d: Buffer) => {
        const dec = decoding.createDecoder(new Uint8Array(d));
        const t = decoding.readVarUint(dec);
        if (t === 0) {
          const st = decoding.readVarUint(dec);
          if (st !== 0) { Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'server'); this.synced = true; }
          else this.step1s++;
        } else if (t === 102) Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), 'server');
        else if (t === 100) this.ident = JSON.parse(decoding.readVarString(dec));
      });
      this.doc.on('update', (u: Uint8Array, o: unknown) => {
        if (o === 'server' || ws.readyState !== 1) return;
        this.send(u);
      });
    });
  }
  send(u: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeUpdate(e, u);
    this.ws.send(encoding.toUint8Array(e));
  }
  /** close code within `ms`, or null when the server kept the connection open */
  async closeCode(ms = 3000): Promise<number | null> {
    return Promise.race([this.closed, sleep(ms).then(() => null)]);
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function joined(url: string, headers: Record<string, string | undefined> = {}): Promise<Raw> {
  const c = new Raw(url, headers);
  await c.open();
  await until(() => c.synced || c.code !== null);
  return c;
}

function geo(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id, type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 200, h: 120, rotation: 0, color: 'red', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'none', opacity: 1, index: 1, text: '' })) m.set(k, v);
    doc.getMap('shapes').set(id, m);
  });
}
/** client id that wrote the server-only roots (the server's stamper), from the ledger */
const stamperClient = (ledger: Y.Doc): number => ((ledger.getArray('history') as unknown as { _start: Y.Item })._start).id.client;
/** a valid shape at clock 1 of a fresh client, without clock 0: Yjs parks it as pending */
function gapUpdate(): Uint8Array {
  const a = new Y.Doc();
  a.clientID = 4000000000 + Math.floor(Math.random() * 1e8);
  geo(a, 'pad0');
  const sv = Y.encodeStateVector(a);
  geo(a, 'pad1');
  return Y.encodeStateAsUpdate(a, sv);
}
/**
 * An item appended to history right after the server's future LEDGER struct (S, N + before),
 * sent as a content update (the attacker merges the broadcast ledger into its copy).
 */
function afterFuture(c: { doc: Y.Doc; ledger: Y.Doc }, S: number, before: number, entry: Record<string, unknown>): Uint8Array {
  const state = new Y.Doc();
  Y.applyUpdate(state, Y.encodeStateAsUpdate(c.doc));
  Y.applyUpdate(state, Y.encodeStateAsUpdate(c.ledger));
  const sim = new Y.Doc();
  Y.applyUpdate(sim, Y.encodeStateAsUpdate(state));
  sim.clientID = S;
  sim.transact(() => {
    for (let i = 0; i < before; i++) sim.getMap('attribution').set(`__sim${i}`, {});
    sim.getArray('history').push([{}]);
  });
  const ev = new Y.Doc();
  Y.applyUpdate(ev, Y.encodeStateAsUpdate(sim));
  ev.clientID = 3000000000 + Math.floor(Math.random() * 1e8);
  const sv = Y.encodeStateVector(ev);
  const h = ev.getArray('history');
  h.insert(h.length, [entry]);
  return Y.encodeStateAsUpdate(ev, sv);
}
const lines = (ledger: Y.Doc) => (ledger.getArray('history').toJSON() as { by: string; verb: string; shapeId: string }[]).map((e) => `${e.by} ${e.verb} ${e.shapeId}`);

async function restartCanvas(): Promise<void> {
  expect(spawnSync('docker', ['restart', container('canvas')]).status).toBe(0);
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/_canvas/readyz`)).ok;
    } catch {
      return false;
    }
  }, 60_000, 'canvas ready after restart');
}

test.beforeAll(async ({ browser }) => {
  U = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv2-u-${stamp}`);
  PUB = publish('pub', `fv2-pub-${stamp}`);
  for (const u of ['user1', 'user2'] as UserName[]) {
    const ctx = await newContext(browser);
    ctxs.push(ctx);
    const page = await ctx.newPage();
    expect(await openWithLogin(page, U.canvas, u)).toBe(200);
    cookies[u] = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  }
});
test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
});

for (const [label, keyOf, attacker] of [
  ['u-user2', () => U.key, () => ({ cookie: cookies.user2 })],
  ['pub-anon', () => PUB.key, () => ({})],
] as const) {
  test(`A ${label}: a parked struct is never released into history (gap write, item after the next stamper clock, victim edit, empty update)`, async () => {
    const key = keyOf();
    const honest = await joined(wsUrl(key), { cookie: cookies.user1 });
    geo(honest.doc, `h1-${label}`);
    await until(() => honest.ledger.getArray('history').length > 0);
    const before = honest.ledger.getArray('history').length;

    const e1 = await joined(wsUrl(key), attacker());
    expect(e1.synced).toBe(true);
    await until(() => e1.step1s >= 1);
    e1.send(gapUpdate());
    expect(await until(() => e1.step1s >= 2), 'gap write: answered with a resync request').toBe(true);
    expect(e1.code, 'gap write: not closed').toBeNull();
    e1.close();

    const e2 = await joined(wsUrl(key), attacker());
    await until(() => e2.ledger.getArray('history').length > 0);
    await until(() => e2.step1s >= 1);
    e2.send(afterFuture(e2, stamperClient(e2.ledger), 1, { t: Date.now(), by: USERS.user1.email, verb: 'delete', shapeId: `FORGED-${label}`, shapeType: 'geo' }));
    // closed 4403 (`foreign-client` when the stamper id is this process's ledger), else — a
    // stamper id from an earlier process, its next clock missing — never applied and answered
    // with a resync request (fv5 M-2)
    const c2 = await e2.closeCode(1500);
    expect(c2 === 4403 || (c2 === null && e2.step1s >= 2), `item after the future history line (close ${c2}, step 1s ${e2.step1s})`).toBe(true);
    e2.close();

    geo(honest.doc, `h2-${label}`);
    await until(() => honest.ledger.getArray('history').length > before);
    const e3 = await joined(wsUrl(key), attacker());
    e3.send(Y.encodeStateAsUpdate(new Y.Doc())); // the empty update that released the parked item
    expect(await e3.closeCode(1500), 'empty update is harmless').toBeNull();

    const fresh = await joined(wsUrl(key), { cookie: cookies.user1 });
    await until(() => fresh.ledger.getArray('history').length >= before + 1);
    const hist = lines(fresh.ledger);
    console.log(`[fv2] ${label}: history ${JSON.stringify(hist)}`);
    expect(hist.some((l) => l.includes('FORGED'))).toBe(false);
    expect(hist.filter((l) => l.endsWith(`h1-${label}`) || l.endsWith(`h2-${label}`))).toHaveLength(2);
    for (const c of [honest, e3, fresh]) c.close();
    await sleep(2500);
    await restartCanvas();
    const after = await joined(wsUrl(key), { cookie: cookies.user1 });
    await until(() => after.ledger.getArray('history').length >= hist.length);
    expect(lines(after.ledger).some((l) => l.includes('FORGED')), 'after restart (reloaded from MinIO)').toBe(false);
    expect(lines(after.ledger)).toEqual(hist);
    after.close();
  });
}

test('B: a pending delete set on future stamper clocks is never applied and deletes no later history line', async () => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv2-del-${stamp}`);
  const honest = await joined(wsUrl(P.key), { cookie: cookies.user1 });
  geo(honest.doc, 'd1');
  await until(() => honest.ledger.getArray('history').length > 0);
  const evil = await joined(wsUrl(P.key), { cookie: cookies.user2 });
  await until(() => evil.ledger.getArray('history').length > 0);
  const S = stamperClient(evil.ledger);
  const N = Y.getState(evil.ledger.store, S);
  const enc = encoding.createEncoder();
  for (const n of [0, 1, S, 1, N, 64]) encoding.writeVarUint(enc, n); // 0 structs; ds {S: [N, N+64)}
  await until(() => evil.step1s >= 1);
  evil.send(encoding.toUint8Array(enc));
  expect(await until(() => evil.step1s >= 2), 'pending delete set: answered with a resync request').toBe(true);
  // the same after a gap write (the verifier's order)
  const evil2 = await joined(wsUrl(P.key), { cookie: cookies.user2 });
  await until(() => evil2.step1s >= 1);
  evil2.send(gapUpdate());
  expect(await until(() => evil2.step1s >= 2), 'gap write: answered with a resync request').toBe(true);
  evil.close();
  evil2.close();
  geo(honest.doc, 'd2');
  await until(() => honest.ledger.getArray('history').length > 1);
  await sleep(300);
  const fresh = await joined(wsUrl(P.key), { cookie: cookies.user1 });
  await until(() => fresh.ledger.getArray('history').length >= 2);
  expect(lines(fresh.ledger)).toEqual([`${USERS.user1.email} create d1`, `${USERS.user1.email} create d2`]);
  expect(Object.keys(fresh.ledger.getMap('attribution').toJSON()).sort()).toEqual(['d1', 'd2']);
  for (const c of [honest, fresh]) c.close();
});

test('C: non-map / malformed shapes are refused 4403 next to a live browser; a stored bad value does not break the canvas', async ({ browser }) => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv2-shape-${stamp}`);
  const c1 = await newContext(browser);
  ctxs.push(c1);
  const p1 = await c1.newPage();
  const errs: string[] = [];
  p1.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  expect(await openWithLogin(p1, P.canvas, 'user1')).toBe(200);
  await editorReady(p1);
  const box = async () => {
    await p1.keyboard.press('r');
    await p1.mouse.move(300, 300);
    await p1.mouse.down();
    await p1.mouse.move(420, 400, { steps: 4 });
    await p1.mouse.up();
  };
  await box();
  await waitFor(async () => (await shapes(p1)).length === 1, 8_000, 'first rectangle');

  const writes: [string, (d: Y.Doc) => void][] = [
    ['number', (d) => d.getMap('shapes').set('evil-num', 42 as never)],
    ['string', (d) => d.getMap('shapes').set('evil-str', 'x' as never)],
    ['null', (d) => d.getMap('shapes').set('evil-null', null as never)],
    ['array', (d) => d.getMap('shapes').set('evil-arr', new Y.Array() as never)],
    ['evil-geo', (d) => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries({ type: 'geo', geo: 'rectangle', x: 'NaN', w: -1e308, text: 12 })) m.set(k, v);
      d.getMap('shapes').set('evil-geo', m);
    }],
  ];
  for (const [name, fn] of writes) {
    const a = await joined(wsUrl(P.key), { cookie: cookies.user2 });
    fn(a.doc);
    expect(await a.closeCode(), name).toBe(4403);
  }
  await sleep(500);
  expect((await shapes(p1)).length).toBe(1);
  await box();
  await waitFor(async () => (await shapes(p1)).length === 2, 8_000, 'drawing after the attack');

  // recovery: a stored document that already holds bad values (written before this fix)
  const objectPath = `artifacts/_plugins/canvas/${P.key}.ydoc`;
  await c1.close();
  await sleep(2500); // last leave: the room flushes and is evicted
  await restartCanvas();
  const stored = mcBytes(objectPath);
  expect(stored).not.toBeNull();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(stored!));
  const sv = Y.encodeStateVector(doc);
  doc.transact(() => {
    doc.getMap('shapes').set('stored-num', 42 as never);
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ type: 'geo', x: 'NaN', text: 12 })) m.set(k, v);
    doc.getMap('shapes').set('stored-geo', m);
  });
  const bad = Y.mergeUpdates([new Uint8Array(stored!), Y.encodeStateAsUpdate(doc, sv)]);
  expect(mc(`mc pipe "local/${objectPath}" >/dev/null && echo ok`, Buffer.from(bad)).out.trim()).toBe('ok');
  const c2 = await newContext(browser);
  ctxs.push(c2);
  const p2 = await c2.newPage();
  p2.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  expect(await openWithLogin(p2, P.canvas, 'user1')).toBe(200);
  await editorReady(p2);
  await waitFor(async () => (await shapes(p2)).length === 2, 10_000, 'the two good shapes render');
  const raw = await p2.evaluate(() => (window as any).__canvas.ydoc.getMap('shapes').size);
  expect(raw).toBe(4); // the bad entries are there, and skipped
  await p2.keyboard.press('r');
  await p2.mouse.move(500, 300);
  await p2.mouse.down();
  await p2.mouse.move(600, 380, { steps: 4 });
  await p2.mouse.up();
  await waitFor(async () => (await shapes(p2)).length === 3, 8_000, 'drawing on the recovered canvas');
  console.log(`[fv2] shapes: 5 malformed writes -> 4403; stored doc with 2 bad values renders ${(await shapes(p2)).length} good shapes; page errors ${errs.length}`);
  expect(errs).toEqual([]);
  await c2.close();
});

test('D: a later anonymous visitor hinting a freed number gets the label, never the earlier visitor\'s attribution id', async () => {
  const P = publish('pub', `fv2-anon-${stamp}`);
  const a = await joined(wsUrl(P.key, '?anon=4321'));
  expect(a.ident?.name).toBe('Anónimo 4321');
  geo(a.doc, 'by-a');
  await until(() => !!a.ledger.getMap('attribution').get('by-a'));
  const idA = a.ident!.id;
  a.close();
  await a.closed;
  await sleep(300);
  const b = await joined(wsUrl(P.key, '?anon=4321'));
  expect(b.ident?.name).toBe('Anónimo 4321');
  expect(b.ident?.id).not.toBe(idA);
  (b.doc.getMap('shapes').get('by-a') as Y.Map<unknown>).set('x', 150);
  geo(b.doc, 'by-b');
  await until(() => !!b.ledger.getMap('attribution').get('by-b'));
  const attr = b.ledger.getMap('attribution').toJSON() as Record<string, { createdBy: string; updatedBy: string }>;
  expect(attr['by-a'].createdBy).toBe(idA);
  expect(attr['by-a'].updatedBy).toBe(b.ident!.id);
  expect(attr['by-b'].createdBy).toBe(b.ident!.id);
  // the original visitor (its signed cookie) is still itself
  const a2 = await joined(wsUrl(P.key, '?anon=9999'), { cookie: a.setCookie!.split(';')[0] });
  expect(a2.ident?.id).toBe(idA);
  console.log(`[fv2] anon reuse: a=${idA} b=${b.ident?.id} (both "Anónimo 4321"); by-a createdBy stays a`);
  for (const c of [b, a2]) c.close();
});
