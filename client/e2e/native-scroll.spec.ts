import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

/**
 * Native scroll (docs/design.md §6.4), opt-in with `?scroll=native`: at the zoom the page is read at,
 * a scroll moves the artifact's own document inside a frame that stays put on the screen, and the
 * camera follows where the reporter says the document is. Zooming, and panning past the page, still
 * move the frame with the camera (the transform), which is also the default without the option.
 * Fixtures: dev/artifacts/sections.html (eight sections of 700 px and a CSS animation that never stops)
 * and snap-scroll.html (the same sections on a page whose scroll lands on its own 4 px grid).
 */
const NATIVE = { scroll: 'native' };

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');
const ed = (p: Page) => p.evaluate(() => {
  const e = (window as any).__canvas.editor;
  return { native: e.nativeScrolling as boolean, cam: { ...e.camera }, vis: e.visibleWorld(), fit: e.fitZoom() as number, pageHeight: e.pageHeight as number, presenting: e.presenting as boolean };
});
const docScroll = (p: Page) => frameOf(p).locator('html').evaluate(() => window.scrollY);
const frameBox = async (p: Page) => (await p.locator('iframe.artifact-frame').boundingBox())!;
/** The frame's box on the screen is the same (to a hundredth of a px). */
function sameBox(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.01);
}

/** Where an element of the artifact is on the wrapper's screen (the frame's box and the camera's zoom). */
async function onScreen(p: Page, selector: string) {
  const f = await frameBox(p);
  const r = await frameOf(p).locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, vw: window.innerWidth };
  });
  const k = f.width / r.vw;
  return { x: f.x + r.x * k, y: f.y + r.y * k };
}

/** Wheel the stage at (x, y): `n` steps of `dy` screen px. */
async function wheel(p: Page, dy: number, n = 1, x = 720, y = 450) {
  await p.mouse.move(x, y);
  for (let i = 0; i < n; i++) await p.mouse.wheel(0, dy);
}

/** The camera has stood still (the last scroll answered) for 300 ms. */
async function settle(p: Page) {
  let last = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await p.evaluate(() => [(window as any).__canvas.editor.camera, (window as any).__canvas.editor.intendedCamera()]));
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [300] }).toBe(true);
}

