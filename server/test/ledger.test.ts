/**
 * The two trust domains of a room (protocol §5-§8): the CONTENT document (clients write it,
 * through the guard) and the LEDGER document (attribution/users/history/writers, written by
 * the stamper only). Unit level: the stamper, the guard rules added after the third
 * verification (zero-length structs and delete ranges, dependencies of known structs,
 * ContentDeleted at a field key, style enums, forbidden keys, capped points), the
 * apply-with-cleanup, persistence as two objects, and the migration of a stored single-doc
 * canvas.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import {
  applyGuarded,
  attachStamper,
  checkClientUpdate,
  forbiddenRootWrite,
  hasPending,
} from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger, migrateLegacyRoots } from '@pocharlies/artifacts-canvas-shared/ledger';
import { MAX_POINTS, plainJsonOk, shapeFieldProblem } from '@pocharlies/artifacts-canvas-shared/model';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { Metrics } from '../src/metrics.js';
import { MemoryCanvasObjectStore } from '../src/store.js';
import { RoomManager } from '../src/rooms.js';
import { canvasLedgerKey, canvasObjectKey, artifactKeyFromObject } from '../src/paths.js';
import type { AuthzClient } from '../src/authz.js';

const ALICE = { id: 'user:alice', info: { name: 'Alice', anonymous: false } };
const MALLORY = { id: 'anon:mallory', info: { name: 'Anónimo 6666', anonymous: true } };

function room() {
  const content = materializeContent(new Y.Doc());
  const ledger = materializeLedger(new Y.Doc());
  attachStamper(content, ledger, { userOf: (o) => (o === 'alice' ? ALICE : o === 'mallory' ? MALLORY : null) });
  /** the server path of ws.ts: guard, then apply with cleanup */
  const send = (who: string, u: Uint8Array): string | null => {
    const bad = forbiddenRootWrite(content, u);
    if (bad) return bad;
    const out = applyGuarded(content, u, who);
    return out.threw ? 'threw' : out.droppedPending ? 'dropped' : null;
  };
  const ledgerHex = () => Buffer.from(Y.encodeStateAsUpdate(ledger)).toString('hex');
  return { content, ledger, send, ledgerHex };
}

function geo(client: number, id: string, extra: Record<string, unknown> = {}): Uint8Array {
  const d = new Y.Doc();
  d.clientID = client;
  d.transact(() => {
    const m = new Y.Map<unknown>();
    d.getMap('shapes').set(id, m);
    for (const [k, v] of Object.entries({ type: 'geo', geo: 'rectangle', x: 10, ...extra })) m.set(k, v);
  });
  return Y.encodeStateAsUpdate(d);
}

function edit(content: Y.Doc, client: number, fn: (d: Y.Doc) => void): Uint8Array {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(content));
  d.clientID = client;
  const sv = Y.encodeStateVector(d);
  fn(d);
  return Y.encodeStateAsUpdate(d, sv);
}

/** raw v1 update: one client block of `items`, then an optional delete set */
function rawUpdate(client: number, clock: number, items: Y.Item[], ds: [number, number, number][] = []): Uint8Array {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, items.length ? 1 : 0);
  if (items.length) {
    encoding.writeVarUint(enc.restEncoder, items.length);
    enc.writeClient(client);
    encoding.writeVarUint(enc.restEncoder, clock);
    for (const it of items) it.write(enc, 0);
  }
  encoding.writeVarUint(enc.restEncoder, ds.length);
  for (const [c, k, len] of ds) {
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, c);
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeDsClock(k);
    enc.writeDsLen(len);
  }
  return enc.toUint8Array();
}

