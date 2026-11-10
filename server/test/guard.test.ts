import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { attachStamper, forbiddenRootWrite, STAMP_ORIGIN } from '@pocharlies/artifacts-canvas-shared/stamper';

/**
 * Protocol §5.3 guard: a client may only write `shapes`, `assets` and `meta`. These cases
 * cover every way a Yjs update can reach a root: items that carry their parent, items that
 * only carry a left/right origin (Yjs omits `parent` for them), nested types, deletions,
 * deletions of items the room does not have yet, and updates with missing dependencies.
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

/** A room as the server keeps it: stamper attached, one shape and one history line by "ana". */
function seededRoom(): Y.Doc {
  const room = new Y.Doc();
  attachStamper(room, { userOf: (o) => (o === 'ana' ? { id: 'ana@corp', info: { name: 'Ana', anonymous: false, color: '#123456' } } : null) });
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
  expect(room.getArray('history').length).toBe(2);
  expect(room.getMap('attribution').size).toBe(2);
  return room;
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

  it('map overwrite of an existing attribution / users entry', () => {
    const room = seededRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').set('s1', { createdBy: 'mallory' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').set('ana@corp', { name: 'FORGED', anonymous: false })))).toBe('users');
  });

  it('new key in a stamper map', () => {
    const room = seededRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').set('brand-new', { createdBy: 'x' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').set('mallory', { name: 'CEO' })))).toBe('users');
  });

  it('array append after the last history item (item with origin, parent === null)', () => {
    const room = seededRoom();
    const u = clientUpdate(room, (d) => d.getArray('history').push([{ by: 'test@example.com', verb: 'delete' }]));
    // the bug this guards: the forged item travels without a parent
    const s = Y.decodeUpdate(u).structs.find((x) => x instanceof Y.Item) as Y.Item;
    expect(s.parent).toBeNull();
    expect(s.origin).not.toBeNull();
    expect(forbiddenRootWrite(room, u)).toBe('history');
  });

  it('array insert in the middle and at the start of history', () => {
    const room = seededRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').insert(1, [{ by: 'x' }])))).toBe('history');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').insert(0, [{ by: 'x' }])))).toBe('history');
  });

  it('delete of stamper-owned content', () => {
    const room = seededRoom();
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getArray('history').delete(0, 1)))).toBe('history');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('attribution').delete('s1')))).toBe('attribution');
    expect(forbiddenRootWrite(room, clientUpdate(room, (d) => d.getMap('users').delete('ana@corp')))).toBe('users');
  });

  it('nested: a write into a type nested under a stamper root', () => {
    const room = seededRoom();
    // a nested type the server created under `users` (parent = ID of that item)
    room.transact(() => {
      const nested = new Y.Map<unknown>();
      nested.set('k', 1);
      room.getMap('users').set('nested', nested);
    }, STAMP_ORIGIN);
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

  it('a delete of clocks the room does not have yet (would wait as a pending delete for the stamper)', () => {
    const room = seededRoom();
    const sv = Y.getState(room.store, room.clientID);
    // update v1: 0 struct clients, then a delete set {room.clientID: [sv, sv+50)}
    const update = new Uint8Array([0, 1, ...encodeDs(room.clientID, sv, 50)]);
    expect(forbiddenRootWrite(room, update)).toBe('pending');
    // and the room is untouched by the check
    expect(room.store.pendingDs).toBeNull();
  });

  it('missing dependencies go to the scratch path: forbidden once released, pending otherwise', () => {
    const room = seededRoom();
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(room));
    const sv0 = Y.encodeStateVector(c);
    c.getMap('shapes').set('dep', shapeMap({ type: 'geo' })); // update A (the dependency)
    const sv1 = Y.encodeStateVector(c);
    const a = Y.encodeStateAsUpdate(c, sv0);
    c.getArray('history').push([{ forged: true }]); // update B: history item after A in the same client
    const b = Y.encodeStateAsUpdate(c, sv1);
    // B alone: its clock starts after A, which the room does not have -> it would wait as pending
    expect(forbiddenRootWrite(room, b)).toBe('history');
    // A + B merged: forbidden
    expect(forbiddenRootWrite(room, Y.mergeUpdates([a, b]))).toBe('history');
    // A alone: fine
    expect(forbiddenRootWrite(room, a)).toBeNull();
  });

  it('the check never mutates the room document', () => {
    const room = seededRoom();
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
