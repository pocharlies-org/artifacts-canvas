import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

/**
 * Pages written as a deck of full-screen sections (dev/artifacts/scroll-deck.html): a root font
 * sized from vw and vh, sections of `min-height:100vh` that snap, and a script that hides the
 * sections until an IntersectionObserver reports them. In the canvas the frame is as tall as the
 * page, so `vh` grew with the page (a feedback loop up to the frame's cap), and the observer never
 * reported the sections, so they stayed hidden on the board and in presentation mode. The
 * reporter now resolves vh-family lengths against a reference screen (the frame's width, 16:9) and
 * reports every observed section as in view (docs/protocol.md §3 "Viewport units and reveal
 * scripts"). dev/artifacts/viewport-units.html covers where the units can come from.
 */

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');
const PAGE_W = 980;
/** The reference screen: the frame's width and 9/16 of it. */
const REF_H = (PAGE_W * 9) / 16;
const VH = REF_H / 100;

type Deck = { fontSize: number; innerH: number; docH: number; sections: { id: string; top: number; h: number; inClass: boolean; opacity: number[] }[]; tailH: number; jsAnim: boolean };

/** The deck's layout as the frame has it (document px). */
function deck(p: Page): Promise<Deck> {
  return frameOf(p).locator('html').evaluate((html) => ({
    fontSize: parseFloat(getComputedStyle(html).fontSize),
    innerH: window.innerHeight,
    docH: html.scrollHeight,
    jsAnim: html.classList.contains('js-anim'),
    tailH: document.getElementById('tail')!.getBoundingClientRect().height,
    sections: Array.from(document.querySelectorAll<HTMLElement>('.scr')).map((s) => ({
      id: s.id,
      top: s.getBoundingClientRect().top + window.scrollY,
      h: s.getBoundingClientRect().height,
      inClass: s.classList.contains('in'),
      opacity: Array.from(s.querySelectorAll('.rv')).map((el) => parseFloat(getComputedStyle(el).opacity)),
    })),
  }));
}

const pageHeight = (p: Page) => p.evaluate(() => (window as any).__canvas.editor.pageHeight as number);

/** Mean brightness of the brightest and the darkest 10 % of a region of the screen (viewport px). */
async function contrast(page: Page, r: { x: number; y: number; w: number; h: number }): Promise<{ top: number; bottom: number }> {
  const png = await page.screenshot();
  return page.evaluate(
    async ({ b64, r }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
      const v: number[] = [];
      for (let i = 0; i < px.length; i += 4) v.push((px[i] + px[i + 1] + px[i + 2]) / 3);
      v.sort((a, b) => a - b);
      const k = Math.max(1, Math.floor(v.length / 10));
      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      return { top: avg(v.slice(-k)), bottom: avg(v.slice(0, k)) };
    },
    { b64: png.toString('base64'), r },
  );
}

/** Bring artifact point (x, y) under the top of the view, and give the heading of `id` on screen. */
async function headingOnScreen(p: Page, id: string) {
  const top = await frameOf(p).locator(`#${id}`).evaluate((s) => s.getBoundingClientRect().top + window.scrollY);
  await p.evaluate((y) => (window as any).__canvas.editor.revealTop({ x: 490, y }), top);
  const h2 = frameOf(p).locator(`#${id} h2`);
  await expect.poll(async () => {
    const b = await h2.boundingBox();
    return !!b && b.y > 0 && b.y + b.height < p.viewportSize()!.height;
  }).toBe(true);
  return (await h2.boundingBox())!;
}

