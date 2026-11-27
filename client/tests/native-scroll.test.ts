import { describe, expect, it } from 'vitest';
import { nativeScroll } from '../src/editor/camera';

// A 1440 x 900 view, a 980 px page 5600 px tall, read at the zoom where it is as wide as the view.
const Z = 1440 / 980;
const at = (y: number, z = Z) => ({ z, tx: 0, ty: -y * z });

describe('nativeScroll: when the artifact scrolls itself (docs/design.md §6.4)', () => {
  it('at the reading zoom, with the view inside the page: the document scrolls to the top line', () => {
    const n = nativeScroll(at(1234.5), Z, 900, 5600)!;
    expect(n.y).toBeCloseTo(1234.5, 9);
    // the frame is the view's height in artifact px, rounded up: it covers the view
    expect(n.winH).toBe(Math.ceil(900 / Z));
    expect(n.winH * Z).toBeGreaterThanOrEqual(900);
  });

  it('the page top and its last line are still native; a fraction past them snaps', () => {
    expect(nativeScroll(at(0), Z, 900, 5600)!.y).toBe(0);
    expect(nativeScroll(at(-0.4), Z, 900, 5600)!.y).toBe(0);
    const winH = Math.ceil(900 / Z);
    const max = 5600 - winH - 1;
    expect(nativeScroll(at(max), Z, 900, 5600)!.y).toBeCloseTo(max, 9);
    expect(nativeScroll(at(max + 1.5), Z, 900, 5600)!.y).toBe(max);
  });

  it('past the page top or end, at another zoom, or on a page no taller than the view: the transform', () => {
    expect(nativeScroll(at(-1), Z, 900, 5600)).toBeNull();
    const winH = Math.ceil(900 / Z);
    expect(nativeScroll(at(5600 - winH + 5), Z, 900, 5600)).toBeNull();
    expect(nativeScroll(at(100, Z * 1.25), Z, 900, 5600)).toBeNull();
    expect(nativeScroll(at(100, 1), Z, 900, 5600)).toBeNull();
    expect(nativeScroll(at(0), Z, 900, 600)).toBeNull();
    expect(nativeScroll(at(0), Z, 900, winH + 1)).toBeNull();
    expect(nativeScroll(at(0), Z, 0, 5600)).toBeNull();
  });

  it('a zoom a rounding away from the reading zoom (a follower matching a viewport) is the reading zoom', () => {
    const z = (1440 / (1440 / Z)) * (1 + 1e-9);
    expect(nativeScroll(at(300, z), Z, 900, 5600)).not.toBeNull();
  });

  it('the horizontal position does not matter (a sideways move shows with the transform, the window stays)', () => {
    expect(nativeScroll({ z: Z, tx: -200, ty: -300 * Z }, Z, 900, 5600)!.y).toBeCloseTo(300, 9);
    expect(nativeScroll({ z: Z, tx: 350, ty: -300 * Z }, Z, 900, 5600)!.y).toBeCloseTo(300, 9);
  });
});