test('the default view scrolls the artifact natively: the frame stays put, the drawings stay on the page, a follower agrees', async ({ browser }) => {
  const room = newRoom('native');
  const A = await open(browser, 'Ana', room, { artifact: 'sections.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  const e0 = await ed(p);
  expect(e0.cam.z).toBeCloseTo(e0.fit, 6);
  // the frame is a window as tall as the view, not the page
  const f0 = await frameBox(p);
  expect(f0.height).toBeGreaterThanOrEqual(900);
  expect(f0.height).toBeLessThan(905);
  expect(await docScroll(p)).toBe(0);

  // a stroke on the first section
  await p.keyboard.press('d');
  await p.mouse.move(400, 300);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(400 + i * 20, 300 + (i % 2) * 10);
  await p.mouse.up();
  await p.keyboard.press('v');
  const stroke = p.locator('svg.shapes [data-shape-type="draw"]').first();
  const offset = async () => {
    const s = (await stroke.boundingBox())!;
    const h = await onScreen(p, '#s1 h2');
    return { x: s.x - h.x, y: s.y - h.y };
  };
  const o0 = await offset();

  // the follower, in a window of the same size: it shows what Ana shows
  const B = await open(browser, 'Marta', room, { artifact: 'sections.html', fit: true, query: NATIVE });
  await expect.poll(async () => (await ed(B.page)).native).toBe(true);
  await B.page.evaluate(() => (window as any).__canvas.editor.follow('dev:Ana'));

  // ten wheel steps of 80 px: the document scrolls, the frame does not move
  await wheel(p, 80, 10);
  await settle(p);
  const e1 = await ed(p);
  expect(e1.native).toBe(true);
  const y1 = await docScroll(p);
  expect(Math.abs(y1 - 800 / e1.cam.z)).toBeLessThan(2);
  expect(Math.abs(e1.vis.y - y1)).toBeLessThan(0.5);
  sameBox(await frameBox(p), f0);
  // the drawing kept its place on the page
  const o1 = await offset();
  expect(Math.abs(o1.x - o0.x)).toBeLessThan(1.5);
  expect(Math.abs(o1.y - o0.y)).toBeLessThan(1.5);
  // the follower shows the same part of the page, natively too
  await expect.poll(async () => Math.abs((await ed(B.page)).vis.y - e1.vis.y)).toBeLessThan(2);
  expect((await ed(B.page)).native).toBe(true);
  await expect.poll(async () => Math.abs((await docScroll(B.page)) - y1)).toBeLessThan(2);
  const [ha, hb] = [await onScreen(p, '#s2 h2'), await onScreen(B.page, '#s2 h2')];
  expect(Math.abs(ha.y - hb.y)).toBeLessThan(3);
  // and sees the stroke on the same place of the page
  const sb = (await B.page.locator('svg.shapes [data-shape-type="draw"]').first().boundingBox())!;
  expect(Math.abs(sb.y - (await onScreen(B.page, '#s1 h2')).y - o0.y)).toBeLessThan(2);

  // past the page top the camera pans on (the transform), and back into the page it scrolls natively again
  await wheel(p, -400, 4);
  await settle(p);
  const e2 = await ed(p);
  expect(e2.native).toBe(false);
  expect(e2.vis.y).toBeLessThan(-100);
  expect(await docScroll(p)).toBe(0);
  const o2 = await offset();
  expect(Math.abs(o2.y - o0.y)).toBeLessThan(1.5);
  await wheel(p, 400, 6);
  await settle(p);
  expect((await ed(p)).native).toBe(true);
  expect(Math.abs((await ed(p)).vis.y - (await docScroll(p)))).toBeLessThan(0.5);
  const o3 = await offset();
  expect(Math.abs(o3.y - o0.y)).toBeLessThan(1.5);

  // page keys scroll it too
  const before = await docScroll(p);
  await p.mouse.click(720, 450); // focus on the board, nothing under it
  await p.keyboard.press('PageDown');
  await settle(p);
  expect(await docScroll(p)).toBeGreaterThan(before + 400);
  await p.keyboard.press('Home');
  await settle(p);
  expect(await docScroll(p)).toBe(0);
  expect((await ed(p)).native).toBe(true);
  await B.close();
  await A.close();
});

test('without the option the reading zoom pans with the transform: the frame moves, the document never scrolls', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-off'), { artifact: 'sections.html', fit: true });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).pageHeight).toBeGreaterThan(5000);
  const f0 = await frameBox(p);
  expect(f0.height / (await ed(p)).cam.z).toBeGreaterThan((await ed(p)).pageHeight - 2);
  await wheel(p, 80, 5);
  await settle(p);
  const e = await ed(p);
  expect(e.native).toBe(false);
  expect(Math.abs(e.vis.y - 400 / e.cam.z)).toBeLessThan(2);
  expect(await docScroll(p)).toBe(0);
  expect(Math.abs((await frameBox(p)).y - (f0.y - 400))).toBeLessThan(1);
  await A.close();
});

test('a zoom still moves the frame with the camera; back at the reading zoom the page scrolls natively', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-zoom'), { artifact: 'sections.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  await wheel(p, 100, 6);
  await settle(p);
  const line = (await ed(p)).vis.y;
  // ctrl + wheel (a trackpad pinch): the zoom changes, the frame is as tall as the page again
  await p.keyboard.down('Control');
  await p.mouse.wheel(0, -120);
  await p.keyboard.up('Control');
  await settle(p);
  const z = await ed(p);
  expect(z.native).toBe(false);
  expect(z.cam.z).toBeGreaterThan(z.fit * 1.1);
  expect(await docScroll(p)).toBe(0);
  const f = await frameBox(p);
  expect(f.height / z.cam.z).toBeGreaterThan(z.pageHeight - 2);
  // the artifact still sits where the camera says (its section 2 heading at world y 700 + 48)
  const h = await onScreen(p, '#s2 h2');
  expect(Math.abs(h.y - (748 * z.cam.z + z.cam.ty))).toBeLessThan(2);
  // the zoom buttons too
  await p.getByTestId('zoom-out').click();
  await settle(p);
  expect((await ed(p)).native).toBe(false);
  // back to the reading zoom at the same line: native again, at that line
  await p.evaluate((line) => {
    const e = (window as any).__canvas.editor;
    const zf = e.fitZoom();
    e.setCamera({ z: zf, tx: (e.viewW - e.pageWidth * zf) / 2, ty: -line * zf });
  }, line);
  await settle(p);
  expect((await ed(p)).native).toBe(true);
  expect(Math.abs((await docScroll(p)) - line)).toBeLessThan(1);
  await A.close();
});

