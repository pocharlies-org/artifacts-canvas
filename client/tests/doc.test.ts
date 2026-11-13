import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc, DELETE_BATCH, compareOrder } from '../src/model/doc';
import type { GeoShape, NoteShape } from '../src/model/types';
import { linkedDocs } from './helpers';

describe('CanvasDoc', () => {
  it('creates, reads, updates and deletes shapes', () => {
    const d = new CanvasDoc();
    const id = d.create({ type: 'geo', geo: 'rectangle', x: 10, y: 20, w: 100, h: 50, text: '' } as Partial<GeoShape> & { type: 'geo' });
    const s = d.get(id) as GeoShape;
    expect(s).toMatchObject({ type: 'geo', x: 10, y: 20, w: 100, h: 50, color: 'black', rotation: 0, locked: false });
    d.update(id, { x: 30, color: 'red' });
    expect(d.get(id)).toMatchObject({ x: 30, color: 'red' });
    d.delete([id]);
    expect(d.get(id)).toBeUndefined();
    expect(d.ids()).toEqual([]);
  });

  it('keeps a paint order: frames, then highlights, then the rest by index', () => {
    const d = new CanvasDoc();
    const a = d.create({ type: 'geo', geo: 'rectangle' } as never);
    const f = d.create({ type: 'frame', name: 'F' } as never);
    const h = d.create({ type: 'draw', points: [0, 0, 0.5], highlight: true } as never);
    const b = d.create({ type: 'geo', geo: 'ellipse' } as never);
    expect(d.all().map((s) => s.id)).toEqual([f, h, a, b]);
    d.bringToFront([a]);
    expect(d.all().map((s) => s.id)).toEqual([f, h, b, a]);
    d.sendToBack([a]);
    expect(d.all().map((s) => s.id)).toEqual([f, h, a, b]);
    expect(compareOrder(d.get(a)!, d.get(b)!)).toBeLessThan(0);
  });

  it('groups, ungroups and locks', () => {
    const d = new CanvasDoc();
    const a = d.create({ type: 'geo', geo: 'rectangle' } as never);
    const b = d.create({ type: 'geo', geo: 'ellipse' } as never);
    const c = d.create({ type: 'geo', geo: 'star' } as never);
    d.group([a, b]);
    expect(new Set(d.expandGroups([a]))).toEqual(new Set([a, b]));
    expect(d.expandGroups([c])).toEqual([c]);
    d.ungroup([a, b]);
    expect(d.expandGroups([a])).toEqual([a]);
    d.setLocked([c], true);
    expect(d.get(c)!.locked).toBe(true);
  });

  it('merges concurrent typing in the same note (Y.Text)', () => {
    const { docs } = linkedDocs(['u1', 'u2']);
    const id = docs[0].create({ type: 'note', text: 'hola' } as Partial<NoteShape> & { type: 'note' });
    expect((docs[1].get(id) as NoteShape).text).toBe('hola');
    // simulate concurrency: apply edits on unlinked copies, then exchange
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(docs[0].doc));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(docs[0].doc));
    const ca = new CanvasDoc(a);
    const cb = new CanvasDoc(b);
    ca.update(id, { text: 'hola Marta' });
    cb.update(id, { text: '¡hola' });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect((ca.get(id) as NoteShape).text).toBe('¡hola Marta');
    expect((cb.get(id) as NoteShape).text).toBe('¡hola Marta');
  });

  it('two people moving the same shape converge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = new CanvasDoc(a);
    const id = ca.create({ type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 } as never);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const cb = new CanvasDoc(b);
    ca.update(id, { x: 100 });
    cb.update(id, { y: 50, color: 'blue' });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(ca.get(id)).toMatchObject({ x: 100, y: 50, color: 'blue' });
    expect(cb.get(id)).toEqual(ca.get(id));
  });

  it('appends freehand points live and unbinds arrows of deleted shapes', () => {
    const d = new CanvasDoc();
    const s = d.create({ type: 'draw', points: [0, 0, 0.5] } as never);
    d.appendPoints(s, [1, 1, 0.5, 2, 2, 0.5]);
    expect((d.get(s) as { points: number[] }).points).toHaveLength(9);
    const r = d.create({ type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 } as never);
    const a = d.create({ type: 'arrow', start: { x: 50, y: 50 }, end: { x: 5, y: 5, bind: { shapeId: r, nx: 0.5, ny: 0.5 } }, bend: 0 } as never);
    d.delete([r]);
    expect((d.get(a) as { end: object }).end).toEqual({ x: 5, y: 5 });
  });

  it('deletes a big selection in parts of DELETE_BATCH shapes (one update each, review F-1), one undo step, arrows unbound', () => {
    const d = new CanvasDoc();
    const n = 2 * DELETE_BATCH + 500;
    const ids: string[] = [];
    d.transact(() => {
      for (let i = 0; i < n; i++) ids.push(d.create({ type: 'geo', geo: 'rectangle', x: i, y: 0, w: 10, h: 10 } as never));
    });
    // an arrow bound to the LAST shape deleted (in the last part)
    const a = d.create({ type: 'arrow', start: { x: 50, y: 50 }, end: { x: 5, y: 5, bind: { shapeId: ids[n - 1], nx: 0.5, ny: 0.5 } }, bend: 0 } as never);
    d.endGesture();
    const parts: number[] = [];
    d.doc.on('update', (u: Uint8Array) => {
      const dec = Y.decodeUpdate(u);
      let deleted = 0;
      for (const ranges of dec.ds.clients.values()) for (const r of ranges) deleted += r.len;
      parts.push(deleted);
    });
    d.delete(ids);
    d.endGesture();
    expect(parts.length).toBe(3);
    expect(d.ids()).toEqual([a]);
    expect((d.get(a) as { end: object }).end).toEqual({ x: 5, y: 5 });
    // one step undoes the whole delete (and the unbinding)
    expect(d.undo()).toBe(true);
    expect(d.ids().length).toBe(n + 1);
    expect((d.get(a) as { end: { bind?: { shapeId: string } } }).end.bind?.shapeId).toBe(ids[n - 1]);
    // a small selection is one update, as before
    parts.length = 0;
    d.delete(ids.slice(0, 10));
    expect(parts.length).toBe(1);
  });

  it('notifies changed shape ids', () => {
    const d = new CanvasDoc();
    const seen: string[][] = [];
    d.onChange((c) => c.shapes.size && seen.push([...c.shapes]));
    const id = d.create({ type: 'geo', geo: 'rectangle' } as never);
    d.update(id, { x: 5 });
    d.update(id, { text: 'abc' });
    expect(seen).toEqual([[id], [id], [id]]);
  });
});