describe('stamper: content in, ledger out', () => {
  it('stamps the ledger only; the content document has no ledger root', () => {
    const r = room();
    expect(r.send('alice', geo(1001, 's1'))).toBeNull();
    expect(r.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'user:alice' });
    expect(r.ledger.getMap('users').get('user:alice')).toMatchObject({ name: 'Alice' });
    expect(r.ledger.getArray('history').length).toBe(1);
    expect([...r.content.share.keys()].sort()).toEqual(['assets', 'meta', 'shapes']);
    // the ledger holds only the stamper's own structs
    expect([...r.ledger.store.clients.keys()]).toEqual([r.ledger.clientID]);
  });

  it('refuses one document for both roles', () => {
    const d = new Y.Doc();
    expect(() => attachStamper(d, d, { userOf: () => null })).toThrow(/separate/);
  });
});

describe('zerolen.mjs (fv3 HIGH): zero-length structs', () => {
  it('the PoC (zero-length items on attribution/users ids) is refused and the ledger stays byte-identical', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const before = r.ledgerHex();
    const target = (r.ledger.getMap('attribution') as unknown as { _map: Map<string, Y.Item> })._map.get('s1')!.id;
    const usersTarget = (r.ledger.getMap('users') as unknown as { _map: Map<string, Y.Item> })._map.get('user:alice')!.id;
    const u = rawUpdate(6666, 0, [
      new Y.Item(Y.createID(6666, 0), null, target, null, null, null, null, new Y.ContentAny([])),
      new Y.Item(Y.createID(6666, 0), null, usersTarget, null, null, null, null, new Y.ContentAny([])),
    ]);
    expect(r.send('mallory', u)).toBe('malformed');
    // mallory moves the shape: a real edit, attributed to mallory as an UPDATE, alice stays the author
    expect(r.send('mallory', edit(r.content, 6667, (d) => (d.getMap('shapes').get('s1') as Y.Map<unknown>).set('x', 11)))).toBeNull();
    expect(r.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'user:alice', updatedBy: 'anon:mallory' });
    expect(before).not.toEqual(r.ledgerHex()); // only the stamper changed it
    const re = new Y.Doc();
    Y.applyUpdate(re, Y.encodeStateAsUpdate(r.ledger));
    expect((re.getMap('attribution').get('s1') as { createdBy: string }).createdBy).toBe('user:alice');
  });

  it('a zero-length item over a live shape entry (would erase the shape and brick encoding) is refused', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const shapeItem = (r.content.getMap('shapes') as unknown as { _map: Map<string, Y.Item> })._map.get('s1')!.id;
    for (const content of [new Y.ContentAny([]), new Y.ContentString(''), new Y.ContentJSON([])]) {
      const u = rawUpdate(7777, 0, [new Y.Item(Y.createID(7777, 0), null, shapeItem, null, null, null, null, content)]);
      expect(r.send('mallory', u)).toBe('malformed');
    }
    expect(r.content.getMap('shapes').has('s1')).toBe(true);
    expect(() => Y.encodeStateAsUpdate(r.content)).not.toThrow();
  });

  it('zero-length delete ranges are refused (Yjs throws re-encoding them)', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    expect(r.send('mallory', rawUpdate(0, 0, [], [[4242, 7, 0]]))).toBe('malformed');
    expect(r.send('mallory', rawUpdate(0, 0, [], [[1001, 0, 0]]))).toBe('malformed');
    expect(hasPending(r.content)).toBe(false);
  });
});

