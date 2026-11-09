import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc, compareOrder } from '../src/model/doc';
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
