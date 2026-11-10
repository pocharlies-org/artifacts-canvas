/**
 * FULL-SYSTEM regressions of the third independent verification (fv3), against the live
 * compose stack: the verifier's live attacks (fv3.spec.ts) with the expectations turned
 * around. Every forgery attempt leaves the LEDGER (the server-only document with attribution,
 * users and history) byte-identical; honest users are never kicked; offline edits arrive; and
 * a same-origin script cannot read the session id_token from any /oauth2/ path.
 * Screenshots land in SYSTEM_SHOTS (default client/test-results/system/shots).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { BASE, REPO, USERS, container, editorReady, newContext, openWithLogin, publish, type Published, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });
const OUT = process.env.SYSTEM_SHOTS ?? path.join(REPO, 'client', 'test-results', 'system', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36);
const WSB = BASE.replace(/^http/, 'ws');
const cookies: Partial<Record<UserName, string>> = {};
const ctxs: BrowserContext[] = [];
const pages: Partial<Record<UserName, Page>> = {};
let U: Published;
let PUB: Published;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const d = Date.now() + ms;
  while (!(await fn()) && Date.now() < d) await sleep(50);
  return fn();
}
const wsUrl = (key: string) => `${WSB}/_canvas/_/ws/artifacts/${key}`;
const log = (k: string, v: unknown) => console.log(`[fv3] ${k}: ${JSON.stringify(v)}`);

/** Raw client: content document + ledger document (LEDGER 102), the browser's Origin. */
class Raw {
  doc = new Y.Doc();
  ledger = new Y.Doc();
  aw = new awarenessProtocol.Awareness(new Y.Doc());
  ws!: WebSocket;
  ident: { id: string } | null = null;
  code: number | null = null;
  reason = '';
  synced = false;
  constructor(public url: string, public headers: Record<string, string | undefined> = {}) {}
  open(): Promise<void> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries({ origin: BASE, ...this.headers })) if (v !== undefined) h[k] = v;
    this.code = null;
    this.synced = false;
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url, { headers: h, maxPayload: 64 << 20 });
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('unexpected-response', (_q, r) => { this.code = r.statusCode ?? -1; resolve(); });
      ws.on('error', () => resolve());
      ws.on('close', (c, why) => { this.code = c; this.reason = String(why); resolve(); });
      ws.on('message', (d: Buffer) => {
        const dec = decoding.createDecoder(new Uint8Array(d));
        const t = decoding.readVarUint(dec);
        if (t === 0) {
          const st = decoding.readVarUint(dec);
          if (st !== 0) {
            Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'server');
            this.synced = true;
          }
        } else if (t === 1) awarenessProtocol.applyAwarenessUpdate(this.aw, decoding.readVarUint8Array(dec), 'server');
        else if (t === 100) this.ident = JSON.parse(decoding.readVarString(dec));
        else if (t === 102) Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), 'server');
      });
    });
  }
  send(u: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeUpdate(e, u);
    this.ws.send(encoding.toUint8Array(e));
  }
  sendRaw(b: Uint8Array) { this.ws.send(b); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}
async function joined(url: string, headers: Record<string, string | undefined> = {}) {
  const c = new Raw(url, headers);
  await c.open();
  await until(() => c.synced || c.code !== null);
  return c;
}
function geoUpdate(doc: Y.Doc, id: string, extra: Record<string, unknown> = {}): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, Y.encodeStateAsUpdate(doc));
  tmp.clientID = 2000000000 + Math.floor(Math.random() * 1e8);
  tmp.transact(() => {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ type: 'geo', geo: 'rectangle', x: 120, y: 160, w: 220, h: 120, color: 'red', fill: 'solid', ...extra })) m.set(k, v);
    tmp.getMap('shapes').set(id, m);
  });
  return Y.encodeStateAsUpdate(tmp, sv);
}
function zeroLen(client: number, clock: number, targets: Y.ID[]): Uint8Array {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, 1);
  encoding.writeVarUint(enc.restEncoder, targets.length);
  enc.writeClient(client);
  encoding.writeVarUint(enc.restEncoder, clock);
  for (const t of targets) new Y.Item(Y.createID(client, clock), null, t, null, null, null, null, new Y.ContentAny([])).write(enc, 0);
  encoding.writeVarUint(enc.restEncoder, 0);
  return enc.toUint8Array();
}
const entryId = (doc: Y.Doc, root: string, key: string): Y.ID => (doc.getMap(root) as unknown as { _map: Map<string, Y.Item> })._map.get(key)!.id;
const ledgerHex = (c: Raw) => Buffer.from(Y.encodeStateAsUpdate(c.ledger)).toString('hex');
async function stroke(page: Page, x: number, y: number) {
  await page.keyboard.press('d');
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 12, y + (i % 2) * 10);
  await page.mouse.up();
  await sleep(150);
  await page.keyboard.press('v');
}
const pageState = (p: Page) =>
  p.evaluate(() => {
    const c = (window as any).__canvas;
    return { status: c.editor.status, close: c.conn.closeCode, closes: (window as any).__wsCloses as number[], clientID: c.ydoc.clientID, shapes: c.ydoc.getMap('shapes').size };
  });
