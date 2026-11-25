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
  const A = await open(browser, 'Ana', newRoom('perf'));
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

/** A scripted vertical pan of `ms` (the camera moves on every frame, as a wheel or a drag does). */
async function pan(p: import('@playwright/test').Page, ms = 2000) {
  return p.evaluate(async (ms) => {
    const e = (window as any).__canvas.editor;
    const long: number[] = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((x) => long.push(x.duration)));
    po.observe({ type: 'longtask' });
    const frames: number[] = [];
    const c0 = { ...e.camera };
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        frames.push(t);
        const k = (t - t0) / 1000;
        e.setCamera({ z: c0.z, tx: c0.tx, ty: c0.ty - 300 * k }, 'user');
        if (t - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    po.disconnect();
    const deltas = frames.slice(1).map((f, i) => f - frames[i]).sort((a, b) => a - b);
    return {
      fps: Math.round((frames.length - 1) / ((frames.at(-1)! - frames[0]) / 1000)),
      p95FrameMs: Math.round(deltas[Math.floor(deltas.length * 0.95)] * 10) / 10,
      longTasks: long.length,
    };
  }, ms);
}

// A heavy page (dev/artifacts/heavy-page.html): a WebGL scene sized to innerWidth x innerHeight and
// redrawn on every frame, script work on every frame, sections revealed by an IntersectionObserver
// and a video. In canvas mode the frame is as tall as the page: innerHeight was the page's height
// (a scene thousands of pixels tall), and every camera move waited for the page's frame
// (docs/protocol.md §3 "Camera motion"). The gates, in the same browser (see above for why the
// fps is relative): the scene is one reference screen; the page's animation frames wait while the
// camera moves and run once it stands still; a pan over it keeps 85 % of the frame rate of a pan
// over a plain page, with no long task.
test('a heavy page: the scene is one screen, and a pan does not wait for the page\'s animation', async ({ browser }) => {
  const frame = (p: import('@playwright/test').Page) => p.frameLocator('iframe.artifact-frame').locator('html');
  const L = await open(browser, 'Ana', newRoom('perf-light'));
  await pan(L.page, 500); // warm up
  const light = await pan(L.page);
  await L.close();

  const H = await open(browser, 'Ana', newRoom('perf-heavy'), { artifact: 'heavy-page.html' });
  const state = () => frame(H.page).evaluate(() => ({ ...(window as any).__heavy, dpr: devicePixelRatio, innerH: innerHeight, docH: document.documentElement.scrollHeight }));
  await expect.poll(async () => (await state()).frames).toBeGreaterThan(5);
  const s = await state();
  const REF_H = Math.round((980 * 9) / 16);
  expect(s.gl).toBe(true);
  expect(s.innerH).toBe(REF_H);
  expect(s.cssH).toBe(REF_H);
  expect(s.h).toBeLessThanOrEqual(Math.ceil(REF_H * s.dpr));
  expect(s.docH).toBeGreaterThan(10 * REF_H); // the page itself is twelve screens

  await pan(H.page, 500); // warm up
  await H.page.waitForTimeout(400);
  const f0 = (await state()).frames;
  const heavy = await pan(H.page);
  const f1 = (await state()).frames;
  // held while the camera moved (a frame or two may run before the first `motion` message lands)
  expect(f1 - f0).toBeLessThanOrEqual(3);
  // and running again once it stands still
  await expect.poll(async () => (await state()).frames, { timeout: 5000 }).toBeGreaterThan(f1 + 5);
  console.log(`PERF pan over a plain page: ${light.fps} fps, p95 frame ${light.p95FrameMs} ms; over the heavy page: ${heavy.fps} fps, p95 frame ${heavy.p95FrameMs} ms, ${heavy.longTasks} long tasks; scene ${s.w}x${s.h}`);
  expect(heavy.longTasks).toBe(0);
  expect(heavy.fps).toBeGreaterThanOrEqual(Math.floor(light.fps * 0.85));
  await H.close();
});