test('a deck steps in both modes, and its own navigation in native scroll moves the followers too', async ({ browser }) => {
  const room = newRoom('native-deck');
  const A = await open(browser, 'Ana', room, { artifact: 'slide-deck.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  const tops = await frameOf(p).locator('.slide').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top + window.scrollY));
  const atTop = async () => {
    const v = await p.evaluate(() => {
      const e = (window as any).__canvas.editor;
      return e.visibleWorld().y + 48 / e.camera.z;
    });
    return tops.findIndex((y) => Math.abs(y - v) < 3) + 1;
  };
  await p.evaluate(() => (window as any).__canvas.editor.setPresenting(true, true));
  await settle(p);
  expect(await atTop()).toBe(1);
  // the presentation's zoom is the one the page is read at: stepping scrolls natively
  await p.keyboard.press('PageDown');
  await expect.poll(atTop).toBe(2);
  await p.keyboard.press('PageDown');
  await expect.poll(atTop).toBe(3);
  await settle(p);
  expect((await ed(p)).native).toBe(true);
  expect(Math.abs((await docScroll(p)) - (await ed(p)).vis.y)).toBeLessThan(0.5);
  // zoomed in (the transform): the steps still land on the slides
  await p.evaluate(() => (window as any).__canvas.editor.zoomBy(1));
  await settle(p);
  expect((await ed(p)).native).toBe(false);
  await p.keyboard.press('PageDown');
  await expect.poll(atTop).toBe(4);
  await p.keyboard.press('PageUp');
  await expect.poll(atTop).toBe(3);
  await p.evaluate(() => (window as any).__canvas.editor.setPresenting(false));
  await A.close();

  // a deck's own navigation (scroll-deck.html: its arrow keys call scrollIntoView) with native scroll:
  // the document scrolls, the camera follows it, and so does whoever follows
  const P = await open(browser, 'Pablo', room + '-own', { artifact: 'scroll-deck.html', fit: true, query: NATIVE });
  const F = await open(browser, 'Flor', room + '-own', { artifact: 'scroll-deck.html', fit: true, query: NATIVE });
  await expect.poll(async () => (await ed(P.page)).native).toBe(true);
  await F.page.evaluate(() => (window as any).__canvas.editor.follow('dev:Pablo'));
  await P.page.keyboard.press('i');
  const s1 = await onScreen(P.page, '#s1 p');
  await P.page.mouse.click(s1.x + 20, s1.y + 8);
  await P.page.keyboard.press('ArrowDown');
  const s2 = await frameOf(P.page).locator('#s2').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await expect.poll(async () => Math.abs((await ed(P.page)).vis.y - s2)).toBeLessThan(2);
  expect((await ed(P.page)).native).toBe(true);
  expect(Math.abs((await docScroll(P.page)) - s2)).toBeLessThan(2);
  await expect.poll(async () => Math.abs((await ed(F.page)).vis.y - s2)).toBeLessThan(3);
  await F.close();
  await P.close();
});

/** The last scroll request has been answered (none on its way). */
const answered = (p: Page) => expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.scrollWant === null)).toBe(true);
/** The line the next move starts from (the intended camera's top, artifact px). */
const intendedLine = (p: Page) => p.evaluate(() => {
  const c = (window as any).__canvas.editor.intendedCamera();
  return -c.ty / c.z;
});

