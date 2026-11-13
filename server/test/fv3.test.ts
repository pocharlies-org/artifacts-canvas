/**
 * Regressions of the third independent verification (fv3), through the real server. Each
 * case is the verifier's PoC (fv3.test.ts) with the expectation turned around: the attack is
 * refused, the LEDGER (attribution/users/history, a separate Y.Doc) does not change by a
 * single byte, and honest users keep working.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { loadConfig, type Config } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { createLogger } from '../src/logging.js';
import { canvasLedgerKey, canvasObjectKey } from '../src/paths.js';
import { startFakeCore, allowUser, allowAnon, type FakeCore } from './helpers/fakecore.js';
import { TEST_ORIGIN, TestClient, expectClose, waitFor, roomDocs } from './helpers/yclient.js';
import { checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { encodeLedger } from '@pocharlies/artifacts-canvas-shared/protocol';

let core: FakeCore;
let staticDir: string;
let store: MemoryCanvasObjectStore;
let portSeq = 24100;
const apps: App[] = [];
const silent = createLogger('silent');

function cfgFor(port: number): Config {
  return loadConfig({
    GATE_AUTHZ_URL: core.authzUrl, ARTIFACT_BASE_URL: core.artifactBaseUrl, S3_BUCKET: 'canvas-test',
    STATIC_DIR: staticDir, LOG_LEVEL: 'silent', AUTHZ_RECHECK_SECONDS: '30', SAVE_DEBOUNCE_MS: '50',
    READYZ_CACHE_MS: '10', PORT: String(port), ALLOWED_ORIGINS: TEST_ORIGIN, METRICS_PORT: '0',
  });
}
async function startApp(): Promise<App> {
  for (;;) {
    const app = createApp({ config: cfgFor(++portSeq), store, logger: silent });
    try {
      await app.listen();
    } catch (e) {
      await app.close().catch(() => undefined);
      if (String(e).includes('EADDRINUSE')) continue;
      throw e;
    }
    apps.push(app);
    return app;
  }
}
async function startOnPort(port: number): Promise<App> {
  const app = createApp({ config: cfgFor(port), store, logger: silent });
  await app.listen();
  apps.push(app);
  return app;
}
const base = (app: App) => `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/_canvas/_/ws`;
const msg = (u: Uint8Array) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, u);
  return encoding.toUint8Array(e);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shape = (f: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(f)) m.set(k, v);
  return m;
};
/** The ledger's exact bytes (state vector + full encoding) for "not a single byte changed". */
const ledgerBytes = async (app: App, key: string) => {
  const l = (await roomDocs(app, key))!.ledger;
  return { sv: Buffer.from(Y.encodeStateVector(l)).toString('hex'), all: Buffer.from(Y.encodeStateAsUpdate(l)).toString('hex') };
};

beforeAll(async () => {
  core = await startFakeCore();
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv3-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>c</title>');
});
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await core.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});
beforeEach(() => {
  store = new MemoryCanvasObjectStore();
  core.rules.clear();
  core.rulesByCookie.clear();
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

function users(key: string) {
  core.rules.set(key, allowUser('ana@corp', 'Ana'));
  core.rulesByCookie.set(`sid=bob|${key}`, allowUser('bob@corp', 'Bob'));
}

/** `ws` with the allowed Origin header, shaped like the browser WebSocket for y-websocket. */
class OriginWs extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { headers: { origin: TEST_ORIGIN } });
  }
}
/** The stock browser client (y-websocket) plus the LEDGER handler the canvas client adds. */
function provider(app: App, key: string, doc: Y.Doc, ledger = new Y.Doc()) {
  const prov = new WebsocketProvider(base(app), key, doc, { WebSocketPolyfill: OriginWs as never, disableBc: true, maxBackoffTime: 300 });
  prov.messageHandlers[102] = (_e: encoding.Encoder, dec: decoding.Decoder) => {
    Y.applyUpdate(ledger, decoding.readVarUint8Array(dec), 'server');
  };
  return { prov, ledger };
}