async function expectDeckOnBoard(p: Page) {
  // every section revealed (the transition has ended), one reference screen each, the font sane
  await expect.poll(async () => (await deck(p)).sections.every((s) => s.inClass && s.opacity.every((o) => o === 1))).toBe(true);
  // the layout settles (after a mode change the frame goes back to its canvas size first)
  await expect.poll(async () => {
    const d = await deck(p);
    return Math.abs(d.docH - (6 * REF_H + d.tailH)) < 4 && Math.abs((await pageHeight(p)) - d.docH) < 3;
  }).toBe(true);
  const d = await deck(p);
  expect(d.jsAnim).toBe(true); // the page did hide them: the observer revealed them
  expect(d.sections).toHaveLength(6);
  for (const s of d.sections) {
    expect(Math.abs(s.h - REF_H)).toBeLessThan(1);
    expect(s.h).toBeLessThan(d.docH / 4);
  }
  // sections follow each other, one screen apart
  d.sections.forEach((s, i) => expect(Math.abs(s.top - i * REF_H)).toBeLessThan(2));
  // max(10.5px, min(100vw / 90, 100vh / 56.25)) with the reference screen: 551.25 / 56.25 = 9.8 -> 10.5
  expect(d.fontSize).toBeCloseTo(10.5, 2);
  // the page is the six screens and the notes, nothing more: the frame is that tall
  expect(Math.abs(d.docH - (6 * REF_H + d.tailH))).toBeLessThan(4);
  expect(Math.abs((await pageHeight(p)) - d.docH)).toBeLessThan(3);
  // the frame shows the whole page, no inner scroll
  const frameH = await p.locator('iframe.artifact-frame').evaluate((f) => parseFloat((f as HTMLIFrameElement).style.height));
  expect(frameH).toBeGreaterThanOrEqual(d.docH - 2);
  // and the page's scripts read the reference screen's height, as 100vh is (protocol §3)
  expect(d.innerH).toBe(Math.round(REF_H));
}

test('a scroll-snap deck: every section shows on the board, one reference screen high, with a sane font', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('deck-board'), { artifact: 'scroll-deck.html' });
  // the reporter's messages reach the wrapper in every engine (Firefox masks ancestorOrigins as "null")
  await expect.poll(() => A.page.evaluate(() => (window as any).__canvas.editor.frame.title)).toBe('Scroll deck test page');
  await expectDeckOnBoard(A.page);
  // the page cannot scroll in the frame (the camera pans it), snapping included
  const root = await frameOf(A.page).locator('html').evaluate((h) => ({ snap: getComputedStyle(h).scrollSnapType, overflow: getComputedStyle(h).overflowY, y: window.scrollY }));
  expect(root).toEqual({ snap: 'none', overflow: 'hidden', y: 0 });
  // the last section and the notes are drawn, not only laid out
  const b = await headingOnScreen(A.page, 's6');
  const c = await contrast(A.page, { x: b.x, y: b.y, w: Math.min(b.width, 400), h: b.height });
  expect(c.top - c.bottom).toBeGreaterThan(80);
  await A.close();
});

test('presentation mode shows the sections, and a follower in a smaller window gets the same layout and view', async ({ browser }) => {
  const room = newRoom('deck-present');
  const A = await open(browser, 'Ana', room, { artifact: 'scroll-deck.html' });
  const B = await open(browser, 'Marta', room, { artifact: 'scroll-deck.html', viewport: { width: 1024, height: 640 } });
  await A.page.getByTestId('present').click();
  await expect.poll(() => A.page.evaluate(() => document.body.classList.contains('present-mode'))).toBe(true);
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  await expectDeckOnBoard(A.page);
  // the presenter goes to the fourth screen: its heading is on the screen, drawn
  const b = await headingOnScreen(A.page, 's4');
  const c = await contrast(A.page, { x: b.x, y: b.y, w: Math.min(b.width, 500), h: b.height });
  expect(c.top - c.bottom).toBeGreaterThan(80);
  // the follower sees the same part of the page, laid out the same way
  const view = (p: Page) => p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const v = e.visibleWorld();
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  });
  await expect.poll(async () => {
    const [va, vb] = [await view(A.page), await view(B.page)];
    return Math.abs(va.x - vb.x) < 2 && Math.abs(va.y - vb.y) < 2;
  }).toBe(true);
  const [da, db] = [await deck(A.page), await deck(B.page)];
  expect(db.docH).toBeCloseTo(da.docH, 0);
  expect(db.fontSize).toBe(da.fontSize);
  expect(db.sections.map((s) => [s.top, s.h])).toEqual(da.sections.map((s) => [s.top, s.h]));
  expect(db.sections.every((s) => s.inClass && s.opacity.every((o) => o === 1))).toBe(true);
  await A.page.keyboard.press('Escape');
  await A.close();
  await B.close();
});

