import { describe, expect, it } from 'vitest';
import { linkedDocs } from './helpers';

describe('per-user undo', () => {
  it('undo only reverts my own changes', () => {
    const { docs: [a, b] } = linkedDocs(['ana', 'bea']);
    const ra = a.create({ type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 } as never);
    a.endGesture();
    const rb = b.create({ type: 'geo', geo: 'ellipse', x: 50, y: 0, w: 10, h: 10 } as never);
    b.endGesture();
    expect(a.ids().sort()).toEqual([ra, rb].sort());
    a.undo();
    expect(a.has(ra)).toBe(false);
    expect(a.has(rb)).toBe(true);
    expect(b.has(ra)).toBe(false);
    expect(b.has(rb)).toBe(true);
    a.redo();
    expect(b.has(ra)).toBe(true);
  });

  it('undoing my move of someone else\'s shape restores it, without touching their later edits', () => {
    const { docs: [a, b] } = linkedDocs(['ana', 'bea']);
    const id = b.create({ type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 } as never);
    b.endGesture();
    a.update(id, { x: 100 });
    a.endGesture();
    b.update(id, { color: 'red' });
    b.endGesture();
    a.undo();
    expect(b.get(id)).toMatchObject({ x: 0, color: 'red' });
    // b's undo stack still has its own two steps
    b.undo();
    expect(b.get(id)!.color).toBe('black');
  });

  it('a whole gesture is one undo step', () => {
    const { docs: [a] } = linkedDocs(['ana']);
    const id = a.create({ type: 'draw', points: [0, 0, 0.5] } as never);
    for (let i = 0; i < 20; i++) a.appendPoints(id, [i, i, 0.5]);
    a.update(id, { done: true });
    a.endGesture();
    a.undo();
    expect(a.has(id)).toBe(false);
  });

  it('undo of deleting someone else\'s shape keeps the original author', () => {
    const { docs: [a, b] } = linkedDocs(['ana', 'bea']);
    const id = b.create({ type: 'note', text: 'x', x: 0, y: 0, w: 200, h: 200 } as never);
    b.endGesture();
    a.delete([id]);
    a.endGesture();
    expect(b.has(id)).toBe(false);
    a.undo();
    expect(b.has(id)).toBe(true);
    expect(b.attributionOf(id)?.createdBy).toBe('bea');
    expect(b.attributionOf(id)?.updatedBy).toBe('ana');
  });
});