/** Re-encode an update's structs (one block per client, clock order) with an empty delete set. */
function structsOnly(update: Uint8Array): Uint8Array {
  const { structs } = Y.decodeUpdate(update) as { structs: (Y.Item | Y.GC)[] };
  const by = new Map<number, (Y.Item | Y.GC)[]>();
  for (const st of structs) {
    if (!by.has(st.id.client)) by.set(st.id.client, []);
    by.get(st.id.client)!.push(st);
  }
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, by.size);
  for (const [client, arr] of by) {
    encoding.writeVarUint(enc.restEncoder, arr.length);
    enc.writeClient(client);
    encoding.writeVarUint(enc.restEncoder, arr[0].id.clock);
    for (const st of arr) st.write(enc, 0);
  }
  encoding.writeVarUint(enc.restEncoder, 0);
  return enc.toUint8Array();
}

/** zero-length ContentAny items (one per target), all at clock `clock` of `client` */
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

describe('fv3 HIGH: zero-length structs (Z1) cannot touch the ledger', () => {
  it('Z1 zero-length items on attribution/users ids and on a live shape entry: 4403, ledger byte-identical, room healthy', async () => {
    const key = 'runs/z1.html';
    users(key);
    const app = await startApp();
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    ana.doc.transact(() => ana.doc.getMap('shapes').set('s1', shape({ type: 'geo', geo: 'rectangle', x: 10, y: 10, w: 50, h: 50 })));
    await waitFor(async () => ana.ledger.getMap('attribution').has('s1'), 3000, 'stamped');
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.ledger.getMap('attribution').has('s1'), 3000, 'bob has the ledger');
    const before = await ledgerBytes(app, key);
    const attrItem = (bob.ledger.getMap('attribution') as unknown as { _map: Map<string, Y.Item> })._map.get('s1')!.id;
    const userItem = (bob.ledger.getMap('users') as unknown as { _map: Map<string, Y.Item> })._map.get('ana@corp')!.id;
    const shapeItem = (bob.doc.getMap('shapes') as unknown as { _map: Map<string, Y.Item> })._map.get('s1')!.id;
    const c0 = Y.getState(bob.doc.store, bob.doc.clientID);
    // the verifier's attack (ledger ids), and the same trick on the content document (the shape)
    for (const targets of [[attrItem, userItem], [shapeItem]]) {
      const evil = new TestClient(`${base(app)}/${key}`, 'sid=bob');
      await evil.connect();
      expect(checkClientUpdate((await roomDocs(app, key))!.doc, zeroLen(bob.doc.clientID, c0, targets)).bad).toBe('malformed');
      evil.sendRaw(msg(zeroLen(evil.doc.clientID, Y.getState(evil.doc.store, evil.doc.clientID), targets)));
      await expectClose(evil, 4403);
    }
    await sleep(100);
    expect(await ledgerBytes(app, key)).toEqual(before);
    expect(ana.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'ana@corp' });
    expect((await roomDocs(app, key))!.doc.getMap('shapes').has('s1')).toBe(true);
    // bob moving the shape is just an update: ana stays the creator
    bob.doc.transact(() => (bob.doc.getMap('shapes').get('s1') as Y.Map<unknown>).set('x', 11));
    await waitFor(async () => ((await roomDocs(app, key))!.ledger.getMap('attribution').get('s1') as { updatedBy?: string })?.updatedBy === 'bob@corp', 3000, 'bob stamped');
    expect((await roomDocs(app, key))!.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'ana@corp', updatedBy: 'bob@corp' });
    // the room still encodes, saves and loads; a new joiner gets everything
    await app.manager.get(key)!.flush();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, store.objects.get(canvasLedgerKey('_plugins/canvas', key))!.body);
    expect(stored.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'ana@corp' });
    const carl = new TestClient(`${base(app)}/${key}`);
    await carl.connect();
    await waitFor(async () => carl.ledger.getMap('attribution').has('s1') && carl.doc.getMap('shapes').has('s1'), 3000, 'carl synced');
    expect(carl.identity).toBeTruthy();
    for (const c of [ana, bob, carl]) c.close();
  });
});

