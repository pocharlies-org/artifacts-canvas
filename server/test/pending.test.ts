import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import {
  applyGuarded,
  attachStamper,
  checkClientUpdate,
  dropPending,
  encodeIntegratedState,
  forbiddenRootWrite,
  hasPending,
} from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger } from '@pocharlies/artifacts-canvas-shared/ledger';

/**
 * Regressions of the second independent verification (fv2), re-run against the two-document
 * room: a room must NEVER hold pending (parked) Yjs state, and the LEDGER (attribution,
 * users, history) is a separate Y.Doc no client update reaches. A struct parked behind a
 * clock gap, or whose left origin is the stamper's NEXT ledger clock, could be released
 * later into whatever its dependency resolves to; in the content document such an origin
 * never even exists. These tests replay the verifier's PoC (pending2.mjs) and every variant
 * against the guard, then apply whatever the guard accepts, exactly like server/src/ws.ts,
 * and check the ledger only ever holds the stamper's own structs.
 */

type Who = 'alice' | 'mallory';
const USERS: Record<Who, { id: string; info: { name: string; color: string; anonymous: boolean } }> = {
  alice: { id: 'user:alice', info: { name: 'Alice', color: '#0000ff', anonymous: false } },
  mallory: { id: 'anon:mallory', info: { name: 'Anónimo 6666', color: '#ff0000', anonymous: true } },
};

/** content document of a room -> its ledger */
const LEDGERS = new WeakMap<Y.Doc, Y.Doc>();
const ledgerOf = (room: Y.Doc): Y.Doc => LEDGERS.get(room)!;

/** A room as the server keeps it: the content document (returned) and its ledger. */
function serverRoom(): Y.Doc {
  const room = materializeContent(new Y.Doc());
  const ledger = materializeLedger(new Y.Doc());
  LEDGERS.set(room, ledger);
  attachStamper(room, ledger, { userOf: (o) => USERS[o as Who] ?? null });
  return room;
}

/** Every struct of the ledger was written by the ledger's own (stamper) client. */
function ledgerIsStamperOnly(room: Y.Doc): boolean {
  const l = ledgerOf(room);
  return [...l.store.clients.keys()].every((c) => c === l.clientID);
}

/** guard + apply, like ws.ts; returns the guard's answer (or the apply's failure) */
function send(room: Y.Doc, who: Who, u: Uint8Array): string | null {
  const bad = forbiddenRootWrite(room, u);
  if (bad) return bad;
  const out = applyGuarded(room, u, who);
  expect(ledgerIsStamperOnly(room)).toBe(true);
  return out.threw ? 'threw' : out.droppedPending ? 'dropped-pending' : null;
}

function newShape(client: number, id: string): Uint8Array {
  const d = new Y.Doc();
  d.clientID = client;
  const m = new Y.Map<unknown>();
  d.getMap('shapes').set(id, m);
  m.set('type', 'geo');
  return Y.encodeStateAsUpdate(d);
}

/** clock 1 of a fresh client without clock 0 (a valid shape: only the gap is wrong) */
function gapUpdate(client = 4242): Uint8Array {
  const a = new Y.Doc();
  a.clientID = client;
  const m0 = new Y.Map<unknown>();
  m0.set('type', 'geo');
  a.getMap('shapes').set('p0', m0);
  const sv = Y.encodeStateVector(a);
  const m1 = new Y.Map<unknown>();
  m1.set('type', 'geo');
  a.getMap('shapes').set('p1', m1);
  return Y.encodeStateAsUpdate(a, sv);
}

/**
 * An item appended to history right after the stamper's future history line (the attacker
 * sees the ledger: it is broadcast to everyone). `attributionLinesFirst` < 0: right after
 * the CURRENT last history line instead.
 */
function afterFutureHistory(room: Y.Doc, attributionLinesFirst: number): Uint8Array {
  const sim = new Y.Doc();
  Y.applyUpdate(sim, Y.encodeStateAsUpdate(ledgerOf(room)));
  sim.clientID = ledgerOf(room).clientID;
  if (attributionLinesFirst >= 0) {
    sim.transact(() => {
      for (let i = 0; i < attributionLinesFirst; i++) sim.getMap('attribution').set(`__sim${i}`, {});
      sim.getArray('history').push([{}]);
    });
  }
  const ev = new Y.Doc();
  Y.applyUpdate(ev, Y.encodeStateAsUpdate(room));
  Y.applyUpdate(ev, Y.encodeStateAsUpdate(sim));
  ev.clientID = 777;
  const sv = Y.encodeStateVector(ev);
  const h = ev.getArray('history');
  h.insert(h.length, [{ t: Date.now(), by: 'user:alice', verb: 'delete', shapeId: 'FORGED', shapeType: 'geo' }]);
  return Y.encodeStateAsUpdate(ev, sv);
}

