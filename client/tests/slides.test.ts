import { describe, expect, it } from 'vitest';
import { SLIDE_TOLERANCE, nextSlide, screenStep, stepOf } from '../src/editor/slides';

describe('presentation steps (editor/slides.ts)', () => {
  it('→ ↓ Page Down Space step forward, ← ↑ Page Up ⇧Space back, nothing else steps', () => {
    for (const k of ['ArrowRight', 'ArrowDown', 'PageDown', ' ']) expect(stepOf(k, false)).toBe(1);
    for (const k of ['ArrowLeft', 'ArrowUp', 'PageUp']) expect(stepOf(k, false)).toBe(-1);
    expect(stepOf(' ', true)).toBe(-1);
    expect(stepOf('ArrowRight', true)).toBe(1);
    for (const k of ['Enter', 'Escape', 'Home', 'End', 'Tab', 'k', 'Space', '']) expect(stepOf(k, false)).toBe(0);
  });

  const tops = [0, 540, 1080, 1620, 2160];

  it('forward: the first slide below the line at the top; back: the last one above it', () => {
    expect(nextSlide(tops, 0, 1)).toBe(540);
    expect(nextSlide(tops, 540, 1)).toBe(1080);
    expect(nextSlide(tops, 1080, -1)).toBe(540);
    expect(nextSlide(tops, 540, -1)).toBe(0);
    // in the middle of a slide: forward to the next, back to the top of this one
    expect(nextSlide(tops, 800, 1)).toBe(1080);
    expect(nextSlide(tops, 800, -1)).toBe(540);
  });

  it('a line a few px off a slide top (a camera fitted again) counts as that slide', () => {
    expect(nextSlide(tops, 540 - SLIDE_TOLERANCE + 1, 1)).toBe(1080);
    expect(nextSlide(tops, 540 + SLIDE_TOLERANCE - 1, -1)).toBe(0);
  });

  it('nothing past the last slide, nothing before the page top', () => {
    expect(nextSlide(tops, 2160, 1)).toBeNull();
    expect(nextSlide(tops, 2500, 1)).toBeNull();
    expect(nextSlide(tops, 0, -1)).toBeNull();
    expect(nextSlide(tops, -28, -1)).toBeNull();
  });

  it('the page top is always a stop, in whatever order the tops come', () => {
    expect(nextSlide([1200, 300], 300, -1)).toBe(0);
    expect(nextSlide([1200, 300], 0, 1)).toBe(300);
    expect(nextSlide([1200, 300], 300, 1)).toBe(1200);
    expect(nextSlide([NaN, Infinity, 300], 0, 1)).toBe(300);
    expect(nextSlide([], 500, -1)).toBe(0);
    expect(nextSlide([], 0, 1)).toBeNull();
  });

  it('with no slide that way, a screen at a time, between the page top and the page end', () => {
    expect(screenStep(0, 1, 600, 3000)).toBe(540);
    expect(screenStep(540, -1, 600, 3000)).toBe(0);
    expect(screenStep(2300, 1, 600, 3000)).toBe(2400);
    expect(screenStep(2400, 1, 600, 3000)).toBeNull();
    expect(screenStep(0, -1, 600, 3000)).toBeNull();
    // a page shorter than the screen does not move
    expect(screenStep(0, 1, 600, 400)).toBeNull();
  });

  it('a screen step never goes the other way (the last slide of a deck, its end already in view)', () => {
    // the last of 14 slides of 540 at the top, 721 px shown: the page end is in view
    expect(screenStep(7020, 1, 721, 7560)).toBeNull();
    expect(screenStep(100, -1, 600, 300)).toBe(0);
    expect(screenStep(0, 1, 600, 300)).toBeNull();
  });
});
