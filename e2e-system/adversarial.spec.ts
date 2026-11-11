/**
 * FULL-SYSTEM adversarial cases (regressions of the independent verification), against the
 * same live compose stack as system.spec.ts: forged ledger-root writes (attribution, users,
 * history live in the server-only LEDGER document; a client can only reach the content one), cross-origin
 * WebSockets, the expired-artifact existence leak, the public metrics route, an anonymous
 * visitor locking a room by filling it, and client-chosen anonymous ids.
 */
import { spawnSync } from 'node:child_process';
import { expect, test, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { ACL_CACHE_SECONDS, BASE, USERS, container, mc, mcBytes, newContext, openWithLogin, publish, type Published, type UserName } from './lib';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const WSB = BASE.replace(/^http/, 'ws');
const cookies: Partial<Record<UserName, string>> = {};
const ctxs: BrowserContext[] = [];
let shared: Published; // u/, ACL user1 + user2
let pubArt: Published; // pub/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const d = Date.now() + ms;
  while (!fn() && Date.now() < d) await sleep(50);
  return fn();
}
const wsUrl = (key: string, q = '') => `${WSB}/_canvas/_/ws/artifacts/${key}${q}`;

/** Raw y-websocket client: sends the browser Origin unless told otherwise. */
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
  notices: string[] = [];
  setCookie: string | null = null;
  closed: Promise<number>;
  private res!: (n: number) => void;
  constructor(public url: string, public headers: Record<string, string> = {}) {
    this.closed = new Promise((r) => (this.res = r));
  }
  open(): Promise<void> {
    const h: Record<string, string> = { origin: BASE, ...this.headers };
    if (h.origin === '') delete h.origin;
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
        else if (t === 101) this.notices.push(JSON.parse(decoding.readVarString(dec)).kind);
      });
      this.doc.on('update', (u: Uint8Array, o: unknown) => {
        if (o === 'server' || ws.readyState !== 1) return;
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeUpdate(e, u);
        ws.send(encoding.toUint8Array(e));
      });
    });
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function joined(url: string, headers: Record<string, string> = {}): Promise<Raw> {
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

test.beforeAll(async ({ browser }) => {
  shared = publish({ users: [USERS.user1.email, USERS.user2.email] }, `adv-u-${stamp}`);
  pubArt = publish('pub', `adv-pub-${stamp}`);
  for (const u of ['user1', 'user2', 'user3'] as UserName[]) {
    const ctx = await newContext(browser);
    ctxs.push(ctx);
    const page = await ctx.newPage();
    const status = await openWithLogin(page, shared.canvas, u);
    expect(status).toBe(u === 'user3' ? 403 : 200);
    cookies[u] = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  }
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
});

test('1. forged stamper-root writes (history append/insert, attribution/users overwrite, new key) are refused and change nothing', async () => {
  for (const [label, key, attacker, q] of [
    ['logged-in user2', shared.key, { cookie: cookies.user2! }, ''],
    ['anonymous on pub/', pubArt.key, {}, '?anon=4242'],
  ] as const) {
    const honest = await joined(wsUrl(key), { cookie: cookies.user1! });
    expect(honest.ident?.id).toBe(USERS.user1.email);
    const sid = `adv-${label.replace(/\W/g, '')}`;
    geo(honest.doc, sid);
    await until(() => !!honest.ledger.getMap('attribution').get(sid) && honest.ledger.getArray('history').length > 0);
    const before = {
      attr: honest.ledger.getMap('attribution').toJSON(),
      users: honest.ledger.getMap('users').toJSON(),
      history: honest.ledger.getArray('history').toJSON(),
    };
    const variants: [string, (d: Y.Doc) => void][] = [
      ['history append after the last item', (d) => d.getArray('history').push([{ t: Date.now(), by: USERS.user1.email, verb: 'delete', shapeId: 'zz', shapeType: 'geo' }])],
      ['history insert at the start', (d) => d.getArray('history').insert(0, [{ t: 1, by: USERS.user3.email, verb: 'create', shapeId: 'zz', shapeType: 'geo' }])],
      ['history delete', (d) => d.getArray('history').delete(0, 1)],
      ['attribution overwrite', (d) => d.getMap('attribution').set(sid, { createdBy: USERS.user3.email, createdAt: 1, updatedBy: USERS.user3.email, updatedAt: 1 })],
      ['attribution new key', (d) => d.getMap('attribution').set('brand-new', { createdBy: 'x' })],
      ['users overwrite', (d) => d.getMap('users').set(USERS.user1.email, { name: 'FORGED NAME', anonymous: false, color: '#000000' })],
    ];
    for (const [vname, fn] of variants) {
      const a = await joined(wsUrl(key, q), attacker);
      expect(a.synced, `${label}: ${vname} attacker joined`).toBe(true);
      // the attacker merges the (broadcast) ledger into its content document, so its forged
      // items carry real ledger origins (an append after the last history line has no parent)
      await until(() => a.ledger.getArray('history').length > 0);
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(a.ledger), 'server');
      const step1s = a.step1s;
      fn(a.doc);
      const code = await Promise.race([a.closed, sleep(3000).then(() => null)]);
      const asked = a.step1s > step1s;
      a.close();
      // closed 4403, or — a write whose origin is a ledger clock the content document lacks is
      // `pending` — never applied and answered with a resync request (fv5 M-2)
      expect(code === 4403 || (code === null && asked), `${label}: ${vname} (close ${code}, resync request ${asked})`).toBe(true);
    }
    await sleep(500);
    const fresh = await joined(wsUrl(key), { cookie: cookies.user1! });
    await until(() => fresh.ledger.getArray('history').length >= before.history.length);
    expect(fresh.ledger.getMap('attribution').toJSON()).toEqual(before.attr);
    expect(fresh.ledger.getMap('users').toJSON()).toEqual(before.users);
    expect(fresh.ledger.getArray('history').toJSON()).toEqual(before.history);
    console.log(`[adv] ${label}: 6 forged writes refused, stamper roots unchanged (history ${before.history.length} lines)`);
    fresh.close();
    honest.close();
  }
});