/** update v1 with no structs and one delete range {client: [clock, clock+len)} */
function deleteRange(client: number, clock: number, len: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, client);
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarUint(enc, len);
  return encoding.toUint8Array(enc);
}

const historyIds = (room: Y.Doc) => (ledgerOf(room).getArray('history').toJSON() as { shapeId: string }[]).map((e) => e.shapeId);

describe('pending state never enters the room (fv2 finding 1)', () => {
  it('PoC pending2.mjs: gap write + item after the stamper next clock + victim edit + empty update forge nothing', () => {
    const room = serverRoom();
    expect(send(room, 'alice', newShape(1001, 's1'))).toBeNull();
    expect(send(room, 'mallory', gapUpdate())).toBe('pending');
    expect(hasPending(room)).toBe(false);
    expect(send(room, 'mallory', afterFutureHistory(room, 1))).toBe('pending');
    expect(hasPending(room)).toBe(false);
    expect(send(room, 'alice', newShape(1002, 's2'))).toBeNull();
    expect(send(room, 'mallory', Y.encodeStateAsUpdate(new Y.Doc()))).toBeNull();
    expect(historyIds(room)).toEqual(['s1', 's2']);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(ledgerOf(room)));
    expect((reloaded.getArray('history').toJSON() as { shapeId: string }[]).map((e) => e.shapeId)).toEqual(['s1', 's2']);
  });

  it('an origin on the CURRENT last history line (a ledger struct) is unknown to the content document: pending, ledger unchanged', () => {
    const room = serverRoom();
    send(room, 'alice', newShape(1001, 's1'));
    const sv = Y.encodeStateVector(ledgerOf(room));
    expect(send(room, 'mallory', afterFutureHistory(room, -1))).toBe('pending');
    expect(Y.encodeStateVector(ledgerOf(room))).toEqual(sv);
    expect(historyIds(room)).toEqual(['s1']);
  });

  it('the item after the future history line alone (no gap first) is refused as pending', () => {
    const room = serverRoom();
    send(room, 'alice', newShape(1001, 's1'));
    expect(send(room, 'mallory', afterFutureHistory(room, 1))).toBe('pending');
    expect(send(room, 'mallory', afterFutureHistory(room, 0))).toBe('pending');
    send(room, 'alice', newShape(1002, 's2'));
    expect(historyIds(room)).toEqual(['s1', 's2']);
  });

  it('a pending delete set on future stamper clocks is refused, with or without a gap before it (fv2.spec B)', () => {
    const room = serverRoom();
    send(room, 'alice', newShape(1001, 'd1'));
    const S = room.clientID;
    const N = Y.getState(room.store, S);
    expect(send(room, 'mallory', gapUpdate())).toBe('pending');
    expect(send(room, 'mallory', deleteRange(S, N, 64))).toBe('pending');
    // a range that starts on existing clocks and runs into the future: refused too
    expect(send(room, 'mallory', deleteRange(1001, 0, 1000))).toBe('pending');
    expect(hasPending(room)).toBe(false);
    send(room, 'alice', newShape(1002, 'd2'));
    send(room, 'mallory', Y.encodeStateAsUpdate(new Y.Doc()));
    expect(historyIds(room)).toEqual(['d1', 'd2']);
    expect(Object.keys(ledgerOf(room).getMap('attribution').toJSON()).sort()).toEqual(['d1', 'd2']);
  });

  it('a hole inside the update (merged updates with a Skip) is refused', () => {
    const room = serverRoom();
    const a = new Y.Doc();
    a.clientID = 5150;
    const parts: Uint8Array[] = [];
    for (const id of ['k0', 'k1', 'k2']) {
      const sv = Y.encodeStateVector(a);
      const m = new Y.Map<unknown>();
      m.set('type', 'geo');
      a.getMap('shapes').set(id, m);
      parts.push(Y.encodeStateAsUpdate(a, sv));
    }
    expect(forbiddenRootWrite(room, Y.mergeUpdates([parts[0], parts[2]]))).toBe('pending');
    expect(forbiddenRootWrite(room, Y.mergeUpdates(parts))).toBeNull();
  });

  it('structs carrying the server stamper client id are refused, wherever they write', () => {
    const room = serverRoom();
    send(room, 'alice', newShape(1001, 's1'));
    const sim = new Y.Doc();
    Y.applyUpdate(sim, Y.encodeStateAsUpdate(room));
    sim.clientID = room.clientID;
    const sv = Y.encodeStateVector(sim);
    const m = new Y.Map<unknown>();
    m.set('type', 'geo');
    sim.getMap('shapes').set('as-server', m);
    expect(forbiddenRootWrite(room, Y.encodeStateAsUpdate(sim, sv))).toBe('server-client');
    // an explicit serverClient option wins over doc.clientID
    expect(forbiddenRootWrite(room, newShape(1002, 's2'), { serverClient: 1002 })).toBe('server-client');
  });

  it('new clocks for a client id another connection owns are refused (mayWriteClient)', () => {
    const room = serverRoom();
    const r = checkClientUpdate(room, newShape(1001, 's1'), { mayWriteClient: (c) => c !== 1001 });
    expect(r.bad).toBe('foreign-client');
    const ok = checkClientUpdate(room, newShape(1002, 's2'), { mayWriteClient: (c) => c !== 1001 });
    expect(ok).toEqual({ bad: null, writers: [1002] });
  });

  it('a forged copy of a known struct cannot redirect an origin chain (Yjs keeps the room copy)', () => {
    const room = serverRoom();
    // history written by an earlier stamper (a room loaded from storage): client 4444
    const old = new Y.Doc();
    old.clientID = 4444;
    old.getArray('history').push([{ t: 1, by: 'user:alice', verb: 'create', shapeId: 'old', shapeType: 'geo' }]);
    Y.applyUpdate(room, Y.encodeStateAsUpdate(old), 'load');
    // the attacker re-sends (4444, 0) claiming parent "shapes", plus an item after it
    const forged = new Y.Doc();
    forged.clientID = 4444;
    forged.getMap('shapes').set('x', new Y.Map());
    const ev = new Y.Doc();
    ev.clientID = 31337;
    Y.applyUpdate(ev, Y.encodeStateAsUpdate(room));
    const sv = Y.encodeStateVector(ev);
    ev.getArray('history').push([{ t: 2, by: 'user:alice', verb: 'delete', shapeId: 'FORGED', shapeType: 'geo' }]);
    const evil = Y.encodeStateAsUpdate(ev, sv);
    const s = Y.decodeUpdate(evil).structs[0] as Y.Item;
    expect(s.parent).toBeNull();
    expect(s.origin).toEqual(Y.createID(4444, 0));
    const merged = Y.mergeUpdates([Y.encodeStateAsUpdate(forged), evil]);
    expect(forbiddenRootWrite(room, merged)).toBe('history');
    expect(forbiddenRootWrite(room, evil)).toBe('history');
  });

  it('a struct that only partly overlaps the room state is refused', () => {
    const room = serverRoom();
    const a = new Y.Doc();
    a.clientID = 6000;
    const m = new Y.Map<unknown>();
    m.set('type', 'text');
    a.getMap('shapes').set('t', m);
    const t = new Y.Text();
    m.set('text', t);
    t.insert(0, 'abc');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(a), 'alice');
    const sv = Y.encodeStateVector(a);
    t.insert(3, 'def'); // merged with "abc" into one struct in a full-state encoding
    const full = Y.encodeStateAsUpdate(a);
    const s = Y.decodeUpdate(full).structs.find((x) => x instanceof Y.Item && x.length > 3);
    expect(s).toBeTruthy();
    expect(forbiddenRootWrite(room, full)).toBe('overlap');
    expect(forbiddenRootWrite(room, Y.encodeStateAsUpdate(a, sv))).toBeNull();
  });

  it('a room that holds pending state refuses every write until cleaned; nothing pending is ever encoded', () => {
    const room = serverRoom();
    send(room, 'alice', newShape(1001, 's1'));
    Y.applyUpdate(room, gapUpdate()); // bypass the guard on purpose
    expect(hasPending(room)).toBe(true);
    expect(forbiddenRootWrite(room, newShape(1002, 's2'))).toBe('room-pending');
    // encodeStateAsUpdate would merge the parked struct in; the integrated encoding does not
    const withPending = new Y.Doc();
    Y.applyUpdate(withPending, Y.encodeStateAsUpdate(room));
    expect(hasPending(withPending)).toBe(true);
    const clean = new Y.Doc();
    Y.applyUpdate(clean, encodeIntegratedState(room));
    expect(hasPending(clean)).toBe(false);
    expect(hasPending(room)).toBe(true); // encodeIntegratedState leaves the room as it was
    expect(dropPending(room)).toBe(true);
    expect(hasPending(room)).toBe(false);
    expect(dropPending(room)).toBe(false);
    expect(forbiddenRootWrite(room, newShape(1002, 's2'))).toBeNull();
  });

  it('a same-client dependency on a later clock is malformed', () => {
    const room = serverRoom();
    const a = new Y.Doc();
    a.clientID = 7000;
    const m = new Y.Map<unknown>();
    m.set('type', 'geo');
    a.getMap('shapes').set('m', m);
    const u = Y.encodeStateAsUpdate(a);
    const d = Y.decodeUpdate(u);
    const child = d.structs.find((x) => x instanceof Y.Item && x.id.clock === 1) as Y.Item;
    expect(child).toBeTruthy();
    // point the `type` item's parent at its own future clock
    (child as unknown as { parent: Y.ID }).parent = Y.createID(7000, 5);
    const enc = new Y.UpdateEncoderV1();
    encoding.writeVarUint(enc.restEncoder, 1);
    encoding.writeVarUint(enc.restEncoder, d.structs.length);
    enc.writeClient(7000);
    encoding.writeVarUint(enc.restEncoder, 0);
    for (const s of d.structs) (s as Y.Item).write(enc, 0);
    encoding.writeVarUint(enc.restEncoder, 0);
    expect(forbiddenRootWrite(room, enc.toUint8Array())).toBe('malformed');
  });
});

