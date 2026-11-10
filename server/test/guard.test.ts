import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { attachStamper, forbiddenRootWrite } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger } from '@pocharlies/artifacts-canvas-shared/ledger';

/**
 * Protocol §5.3 guard of the CONTENT document: a client may only write `shapes`, `assets`
 * and `meta`. The ledger (attribution/users/history) is a separate Y.Doc the server never
 * applies a client byte to, so these cases check two things: a client cannot even create a
 * ledger-named root in the content document, and a content document from before the split
 * (`legacyRoom`: the old stamper roots still live in it) refuses every write to those roots.
 * They cover every way a Yjs update can reach a root: items that carry their parent, items
 * that only carry a left/right origin (Yjs omits `parent` for them), nested types,
 * deletions, deletions of items the room does not have yet, and missing dependencies.
 */

/** A prelim shape Y.Map with these fields (inserted together with the map). */
function shapeMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

/** The update a client would send for `fn`, starting from the room state. */
function clientUpdate(room: Y.Doc, fn: (d: Y.Doc) => void): Uint8Array {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(room));
  const sv = Y.encodeStateVector(c);
  fn(c);
  return Y.encodeStateAsUpdate(c, sv);
}

const ANA = { id: 'ana@corp', info: { name: 'Ana', anonymous: false, color: '#123456' } };

/** A room as the server keeps it (content returned; its ledger in `ledgerOf`): two shapes by "ana". */
const LEDGERS = new WeakMap<Y.Doc, Y.Doc>();
function seededRoom(): Y.Doc {
  const room = materializeContent(new Y.Doc());
  const ledger = materializeLedger(new Y.Doc());
  LEDGERS.set(room, ledger);
  attachStamper(room, ledger, { userOf: (o) => (o === 'ana' ? ANA : null) });
  seedShapes(room);
  expect(ledger.getArray('history').length).toBe(2);
  expect(ledger.getMap('attribution').size).toBe(2);
  expect([...room.share.keys()].sort()).toEqual(['assets', 'meta', 'shapes']);
  return room;
}

/**
 * A content document stored BEFORE the split: the old stamper wrote attribution/users/history
 * into it (client 4444). The room migrates such a document on load; the guard must refuse
 * any write to those roots in any state of it.
 */
function legacyRoom(): Y.Doc {
  const room = materializeContent(new Y.Doc());
  seedShapes(room);
  const old = new Y.Doc();
  old.clientID = 4444;
  Y.applyUpdate(old, Y.encodeStateAsUpdate(room));
  old.transact(() => {
    old.getMap('attribution').set('s1', { createdBy: 'ana@corp', createdAt: 1, updatedBy: 'ana@corp', updatedAt: 1 });
    old.getMap('attribution').set('s2', { createdBy: 'ana@corp', createdAt: 1, updatedBy: 'ana@corp', updatedAt: 1 });
    old.getMap('users').set('ana@corp', ANA.info);
    old.getArray('history').push([{ t: 1, by: 'ana@corp', verb: 'create', shapeId: 's1', shapeType: 'geo' }, { t: 2, by: 'ana@corp', verb: 'create', shapeId: 's2', shapeType: 'geo' }]);
  });
  Y.applyUpdate(room, Y.encodeStateAsUpdate(old), 'load');
  return room;
}

function seedShapes(room: Y.Doc): void {
  room.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('type', 'geo');
    m.set('points', new Y.Array<number>());
    m.set('text', new Y.Text('hello'));
    room.getMap('shapes').set('s1', m);
  }, 'ana');
  room.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('type', 'geo');
    room.getMap('shapes').set('s2', m);
  }, 'ana');
}