test('2. WebSocket Origin: missing, null and foreign origins are refused 4403; the artifacts origin joins', async () => {
  for (const origin of ['', 'null', 'https://evil.example.net', 'http://127.0.0.1:8081', 'http://localhost:8080']) {
    const c = new Raw(wsUrl(shared.key), { cookie: cookies.user1!, origin });
    await c.open();
    await until(() => c.code !== null || c.ident !== null, 5000);
    expect(c.ident, `origin "${origin}"`).toBeNull();
    expect(c.code, `origin "${origin}"`).toBe(4403);
    c.close();
  }
  const ok = await joined(wsUrl(shared.key), { cookie: cookies.user1! });
  expect(ok.ident?.id).toBe(USERS.user1.email);
  ok.close();
});

test('3. expired artifact: a stranger gets the same 403/4403 as for a live one; only a listed user learns 410', async () => {
  const X = publish({ users: [USERS.user1.email] }, `adv-exp-${stamp}`);
  const h = await joined(wsUrl(X.key), { cookie: cookies.user1! });
  geo(h.doc, 'e1');
  await sleep(1500);
  h.close();
  const obj = `artifacts/_plugins/canvas/${X.key}.ydoc`;
  await until(() => mcBytes(obj) !== null && mcBytes(`${obj}.ledger`) !== null, 10_000);
  expect(mcBytes(obj)).not.toBeNull();
  expect(mcBytes(`${obj}.ledger`)).not.toBeNull();
  const status = async (url: string, ck?: string) =>
    (await fetch(url, { headers: ck ? { cookie: ck } : {}, redirect: 'manual' })).status;
  const live = {
    user3: [await status(`${BASE}/_canvas/artifacts/${X.key}`, cookies.user3), await status(`${BASE}/artifacts/${X.key}`, cookies.user3)],
    anon: [await status(`${BASE}/_canvas/artifacts/${X.key}`), await status(`${BASE}/artifacts/${X.key}`)],
  };
  const aclPath = `local/artifacts/${X.key.replace(/[^/]+$/, '')}.acl.json`;
  const acl = JSON.parse(mc(`mc cat ${aclPath}`).out);
  acl.expires = '2020-01-01T00:00:00Z';
  expect(mc(`mc pipe ${aclPath} >/dev/null && echo ok`, JSON.stringify(acl)).out.trim()).toBe('ok');
  await sleep((ACL_CACHE_SECONDS + 1) * 1000);
  const dead = {
    user3: [await status(`${BASE}/_canvas/artifacts/${X.key}`, cookies.user3), await status(`${BASE}/artifacts/${X.key}`, cookies.user3)],
    user2: [await status(`${BASE}/_canvas/artifacts/${X.key}`, cookies.user2), await status(`${BASE}/artifacts/${X.key}`, cookies.user2)],
    anon: [await status(`${BASE}/_canvas/artifacts/${X.key}`), await status(`${BASE}/artifacts/${X.key}`)],
  };
  console.log(`[adv] expired leak: live ${JSON.stringify(live)} dead ${JSON.stringify(dead)}`);
  expect(dead.user3).toEqual(live.user3);
  expect(dead.user3).toEqual([403, 403]);
  expect(dead.user2).toEqual([403, 403]);
  expect(dead.anon).toEqual(live.anon);
  expect(dead.anon).toEqual([302, 302]);
  for (const ck of [cookies.user3!, cookies.user2!]) {
    const w = new Raw(wsUrl(X.key), { cookie: ck });
    await w.open();
    await until(() => w.code !== null, 5000);
    expect(w.code).toBe(4403);
    expect(w.notices).not.toContain('expired');
  }
  await sleep(1000);
  // strangers did not make the canvas react to the expiry (no deletion on their behalf)
  expect(mcBytes(obj)).not.toBeNull();
  // the listed user is told the truth, and the canvas object dies with the artifact
  expect(await status(`${BASE}/_canvas/artifacts/${X.key}`, cookies.user1)).toBe(410);
  const w1 = new Raw(wsUrl(X.key), { cookie: cookies.user1! });
  await w1.open();
  await until(() => w1.code !== null, 5000);
  expect(w1.code).toBe(4410);
  await until(() => mcBytes(obj) === null && mcBytes(`${obj}.ledger`) === null, 10_000);
  expect(mcBytes(obj)).toBeNull();
  expect(mcBytes(`${obj}.ledger`)).toBeNull(); // the ledger object dies with it
});

