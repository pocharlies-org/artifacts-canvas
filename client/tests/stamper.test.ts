import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc } from '../src/model/doc';
import { attachStamper, forbiddenRootWrite, STAMP_ORIGIN } from '../src/model/stamper';

function setup(now: { t: number }) {
  const doc = new CanvasDoc();
  const conns = { ana: { name: 'Ana López' }, bea: { name: 'Bea Gil' } } as const;
  attachStamper(doc.doc, {
    userOf: (origin) => {
      const k = origin as keyof typeof conns;
      return conns[k] ? { id: k, info: { name: conns[k].name, anonymous: false } } : null;
    },
    now: () => now.t,
  });
  return doc;
}

describe('attribution stamper', () => {
  it('stamps createdBy/updatedBy per shape and records the user', () => {
    const now = { t: 1000 };
    const d = setup(now);
    const id = d.transact(() => d.create({ type: 'geo', geo: 'rectangle' } as never), 'ana');
    expect(d.attributionOf(id)).toEqual({ createdBy: 'ana', createdAt: 1000, updatedBy: 'ana', updatedAt: 1000 });
    expect(d.user('ana')).toEqual({ name: 'Ana López', anonymous: false });
    now.t = 70_000;
    d.transact(() => d.update(id, { x: 50 }), 'bea');
    expect(d.attributionOf(id)).toEqual({ createdBy: 'ana', createdAt: 1000, updatedBy: 'bea', updatedAt: 70_000 });
    const h = d.historyEntries();
    expect(h.map((e) => [e.by, e.verb, e.owner])).toEqual([
      ['ana', 'create', undefined],
      ['bea', 'move', 'ana'],
    ]);
  });

  it('infers verbs and skips the author finishing their own gesture', () => {
    const now = { t: 0 };
    const d = setup(now);
    const id = d.transact(() => d.create({ type: 'geo', geo: 'ellipse', w: 1, h: 1 } as never), 'ana');
    now.t = 100;
    d.transact(() => d.update(id, { w: 100, h: 80 }), 'ana'); // still dragging it out
    now.t = 10_000;
    d.transact(() => d.update(id, { rotation: 1 }), 'ana');
    now.t = 20_000;
    d.transact(() => d.update(id, { text: 'hola' }), 'bea');
    now.t = 30_000;
    d.transact(() => d.update(id, { color: 'red' }), 'bea');
    now.t = 40_000;
    d.transact(() => d.delete([id]), 'bea');
    expect(d.historyEntries().map((e) => `${e.by}:${e.verb}:${e.shapeType}`)).toEqual([
      'ana:create:geo', 'ana:rotate:geo', 'bea:edit:geo', 'bea:style:geo', 'bea:delete:geo',
    ]);
  });

  it('coalesces repeated lines and caps the history', () => {
    const now = { t: 0 };
    const doc = new CanvasDoc();
    attachStamper(doc.doc, { userOf: (o) => (o === 'ana' ? { id: 'ana', info: { name: 'Ana', anonymous: false } } : null), now: () => now.t, historyLimit: 5 });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(doc.transact(() => doc.create({ type: 'geo', geo: 'rectangle' } as never), 'ana'));
    expect(doc.historyEntries()).toHaveLength(5);
    now.t = 5000;
    for (let i = 0; i < 10; i++) doc.transact(() => doc.update(ids[0], { x: i }), 'ana');
    expect(doc.historyEntries().filter((e) => e.verb === 'move')).toHaveLength(1);
  });

  it('ignores transactions with an unknown origin and its own writes', () => {
    const d = setup({ t: 0 });
    d.transact(() => d.create({ type: 'geo', geo: 'rectangle' } as never), 'stranger');
    d.transact(() => d.create({ type: 'geo', geo: 'rectangle' } as never), STAMP_ORIGIN);
    expect(d.attribution.size).toBe(0);
    expect(d.history.length).toBe(0);
  });

  it('forbiddenRootWrite rejects client writes to attribution, users and history', () => {
    const room = new Y.Doc();
    const client = new Y.Doc();
    // a normal shape edit is fine
    const ok = captureUpdate(client, () => {
      const m = new Y.Map<unknown>();
      m.set('type', 'geo');
      client.getMap('shapes').set('s1', m);
    });
    expect(forbiddenRootWrite(room, ok)).toBeNull();
    Y.applyUpdate(room, ok);
    // forging attribution / users / history is not
    expect(forbiddenRootWrite(room, captureUpdate(client, () => client.getMap('attribution').set('s1', { createdBy: 'someone-else' })))).toBe('attribution');
    expect(forbiddenRootWrite(room, captureUpdate(client, () => client.getMap('users').set('x', { name: 'CEO', anonymous: false })))).toBe('users');
    expect(forbiddenRootWrite(room, captureUpdate(client, () => client.getArray('history').push([{ by: 'x' }])))).toBe('history');
    // deleting server-written history is rejected too
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(room));
    server.getArray('history').push([{ by: 'ana' }]);
    Y.applyUpdate(room, Y.encodeStateAsUpdate(server));
    const c2 = new Y.Doc();
    Y.applyUpdate(c2, Y.encodeStateAsUpdate(room));
    const del = captureUpdate(c2, () => c2.getArray('history').delete(0, 1));
    expect(forbiddenRootWrite(room, del)).toBe('history');
  });
});

function captureUpdate(doc: Y.Doc, fn: () => void): Uint8Array {
  let out: Uint8Array | null = null;
  const h = (u: Uint8Array) => (out = u);
  doc.on('update', h);
  fn();
  doc.off('update', h);
  return out!;
}