describe('malformed entries under `shapes` (fv2 finding 2: recovery)', () => {
  it('a document already holding bad values still renders every good shape; nothing throws', async () => {
    const { shapeElement } = await import('../src/render/shapeSvg');
    const raw = new Y.Doc();
    const d = new CanvasDoc(raw);
    const good = d.create({ type: 'geo', geo: 'rectangle', x: 10, y: 20, w: 100, h: 50, text: 'ok' } as never);
    const arrow = d.create({ type: 'arrow', start: { x: 0, y: 0 }, end: { x: 50, y: 0 } } as never);
    // what an old server (or a development relay) may have stored
    const evil = new Y.Doc();
    Y.applyUpdate(evil, Y.encodeStateAsUpdate(raw));
    const sv = Y.encodeStateVector(evil);
    const map = (o: Record<string, unknown>) => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(o)) m.set(k, v);
      return m;
    };
    evil.transact(() => {
      const shapes = evil.getMap('shapes');
      shapes.set('evil-num', 42 as never);
      shapes.set('evil-str', 'x' as never);
      shapes.set('evil-null', null as never);
      shapes.set('evil-arr', new Y.Array() as never);
      shapes.set('evil-geo', map({ type: 'geo', geo: 'rectangle', x: 'NaN', w: -1e308, text: 12 }));
      shapes.set('evil-notype', map({ x: 1, y: 1 }));
      shapes.set('evil-type', map({ type: 'rect' }));
      shapes.set('evil-arrow', map({ type: 'arrow' })); // no terminals
      shapes.set('evil-id', map({ type: 'note', id: good, text: 'impostor', x: 0, y: 0, w: 10, h: 10 }));
    });
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(evil, sv));
    let all: ReturnType<CanvasDoc['all']> = [];
    expect(() => (all = d.all())).not.toThrow();
    // the impostor keeps its own key as id: it cannot shadow the good shape
    expect(all.map((s) => s.id).sort()).toEqual([arrow, 'evil-id', good].sort());
    expect(d.get(good)).toMatchObject({ type: 'geo', x: 10 });
    expect(d.get('evil-id')?.id).toBe('evil-id');
    for (const k of ['evil-num', 'evil-str', 'evil-null', 'evil-arr', 'evil-geo', 'evil-notype', 'evil-type', 'evil-arrow']) {
      expect(d.get(k), k).toBeUndefined();
      expect(d.has(k), k).toBe(false);
    }
    expect(d.ids().sort()).toEqual([arrow, 'evil-id', good].sort());
    expect(() => d.maxIndex()).not.toThrow();
    expect(() => d.minIndex()).not.toThrow();
    expect(() => d.update('evil-num', { x: 1 })).not.toThrow();
    expect(() => d.appendPoints('evil-arr', [1, 2, 3])).not.toThrow();
    expect(() => d.delete(['evil-num', good])).not.toThrow();
    const env = { get: () => undefined, asset: () => '' };
    for (const s of d.all()) {
      const svg = shapeElement(s, env);
      expect(svg.startsWith('<g'), s.id).toBe(true);
      expect(svg).not.toContain('NaN');
    }
    // drawing still works next to the bad entries
    const later = d.create({ type: 'geo', geo: 'ellipse', x: 1, y: 1, w: 5, h: 5 } as never);
    expect(d.get(later)).toBeTruthy();
  });
});