describe('fv3: no client byte ever reaches the ledger', () => {
  it('a LEDGER (102) message from a client closes 4403 and changes nothing', async () => {
    const key = 'runs/l1.html';
    users(key);
    const app = await startApp();
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    ana.doc.transact(() => ana.doc.getMap('shapes').set('s1', shape({ type: 'geo' })));
    await waitFor(async () => ana.ledger.getMap('attribution').has('s1'), 3000, 'stamped');
    const before = await ledgerBytes(app, key);
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.ledger.getMap('attribution').has('s1'), 3000, 'bob synced');
    // the most "valid" forgery there is: a real update of bob's own copy of the ledger
    const sv = Y.encodeStateVector(bob.ledger);
    bob.ledger.getMap('attribution').set('s1', { createdBy: 'bob@corp', createdAt: 1, updatedBy: 'bob@corp', updatedAt: 1 });
    bob.sendRaw(encodeLedger(Y.encodeStateAsUpdate(bob.ledger, sv)));
    await expectClose(bob, 4403);
    await sleep(100);
    expect(await ledgerBytes(app, key)).toEqual(before);
    expect(ana.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'ana@corp' });
    ana.close();
  });
});

describe('fv3 P1: a throw while applying never leaves the room pending (room-wide DoS)', () => {
  it('P1 known struct with a missing origin + a zero-length delete range: 4403; the room stays writable', async () => {
    const key = 'runs/p1.html';
    users(key);
    const app = await startApp();
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    ana.doc.transact(() => ana.doc.getMap('shapes').set('s1', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => ana.ledger.getArray('history').length === 1, 3000, 'stamped');
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.ledger.getArray('history').length === 1, 3000, 'bob synced');
    const S = ((bob.ledger.getArray('history') as unknown as { _start: Y.Item })._start).id.client;
    const NS = Y.getState(bob.ledger.store, S);
    const A = ana.doc.clientID;
    const craft = (withZeroDs: boolean, withKnown: boolean) => {
      const enc = new Y.UpdateEncoderV1();
      encoding.writeVarUint(enc.restEncoder, withKnown ? 1 : 0);
      if (withKnown) {
        encoding.writeVarUint(enc.restEncoder, 1);
        enc.writeClient(A);
        encoding.writeVarUint(enc.restEncoder, 0);
        new Y.Item(Y.createID(A, 0), null, Y.createID(S, NS + 5), null, null, null, null, new Y.ContentAny([1])).write(enc, 0);
      }
      encoding.writeVarUint(enc.restEncoder, withZeroDs ? 1 : 0);
      if (withZeroDs) {
        enc.resetDsCurVal();
        encoding.writeVarUint(enc.restEncoder, 4242);
        encoding.writeVarUint(enc.restEncoder, 1);
        enc.writeDsClock(7);
        enc.writeDsLen(0);
      }
      return enc.toUint8Array();
    };
    const roomDoc = (await roomDocs(app, key))!.doc;
    expect(checkClientUpdate(roomDoc, craft(true, true)).bad).not.toBeNull();
    expect(checkClientUpdate(roomDoc, craft(true, false)).bad).toBe('malformed'); // zero-length range
    expect(checkClientUpdate(roomDoc, craft(false, true)).bad).toBe('pending'); // known struct, missing origin
    const before = await ledgerBytes(app, key);
    bob.sendRaw(msg(craft(true, true)));
    await expectClose(bob, 4403);
    const room = app.manager.get(key)!;
    expect((await room.hasPending())).toBe(false);
    // ana keeps working
    ana.doc.transact(() => ana.doc.getMap('shapes').set('s2', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').has('s2'), 3000, 'ana edit applied');
    expect(ana.closeCode).toBeNull();
    expect((await room.hasPending())).toBe(false);
    expect((await ledgerBytes(app, key)).sv).not.toEqual(before.sv); // only the stamper's line for s2
    expect(((await room.inspect()).ledger.getArray('history').toJSON() as { by: string; shapeId: string }[]).map((e) => `${e.by} ${e.shapeId}`)).toEqual(['ana@corp s1', 'ana@corp s2']);
    ana.close();
  });
});

describe('fv3 S1/S2/S3: content schema', () => {
  it('S1 a ContentDeleted overwrite of `type` on a victim shape is refused 4403 (the shape keeps its type)', async () => {
    const key = 'runs/s1.html';
    users(key);
    const app = await startApp();
    const ana = new TestClient(`${base(app)}/${key}`);
    await ana.connect();
    ana.doc.transact(() => ana.doc.getMap('shapes').set('v1', shape({ type: 'geo', geo: 'rectangle', x: 1, y: 1, w: 50, h: 50 })));
    await waitFor(async () => ana.ledger.getArray('history').length === 1, 3000, 'stamped');
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.doc.getMap('shapes').has('v1'), 3000, 'bob synced');
    const sv = Y.encodeStateVector(bob.doc);
    const evil = new Y.Doc();
    evil.clientID = 900001;
    Y.applyUpdate(evil, Y.encodeStateAsUpdate(bob.doc));
    const m = evil.getMap('shapes').get('v1') as Y.Map<unknown>;
    evil.transact(() => m.set('type', 'geo'));
    evil.transact(() => m.delete('type'));
    const upd = structsOnly(Y.encodeStateAsUpdate(evil, sv)); // same structs, EMPTY delete set
    const kinds = Y.decodeUpdate(upd).structs.map((x) => (x as Y.Item).content?.constructor?.name);
    expect(kinds).toContain('ContentDeleted');
    expect(checkClientUpdate((await roomDocs(app, key))!.doc, upd).bad).toBe('shapes-schema');
    bob.sendRaw(msg(upd));
    await expectClose(bob, 4403);
    expect((ana.doc.getMap('shapes').get('v1') as Y.Map<unknown>).get('type')).toBe('geo');
    expect(((await roomDocs(app, key))!.doc.getMap('shapes').get('v1') as Y.Map<unknown>).get('type')).toBe('geo');
    ana.close();
  });

  it('S2/S3 enum strings, a `__proto__` field or id, oversized points: each closes 4403, nothing reaches the room', async () => {
    const key = 'pub/s2.html';
    core.rules.set(key, allowAnon());
    const app = await startApp();
    const cases: [string, (s: Y.Map<unknown>) => void][] = [
      ['note color zzz', (s) => s.set('n1', shape({ type: 'note', color: 'zzz', x: 10, y: 10, w: 100, h: 100, text: 'x' }))],
      ['text font zzz', (s) => s.set('t1', shape({ type: 'text', font: 'zzz', x: 10, y: 200, w: 100, h: 20, text: 'x' }))],
      ['geo fill zzz', (s) => s.set('g1', shape({ type: 'geo', geo: 'rectangle', fill: 'zzz' }))],
      ['size zzz', (s) => s.set('g2', shape({ type: 'geo', geo: 'rectangle', size: 'zzz' }))],
      ['dash zzz', (s) => s.set('g3', shape({ type: 'geo', geo: 'rectangle', dash: 'zzz' }))],
      ['arrowheads zzz', (s) => s.set('a1', shape({ type: 'arrow', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, arrowheads: 'zzz' }))],
      ['color __proto__', (s) => s.set('n2', shape({ type: 'note', color: '__proto__' }))],
      ['__proto__ field', (s) => {
        const m = shape({ type: 'draw', x: 0, y: 0, w: 10, h: 10 });
        m.set('__proto__', { points: { length: 3e8 }, ow: 0, done: false });
        s.set('p1', m);
      }],
      ['__proto__ field on an existing shape', (s) => (s.get('near') as Y.Map<unknown>).set('__proto__', { text: 12345 })],
      ['constructor field', (s) => s.set('p2', shape({ type: 'draw', constructor: 1 }))],
      ['__proto__ shape id', (s) => s.set('__proto__', shape({ type: 'geo' }))],
      ['prototype shape id', (s) => s.set('prototype', shape({ type: 'geo' }))],
      ['terminal with __proto__', (s) => s.set('a2', shape({ type: 'arrow', start: JSON.parse('{"x":0,"y":0,"__proto__":{"bind":{"shapeId":"x","nx":0,"ny":0}}}'), end: { x: 1, y: 1 } }))],
      ['unknown field with polluted JSON', (s) => s.set('u1', shape({ type: 'geo', future: JSON.parse('{"__proto__":{"x":1}}') }))],
      ['points over the cap', (s) => {
        const m = shape({ type: 'draw' });
        const p = new Y.Array<number>();
        m.set('points', p);
        s.set('big', m);
        p.push(new Array(300_001).fill(1));
      }],
    ];
    // a shape near the cap that a later append pushes over it
    const seed = new TestClient(`${base(app)}/${key}`);
    await seed.connect();
    seed.doc.transact(() => {
      const m = shape({ type: 'draw' });
      const p = new Y.Array<number>();
      m.set('points', p);
      seed.doc.getMap('shapes').set('near', m);
      p.push(new Array(299_990).fill(1));
    });
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('near'), 5000, 'near cap stored');
    cases.push(['append past the cap', (s) => ((s.get('near') as Y.Map<unknown>).get('points') as Y.Array<number>).push(new Array(20).fill(2))]);
    for (const [name, fn] of cases) {
      const c = new TestClient(`${base(app)}/${key}`);
      await c.connect();
      await waitFor(async () => c.doc.getMap('shapes').has('near'), 5000, 'synced');
      c.doc.transact(() => fn(c.doc.getMap('shapes')));
      await expectClose(c, 4403).catch((e) => {
        throw new Error(`${name}: ${e}`);
      });
    }
    await sleep(100);
    const room = app.manager.get(key)!;
    expect([...(await room.inspect()).doc.getMap('shapes').keys()]).toEqual(['near']);
    expect((((await room.inspect()).doc.getMap('shapes').get('near') as Y.Map<unknown>).get('points') as Y.Array<number>).length).toBe(299_990);
    // legitimate shapes with every enum value still go through
    seed.doc.transact(() => {
      seed.doc.getMap('shapes').set('ok', shape({ type: 'note', color: 'light-blue', fill: 'pattern', dash: 'dotted', size: 'xl', font: 'mono', arrowheads: 'both', opacity: 0.5, text: 'ok' }));
    });
    await waitFor(async () => (await room.inspect()).doc.getMap('shapes').has('ok'), 3000, 'good shape');
    expect(seed.closeCode).toBeNull();
    seed.close();
  });
});