async function waitCanvasUp() {
  await until(async () => {
    try {
      return (await fetch(`${BASE}/_canvas/readyz`)).ok;
    } catch {
      return false;
    }
  }, 60_000);
}

test.beforeAll(async ({ browser }) => {
  U = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv3-u-${stamp}`);
  PUB = publish('pub', `fv3-pub-${stamp}`);
  for (const u of ['user1', 'user2'] as UserName[]) {
    const ctx = await newContext(browser);
    ctxs.push(ctx);
    const page = await ctx.newPage();
    expect(await openWithLogin(page, U.canvas, u)).toBe(200);
    await editorReady(page);
    pages[u] = page;
    cookies[u] = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  }
});
test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
});

test('Z zero-length structs (anonymous on pub/, user2 on u/) and a client LEDGER message: 4403, the ledger byte-identical, persisted', async ({ browser }) => {
  for (const [label, key, attackerHdr, victimHdr] of [
    ['u-user2', () => U.key, () => ({ cookie: cookies.user2 }), () => ({ cookie: cookies.user1 })],
    ['pub-anon', () => PUB.key, () => ({}), () => ({ cookie: cookies.user1 })],
  ] as const) {
    const honest = await joined(wsUrl(key()), victimHdr());
    const sid = `victim-${label}`;
    honest.send(geoUpdate(honest.doc, sid));
    await until(() => honest.ledger.getMap('attribution').has(sid));
    const before = ledgerHex(honest);
    const evil = await joined(wsUrl(key()), attackerHdr());
    await until(() => evil.ledger.getMap('attribution').has(sid));
    const me = evil.doc.clientID;
    evil.send(zeroLen(me, Y.getState(evil.doc.store, me), [entryId(evil.ledger, 'attribution', sid), entryId(evil.ledger, 'users', honest.ident!.id)]));
    await until(() => evil.code !== null, 5000);
    // the same on the content document: a zero-length item over the victim's shape entry
    const evil2 = await joined(wsUrl(key()), attackerHdr());
    evil2.send(zeroLen(evil2.doc.clientID, 0, [entryId(evil2.doc, 'shapes', sid)]));
    await until(() => evil2.code !== null, 5000);
    // and the direct way: a LEDGER (102) message with a real update of the attacker's ledger copy
    const evil3 = await joined(wsUrl(key()), attackerHdr());
    await until(() => evil3.ledger.getMap('attribution').has(sid));
    const sv = Y.encodeStateVector(evil3.ledger);
    evil3.ledger.getMap('attribution').set(sid, { createdBy: 'mallory', createdAt: 1, updatedBy: 'mallory', updatedAt: 1 });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 102);
    encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(evil3.ledger, sv));
    evil3.sendRaw(encoding.toUint8Array(e));
    await until(() => evil3.code !== null, 5000);
    await sleep(500);
    log(`${label}`, { codes: [evil.code, evil2.code, evil3.code], victimAttribution: honest.ledger.getMap('attribution').get(sid), ledgerUnchanged: ledgerHex(honest) === before });
    expect([evil.code, evil2.code, evil3.code]).toEqual([4403, 4403, 4403]);
    expect(ledgerHex(honest)).toBe(before);
    expect(honest.ledger.getMap('attribution').get(sid)).toMatchObject({ createdBy: honest.ident!.id });
    // the victim's shape is still in the room (the zero-length item over it was refused)
    const probe = await joined(wsUrl(key()), victimHdr());
    expect(probe.doc.getMap('shapes').has(sid)).toBe(true);
    for (const c of [evil, evil2, evil3, honest, probe]) c.close();
  }
  // persisted: after the save debounce + a canvas restart a fresh client sees the true author
  await sleep(2500);
  expect(spawnSync('docker', ['restart', container('canvas')]).status).toBe(0);
  await waitCanvasUp();
  const fresh = await joined(wsUrl(U.key), { cookie: cookies.user1 });
  await until(() => fresh.ledger.getMap('attribution').has('victim-u-user2'));
  expect(fresh.ledger.getMap('attribution').get('victim-u-user2')).toMatchObject({ createdBy: USERS.user1.email });
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const p = await ctx.newPage();
  await openWithLogin(p, U.canvas, 'user1');
  await editorReady(p);
  await until(async () => (await p.evaluate(() => document.querySelector('[data-shape-id="victim-u-user2"]')?.getAttribute('data-author'))) === USERS.user1.email, 10_000);
  const author = await p.evaluate(() => document.querySelector('[data-shape-id="victim-u-user2"]')?.getAttribute('data-author'));
  log('browser data-author after restart', author);
  expect(author).toBe(USERS.user1.email);
  await p.screenshot({ path: `${OUT}/fv3-z-attribution-intact-1440.png` });
  fresh.close();
  await ctx.close();
});

test('P a known struct with a missing origin + a zero-length delete range: the attacker is closed, the victim keeps drawing', async () => {
  const R = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv3-p-${stamp}`);
  const seed = await joined(wsUrl(R.key), { cookie: cookies.user1 });
  seed.send(geoUpdate(seed.doc, 'p-seed'));
  await until(() => seed.ledger.getArray('history').length > 0);
  const page = pages.user1!;
  await page.goto(R.canvas);
  await editorReady(page);
  await sleep(2500); // room idle + saved
  const evil = await joined(wsUrl(R.key), { cookie: cookies.user2 });
  await until(() => evil.ledger.getArray('history').length > 0);
  const S = ((evil.ledger.getArray('history') as unknown as { _start: Y.Item })._start).id.client;
  const K = Array.from(evil.doc.store.clients.keys()).find((c) => Y.getState(evil.doc.store, c) > 0)!;
  const enc2 = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc2.restEncoder, 1);
  encoding.writeVarUint(enc2.restEncoder, 1);
  enc2.writeClient(K);
  encoding.writeVarUint(enc2.restEncoder, 0);
  new Y.Item(Y.createID(K, 0), null, Y.createID(S, Y.getState(evil.ledger.store, S) + 50), null, null, null, null, new Y.ContentAny([1])).write(enc2, 0);
  encoding.writeVarUint(enc2.restEncoder, 1);
  enc2.resetDsCurVal();
  encoding.writeVarUint(enc2.restEncoder, 4242);
  encoding.writeVarUint(enc2.restEncoder, 1);
  enc2.writeDsClock(7);
  enc2.writeDsLen(0);
  evil.send(enc2.toUint8Array());
  await until(() => evil.code !== null, 5000);
  const before = (await pageState(page)).shapes;
  await stroke(page, 400, 500);
  await sleep(1500);
  const st = await pageState(page);
  const honest = await joined(wsUrl(R.key), { cookie: cookies.user1 });
  honest.send(geoUpdate(honest.doc, 'p-after-attack'));
  await until(() => honest.ledger.getMap('attribution').has('p-after-attack'));
  log('P', { attacker: evil.code, victim: st, localShapesBefore: before, rawHonestClose: honest.code });
  await page.screenshot({ path: `${OUT}/fv3-p-victim-keeps-drawing-1440.png` });
  expect(evil.code).toBe(4403);
  expect(st.closes).not.toContain(4403);
  expect(st.status).toBe('synced');
  expect(st.shapes).toBe(before + 1);
  expect(honest.code).toBeNull();
  expect(honest.ledger.getMap('attribution').has('p-after-attack')).toBe(true);
  for (const c of [evil, honest, seed]) c.close();
});