describe('document schema of the client roots (fv2 finding 2)', () => {
  function seeded(): Y.Doc {
    const room = serverRoom();
    const c = new Y.Doc();
    c.clientID = 1001;
    const m = new Y.Map<unknown>();
    m.set('type', 'geo');
    m.set('x', 1);
    m.set('points', new Y.Array<number>());
    m.set('text', new Y.Text('hi'));
    c.getMap('shapes').set('s1', m);
    Y.applyUpdate(room, Y.encodeStateAsUpdate(c), 'alice');
    return room;
  }
  const edit = (room: Y.Doc, fn: (d: Y.Doc) => void) => {
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(room));
    const sv = Y.encodeStateVector(c);
    fn(c);
    return Y.encodeStateAsUpdate(c, sv);
  };
  const s1 = (d: Y.Doc) => d.getMap('shapes').get('s1') as Y.Map<unknown>;
  const mapOf = (o: Record<string, unknown>) => {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(o)) m.set(k, v);
    return m;
  };

  it('only Y.Map values directly under shapes (fv2.spec C / fv2b: number, string, null, array, text)', () => {
    const room = seeded();
    const values: [string, unknown][] = [
      ['number', 42], ['string', 'x'], ['null', null], ['boolean', true], ['object', { type: 'geo' }],
      ['array', new Y.Array()], ['text', new Y.Text('x')],
    ];
    for (const [name, v] of values) {
      expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('shapes').set(`bad-${name}`, v as never))), name).toBe('shapes-schema');
    }
  });

  it('a new shape needs a valid type; geometry must be finite numbers; text a string or Y.Text', () => {
    const room = seeded();
    const bad: [string, Record<string, unknown>][] = [
      ['no type', { x: 1 }],
      ['unknown type', { type: 'rect' }],
      ['type not a string', { type: 7 }],
      ['x as a string (fv2b)', { type: 'geo', x: 'NaN' }],
      ['NaN', { type: 'geo', y: Number.NaN }],
      ['huge w (fv2b -1e308)', { type: 'geo', w: -1e308 }],
      ['infinite h', { type: 'geo', h: Number.POSITIVE_INFINITY }],
      ['text as a number (fv2b)', { type: 'geo', text: 12 }],
      ['geo not a kind', { type: 'geo', geo: 'blob' }],
      ['start not a terminal', { type: 'arrow', start: 5, end: { x: 0, y: 0 } }],
      ['locked not a boolean', { type: 'geo', locked: 'yes' }],
      ['nested map field', { type: 'geo', color: new Y.Map() }],
    ];
    for (const [name, f] of bad) {
      expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('shapes').set('n', mapOf(f)))), name).toBe('shapes-schema');
    }
    const good = { type: 'arrow', x: 1, y: 2, w: 0, h: 0, rotation: 0.5, index: 3, start: { x: 0, y: 0 }, end: { x: 9, y: 9, bind: { shapeId: 's1', nx: 0.5, ny: 0.5 } }, color: 'red', future: 'ok' };
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('shapes').set('n', mapOf(good))))).toBeNull();
  });

  it('later edits of a shape are checked field by field (fv2b evil-geo on an existing shape)', () => {
    const room = seeded();
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).set('x', 'NaN')))).toBe('shapes-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).set('type', 'rect')))).toBe('shapes-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => (s1(d).get('points') as Y.Array<unknown>).push(['x'])))).toBe('shapes-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => (s1(d).get('points') as Y.Array<unknown>).push([new Y.Map()])))).toBe('shapes-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).set('text', new Y.Map())))).toBe('shapes-schema');
    // fine: numbers, points, text, a type change within the allow-list
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).set('x', 99)))).toBeNull();
    expect(forbiddenRootWrite(room, edit(room, (d) => (s1(d).get('points') as Y.Array<number>).push([1, 2, 0.5])))).toBeNull();
    expect(forbiddenRootWrite(room, edit(room, (d) => (s1(d).get('text') as Y.Text).insert(1, 'XX')))).toBeNull();
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).set('type', 'note')))).toBeNull();
  });

  it('deleting the type of a live shape is refused; deleting the whole shape is fine', () => {
    const room = seeded();
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).delete('type')))).toBe('shapes-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => s1(d).delete('x')))).toBeNull();
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('shapes').delete('s1')))).toBeNull();
  });

  it('assets hold strings, meta holds plain values (no nested types)', () => {
    const room = seeded();
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('assets').set('a', 42)))).toBe('assets-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('assets').set('a', new Y.Map())))).toBe('assets-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('assets').set('a', 'data:image/png;base64,AAAA')))).toBeNull();
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('meta').set('nest', mapOf({ history: 'x' }))))).toBe('meta-schema');
    expect(forbiddenRootWrite(room, edit(room, (d) => d.getMap('meta').set('pageWidth', 1200)))).toBeNull();
  });

  it('the slow path (long cross-client origin chain) applies the same rules', () => {
    // 80 clients each overwrite meta.k after the previous one: an origin chain deeper than
    // the fast path follows, so the update goes to the scratch copy
    const build = (last: (d: Y.Doc) => void) => {
      const room = seeded();
      let prev = new Y.Doc();
      Y.applyUpdate(prev, Y.encodeStateAsUpdate(room));
      const sv0 = Y.encodeStateVector(prev);
      for (let i = 0; i < 80; i++) {
        const d = new Y.Doc();
        d.clientID = 900000 + i;
        Y.applyUpdate(d, Y.encodeStateAsUpdate(prev));
        if (i === 79) last(d);
        else d.getMap('meta').set('k', i);
        prev = d;
      }
      return { room, update: Y.encodeStateAsUpdate(prev, sv0) };
    };
    const ok = build((d) => d.getMap('meta').set('k', 'final'));
    expect(forbiddenRootWrite(ok.room, ok.update)).toBeNull();
    const nested = build((d) => d.getMap('meta').set('k', new Y.Map()));
    expect(forbiddenRootWrite(nested.room, nested.update)).toBe('meta-schema');
    const nonMapShape = build((d) => d.getMap('shapes').set('evil', 42 as never));
    expect(forbiddenRootWrite(nonMapShape.room, nonMapShape.update)).toBe('shapes-schema');
  });

  it('the stamper never throws on (or stamps) a malformed value already in the document', () => {
    const room = serverRoom();
    const c = new Y.Doc();
    c.clientID = 1234;
    c.getMap('shapes').set('evil-num', 42 as never);
    c.getMap('shapes').set('no-type', new Y.Map());
    expect(() => Y.applyUpdate(room, Y.encodeStateAsUpdate(c), 'alice')).not.toThrow();
    expect(ledgerOf(room).getMap('attribution').size).toBe(0);
    expect(ledgerOf(room).getArray('history').length).toBe(0);
    send(room, 'alice', newShape(1001, 'good'));
    expect(historyIds(room)).toEqual(['good']);
  });
});