test("a deck's own navigation (arrow keys, scrollIntoView) moves the camera, not the canvas under it, and the followers follow", async ({ browser, browserName }) => {
  const room = newRoom('deck-nav');
  const A = await open(browser, 'Ana', room, { artifact: 'scroll-deck.html' });
  const B = await open(browser, 'Marta', room, { artifact: 'scroll-deck.html', viewport: { width: 1024, height: 640 } });
  await A.page.getByTestId('present').click();
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  await expectDeckOnBoard(A.page);
  const state = (p: Page) => p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const v = e.visibleWorld();
    return { stage: [e.stage.scrollLeft, e.stage.scrollTop], top: v.y, cx: v.x + v.w / 2, cy: v.y + v.h / 2 };
  });
  const before = await state(A.page);
  // the presenter uses the page: a click in it, then the deck's own key
  await A.page.getByTestId('present-tool-interact').click();
  await frameOf(A.page).locator('#s1 p').click();
  await A.page.keyboard.press('ArrowDown');
  if (browserName === 'webkit') {
    // WebKit keeps the scrollIntoView of a cross-origin frame inside the frame: nothing reaches the
    // canvas, so nothing moves (the deck's arrows do nothing there), and nothing is out of step
    await A.page.waitForTimeout(1500);
    const st = await state(A.page);
    expect(st.stage).toEqual([0, 0]);
    expect(st.top).toBeCloseTo(before.top, 1);
    await A.close();
    await B.close();
    return;
  }
  // the deck scrolls the next screen into view: the scroll reaches the stage, and becomes a camera move.
  // Its script takes the screen whose top is above the middle of its screen (innerHeight / 2, the
  // reference screen's in canvas mode: protocol §3) as the current one, the first: the next is the second
  const s2 = await frameOf(A.page).locator('#s2').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await expect.poll(async () => {
    const st = await state(A.page);
    return st.stage[0] === 0 && st.stage[1] === 0 && Math.abs(st.top - s2) < 3;
  }).toBe(true);
  expect((await state(A.page)).top).not.toBe(before.top);
  // what the presenter sees is where the camera is: the second heading at the top of the screen
  const h = (await frameOf(A.page).locator('#s2 h2').boundingBox())!;
  expect(h.y).toBeGreaterThanOrEqual(0);
  expect(h.y).toBeLessThan(A.page.viewportSize()!.height / 2);
  // the follower sees the same part of the page, and its own canvas did not scroll
  await expect.poll(async () => {
    const [a, b] = [await state(A.page), await state(B.page)];
    return Math.abs(a.cx - b.cx) < 2 && Math.abs(a.cy - b.cy) < 2 && b.stage[0] === 0 && b.stage[1] === 0;
  }).toBe(true);
  await A.page.keyboard.press('Escape');
  await A.close();
  await B.close();
});

test('viewers with different windows (desktop, small, phone) get the same layout, so drawings stay on their element', async ({ browser, browserName }) => {
  const room = newRoom('deck-viewers');
  const sizes = [{ width: 1440, height: 900 }, { width: 1100, height: 600 }, { width: 1920, height: 1080 }];
  const tabs = [];
  for (const [i, viewport] of sizes.entries()) tabs.push(await open(browser, `V${i}`, room, { artifact: 'scroll-deck.html', viewport }));
  // Firefox has no mobile emulation: a phone-sized window
  tabs.push(await open(browser, 'Phone', room, { artifact: 'scroll-deck.html', viewport: { width: 390, height: 844 }, mobile: browserName !== 'firefox' }));
  const layouts = [];
  for (const t of tabs) {
    await expect.poll(async () => (await deck(t.page)).sections.every((s) => s.inClass)).toBe(true);
    layouts.push(await deck(t.page));
  }
  for (const l of layouts.slice(1)) {
    expect(l.fontSize).toBe(layouts[0].fontSize);
    expect(l.docH).toBe(layouts[0].docH);
    expect(l.sections.map((s) => [s.top, s.h])).toEqual(layouts[0].sections.map((s) => [s.top, s.h]));
  }
  // a stroke drawn by the first viewer over the third heading is over the third heading for the others
  const h2Top = await frameOf(tabs[0].page).locator('#s3 h2').evaluate((h) => h.getBoundingClientRect().top + window.scrollY);
  for (const t of tabs.slice(1)) {
    expect(await frameOf(t.page).locator('#s3 h2').evaluate((h) => h.getBoundingClientRect().top + window.scrollY)).toBe(h2Top);
  }
  for (const t of tabs) await t.close();
});

