/**
 * Stepping a presentation (Editor.stepSlide): the keys that step it and the slide they lead to.
 * The slides are the tops of the page's slides in artifact px, as the reporter measured them
 * (artifact/frame.ts `slides`); the page top is always a stop.
 */

/** Two tops closer than this (artifact px) are the same place: a camera fitted again, rounding. */
export const SLIDE_TOLERANCE = 8;

/**
 * A key that steps a presentation: forward (1) for → ↓ Page Down and Space, back (-1) for ← ↑
 * Page Up and ⇧Space; 0 for any other key.
 */
export function stepOf(key: string, shift: boolean): 1 | -1 | 0 {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 1;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return -1;
    case ' ':
    case 'Spacebar':
      return shift ? -1 : 1;
    default:
      return 0;
  }
}

/**
 * The top of the slide to show when the line `at` (artifact px) is at the top of the view: the
 * first one below it (dir 1), or the last one above it (dir -1), so a view in the middle of a slide
 * goes back to that slide's own top. Null: nothing further that way.
 */
export function nextSlide(tops: readonly number[], at: number, dir: 1 | -1): number | null {
  const stops = [0, ...tops.filter((y) => Number.isFinite(y) && y > 0)].sort((a, b) => a - b);
  if (dir === 1) return stops.find((y) => y > at + SLIDE_TOLERANCE) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < at - SLIDE_TOLERANCE) return stops[i];
  return null;
}

/**
 * Where there is no slide to go to (a page with none, or more page after the last one), a step is a
 * screen: the line `at` moves by most of `screen` (the height shown under the badge, artifact px),
 * never above the page top nor past the point where the page end reaches the bottom of the view,
 * and never the other way. Null: already there.
 */
export function screenStep(at: number, dir: 1 | -1, screen: number, pageHeight: number): number | null {
  const last = Math.max(0, pageHeight - screen);
  const y = Math.max(0, Math.min(last, at + dir * screen * 0.9));
  return (y - at) * dir > 1 ? y : null;
}