describe('fv3 O: client-id ownership survives a room reload', () => {
  it('O1 an awareness claim of the victim id after a reload neither kicks the victim nor binds the id', async () => {
    const key = 'runs/o1.html';
    users(key);
    const app = await startApp();
    const victimDoc = new Y.Doc();
    const { prov } = provider(app, key, victimDoc);
    await waitFor(async () => prov.synced, 3000, 'victim synced');
    victimDoc.transact(() => victimDoc.getMap('shapes').set('v1', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('v1'), 3000, 'v1 stored');
    const V = victimDoc.clientID;
    prov.disconnect();
    await waitFor(async () => !app.manager.get(key), 3000, 'room unloaded');
    // the binding is persisted with the room (ledger object), so it is back after the reload
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    expect((await roomDocs(app, key))!.ledger.getMap('writers').get(String(V))).toBe('ana@corp');
    const aw = new awarenessProtocol.Awareness(new Y.Doc());
    (aw as unknown as { clientID: number }).clientID = V;
    for (let i = 0; i < 3; i++) aw.setLocalState({ cursor: { x: i, y: i } });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(aw, [V]));
    bob.sendRaw(encoding.toUint8Array(e));
    await sleep(200);
    expect(app.manager.get(key)!.awareness.getStates().has(V)).toBe(false); // the claim was dropped
    let closed: { code: number } | null = null;
    prov.on('closed', (ev: { code: number }) => (closed = ev));
    prov.connect();
    await waitFor(async () => prov.synced, 3000, 'victim re-synced');
    victimDoc.transact(() => victimDoc.getMap('shapes').set('v2', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('v2'), 3000, 'v2 applied');
    expect(closed).toBeNull();
    expect((await roomDocs(app, key))!.ledger.getMap('attribution').get('v2')).toMatchObject({ createdBy: 'ana@corp' });
    prov.destroy();
    bob.close();
  });

  it('O2 (negative) a doc write at the victim id after a reload is refused 4403; the victim edit still lands', async () => {
    const key = 'runs/o2.html';
    users(key);
    const app = await startApp();
    const victimDoc = new Y.Doc();
    const { prov } = provider(app, key, victimDoc);
    await waitFor(async () => prov.synced, 3000);
    victimDoc.transact(() => victimDoc.getMap('shapes').set('v1', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('v1'), 3000, 'v1 stored');
    const V = victimDoc.clientID;
    prov.disconnect();
    await waitFor(async () => !app.manager.get(key), 3000, 'room unloaded');
    const bob = new TestClient(`${base(app)}/${key}`, 'sid=bob');
    await bob.connect();
    await waitFor(async () => bob.doc.getMap('shapes').has('v1'), 3000, 'bob synced');
    const sv = Y.encodeStateVector(bob.doc);
    const evil = new Y.Doc();
    Y.applyUpdate(evil, Y.encodeStateAsUpdate(bob.doc));
    evil.clientID = V;
    evil.transact(() => evil.getMap('shapes').set('bob-as-victim', shape({ type: 'geo', geo: 'rectangle' })));
    bob.sendRaw(msg(Y.encodeStateAsUpdate(evil, sv)));
    await expectClose(bob, 4403);
    expect((await roomDocs(app, key))?.doc.getMap('shapes').has('bob-as-victim') ?? false).toBe(false);
    prov.connect();
    await waitFor(async () => prov.synced, 3000);
    victimDoc.transact(() => victimDoc.getMap('shapes').set('v2', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('v2'), 3000, 'v2 applied');
    prov.destroy();
  });
});

describe('fv3 F: edits made while disconnected are delivered', () => {
  it('F1 a stock y-websocket client that draws during a server restart gets its offline shape and its next shape in', async () => {
    const key = 'runs/f1.html';
    users(key);
    let app = await startApp();
    const port = (app.server.address() as { port: number }).port;
    const doc = new Y.Doc();
    const { prov, ledger } = provider(app, key, doc);
    await waitFor(async () => prov.synced, 3000);
    doc.transact(() => doc.getMap('shapes').set('a', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('a'), 3000, 'a applied');
    let gotClose = false;
    prov.on('connection-close', () => (gotClose = true));
    await app.close(); // a deploy: same port, same store (the close flushes the room)
    apps.splice(apps.indexOf(app), 1);
    await waitFor(async () => gotClose && !prov.wsconnected, 3000, 'client saw the restart');
    for (const id of ['offline1', 'offline2', 'offline3']) doc.transact(() => doc.getMap('shapes').set(id, shape({ type: 'geo', geo: 'rectangle' })));
    app = await startOnPort(port);
    let closed: { code: number } | null = null;
    prov.on('closed', (ev: { code: number }) => (closed = ev));
    await waitFor(async () => prov.wsconnected && prov.synced, 5000, 're-synced');
    await waitFor(async () => await (async () => { const d = (await roomDocs(app, key))?.doc; return ['offline1', 'offline2', 'offline3'].every((id) => !!d?.getMap('shapes').has(id)); })(), 3000, 'offline shapes delivered');
    doc.transact(() => doc.getMap('shapes').set('after', shape({ type: 'geo', geo: 'rectangle' })));
    await waitFor(async () => !!(await roomDocs(app, key))?.doc.getMap('shapes').has('after'), 3000, 'after applied');
    expect(closed).toBeNull();
    await waitFor(async () => ledger.getMap('attribution').has('offline3'), 3000, 'ledger back on the client');
    expect(ledger.getMap('attribution').get('offline1')).toMatchObject({ createdBy: 'ana@corp' });
    // persisted: content + ledger objects
    await app.manager.get(key)!.flush();
    const saved = new Y.Doc();
    Y.applyUpdate(saved, store.objects.get(canvasObjectKey('_plugins/canvas', key))!.body);
    expect([...saved.getMap('shapes').keys()].sort()).toEqual(['a', 'after', 'offline1', 'offline2', 'offline3']);
    prov.destroy();
  });
});
