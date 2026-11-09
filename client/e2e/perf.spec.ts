import { expect, test } from '@playwright/test';
import { newRoom, open } from './helpers';

async function measure(p: import('@playwright/test').Page, ms = 3000) {
  return p.evaluate(async (ms) => {
    const e = (window as any).__canvas.editor;
    const frames: number[] = [];
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        frames.push(t);
        const k = (t - t0) / 1000;
        // pan in a circle while zooming in and out, like a user dragging and pinching
        const z = 1 + 0.6 * Math.sin(k * 3);
        e.setCamera({ z, tx: 200 + Math.cos(k * 4) * 300, ty: 50 + Math.sin(k * 4) * 300 }, 'user');
        if (t - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const deltas = frames.slice(1).map((f, i) => f - frames[i]).sort((a, b) => a - b);
    return {
      fps: Math.round((frames.length - 1) / ((frames.at(-1)! - frames[0]) / 1000)),
      p95FrameMs: Math.round(deltas[Math.floor(deltas.length * 0.95)] * 10) / 10,
    };
  }, ms);
}

// Absolute fps depends on the machine: headless Chromium without a GPU rasterises in software and
// is noisy (the empty page alone reaches 12-40 fps there, while a real Chrome window does 100+ fps
// with 2,000 shapes; run with PERF_HEADED=1 to measure that). The gates are therefore:
//   - the JavaScript cost of one camera update with 2,000 shapes (what this code controls) < 4 ms,
//   - the frame rate with 2,000 shapes is at least half of the empty page's, in the same browser.
test.use({ headless: !process.env.PERF_HEADED });
test('2,000 shapes: pan and zoom stay smooth', async ({ browser }) => {
  const A = await open(browser, 'Daniel Ibáñez', newRoom('perf'));
  const p = A.page;
  await measure(p, 500); // warm up
  const baseline = await measure(p);
  const created = await p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const kinds = ['rectangle', 'ellipse', 'star', 'cloud', 'diamond'];
    const t0 = performance.now();
    e.doc.transact(() => {
      for (let i = 0; i < 2000; i++) {
        const x = (i % 40) * 24;
        const y = Math.floor(i / 40) * 40;
        if (i % 3 === 0) {
          const pts: number[] = [];
          for (let k = 0; k < 20; k++) pts.push(k * 1.5, Math.sin(k / 2) * 6, 0.5);
          e.doc.create({ type: 'draw', x, y, w: 28.5, h: 12, ow: 28.5, oh: 12, points: pts, highlight: false, done: true, pen: false, color: 'red' });
        } else {
          e.doc.create({ type: 'geo', geo: kinds[i % kinds.length], x, y, w: 20, h: 20, text: '', color: 'blue', fill: i % 2 ? 'semi' : 'none' });
        }
      }
    });
    e.renderer.flush();
    return { n: e.doc.shapes.size, rendered: e.renderer.renderedCount(), ms: Math.round(performance.now() - t0) };
  });
  expect(created.n).toBe(2000);
  expect(created.rendered).toBe(2000);
  const jsMs = await p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) e.setCamera({ z: 1 + (i % 10) / 10, tx: i, ty: -i }, 'user');
    return (performance.now() - t0) / 200;
  });
  const fps = await measure(p);
  console.log(`PERF baseline (0 shapes): ${baseline.fps} fps, p95 frame ${baseline.p95FrameMs} ms`);
  console.log(`PERF 2000 shapes: create+render ${created.ms} ms; pan/zoom ${fps.fps} fps, p95 frame ${fps.p95FrameMs} ms`);
  console.log(`PERF JS per camera update with 2000 shapes: ${jsMs.toFixed(3)} ms`);
  expect(jsMs).toBeLessThan(4);
  expect(fps.fps).toBeGreaterThanOrEqual(Math.floor(baseline.fps * 0.5));
  if (baseline.fps >= 50) expect(fps.fps).toBeGreaterThanOrEqual(30);
  await A.close();
});