test('canvas hidden: the page is itself (real viewport units, its own scrolling); shown again: the reference screen', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('deck-native'), { artifact: 'scroll-deck.html' });
  await expectDeckOnBoard(A.page);
  await A.page.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(false));
  await expect.poll(async () => {
    const d = await deck(A.page);
    return d.sections.every((s) => Math.abs(s.h - d.innerH) < 1) && d.innerH > 600;
  }).toBe(true);
  // the root font follows the real screen again: min(100vw / 90, 100vh / 56.25) of the frame
  const real = await frameOf(A.page).locator('html').evaluate((h) => ({
    font: parseFloat(getComputedStyle(h).fontSize),
    want: Math.max(10.5, Math.min(window.innerWidth / 90, window.innerHeight / 56.25)),
    snap: getComputedStyle(h).scrollSnapType,
  }));
  expect(real.font).toBeCloseTo(real.want, 1);
  expect(real.snap).toContain('y');
  // what was revealed stays revealed
  expect((await deck(A.page)).sections.every((s) => s.opacity.every((o) => o === 1))).toBe(true);
  await A.page.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(true));
  await expectDeckOnBoard(A.page);
  await A.close();
});

test('reveal scripts: an observer of the page reports its targets in view at once; one with its own root is the browser\'s', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('deck-io'), { artifact: 'scroll-deck.html' });
  const r = await frameOf(A.page).locator('html').evaluate(async () => {
    const tail = document.getElementById('tail-end')!;
    const seen: any[] = [];
    const io = new IntersectionObserver((es, obs) => {
      for (const e of es) seen.push({ id: (e.target as HTMLElement).id, isIntersecting: e.isIntersecting, ratio: e.intersectionRatio, h: e.boundingClientRect.height, same: obs === io, entry: e instanceof IntersectionObserverEntry });
    }, { threshold: [0, 0.5, 1], rootMargin: '0px' });
    io.observe(tail);
    io.observe(tail); // twice: one entry, as the browser does
    // a sentinel whose callback observes it again is told once, not in a loop
    let again = 0;
    const sentinel = new IntersectionObserver((es, obs) => {
      again++;
      for (const e of es) { obs.unobserve(e.target); obs.observe(e.target); }
    });
    sentinel.observe(tail);
    await new Promise((res) => setTimeout(res, 300));
    sentinel.disconnect();
    // disconnected and observed again: told again
    sentinel.observe(tail);
    await new Promise((res) => setTimeout(res, 100));
    sentinel.disconnect();
    const own = new IntersectionObserver(() => {}, { root: document.documentElement });
    const out = {
      seen,
      thresholds: io.thresholds,
      root: io.root,
      rootMargin: io.rootMargin,
      takeRecords: io.takeRecords().length,
      ownIsBrowser: !(own instanceof IntersectionObserver) || own.root === document.documentElement,
      badTarget: (() => { try { io.observe({} as Element); return 'no error'; } catch (e) { return (e as Error).name; } })(),
      noNew: (() => { try { (IntersectionObserver as any)(() => {}); return 'no error'; } catch (e) { return (e as Error).name; } })(),
      again,
    };
    io.disconnect();
    own.disconnect();
    return out;
  });
  expect(r.seen).toHaveLength(1);
  expect(r.seen[0]).toMatchObject({ id: 'tail-end', isIntersecting: true, ratio: 1, same: true, entry: true });
  expect(r.seen[0].h).toBeGreaterThan(0);
  expect(r.thresholds).toEqual([0, 0.5, 1]);
  expect(r.root).toBeNull();
  expect(r.rootMargin).toBe('0px 0px 0px 0px');
  expect(r.takeRecords).toBe(0);
  expect(r.ownIsBrowser).toBe(true);
  expect(r.badTarget).toBe('TypeError');
  expect(r.noNew).toBe('TypeError');
  expect(r.again).toBe(2);
  await A.close();
});