test('4. metrics are not public: 404 on the route, served only on the internal port', async () => {
  for (const p of ['/_canvas/metrics', '/_canvas/_/metrics']) {
    const r = await fetch(`${BASE}${p}`);
    const body = await r.text();
    expect(r.status, p).toBe(404);
    expect(body, p).not.toContain('canvas_');
  }
  // any other spelling is just an (invalid) artifact path: refused, never metrics
  for (const p of ['/_canvas/metrics/', '/_canvas/metrics?x=1', '/_canvas/%6detrics']) {
    const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    expect([302, 400, 403, 404], p).toContain(r.status);
    expect(await r.text(), p).not.toContain('canvas_');
  }
  const inside = spawnSync('docker', ['exec', container('canvas'), 'wget', '-qO-', 'http://127.0.0.1:9091/metrics'], { encoding: 'utf8' });
  expect(inside.status).toBe(0);
  expect(inside.stdout).toContain('canvas_rooms_active');
  // the metrics port is not published on the host
  await expect(fetch('http://127.0.0.1:9091/metrics')).rejects.toThrow();
});

test('5. an anonymous visitor filling the document is closed alone; logged-in and anonymous visitors keep using the room', async () => {
  const P = publish('pub', `adv-fill-${stamp}`);
  // a logged-in visitor stays in the room the whole time (keeps the room loaded)
  const observer = await joined(wsUrl(P.key), { cookie: cookies.user2! });
  expect(observer.synced).toBe(true);
  const g = await joined(wsUrl(P.key));
  expect(g.ident?.anonymous).toBe(true);
  for (let i = 0; i < 9 && g.code === null; i++) {
    g.doc.getMap('assets').set(`blob${i}`, 'data:image/png;base64,' + 'A'.repeat(900 * 1024));
    await sleep(700);
  }
  expect(g.code).toBe(4413);
  expect(g.notices).toContain('too-large');
  // the refused update was not applied, and the observer was not dropped
  await sleep(300);
  expect(observer.doc.getMap('assets').size).toBe(g.doc.getMap('assets').size - 1);
  expect(observer.code).toBeNull();
  const u1 = await joined(wsUrl(P.key), { cookie: cookies.user1! });
  expect(u1.code).toBeNull();
  expect(u1.synced).toBe(true);
  const anon2 = await joined(wsUrl(P.key));
  expect(anon2.code).toBeNull();
  expect(anon2.synced).toBe(true);
  geo(u1.doc, 'after-fill');
  await until(() => anon2.doc.getMap('shapes').has('after-fill'));
  expect(anon2.doc.getMap('shapes').has('after-fill')).toBe(true);
  console.log(`[adv] anon filler closed 4413 after ${g.doc.getMap('assets').size} blobs; user1 + anon2 joined and wrote`);
  for (const c of [u1, anon2, observer]) c.close();
});