describe('dependencies of KNOWN structs (fv3 P1)', () => {
  it('a copy of a known struct whose origin the room lacks is pending; one whose same-client origin is missing is malformed', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const L = r.ledger.clientID;
    const futureOrigin = new Y.Item(Y.createID(1001, 0), null, Y.createID(L, 99), null, null, null, null, new Y.ContentAny([1]));
    expect(checkClientUpdate(r.content, rawUpdate(1001, 0, [futureOrigin])).bad).toBe('pending');
    const sameClient = new Y.Item(Y.createID(1001, 0), null, Y.createID(1001, 500), null, null, null, null, new Y.ContentAny([1]));
    expect(checkClientUpdate(r.content, rawUpdate(1001, 0, [sameClient])).bad).toBe('malformed');
    // a known struct whose dependencies exist is harmless (Yjs skips it)
    const fine = new Y.Item(Y.createID(1001, 0), null, null, null, null, 'shapes', 's1', new Y.ContentAny([1]));
    expect(checkClientUpdate(r.content, rawUpdate(1001, 0, [fine])).bad).toBeNull();
  });

  it('applyGuarded: whatever Yjs does with an update (even throw), the room is left without pending state', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const L = r.ledger.clientID;
    // the verifier's P1 update, applied WITHOUT the guard on purpose
    const p1 = rawUpdate(1001, 0, [new Y.Item(Y.createID(1001, 0), null, Y.createID(L, 5), null, null, null, null, new Y.ContentAny([1]))], [[4242, 7, 0]]);
    const out = applyGuarded(r.content, p1, 'mallory');
    expect(out.threw !== null || out.droppedPending).toBe(true);
    expect(hasPending(r.content)).toBe(false);
    // the room keeps working for everyone
    expect(r.send('alice', geo(1002, 's2'))).toBeNull();
    expect(r.content.getMap('shapes').has('s2')).toBe(true);
    expect(() => Y.encodeStateAsUpdate(r.content)).not.toThrow();
  });
});

describe('found by the ledger fuzzer (test/fuzz/guard-fuzz.ts)', () => {
  it('an origin/rightOrigin cycle across two clients is refused at once (it hung the old guard: 2^64 calls)', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const s1001 = Y.getState(r.content.store, 1001);
    const enc = new Y.UpdateEncoderV1();
    encoding.writeVarUint(enc.restEncoder, 2);
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeClient(778);
    encoding.writeVarUint(enc.restEncoder, 0);
    new Y.Item(Y.createID(778, 0), null, Y.createID(1001, s1001), null, Y.createID(1001, s1001), null, null, new Y.ContentAny([1])).write(enc, 0);
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeClient(1001);
    encoding.writeVarUint(enc.restEncoder, s1001);
    new Y.Item(Y.createID(1001, s1001), null, Y.createID(778, 0), null, Y.createID(778, 0), null, null, new Y.ContentAny([1])).write(enc, 0);
    encoding.writeVarUint(enc.restEncoder, 0);
    const t0 = performance.now();
    expect(checkClientUpdate(r.content, enc.toUint8Array()).bad).toBe('pending');
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('a client in two struct blocks (Yjs keeps only the last) is malformed', () => {
    const r = room();
    const a = new Y.Doc();
    a.clientID = 5000;
    const parts: Uint8Array[] = [];
    for (const id of ['k0', 'k1']) {
      const sv = Y.encodeStateVector(a);
      a.transact(() => {
        const m = new Y.Map<unknown>();
        a.getMap('shapes').set(id, m);
        m.set('type', 'geo');
      });
      parts.push(Y.encodeStateAsUpdate(a, sv));
    }
    // splice the two single-client updates into one update with two blocks for client 5000
    const blocks = parts.map((u) => {
      const d = Y.decodeUpdate(u).structs as Y.Item[];
      return d;
    });
    const enc = new Y.UpdateEncoderV1();
    encoding.writeVarUint(enc.restEncoder, 2);
    for (const b of blocks) {
      encoding.writeVarUint(enc.restEncoder, b.length);
      enc.writeClient(5000);
      encoding.writeVarUint(enc.restEncoder, b[0].id.clock);
      for (const it of b) it.write(enc, 0);
    }
    encoding.writeVarUint(enc.restEncoder, 0);
    expect(checkClientUpdate(r.content, enc.toUint8Array()).bad).toBe('malformed');
    expect(checkClientUpdate(r.content, Y.mergeUpdates(parts)).bad).toBeNull();
  });

  it('a fresh `type` value deleted in the same update (the shape would lose its type) is refused', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const u = edit(r.content, 9001, (d) => {
      const m = d.getMap('shapes').get('s1') as Y.Map<unknown>;
      m.set('type', 'note');
    });
    // add the new type item to the update's own delete set
    const dec = Y.decodeUpdate(u);
    const it = dec.structs[0] as Y.Item;
    const enc = new Y.UpdateEncoderV1();
    encoding.writeVarUint(enc.restEncoder, 1);
    encoding.writeVarUint(enc.restEncoder, dec.structs.length);
    enc.writeClient(9001);
    encoding.writeVarUint(enc.restEncoder, it.id.clock);
    for (const st of dec.structs as Y.Item[]) st.write(enc, 0);
    const old = [...dec.ds.clients.entries()];
    encoding.writeVarUint(enc.restEncoder, old.length + 1);
    for (const [c, ranges] of old) {
      enc.resetDsCurVal();
      encoding.writeVarUint(enc.restEncoder, c);
      encoding.writeVarUint(enc.restEncoder, ranges.length);
      for (const rr of ranges) {
        enc.writeDsClock(rr.clock);
        enc.writeDsLen(rr.len);
      }
    }
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, 9001);
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeDsClock(it.id.clock);
    enc.writeDsLen(it.length);
    expect(checkClientUpdate(r.content, enc.toUint8Array()).bad).toBe('shapes-schema');
    expect(checkClientUpdate(r.content, u).bad).toBeNull(); // the plain type change is fine
  });

  it('a known struct whose same-client right origin is a later (new) clock is malformed (Yjs throws resolving it)', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const k = Y.getState(r.content.store, 1001);
    const known = new Y.Item(Y.createID(1001, k - 1), null, null, null, Y.createID(1001, k + 1), null, null, new Y.ContentAny([1]));
    const a = new Y.Item(Y.createID(1001, k), null, null, null, null, 'meta', 'x', new Y.ContentAny([1]));
    const b = new Y.Item(Y.createID(1001, k + 1), null, null, null, null, 'meta', 'y', new Y.ContentAny([1]));
    expect(checkClientUpdate(r.content, rawUpdate(1001, k - 1, [known, a, b])).bad).toBe('malformed');
  });
});