describe('forbiddenRootWrite', () => {
  it('accepts ordinary client edits of shapes, assets and meta', () => {
    const room = seededRoom();
    const cases: [string, (d: Y.Doc) => void][] = [
      ['new shape', (d) => d.getMap('shapes').set('s3', shapeMap({ type: 'note', x: 1, y: 2 }))],
      ['overwrite shape field', (d) => (d.getMap('shapes').get('s1') as Y.Map<unknown>).set('type', 'note')],
      ['append points (origin-only items)', (d) => ((d.getMap('shapes').get('s1') as Y.Map<unknown>).get('points') as Y.Array<number>).push([1, 2, 3])],
      ['edit text in the middle', (d) => ((d.getMap('shapes').get('s1') as Y.Map<unknown>).get('text') as Y.Text).insert(2, 'XX')],
      ['delete a shape', (d) => d.getMap('shapes').delete('s2')],
      ['asset', (d) => d.getMap('assets').set('a1', 'data:image/png;base64,AAAA')],
      ['meta', (d) => d.getMap('meta').set('pageWidth', 1200)],
    ];
    for (const [name, fn] of cases) {
      expect(forbiddenRootWrite(room, clientUpdate(room, fn)), name).toBeNull();
    }
  });

  it('a ledger-named root in the content document is refused (the ledger is another Y.Doc)', () => {
    const room = seededRoom();
    const ledgerSv = Y.encodeStateVector(LEDGERS.get(room)!);
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').set('s1', { createdBy: 'mallory' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').set('ana@corp', { name: 'FORGED', anonymous: false })))).toBe('users');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').push([{ by: 'x' }])))).toBe('history');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('writers').set('1', 'mallory')))).toBe('writers');
    expect(Y.encodeStateVector(LEDGERS.get(room)!)).toEqual(ledgerSv);
  });

  it('legacy document: map overwrite of an existing attribution / users entry', () => {
    const room = legacyRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').set('s1', { createdBy: 'mallory' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').set('ana@corp', { name: 'FORGED', anonymous: false })))).toBe('users');
  });

  it('legacy document: new key in a stamper map', () => {
    const room = legacyRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').set('brand-new', { createdBy: 'x' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').set('mallory', { name: 'CEO' })))).toBe('users');
  });

  it('legacy document: array append after the last history item (item with origin, parent === null)', () => {
    const room = legacyRoom();
    const u = clientUpdate(room, (d) => d.getArray('history').push([{ by: 'test@example.com', verb: 'delete' }]));
    // the bug this guards: the forged item travels without a parent
    const s = Y.decodeUpdate(u).structs.find((x) => x instanceof Y.Item) as Y.Item;
    expect(s.parent).toBeNull();
    expect(s.origin).not.toBeNull();
    expect(forbiddenRootWrite(room, u)).toBe('history');
  });

  it('legacy document: array insert in the middle and at the start of history', () => {
    const room = legacyRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').insert(1, [{ by: 'x' }])))).toBe('history');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').insert(0, [{ by: 'x' }])))).toBe('history');
  });

  it('legacy document: delete of stamper-owned content', () => {
    const room = legacyRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').delete(0, 1)))).toBe('history');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').delete('s1')))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').delete('ana@corp')))).toBe('users');
  });

  it('legacy document: nested: a write into a type nested under a stamper root', () => {
    const room = legacyRoom();
    // a nested type the old server created under `users` (parent = ID of that item)
    const old = new Y.Doc();
    old.clientID = 4445;
    Y.applyUpdate(old, Y.encodeStateAsUpdate(room));
    old.transact(() => {
      const nested = new Y.Map<unknown>();
      nested.set('k', 1);
      old.getMap('users').set('nested', nested);
    });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(old), 'load');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => (d.getMap('users').get('nested') as Y.Map<unknown>).set('k', 2)))).toBe('users');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => (d.getMap('users').get('nested') as Y.Map<unknown>).set('new', 2)))).toBe('users');
    // nesting created by the client inside the same update: a new map under history with content
    expect(
      forbiddenRootWrite(room, clientUpdate(room, (d) => {
        const m = new Y.Map<unknown>();
        d.getArray('history').push([m]);
        m.set('by', 'x');
      })),
    ).toBe('history');
    // a client shape with nested types stays fine
    expect(
      forbiddenRootWrite(room, clientUpdate(room, (d) => {
        const m = new Y.Map<unknown>();
        d.getMap('shapes').set('s9', m);
        m.set('type', 'text');
        const t = new Y.Text();
        m.set('text', t);
        t.insert(0, 'abc');
      })),
    ).toBeNull();
  });

  it('roots outside the allow-list are server-only', () => {
    const room = seededRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('evil').set('x', 1)))).toBe('evil');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getText('notes').insert(0, 'x')))).toBe('notes');
  });

  it('a delete of clocks the room does not have yet (would wait as a pending delete)', () => {
    const room = seededRoom();
    // the ledger's stamper clocks (current and future) do not exist in the content document
    const L = LEDGERS.get(room)!;
    for (const [client, clock] of [[room.clientID, Y.getState(room.store, room.clientID)], [L.clientID, 0], [L.clientID, Y.getState(L.store, L.clientID)]]) {
      // update v1: 0 struct clients, then a delete set {client: [clock, clock+50)}
      const update = new Uint8Array([0, 1, ...encodeDs(client, clock, 50)]);
      expect(forbiddenRootWrite(room, update)).toBe('pending');
    }
    // and the room is untouched by the check
    expect(room.store.pendingDs).toBeNull();
  });

  it('missing dependencies go to the scratch path: forbidden once released, pending otherwise', () => {
    const room = legacyRoom();
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(room));
    const sv0 = Y.encodeStateVector(c);
    c.getMap('shapes').set('dep', shapeMap({ type: 'geo' })); // update A (the dependency)
    const sv1 = Y.encodeStateVector(c);
    const a = Y.encodeStateAsUpdate(c, sv0);
    c.getArray('history').push([{ forged: true }]); // update B: history item after A in the same client
    const b = Y.encodeStateAsUpdate(c, sv1);
    // B alone: its clock starts after A, which the room does not have -> it would wait as pending
    expect(forbiddenRootWrite(room, b)).toBe('pending');
    // A + B merged: forbidden
    expect(forbiddenRootWrite(room, Y.mergeUpdates([a, b]))).toBe('history');
    // A alone: fine
    expect(forbiddenRootWrite(room, a)).toBeNull();
  });

  it('the check never mutates the room document', () => {
    const room = legacyRoom();
    const before = Y.encodeStateAsUpdate(room);
    forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').push([{ by: 'x' }])));
    forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('shapes').set('z', 1)));
    expect(Y.encodeStateAsUpdate(room)).toEqual(before);
  });

  it('fast path stays fast on a large room', () => {
    const room = seededRoom();
    room.transact(() => {
      for (let i = 0; i < 2000; i++) {
        const m = new Y.Map<unknown>();
        m.set('type', 'draw');
        m.set('points', new Y.Array<number>());
        room.getMap('shapes').set(`p${i}`, m);
      }
    }, 'ana');
    const u = clientUpdate(room, (d) => ((d.getMap('shapes').get('p1999') as Y.Map<unknown>).get('points') as Y.Array<number>).push([1, 2]));
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(forbiddenRootWrite(room, u)).toBeNull();
    expect((performance.now() - t0) / 200).toBeLessThan(5);
  });
});

/** varUint encoding of a delete set with one client and one range (Yjs update v1 layout). */
function encodeDs(client: number, clock: number, len: number): number[] {
  const out: number[] = [];
  const vu = (n: number) => {
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  vu(client);
  vu(1);
  vu(clock);
  vu(len);
  return out;
}