test('a page that lands each scroll up to 2 px off (its own grid) does not drift: the steps add up to the line asked for', async ({ browser }) => {
  // dev/artifacts/snap-scroll.html: every window.scrollTo lands on the page's 4 px grid
  const A = await open(browser, 'Ana', newRoom('native-snap'), { artifact: 'snap-scroll.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  // past the period's first second (a request that lands off waits for the window until then)
  await p.waitForTimeout(1100);
  await p.mouse.move(720, 450);
  // each step answered before the next: it starts from the line last asked for, not from the grid's
  for (let i = 0; i < 10; i++) {
    await p.mouse.wheel(0, 80);
    await answered(p);
  }
  await settle(p);
  const e = await ed(p);
  expect(e.native).toBe(true);
  const want = 800 / e.cam.z;
  const y = await docScroll(p);
  expect(y % 4).toBe(0);
  expect(Math.abs(y - want)).toBeLessThanOrEqual(2);
  // the camera shows where the document is, and the next move starts from the line asked for
  expect(Math.abs(e.vis.y - y)).toBeLessThan(0.5);
  expect(Math.abs((await intendedLine(p)) - want)).toBeLessThan(0.01);
  // a step back up adds up the same way
  for (let i = 0; i < 4; i++) {
    await p.mouse.wheel(0, -80);
    await answered(p);
  }
  await settle(p);
  expect(Math.abs((await intendedLine(p)) - 480 / e.cam.z)).toBeLessThan(0.01);
  expect(Math.abs((await docScroll(p)) - 480 / e.cam.z)).toBeLessThanOrEqual(2);
  expect((await ed(p)).native).toBe(true);
  await A.close();
});

test('a page that scrolls itself in the first second of a period is followed at once', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-self'), { artifact: 'snap-scroll.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  // zoomed in (the transform): the frame is as tall as the page, the document at its top
  await p.evaluate(() => (window as any).__canvas.editor.zoomBy(1));
  await settle(p);
  expect((await ed(p)).native).toBe(false);
  await p.waitForTimeout(300);
  const s4 = await frameOf(p).locator('#s4').evaluate((el) => (el as HTMLElement).offsetTop);
  // the page goes to its fourth section by itself 150 ms after its window next changes size (the
  // window of a new period)
  await frameOf(p).locator('html').evaluate(() => {
    addEventListener('resize', () => setTimeout(() => document.getElementById('s4')!.scrollIntoView(), 150), { once: true });
  });
  // back to the reading zoom at line 102: the grid lands the request 2 px off, so the reporter waits
  // for the window (up to 1 s); the page's own scroll meanwhile is said at once
  const ms = await p.evaluate(async (s4) => {
    const e = (window as any).__canvas.editor;
    const z = e.fitZoom();
    const t0 = performance.now();
    e.setCamera({ z, tx: (e.viewW - e.pageWidth * z) / 2, ty: -102 * z });
    while (performance.now() - t0 < 3000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (Math.abs(e.visibleWorld().y - s4) < 2) return performance.now() - t0;
    }
    return -1;
  }, s4);
  console.log(`SELF-SCROLL followed after ${ms.toFixed(0)} ms`);
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(800);
  await settle(p);
  expect((await ed(p)).native).toBe(true);
  expect(Math.abs((await docScroll(p)) - s4)).toBeLessThan(2);
  expect(Math.abs((await ed(p)).vis.y - s4)).toBeLessThan(2);
  // the request it overtook is not applied after it: the document stays where the page put it
  await p.waitForTimeout(1200);
  expect(Math.abs((await docScroll(p)) - s4)).toBeLessThan(2);
  expect(Math.abs((await ed(p)).vis.y - s4)).toBeLessThan(2);
  await A.close();
});

// In the artifact's frame, before the reporter: a `scroll-to` is dropped while window.__dropScrollTo is set
// (a document on its way out that never answers).
const dropScrollTo = `(() => {
  if (window === window.top) return;
  addEventListener('message', (e) => {
    if (window.__dropScrollTo && e.data && e.data.type === 'scroll-to') e.stopImmediatePropagation();
  });
})();`;

test('the frame reloads with a scroll request on its way: the view stays where it was, and the next step starts from there', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-reload'), { artifact: 'sections.html', fit: true, query: NATIVE, initScript: dropScrollTo });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  await wheel(p, 80, 10);
  await settle(p);
  const line = (await ed(p)).vis.y;
  expect(line).toBeGreaterThan(400);
  // the document stops answering (it is on its way out) and a request goes out
  await frameOf(p).locator('html').evaluate(() => {
    (window as any).__dropScrollTo = true;
    (window as any).__old = true;
  });
  expect(await p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    e.panBy(0, -300);
    return e.scrollWant;
  })).not.toBeNull();
  await p.waitForTimeout(200);
  expect(await p.evaluate(() => (window as any).__canvas.editor.scrollWant)).not.toBeNull();
  expect(Math.abs((await docScroll(p)) - line)).toBeLessThan(2);
  // the page reloads itself
  await frameOf(p).locator('html').evaluate(() => { setTimeout(() => location.reload(), 0); });
  await expect.poll(async () => {
    try {
      return await frameOf(p).locator('html').evaluate(() => !(window as any).__old && document.readyState === 'complete');
    } catch {
      return false;
    }
  }).toBe(true);
  await expect.poll(async () => Math.abs((await docScroll(p)) - line)).toBeLessThan(2);
  await settle(p);
  const e = await ed(p);
  expect(e.native).toBe(true);
  expect(Math.abs(e.vis.y - line)).toBeLessThan(1);
  expect(await p.evaluate(() => (window as any).__canvas.editor.scrollWant)).toBeNull();
  // the next step starts from the line on the screen, not from the request the old document lost
  await wheel(p, 80, 1);
  await settle(p);
  expect(Math.abs((await ed(p)).vis.y - (line + 80 / e.cam.z))).toBeLessThan(2);
  expect(Math.abs((await docScroll(p)) - (line + 80 / e.cam.z))).toBeLessThan(2);
  await A.close();
});