describe('content schema (fv3 findings 3, 4, 8)', () => {
  it('S1: a ContentDeleted item at a live shape\'s `type` is refused; deleting other fields or the shape is fine', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    const typeItem = ((r.content.getMap('shapes').get('s1') as Y.Map<unknown>) as unknown as { _map: Map<string, Y.Item> })._map.get('type')!;
    const xItem = ((r.content.getMap('shapes').get('s1') as Y.Map<unknown>) as unknown as { _map: Map<string, Y.Item> })._map.get('x')!;
    const over = (target: Y.Item) => rawUpdate(8888, 0, [new Y.Item(Y.createID(8888, 0), null, target.lastId, null, null, null, null, new Y.ContentDeleted(1))]);
    expect(checkClientUpdate(r.content, over(typeItem)).bad).toBe('shapes-schema');
    expect(checkClientUpdate(r.content, over(xItem)).bad).toBeNull();
  });

  it('style enums come from the shared allow-lists', () => {
    for (const [k, good, bad] of [
      ['color', 'light-blue', 'zzz'], ['fill', 'pattern', 'zzz'], ['dash', 'draw', 'zzz'], ['size', 'xl', 'zzz'],
      ['font', 'mono', 'zzz'], ['arrowheads', 'dot', 'zzz'], ['color', 'black', '__proto__'], ['font', 'sans', 'constructor'],
    ] as const) {
      expect(shapeFieldProblem(k, good), `${k}=${good}`).toBeNull();
      expect(shapeFieldProblem(k, bad), `${k}=${bad}`).toBe(k);
    }
    const r = room();
    expect(r.send('mallory', geo(1001, 'n1', { type: 'note', color: 'zzz' }))).toBe('shapes-schema');
    expect(r.send('alice', geo(1002, 'n2', { type: 'note', color: 'red', fill: 'solid', dash: 'dashed', size: 's', font: 'serif', arrowheads: 'none' }))).toBeNull();
  });

  it('forbidden keys (__proto__, constructor, prototype) as shape ids, fields, asset ids, meta keys, JSON keys', () => {
    const r = room();
    r.send('alice', geo(1001, 's1'));
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      expect(r.send('mallory', geo(2000, k)), `id ${k}`).toBe('shapes-schema');
      expect(r.send('mallory', edit(r.content, 2001, (d) => (d.getMap('shapes').get('s1') as Y.Map<unknown>).set(k, 1))), `field ${k}`).toBe('shapes-schema');
      expect(r.send('mallory', edit(r.content, 2002, (d) => d.getMap('assets').set(k, 'data:x'))), `asset ${k}`).toBe('assets-schema');
      expect(r.send('mallory', edit(r.content, 2003, (d) => d.getMap('meta').set(k, 1))), `meta ${k}`).toBe('meta-schema');
    }
    expect(plainJsonOk(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toBe(false);
    expect(plainJsonOk({ a: [1, 'b', null, { c: true }] })).toBe(true);
    // a terminal decoded with a `__proto__` key inherits `bind`: refused
    const polluted = JSON.parse('{"x":0,"y":0,"__proto__":{"bind":{"shapeId":"s1","nx":0,"ny":0}}}');
    expect(shapeFieldProblem('start', polluted)).toBe('start');
    expect(shapeFieldProblem('start', { x: 0, y: 0, bind: { shapeId: 's1', nx: 0.5, ny: 0.5 } })).toBeNull();
    expect(shapeFieldProblem('start', { x: 0, y: 0, extra: 1 })).toBe('start');
    expect(r.content.getMap('shapes').size).toBe(1);
  });

  it('points are capped, also across appends', () => {
    const r = room();
    const d = new Y.Doc();
    d.clientID = 3001;
    let p!: Y.Array<number>;
    d.transact(() => {
      const m = new Y.Map<unknown>();
      d.getMap('shapes').set('pen', m);
      m.set('type', 'draw');
      p = new Y.Array<number>();
      m.set('points', p);
      p.push(new Array(MAX_POINTS - 3).fill(1));
    });
    expect(r.send('alice', Y.encodeStateAsUpdate(d))).toBeNull();
    const sv = Y.encodeStateVector(d);
    p.push([1, 2, 3]);
    const ok = Y.encodeStateAsUpdate(d, sv);
    const sv2 = Y.encodeStateVector(d);
    p.push([4]);
    const over = Y.encodeStateAsUpdate(d, sv2);
    expect(r.send('alice', ok)).toBeNull();
    expect(r.send('alice', over)).toBe('shapes-schema');
    expect(((r.content.getMap('shapes').get('pen') as Y.Map<unknown>).get('points') as Y.Array<number>).length).toBe(MAX_POINTS);
  });
});