test('S2 a note with color "zzz" is refused 4403; every viewer renders every shape without a page error', async ({ browser }) => {
  const R = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv3-s2-${stamp}`);
  const evil = await joined(wsUrl(R.key), { cookie: cookies.user2 });
  evil.send(geoUpdate(evil.doc, 'a-bad-note', { type: 'note', color: 'zzz', text: 'x' }));
  await until(() => evil.code !== null, 5000);
  expect(evil.code).toBe(4403);
  const good = await joined(wsUrl(R.key), { cookie: cookies.user2 });
  for (let i = 0; i < 4; i++) {
    good.send(geoUpdate(good.doc, `z-good-${i}`, { x: 120 + i * 260, y: 420 }));
    await sleep(150);
  }
  await sleep(500);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await openWithLogin(p, R.canvas, 'user1');
  await editorReady(p);
  await until(async () => (await p.evaluate(() => document.querySelectorAll('[data-shape-id]').length)) === 4, 10_000);
  const rendered = await p.evaluate(() => Array.from(document.querySelectorAll('[data-shape-id]')).map((e) => e.getAttribute('data-shape-id')));
  const inDoc = await p.evaluate(() => Array.from((window as any).__canvas.ydoc.getMap('shapes').keys()));
  log('S2', { attacker: evil.code, inDoc, rendered, pageErrors: errors });
  await p.screenshot({ path: `${OUT}/fv3-s2-viewer-1440.png` });
  expect(inDoc).not.toContain('a-bad-note');
  expect(rendered.sort()).toEqual(['z-good-0', 'z-good-1', 'z-good-2', 'z-good-3']);
  expect(errors).toEqual([]);
  good.close();
  await ctx.close();
});

test('S3 a `__proto__` shape field is refused 4403; the viewer stays responsive', async ({ browser }) => {
  const R = publish('pub', `fv3-s3-${stamp}`);
  const evil = await joined(wsUrl(R.key)); // anonymous on pub/
  const sv = Y.encodeStateVector(evil.doc);
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, Y.encodeStateAsUpdate(evil.doc));
  tmp.clientID = evil.doc.clientID;
  tmp.transact(() => {
    const m = new Y.Map<unknown>();
    tmp.getMap('shapes').set('freeze', m);
    for (const [k, v] of Object.entries({ type: 'draw', x: 100, y: 100, w: 50, h: 50 })) m.set(k, v);
    m.set('__proto__', { points: { length: 3e8 }, ow: 0, done: false });
  });
  evil.send(Y.encodeStateAsUpdate(tmp, sv));
  await until(() => evil.code !== null, 5000);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const p = await ctx.newPage();
  await p.goto(R.canvas, { timeout: 30000 });
  await editorReady(p);
  const t0 = Date.now();
  const alive = await Promise.race([p.evaluate(() => 'responsive'), sleep(5000).then(() => 'NO ANSWER')]);
  const inDoc = await p.evaluate(() => (window as any).__canvas.ydoc.getMap('shapes').has('freeze'));
  log('S3', { attacker: evil.code, alive, ms: Date.now() - t0, inDoc });
  expect(evil.code).toBe(4403);
  expect(alive).toBe('responsive');
  expect(inDoc).toBe(false);
  await ctx.close();
});

test('O an awareness claim of the victim id right after a canvas restart: the victim is not kicked, its stroke lands', async () => {
  const page = pages.user2!;
  await page.goto(U.canvas);
  await editorReady(page);
  await stroke(page, 200, 600); // the victim's client id gets clocks (bound to user2 in the ledger)
  await sleep(1500);
  const spy = await joined(wsUrl(U.key), { cookie: cookies.user1 });
  await until(() => Array.from(spy.aw.getStates().values()).some((s: any) => s?.user?.id === USERS.user2.email));
  const V = Array.from(spy.aw.getStates().entries()).find(([, s]: any) => s?.user?.id === USERS.user2.email)![0];
  spy.close();
  await sleep(500);
  const fake = new awarenessProtocol.Awareness(new Y.Doc());
  (fake as unknown as { clientID: number }).clientID = V;
  for (let i = 0; i < 1000; i++) fake.setLocalState({ cursor: { x: i, y: i } });
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(fake, [V]));
  const claim = encoding.toUint8Array(e);
  const cid = container('canvas');
  expect(spawnSync('docker', ['stop', '-t', '1', cid]).status).toBe(0);
  await sleep(4000);
  expect(spawnSync('docker', ['start', cid]).status).toBe(0);
  const evil = new Raw(wsUrl(U.key), { cookie: cookies.user1 });
  await until(async () => {
    await evil.open();
    if (evil.code === null && evil.ws.readyState === 1) {
      await until(() => evil.ident !== null, 3000);
      evil.sendRaw(claim);
      return true;
    }
    await sleep(20);
    return false;
  }, 30000);
  await until(async () => (await pageState(page)).status === 'synced', 30000);
  await sleep(500);
  const before = (await pageState(page)).shapes;
  await stroke(page, 500, 600);
  await sleep(1500);
  const st = await pageState(page);
  const check = await joined(wsUrl(U.key), { cookie: cookies.user1 });
  log('O', { victimClientId: V, victim: st, serverShapes: check.doc.getMap('shapes').size });
  await page.screenshot({ path: `${OUT}/fv3-o-victim-not-kicked-1440.png` });
  expect(st.closes).not.toContain(4403);
  expect(st.shapes).toBe(before + 1);
  expect(check.doc.getMap('shapes').size).toBe(st.shapes);
  evil.close();
  check.close();
});

test('F a browser that draws 3 strokes while the canvas is down: all of them reach the server, and the next one too', async ({ browser }) => {
  const R = publish({ users: [USERS.user1.email, USERS.user2.email] }, `fv3-f-${stamp}`);
  const ctx = await newContext(browser);
  ctxs.push(ctx);
  const page = await ctx.newPage();
  await openWithLogin(page, R.canvas, 'user1');
  await editorReady(page);
  await sleep(500);
  await stroke(page, 300, 300);
  await sleep(800);
  const cid = container('canvas');
  expect(spawnSync('docker', ['stop', '-t', '2', cid]).status).toBe(0);
  await until(async () => (await pageState(page)).status !== 'synced', 10000);
  for (const y of [400, 480, 560]) await stroke(page, 300, y); // drawn while offline (the UI lets you)
  const offline = (await pageState(page)).shapes;
  expect(offline).toBe(4);
  expect(spawnSync('docker', ['start', cid]).status).toBe(0);
  await waitCanvasUp();
  await until(async () => (await pageState(page)).status === 'synced', 30000);
  const check = await joined(wsUrl(R.key), { cookie: cookies.user2 });
  await until(() => check.doc.getMap('shapes').size === 4, 10_000);
  const delivered = check.doc.getMap('shapes').size;
  await stroke(page, 300, 650);
  await until(() => check.doc.getMap('shapes').size === 5, 10_000);
  await until(() => check.ledger.getMap('attribution').size === 5, 10_000);
  const st = await pageState(page);
  const authors = Object.values(check.ledger.getMap('attribution').toJSON() as Record<string, { createdBy: string }>).map((a) => a.createdBy);
  log('F', { victim: st, deliveredAfterReconnect: delivered, serverShapes: check.doc.getMap('shapes').size, authors });
  await page.screenshot({ path: `${OUT}/fv3-f-offline-delivered-1440.png` });
  expect(st.closes).not.toContain(4403);
  expect(delivered).toBe(4);
  expect(check.doc.getMap('shapes').size).toBe(5);
  expect(new Set(authors)).toEqual(new Set([USERS.user1.email]));
  check.close();
  await ctx.close();
});

test('T same-origin script on the canvas page reads no token from any /oauth2/ path but the browser endpoints', async () => {
  const page = pages.user1!;
  await page.goto(U.canvas);
  await editorReady(page);
  const r = await page.evaluate(async () => {
    const out: Record<string, [number, string, string | null]> = {};
    for (const p of ['/oauth2/auth', '/oauth2/zzz', '/oauth2/', '/oauth2/ping', '/oauth2/sign_inX', '/oauth2/userinfo', '/oauth2/%ef%bc%a1uth', '/oauth2/start/..;/auth', '/oauth2/SIGN_IN']) {
      const res = await fetch(p, { credentials: 'include', redirect: 'manual' });
      out[p] = [res.status, (res.headers.get('authorization') ?? '').slice(0, 24), res.headers.get('x-auth-request-email')];
    }
    return out;
  });
  log('T same-origin fetch', r);
  for (const [p, [status, authz, email]] of Object.entries(r)) {
    expect(authz, p).toBe('');
    expect(email, p).toBeNull();
    expect(status, p).not.toBe(202);
  }
});