test('per step: the zoom % is not written again, and no presence goes out while nobody follows', async ({ browser }) => {
  const room = newRoom('native-churn');
  const A = await open(browser, 'Ana', room, { artifact: 'sections.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  await p.evaluate(() => {
    const w = window as any;
    const e = w.__canvas.editor;
    w.__churn = { pct: 0, presence: 0, local: 0, paints: 0 };
    new MutationObserver((l) => (w.__churn.pct += l.length)).observe(document.querySelector('[data-testid="zoom-pct"]')!, { childList: true, characterData: true, subtree: true });
    e.on('presence', () => w.__churn.presence++);
    e.conn.awareness.on('change', (_c: unknown, origin: unknown) => { if (origin === 'local') w.__churn.local++; });
  });
  const churn = () => p.evaluate(() => ({ ...(window as any).__churn }));
  await p.waitForTimeout(1200); // the viewport of the first camera has gone out
  await p.evaluate(() => Object.assign((window as any).__churn, { pct: 0, presence: 0, local: 0 }));
  const t0 = Date.now();
  // 1.5 s of wheel steps (native scroll; the pointer stands still, as on a trackpad) and of a
  // scripted pan (the transform, the classic camera)
  await p.mouse.move(720, 450);
  await p.waitForTimeout(1100);
  await p.evaluate(() => Object.assign((window as any).__churn, { local: 0 }));
  for (let i = 0; i < 30; i++) {
    await p.mouse.wheel(0, 40);
    await p.waitForTimeout(25);
  }
  await settle(p);
  await p.evaluate(async () => {
    const e = (window as any).__canvas.editor;
    e.setCamera({ z: 1, tx: (e.viewW - e.pageWidth) / 2, ty: 70 }, 'system');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      e.panBy(0, -10);
    }
  });
  await settle(p);
  const c = await churn();
  const seconds = (Date.now() - t0) / 1000;
  // one write for the change to 100 %, none per step
  expect(c.pct).toBeLessThanOrEqual(2);
  // this tab's own viewport changes nothing the chrome shows, and goes out at most once a second
  expect(c.presence).toBe(0);
  expect(c.local).toBeLessThanOrEqual(Math.ceil(seconds) + 1);
  console.log(`CHURN zoom % writes ${c.pct}, presence renders ${c.presence}, own awareness changes ${c.local} in ${seconds.toFixed(1)} s`);

  // somebody follows: the viewport goes out at the send rate
  const B = await open(browser, 'Marta', room, { artifact: 'sections.html', fit: true, query: NATIVE });
  await B.page.evaluate(() => (window as any).__canvas.editor.follow('dev:Ana'));
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.followed)).toBe(true);
  await p.evaluate(() => Object.assign((window as any).__churn, { local: 0 }));
  await p.evaluate(async () => {
    const e = (window as any).__canvas.editor;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      e.panBy(0, -5);
    }
  });
  await settle(p);
  expect((await churn()).local).toBeGreaterThanOrEqual(8);
  await B.close();
  await A.close();
});

