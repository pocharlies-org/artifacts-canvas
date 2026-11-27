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
    const wall0 = Date.now();
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
      wall: [wall0, Date.now()],
    };
  }, ms);
}

// A heavy page (dev/artifacts/heavy-page.html): a WebGL scene sized to innerWidth x innerHeight and
// redrawn on every frame, script work on every frame, sections revealed by an IntersectionObserver
// and a video. In canvas mode the frame is as tall as the page: innerHeight was the page's height
// (a scene thousands of pixels tall), and every camera move waited for the page's frame
// (docs/protocol.md §3 "Camera motion"). The gates, in the same browser (see above for why the
// fps is relative and loose): the scene is one reference screen; the page's animation frames wait
// while the camera moves and run once it stands still; a pan over it keeps 70 % of the frame rate
// of a pan over a plain page (in a real Chrome window: 118 against 120 fps, perf numbers in
// docs/known-issues.md L-12), with at most one long task.
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
  const heavy = await pan(H.page);
  const after = await state();
  // held while the camera moved: no frame of the page from 150 ms into the pan (the first `motion`
  // message on its way) to its end
  const during = after.at.filter((t: number) => t > heavy.wall[0] + 150 && t <= heavy.wall[1]).length;
  expect(during).toBeLessThanOrEqual(1);
  // and running again once it stands still
  await expect.poll(async () => (await state()).frames, { timeout: 5000 }).toBeGreaterThan(after.frames + 5);
  console.log(`PERF pan over a plain page: ${light.fps} fps, p95 frame ${light.p95FrameMs} ms; over the heavy page: ${heavy.fps} fps, p95 frame ${heavy.p95FrameMs} ms, ${heavy.longTasks} long tasks, ${during} page frames during the pan; scene ${s.w}x${s.h}`);
  expect(heavy.longTasks).toBeLessThanOrEqual(1);
  expect(heavy.fps).toBeGreaterThanOrEqual(Math.floor(light.fps * 0.7));
  // the frame-time budget: the slowest 5 % of the pan's frames take at most two frames of the
  // plain page's (at 60 Hz, 34 ms: before this fix a real Chrome window dropped to 34 ms at 120 Hz)
  expect(heavy.p95FrameMs).toBeLessThanOrEqual(Math.max(light.p95FrameMs, 1000 / 60) * 2 + 1);
  await H.close();
});

// The hold keeps the browser's rules for the page's frames (docs/protocol.md §3 "Camera motion"):
// held while the camera moves, then run in one frame in the order they were asked for; one
// cancelled while held, or by a callback of the same flush, never runs. And a page that cancels
// frame ids it never got (here, every id around its own, all the time) cannot cancel the flush:
// its held loops would wait for good.
test('held animation frames run once the camera stands still, in order, and the page cannot cancel the flush', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('perf-hold'));
  const f = A.page.frameLocator('iframe.artifact-frame').locator('html');
  const panning = pan(A.page, 1500);
  await A.page.waitForTimeout(400); // the camera moves: the first `motion` message is in
  await f.evaluate(() => {
    const w = window as any;
    const log: { k: string; t: number; at: number }[] = (w.__hold = []);
    const note = (k: string) => (t: number) => log.push({ k, t, at: Date.now() });
    let c = 0;
    const a = requestAnimationFrame((t) => {
      note('a')(t);
      cancelAnimationFrame(c); // cancelled by a callback of the same flush
    });
    const b = requestAnimationFrame(note('b'));
    c = requestAnimationFrame(note('c'));
    const d = requestAnimationFrame(note('d'));
    setTimeout(() => cancelAnimationFrame(d), 100); // cancelled while held
    // between any two tasks (a message loop, not a clamped timer) until the camera has long
    // stood still: whatever frame the reporter asks for, this cancels it before it comes
    const mine = new Set([a, b, c, d]);
    const stopAt = Date.now() + 3500;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (Date.now() > stopAt) return;
      const p = requestAnimationFrame(() => {});
      for (let i = Math.max(1, p - 50); i <= p + 50; i++) if (!mine.has(i)) cancelAnimationFrame(i);
      ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
  });
  const p = await panning;
  await expect.poll(() => f.evaluate(() => (window as any).__hold.map((x: { k: string }) => x.k)), { timeout: 5000 }).toEqual(['a', 'b']);
  const log = await f.evaluate(() => (window as any).__hold as { k: string; t: number; at: number }[]);
  expect(log[0].t).toBe(log[1].t); // in one frame
  expect(log[0].at).toBeGreaterThan(p.wall[1]); // after the camera stood still
  await A.close();
});

// Native scroll (docs/design.md §6.4, known issues L-13): at the zoom the page is read at, a wheel
// scrolls the page's own document in a frame that stays put, so no step of the scroll waits for the
// frame to be drawn again where the camera moved it. The gate is structural (headless frame timing
// is noise, see above): the frame's box on the screen is the same on every frame of a wheel scroll
// over the heavy page, the document scrolled, and the page's animation frames were held meanwhile.
test('the default view scrolls the heavy page natively: the frame never moves during a wheel scroll', async ({ browser }) => {
  const H = await open(browser, 'Ana', newRoom('perf-native'), { artifact: 'heavy-page.html', fit: true });
  const p = H.page;
  const f = p.frameLocator('iframe.artifact-frame').locator('html');
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.nativeScrolling)).toBe(true);
  await expect.poll(() => f.evaluate(() => (window as any).__heavy.frames)).toBeGreaterThan(5);
  await p.evaluate(() => {
    const w = window as any;
    const el = document.querySelector('iframe.artifact-frame')!;
    w.__boxes = new Set<string>();
    w.__stop = false;
    const tick = () => {
      const b = el.getBoundingClientRect();
      w.__boxes.add([b.x, b.y, b.width, b.height].map((v) => v.toFixed(2)).join(','));
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const wall0 = Date.now();
  await p.mouse.move(720, 450);
  for (let i = 0; i < 40; i++) await p.mouse.wheel(0, 30);
  const wall1 = Date.now();
  await expect.poll(() => f.evaluate(() => window.scrollY)).toBeGreaterThan(600);
  const boxes = await p.evaluate(() => {
    const w = window as any;
    w.__stop = true;
    return [...w.__boxes];
  });
  expect(boxes).toHaveLength(1);
  expect(await p.evaluate(() => (window as any).__canvas.editor.nativeScrolling)).toBe(true);
  // the camera is where the document is
  const [vy, sy] = [await p.evaluate(() => (window as any).__canvas.editor.visibleWorld().y), await f.evaluate(() => window.scrollY)];
  expect(Math.abs(vy - sy)).toBeLessThan(0.5);
  // held while it scrolled (the first `motion` message on its way: 150 ms)
  const at: number[] = await f.evaluate(() => (window as any).__heavy.at);
  const during = at.filter((t) => t > wall0 + 150 && t <= wall1).length;
  console.log(`PERF native scroll over the heavy page: ${boxes.length} frame position(s), ${during} page frames during ${wall1 - wall0} ms of wheel`);
  expect(during).toBeLessThanOrEqual(Math.max(2, Math.ceil((wall1 - wall0) / 250)));
  await H.close();
});