describe('persistence: two objects, both expire together', () => {
  const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz', ARTIFACT_BASE_URL: 'http://core', S3_BUCKET: 'b', SAVE_DEBOUNCE_MS: '10' });
  const authzOf = (reason: (key: string) => string): AuthzClient =>
    ({ authorize: async (_c: string, key: string) => ({ allowed: reason(key) === 'ok', reason: reason(key) }) }) as unknown as AuthzClient;
  const manager = (store: MemoryCanvasObjectStore, authz = authzOf(() => 'ok')) =>
    new RoomManager({ cfg, store, authz, log: createLogger('silent'), metrics: new Metrics() });

  it('ledger object = `<key>.ydoc.ledger`: never the content object of another artifact', () => {
    expect(canvasObjectKey('_plugins/canvas', 'a/b.html')).toBe('_plugins/canvas/a/b.html.ydoc');
    expect(canvasLedgerKey('_plugins/canvas', 'a/b.html')).toBe('_plugins/canvas/a/b.html.ydoc.ledger');
    // the spelling `<key>.ledger.ydoc` would be the CONTENT object of artifact `<key>.ledger`
    expect(canvasObjectKey('_plugins/canvas', 'a/b.html.ledger')).not.toBe(canvasLedgerKey('_plugins/canvas', 'a/b.html'));
    expect(artifactKeyFromObject('_plugins/canvas', '_plugins/canvas/a/b.html.ydoc.ledger')).toBe('a/b.html');
    expect(artifactKeyFromObject('_plugins/canvas', '_plugins/canvas/a/b.html.ydoc')).toBe('a/b.html');
  });

  it('saves content + ledger with the ttl tag, reloads both, deletes both on expiry; the sweep sees a lone ledger', async () => {
    const store = new MemoryCanvasObjectStore();
    const m = manager(store);
    const r = await m.getOrCreate('runs/x.html', 7);
    r.doc.transact(() => r.doc.getMap('shapes').set('s', new Y.Map()), 'load'); // no stamping (no conn)
    r.ledger.transact(() => r.ledger.getMap('users').set('u', { name: 'U', anonymous: false }));
    r.markDirty();
    await r.flush();
    const ck = canvasObjectKey(cfg.canvasPrefix, 'runs/x.html');
    const lk = canvasLedgerKey(cfg.canvasPrefix, 'runs/x.html');
    expect(store.objects.get(ck)?.tagging).toBe('ttl=7');
    expect(store.objects.get(lk)?.tagging).toBe('ttl=7');
    m.rooms.clear();
    const again = await manager(store).getOrCreate('runs/x.html', 7);
    expect(again.ledger.getMap('users').get('u')).toMatchObject({ name: 'U' });
    expect(again.doc.getMap('shapes').has('s')).toBe(true);
    await manager(store).expireRoom('runs/x.html', 'expired');
    expect(store.objects.has(ck)).toBe(false);
    expect(store.objects.has(lk)).toBe(false);
    // an orphan ledger (its content object already gone) is swept too
    store.objects.set(canvasLedgerKey(cfg.canvasPrefix, 'runs/orphan.html'), { body: new Uint8Array([0, 0]) });
    const res = await manager(store, authzOf((k) => (k === 'runs/orphan.html' ? 'object-missing' : 'ok'))).sweep();
    expect(res).toEqual({ scanned: 1, deleted: 1 });
    expect(store.objects.size).toBe(0);
  });
});