test('6. anonymous ids are assigned by the server: a client hint never collides, never carries an e-mail', async () => {
  const a = await joined(wsUrl(pubArt.key, '?anon=1234'));
  const b = await joined(wsUrl(pubArt.key, '?anon=1234'));
  expect(a.ident?.id).toMatch(/^anon:[A-Za-z0-9_-]{16}$/);
  expect(b.ident?.id).toMatch(/^anon:[A-Za-z0-9_-]{16}$/);
  expect(b.ident?.id).not.toBe(a.ident?.id);
  expect(a.ident?.name).toMatch(/^Anónimo \d{4}$/);
  expect(b.ident?.name).toMatch(/^Anónimo \d{4}$/);
  expect(b.ident?.name).not.toBe(a.ident?.name);
  expect(a.setCookie).toMatch(/^canvas_anon=[^;]+; Path=\/_canvas\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  const e = await joined(wsUrl(pubArt.key, `?anon=${encodeURIComponent(USERS.user1.email)}`));
  expect(e.ident?.id).toMatch(/^anon:[A-Za-z0-9_-]{16}$/);
  expect(e.ident?.id).not.toContain('@');
  expect(e.ident?.name).toMatch(/^Anónimo \d{4}$/);
  // the same visitor (its server cookie) keeps its pseudonym in another tab, whatever it hints
  const a2 = await joined(wsUrl(pubArt.key, '?anon=9999'), { cookie: a.setCookie!.split(';')[0] });
  expect(a2.ident?.id).toBe(a.ident?.id);
  // a tampered cookie is a new visitor: it cannot take a's pseudonym
  const tampered = a.setCookie!.split(';')[0].replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  const t = await joined(wsUrl(pubArt.key, `?anon=${a.ident!.name.slice('Anónimo '.length)}`), { cookie: tampered });
  expect(t.ident?.id).not.toBe(a.ident?.id);
  expect(t.ident?.name).not.toBe(a.ident?.name);
  console.log(`[adv] anon ids: a=${a.ident?.id} b=${b.ident?.id} email-hint=${e.ident?.id} a-tab2=${a2.ident?.id} tampered=${t.ident?.id}`);
  for (const c of [a, b, e, a2, t]) c.close();
});