test('viewport units from every source of CSS resolve against the reference screen; strings, urls and selectors are untouched', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('units'), { artifact: 'viewport-units.html' });
  const f = frameOf(A.page);
  await expect(f.locator('html')).toHaveAttribute('data-late', '1');
  const h = (id: string) => f.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().height);
  const want: Record<string, number> = {
    sheet: 10 * VH, media: 30 * VH, sup: 10 * VH, imp: 10 * VH, upper: 10 * VH, cv: 100 * VH / 4, layer: 6 * VH,
    inline: 20 * VH, ins: 5 * VH, adopt: 4 * VH, late: 7 * VH, js: 8 * VH, cls: 12, pad: 3 * VH + 3,
    vbg: 10 * VH, vmar: 5 * VH, pend: 2 * VH + 1, vin: 20 * VH + 6, // vin: its 3px border, kept
    lg: 30, lgi: 31, // block-size after height still wins
  };
  for (const [id, v] of Object.entries(want)) await expect.poll(() => h(id), { message: id }).toBeCloseTo(v, 1);
  const vm = await f.locator('#vm').evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
  expect(vm[0]).toBeCloseTo(Math.min(PAGE_W, REF_H) / 10, 1);
  expect(vm[1]).toBeCloseTo(Math.max(PAGE_W, REF_H) / 10, 1);
  const misc = await f.locator('html').evaluate(() => ({
    neg: parseFloat(getComputedStyle(document.getElementById('neg')!).marginTop),
    str: getComputedStyle(document.getElementById('str')!, '::after').content,
    url: getComputedStyle(document.getElementById('url')!).backgroundImage,
    kf: new DOMMatrixReadOnly(getComputedStyle(document.getElementById('kf')!).transform).m42,
    // the rest of a block is untouched: shorthands set from var() keep every longhand
    vbg: [getComputedStyle(document.getElementById('vbg')!).backgroundImage, getComputedStyle(document.getElementById('vbg')!).backgroundColor],
    vmar: [getComputedStyle(document.getElementById('vmar')!).marginLeft, getComputedStyle(document.getElementById('vmar')!).marginTop],
    pend: getComputedStyle(document.getElementById('pend')!).paddingTop,
    vin: [getComputedStyle(document.getElementById('vin')!).borderTopWidth, getComputedStyle(document.getElementById('vin')!).borderLeftColor],
    url2: getComputedStyle(document.getElementById('url2')!).backgroundImage,
    // the inline style attribute keeps its var() shorthand as written (a copy through outerHTML too)
    vinHtml: document.getElementById('vin')!.outerHTML,
    // the page's own first sheet is still the first one (the reporter adds none before it)
    firstSheet: (document.styleSheets[0].ownerNode as HTMLElement).localName + ':' + document.styleSheets[0].cssRules.length,
  }));
  expect(misc.neg).toBeCloseTo(-2 * VH, 1);
  expect(misc.str).toBe('"50vh"');
  expect(misc.url).toContain('10vh');
  expect(misc.kf).toBeCloseTo(10 * VH, 1);
  expect(misc.firstSheet).toMatch(/^style:\d+$/);
  expect(misc.vbg[0]).toContain('linear-gradient');
  expect(misc.vbg[1]).toBe('rgb(1, 2, 3)');
  expect(misc.vmar).toEqual(['7px', '3px']);
  expect(misc.pend).toBe('1px');
  expect(misc.vin).toEqual(['3px', 'rgb(0, 0, 255)']);
  expect(misc.url2).toContain("10vh");
  expect(misc.url2).not.toContain('artifacts-canvas');
  expect(misc.vinHtml).toContain('border:var(--bd)');
  expect(misc.vinHtml).toContain('height:calc(20 * var(--artifacts-canvas-vh, 1vh))');
  // the canvas hidden: the real units come back, from the same rewritten CSS
  await A.page.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(false));
  const share = (id: string) => f.locator(`#${id}`).evaluate((el) => Math.round((el.getBoundingClientRect().height / window.innerHeight) * 1000) / 1000);
  await expect.poll(() => f.locator('html').evaluate(() => window.innerHeight)).toBeGreaterThan(700);
  await expect.poll(() => share('sheet')).toBeCloseTo(0.1, 2);
  await expect.poll(() => share('inline')).toBeCloseTo(0.2, 2);
  await expect.poll(() => share('js')).toBeCloseTo(0.08, 2);
  await A.close();
});

test('a reveal script that compares with innerHeight on scroll sees the whole page; sizing code sees one screen', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('scroll-reveal'), { artifact: 'scroll-reveal.html' });
  const f = frameOf(A.page).locator('html');
  // the page's load check saw one screen; the reporter's scroll after load showed it the whole page
  await expect.poll(() => f.evaluate(() => Array.from(document.querySelectorAll('.rv')).map((el) => el.classList.contains('in')))).toEqual([true, true, true, true, true, true]);
  expect(await f.evaluate(() => window.innerHeight)).toBe(Math.round(REF_H));
  // hidden and shown again: still all there
  await A.page.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(false));
  await A.page.evaluate(() => (window as any).__canvas.editor.setCanvasVisible(true));
  await expect.poll(() => f.evaluate(() => window.innerHeight)).toBe(Math.round(REF_H));
  expect(await f.evaluate(() => document.querySelectorAll('.rv.in').length)).toBe(6);
  await A.close();
});