describe('room loading races (found on the full system: duplicated history after a restart)', () => {
  const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz', ARTIFACT_BASE_URL: 'http://core', S3_BUCKET: 'b', SAVE_DEBOUNCE_MS: '10' });
  class SlowStore extends MemoryCanvasObjectStore {
    gate: Promise<void> = Promise.resolve();
    fail = false;
    override async get(k: string) {
      await this.gate;
      if (this.fail) throw new Error('s3 down');
      return super.get(k);
    }
  }
  const mk = (store: MemoryCanvasObjectStore) => new RoomManager({ cfg, store, authz: {} as AuthzClient, log: createLogger('silent'), metrics: new Metrics() });

  it('a second joiner waits for the first load: nobody ever sees (or writes into) an unloaded room', async () => {
    const store = new SlowStore();
    const ledger = materializeLedger(new Y.Doc());
    ledger.getArray('history').push([{ t: 1, by: 'user:alice', verb: 'create', shapeId: 's1', shapeType: 'geo' }]);
    store.objects.set(canvasLedgerKey(cfg.canvasPrefix, 'runs/r.html'), { body: Y.encodeStateAsUpdate(ledger) });
    let release!: () => void;
    store.gate = new Promise((r) => (release = r));
    const m = mk(store);
    const first = m.getOrCreate('runs/r.html', null);
    let secondDone = false;
    const second = m.getOrCreate('runs/r.html', null).then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false); // used to resolve at once, with the room still empty
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(b.ledger.getArray('history').length).toBe(1);
  });

  it('a failed load leaves no empty room behind; the next join loads again', async () => {
    const store = new SlowStore();
    store.fail = true;
    const m = mk(store);
    await expect(m.getOrCreate('runs/f.html', null)).rejects.toThrow(/s3 down/);
    expect(m.get('runs/f.html')).toBeUndefined();
    store.fail = false;
    await expect(m.getOrCreate('runs/f.html', null)).resolves.toBeTruthy();
  });

  it('after shutdown() no room is joined or created (a reconnect goes to the next process)', async () => {
    const m = mk(new MemoryCanvasObjectStore());
    await m.shutdown('shutdown');
    await expect(m.getOrCreate('runs/s.html', null)).rejects.toThrow(/shutting down/);
  });
});