test('a tab whose identity comes after the room\'s presence still knows that a peer follows it', async ({ browser }) => {
  const room = newRoom('followed-late');
  const A = await open(browser, 'Ana', room, { artifact: 'sections.html', fit: true });
  const M = await open(browser, 'Marta', room, { artifact: 'sections.html', fit: true });
  await M.page.evaluate(() => (window as any).__canvas.editor.follow('dev:Ana'));
  await expect.poll(() => A.page.evaluate(() => (window as any).__canvas.editor.followed)).toBe(true);
  await A.page.waitForTimeout(1000); // the follower's own viewport has gone out
  // Ana's second tab: Marta's presence (following Ana) is in before its identity
  const A2 = await open(browser, 'Ana', room, { artifact: 'sections.html', fit: true, holdIdentityMs: 800 });
  await expect.poll(() => A2.page.evaluate(() => (window as any).__canvas.editor.followed)).toBe(true);
  // so its viewport goes out at the send rate
  await A2.page.evaluate(() => {
    const w = window as any;
    w.__local = 0;
    w.__canvas.editor.conn.awareness.on('change', (_c: unknown, origin: unknown) => { if (origin === 'local') w.__local++; });
  });
  await A2.page.evaluate(async () => {
    const e = (window as any).__canvas.editor;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      e.panBy(0, -5);
    }
  });
  await settle(A2.page);
  expect(await A2.page.evaluate(() => (window as any).__local)).toBeGreaterThanOrEqual(8);
  await A2.close();
  await M.close();
  await A.close();
});

test('the page\'s CSS animations pause while the camera moves or the page scrolls, and go on after', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-anim'), { artifact: 'sections.html', fit: true, query: NATIVE });
  const p = A.page;
  await expect.poll(async () => (await ed(p)).native).toBe(true);
  const state = () => frameOf(p).locator('html').evaluate(() => document.getAnimations().map((a) => a.playState));
  await expect.poll(state).toEqual(['running']);
  const time = () => frameOf(p).locator('html').evaluate(() => Number(document.getAnimations()[0].currentTime));
  // native scroll
  await p.mouse.move(720, 450);
  await p.mouse.wheel(0, 60);
  await expect.poll(state, { timeout: 2000, intervals: [20] }).toEqual(['paused']);
  await expect.poll(state, { timeout: 3000 }).toEqual(['running']);
  // the transform (a scripted pan at another zoom)
  const during = p.evaluate(async () => {
    const e = (window as any).__canvas.editor;
    e.setCamera({ z: 1, tx: 100, ty: 0 }, 'system');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      e.panBy(0, -8);
    }
  });
  await expect.poll(state, { timeout: 2000, intervals: [20] }).toEqual(['paused']);
  const held = await time();
  await during;
  await expect.poll(state, { timeout: 3000 }).toEqual(['running']);
  // it goes on from where it was held, not from its start
  expect(await time()).toBeGreaterThanOrEqual(held);
  // hidden (the page as itself): nothing is held
  await p.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(false));
  await p.mouse.move(720, 450);
  await p.mouse.wheel(0, 200);
  await p.waitForTimeout(100);
  expect(await state()).toEqual(['running']);
  await A.close();
});

// The reporter's wheel listener may cancel the wheel (canvas mode); with the canvas hidden the page
// scrolls itself and a listener that may cancel made every first wheel event wait for the page.
const wheelProbe = `(() => {
  if (window === window.top) return;
  const live = new Set();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (this === window && type === 'wheel' && !(opts && opts.passive)) live.add(fn);
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (this === window && type === 'wheel') live.delete(fn);
    return remove.call(this, type, fn, opts);
  };
  window.__wheelBlocking = () => live.size;
})();`;

test('with the canvas hidden the page has no wheel listener that may cancel; shown, it has one', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-wheel'), { artifact: 'sections.html', query: { canvas: '0' }, initScript: wheelProbe });
  const p = A.page;
  const blocking = () => frameOf(p).locator('html').evaluate(() => (window as any).__wheelBlocking());
  await expect.poll(blocking).toBe(0);
  await p.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(true));
  await expect.poll(blocking).toBe(1);
  await p.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(false));
  await expect.poll(blocking).toBe(0);
  await A.close();
});