describe('migration of a stored single-document canvas', () => {
  function legacyObject(): Uint8Array {
    // the pre-split server: shapes AND attribution/users/history in one document
    const d = new Y.Doc();
    d.clientID = 4444;
    d.transact(() => {
      const m = new Y.Map<unknown>();
      d.getMap('shapes').set('s1', m);
      m.set('type', 'geo');
      d.getMap('attribution').set('s1', { createdBy: 'user:alice', createdAt: 1, updatedBy: 'user:alice', updatedAt: 1 });
      d.getMap('users').set('user:alice', { name: 'Alice', anonymous: false });
      d.getArray('history').push([{ t: 1, by: 'user:alice', verb: 'create', shapeId: 's1', shapeType: 'geo' }]);
    });
    return Y.encodeStateAsUpdate(d);
  }

  it('migrateLegacyRoots moves the entries to the ledger and deletes them from the content', () => {
    const content = materializeContent(new Y.Doc());
    const ledger = materializeLedger(new Y.Doc());
    Y.applyUpdate(content, legacyObject(), 'load');
    expect(migrateLegacyRoots(content, ledger)).toBe(true);
    expect(ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'user:alice' });
    expect(ledger.getMap('users').get('user:alice')).toMatchObject({ name: 'Alice' });
    expect(ledger.getArray('history').toJSON()).toHaveLength(1);
    expect(content.getMap('attribution').size).toBe(0);
    expect(content.getMap('users').size).toBe(0);
    expect(content.getArray('history').length).toBe(0);
    expect(content.getMap('shapes').has('s1')).toBe(true);
    expect(migrateLegacyRoots(content, ledger)).toBe(false); // idempotent
  });

  it('the room splits it on load, saves both objects, and a reload finds nothing left to migrate', async () => {
    const store = new MemoryCanvasObjectStore();
    const ck = canvasObjectKey('_plugins/canvas', 'runs/old.html');
    const lk = canvasLedgerKey('_plugins/canvas', 'runs/old.html');
    store.objects.set(ck, { body: legacyObject() });
    const cfg = loadConfig({ GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz', ARTIFACT_BASE_URL: 'http://core', S3_BUCKET: 'b', SAVE_DEBOUNCE_MS: '10' });
    const metrics = new Metrics();
    const mk = () => new RoomManager({ cfg, store, authz: {} as AuthzClient, log: createLogger('silent'), metrics });
    const r = await mk().getOrCreate('runs/old.html', null);
    expect(r.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'user:alice' });
    await r.flush();
    expect(store.objects.has(lk)).toBe(true);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, store.objects.get(ck)!.body);
    expect(saved.getMap('attribution').size).toBe(0);
    expect(saved.getArray('history').length).toBe(0);
    expect(saved.getMap('shapes').has('s1')).toBe(true);
    const again = await mk().getOrCreate('runs/old.html', null);
    expect(again.ledger.getMap('attribution').get('s1')).toMatchObject({ createdBy: 'user:alice' });
    expect((await metrics.registry.getSingleMetric('canvas_legacy_migrations_total')!.get()).values[0].value).toBe(1);
  });
});
