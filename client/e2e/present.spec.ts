import { expect, test, type Page } from '@playwright/test';
import { newRoom, open, ready } from './helpers';

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');

/**
 * A click on an element of the artifact where it is on the screen, once the camera stands still.
 * In a headed window that went fullscreen, Playwright's box of an element inside the frame leaves
 * out the camera's scale (Chromium 1254), so its own click lands beside it: the point comes from
 * the frame element's box in this page and the element's box in the frame.
 */
async function clickInFrame(p: Page, selector: string) {
  await settle(p);
  const f = (await p.locator('iframe.artifact-frame').boundingBox())!;
  const r = await frameOf(p).locator(selector).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, vw: window.innerWidth };
  });
  const k = f.width / r.vw;
  await p.mouse.click(f.x + (r.x + Math.min(r.w / 2, 30)) * k, f.y + (r.y + r.h / 2) * k);
}

/** Is the element of the artifact in the top third of what the camera shows (world = page px)? */
async function nearTop(p: Page, selector: string): Promise<boolean> {
  const y = await frameOf(p).locator(selector).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const v = await p.evaluate(() => (window as any).__canvas.editor.visibleWorld());
  return y >= v.y && y - v.y < v.h / 3;
}

/** Wait until the window size and the camera have stood still for 300 ms. */
async function settle(p: Page) {
  let last = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await p.evaluate(() => [innerWidth, innerHeight, (window as any).__canvas.editor.camera]));
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [300] }).toBe(true);
}

/** Centre and zoom of what a tab sees. */
const view = (p: Page) => p.evaluate(() => {
  const e = (window as any).__canvas.editor;
  const v = e.visibleWorld();
  return { x: v.x + v.w / 2, y: v.y + v.h / 2, z: e.camera.z };
});

/** Does `b` show what `a` shows (centre within 2 px)? */
async function sameView(a: Page, b: Page): Promise<boolean> {
  const [va, vb] = [await view(a), await view(b)];
  return Math.abs(va.x - vb.x) < 2 && Math.abs(va.y - vb.y) < 2;
}

const presentState = (p: Page) => p.evaluate(() => ({
  mode: document.body.classList.contains('present-mode'),
  how: document.body.dataset.present ?? null,
  fullscreen: !!document.fullscreenElement,
  presenting: (window as any).__canvas.editor.presenting,
  tool: (window as any).__canvas.editor.tool,
  following: (window as any).__canvas.editor.followingUserId,
  search: location.search,
}));

/**
 * Counts the page's fullscreen requests, each with the event being handled when it was made (the
 * gesture it rides on), and the fullscreen changes. `refuse`: 'first' fails the first request as a
 * browser does without a gesture (a page load is none, but the test driver's own calls count as
 * gestures, so the refusal is made certain), 'all' fails every one (a policy), 'none' leaves the
 * answer to the browser.
 */
const fsProbe = (refuse: 'none' | 'first' | 'all') => `(() => {
  if (window !== window.top) return;
  const real = Element.prototype.requestFullscreen;
  window.__fs = { asked: [], changes: 0 };
  document.addEventListener('fullscreenchange', () => { window.__fs.changes++; });
  Element.prototype.requestFullscreen = function (o) {
    const n = window.__fs.asked.push(window.event ? window.event.type : null);
    if ('${refuse}' === 'all' || ('${refuse}' === 'first' && n === 1)) return Promise.reject(new TypeError('Permissions check failed'));
    return real.call(this, o);
  };
})();`;
const fsAsked = (p: Page) => p.evaluate(() => (window as any).__fs as { asked: (string | null)[]; changes: number });

/** Nothing in the page asks for fullscreen: presenting shows the badge and the floating controls only. */
async function expectNoPrompt(p: Page) {
  await expect(p.getByTestId('present-fullscreen')).toHaveCount(0);
  await expect(p.locator('button', { hasText: /pantalla completa|full screen/i })).toHaveCount(0);
  expect(await p.locator('.present-ui > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))
    .toEqual(['present-badge', 'present-controls']);
}

test('the laser shows a laser cursor, the toolbar marks it, and the others see a laser dot', async ({ browser }) => {
  const room = newRoom('laser-cursor');
  const A = await open(browser, 'Ana', room);
  const B = await open(browser, 'Marta', room);
  const stage = A.page.getByTestId('stage');
  await A.page.keyboard.press('k');
  await expect(stage).toHaveAttribute('data-tool', 'laser');
  const cursor = await stage.evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).toContain('url("data:image/svg+xml');
  expect(cursor).toContain('crosshair');
  const tool = A.page.getByTestId('tool-laser');
  await expect(tool).toHaveClass(/\bon\b/);
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  // a cursor the select tool had set (move over a shape) does not hide the laser cursor
  await A.page.keyboard.press('v');
  await stage.evaluate((el) => { (el as HTMLElement).dataset.cursor = 'move'; });
  await A.page.keyboard.press('k');
  expect(await stage.evaluate((el) => getComputedStyle(el).cursor)).toContain('data:image/svg+xml');
  // the others see this cursor as a red laser dot, not an arrow
  await A.page.mouse.move(600, 400);
  await A.page.mouse.move(620, 410);
  const remote = B.page.locator('.cursor[data-testid="remote-cursor"]');
  await expect(remote).toHaveClass(/\blaser\b/);
  await expect(remote).toContainText('Ana · láser');
  // pressing draws the trail they see (unchanged)
  await A.page.mouse.down();
  for (let i = 0; i < 10; i++) await A.page.mouse.move(620 + i * 12, 410 + i * 3);
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(1);
  await A.page.mouse.up();
  // back to the select tool: an arrow again (once the trail, which stands for the cursor, has faded)
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(0, { timeout: 4000 });
  await A.page.keyboard.press('v');
  await A.page.mouse.move(500, 300);
  await expect(remote).toHaveCount(1);
  await expect(remote).not.toHaveClass(/\blaser\b/);
  await expect(remote).toHaveText('Ana');
  await A.close();
  await B.close();
});

test('the laser on a touch screen shows a dot under the finger', async ({ browser }) => {
  const room = newRoom('laser-touch');
  const P = await open(browser, 'Ana', room, { viewport: { width: 390, height: 844 }, mobile: true, deviceScaleFactor: 2 });
  const B = await open(browser, 'Marta', room);
  await P.page.evaluate(() => (window as any).__canvas.editor.setTool('laser'));
  const dot = P.page.getByTestId('laser-pointer');
  await expect(dot).toBeHidden();
  const cdp = await P.page.context().newCDPSession(P.page);
  const touch = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', 180, 420);
  await expect(dot).toBeVisible();
  let box = (await dot.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 180)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - 420)).toBeLessThan(2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', 180 + i * 10, 420 + i * 6);
  // pointer moves are dispatched with the next frame
  await expect.poll(async () => {
    const b = (await dot.boundingBox())!;
    return Math.round(b.x + b.width / 2);
  }).toBe(260);
  // the others see the trail while the finger is down
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(1);
  // held still, it stays on for them (sent again while held)
  await P.page.waitForTimeout(1600);
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(1);
  await touch('touchEnd', 0, 0);
  await expect(dot).toBeHidden();
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(0, { timeout: 4000 });
  await P.close();
  await B.close();
});

test('Presentar goes fullscreen at once, asking nothing: chrome hidden, laser, badge; Esc and the exit button leave it', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('present-mode'), { initScript: fsProbe('none') });
  const p = A.page;
  await p.keyboard.press('e');
  await expect(p.getByTestId('present')).toHaveAttribute('title', /pantalla completa.*siguen tu vista/);
  await p.getByTestId('present').click();
  await expect.poll(async () => (await presentState(p)).mode).toBe(true);
  // the click is the gesture fullscreen needs: one request, inside it (refused and missing: the next tests)
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  const st = await presentState(p);
  expect(st.fullscreen).toBe(true);
  expect(await fsAsked(p)).toEqual({ asked: ['click'], changes: 1 });
  await expectNoPrompt(p);
  expect(st.presenting).toBe(true);
  expect(st.tool).toBe('laser');
  expect(st.search).toContain('present=1');
  await expect(p.getByTestId('present-badge')).toHaveText('Presentando · Esc para salir');
  await expect(p.getByTestId('present-controls')).toBeVisible();
  await expect(p.getByTestId('present-tool-laser')).toHaveClass(/\bon\b/);
  for (const id of ['toolbar', 'present', 'share', 'zoom-in', 'style-panel']) await expect(p.getByTestId(id)).toBeHidden();
  // the artifact page fills the screen width
  const fit = await p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const r = e.frame.el.getBoundingClientRect();
    return { left: r.left, right: r.right, w: e.viewW };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.left).toBeLessThan(40);
  expect(fit.w - fit.right).toBeLessThan(40);
  // the pen from the floating controls, then Esc
  await p.getByTestId('present-tool-draw').click();
  expect((await presentState(p)).tool).toBe('draw');
  await p.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(p)).mode).toBe(false);
  await expect.poll(async () => (await presentState(p)).fullscreen).toBe(false);
  const out = await presentState(p);
  // the tool from before presenting comes back
  expect(out).toMatchObject({ how: null, fullscreen: false, presenting: false, tool: 'eraser' });
  expect(out.search).not.toContain('present=');
  await expect(p.getByTestId('toolbar')).toBeVisible();
  await expect(p.getByTestId('present-badge')).toBeHidden();
  // the exit button does the same
  await p.getByTestId('present').click();
  await expect.poll(async () => (await presentState(p)).mode).toBe(true);
  await expect.poll(async () => (await presentState(p)).fullscreen).toBe(true);
  await p.getByTestId('present-exit').click();
  await expect.poll(async () => (await presentState(p)).mode).toBe(false);
  await expect.poll(async () => (await presentState(p)).fullscreen).toBe(false);
  await A.close();
});

test('Esc then "Presentar" at once: the end of the old fullscreen does not end the new presentation', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('present-again'));
  const p = A.page;
  await p.getByTestId('present').click();
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  // the mode ends (it starts leaving fullscreen) and "Presentar" is clicked in the same task, so the
  // fullscreenchange of that exit comes after the new presentation started (CI saw this order once)
  await p.evaluate(() => {
    (window as any).__canvas.editor.setPresenting(false);
    (document.querySelector('[data-testid="present"]') as HTMLElement).click();
  });
  await expect.poll(async () => (await presentState(p)).fullscreen).toBe(false);
  await p.waitForTimeout(300);
  const st = await presentState(p);
  expect(st.presenting).toBe(true);
  expect(st.how).toBe('fallback');
  // in the page, asking nothing; the next key goes fullscreen and still does its job (the pen)
  await expectNoPrompt(p);
  await p.keyboard.press('d');
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  expect((await presentState(p)).tool).toBe('draw');
  await A.close();
});

test('presentation mode stays in the page, asking nothing, where fullscreen is refused or missing', async ({ browser }) => {
  // refused (a policy): the in-page view, nothing asked
  const A = await open(browser, 'Ana', newRoom('present-refused'), { initScript: fsProbe('all') });
  await A.page.getByTestId('present').click();
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fallback');
  await expect(A.page.getByTestId('present-badge')).toBeVisible();
  await expect(A.page.getByTestId('toolbar')).toBeHidden();
  await expectNoPrompt(A.page);
  // the next press tries once more from inside it; refused again, the page stays as it is
  await A.page.mouse.click(700, 450);
  await expect.poll(async () => (await fsAsked(A.page)).asked).toEqual(['click', 'pointerdown']);
  await A.page.keyboard.press('k');
  await A.page.mouse.click(720, 460);
  await A.page.waitForTimeout(300);
  expect(await fsAsked(A.page)).toEqual({ asked: ['click', 'pointerdown'], changes: 0 });
  expect(await presentState(A.page)).toMatchObject({ mode: true, how: 'fallback', presenting: true });
  await expectNoPrompt(A.page);
  await A.page.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(false);
  await A.close();
  // no Fullscreen API at all (an iPhone): the in-page view, nothing asked, a tap changes nothing
  const none = "Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false }); Element.prototype.requestFullscreen = undefined;";
  const B = await open(browser, 'Ana', newRoom('present-none'), { initScript: none, viewport: { width: 390, height: 844 }, mobile: true });
  const errors: string[] = [];
  B.page.on('pageerror', (e) => errors.push(e.message));
  await B.page.evaluate(() => (window as any).__canvas.editor.setTool('select'));
  await B.page.getByTestId('present').tap();
  await expect.poll(async () => (await presentState(B.page)).how).toBe('fallback');
  await expectNoPrompt(B.page);
  await expect(B.page.getByTestId('present-controls')).toBeVisible();
  await B.page.touchscreen.tap(195, 420);
  await B.page.waitForTimeout(300);
  expect(await presentState(B.page)).toMatchObject({ mode: true, how: 'fallback' });
  await expectNoPrompt(B.page);
  await B.page.getByTestId('present-exit').tap();
  await expect.poll(async () => (await presentState(B.page)).mode).toBe(false);
  expect(errors).toEqual([]);
  await B.close();
});

test('another person follows the presenter with a banner, and is released when presenting ends or the presenter leaves', async ({ browser }) => {
  const room = newRoom('present-follow');
  const A = await open(browser, 'Ana', room);
  const B = await open(browser, 'Marta', room);
  await A.page.getByTestId('present').click();
  await expect(B.page.getByTestId('banner')).toBeVisible();
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  await expect(B.page.getByTestId('banner-action')).toHaveText('Dejar de seguir');
  // the presenter moves: B follows
  await A.page.mouse.move(700, 450);
  await A.page.mouse.wheel(0, 900);
  await expect.poll(() => sameView(A.page, B.page)).toBe(true);
  // the presenter never follows anyone, and sees no banner
  expect((await presentState(A.page)).following).toBeNull();
  await expect(A.page.getByTestId('banner')).toBeHidden();
  // "Dejar de seguir": B stays put, can follow again
  await B.page.getByTestId('banner-action').click();
  await expect(B.page.getByTestId('banner-action')).toHaveText('Seguir');
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  const bStill = await view(B.page);
  await A.page.mouse.wheel(0, 500);
  await A.page.waitForTimeout(300);
  expect(await view(B.page)).toEqual(bStill);
  await B.page.getByTestId('banner-action').click();
  await expect.poll(() => sameView(A.page, B.page)).toBe(true);
  // the presenter leaves the mode: released, no banner
  await A.page.keyboard.press('Escape');
  await expect(B.page.getByTestId('banner')).toBeHidden();
  expect((await presentState(B.page)).following).toBeNull();
  // presenting again, then the presenter disconnects: released, no banner
  await A.page.getByTestId('present').click();
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  await A.close();
  await expect(B.page.getByTestId('banner')).toBeHidden({ timeout: 10_000 });
  expect((await presentState(B.page)).following).toBeNull();
  await B.close();
});

test("the presenter's own other session follows it; the presenting session does not follow itself", async ({ browser }) => {
  const room = newRoom('present-self');
  const A1 = await open(browser, 'Ana', room);
  const A2 = await open(browser, 'Ana', room); // same person, another tab or device
  await A1.page.getByTestId('present').click();
  await expect(A2.page.getByTestId('banner-text')).toHaveText('Estás presentando en otra ventana');
  await A1.page.mouse.move(700, 450);
  await A1.page.mouse.wheel(0, 700);
  await expect.poll(() => sameView(A1.page, A2.page)).toBe(true);
  expect((await presentState(A2.page)).following).toBe('dev:Ana');
  const a1 = await presentState(A1.page);
  expect(a1.following).toBeNull();
  await expect(A1.page.getByTestId('banner')).toBeHidden();
  // the follower's camera moves do not come back to the presenter
  const a1View = await view(A1.page);
  await A2.page.evaluate(() => (window as any).__canvas.editor.setCamera({ tx: 0, ty: -3000, z: 0.5 }, 'follow'));
  await A1.page.waitForTimeout(400);
  expect(await view(A1.page)).toEqual(a1View);
  await A1.page.getByTestId('present-exit').click();
  await expect(A2.page.getByTestId('banner')).toBeHidden();
  await A1.close();
  await A2.close();
});

test('?present=1 opens in presentation mode in the page, asking nothing; the first key goes fullscreen and does its job, then the deck steps', async ({ browser }) => {
  const room = newRoom('present-link');
  const B = await open(browser, 'Marta', room, { artifact: 'scroll-deck.html' });
  // a browser refuses fullscreen without a gesture, and a page load is none (fsProbe 'first')
  const A = await open(browser, 'Ana', room, { artifact: 'scroll-deck.html', query: { present: '1' }, initScript: fsProbe('first') });
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(true);
  expect(await presentState(A.page)).toMatchObject({ presenting: true, tool: 'laser' });
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fallback');
  await expect.poll(async () => (await fsAsked(A.page)).asked.length).toBe(1);
  await A.page.waitForTimeout(300);
  await expectNoPrompt(A.page);
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  // the first key: fullscreen, asked from inside its keydown, and the key's own job (the interact tool)
  await A.page.keyboard.press('i');
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fullscreen');
  expect((await fsAsked(A.page)).asked[1]).toBe('keydown');
  expect((await presentState(A.page)).tool).toBe('interact');
  // the deck's own arrow key steps to the next screen (a click in it first, as before)
  const top = () => A.page.evaluate(() => (window as any).__canvas.editor.visibleWorld().y);
  await clickInFrame(A.page, '#s1 p');
  await A.page.keyboard.press('ArrowDown');
  const before = await top();
  await expect.poll(async () => (await top()) !== before).toBe(true);
  // the camera shows the screen the deck went to
  const tops = await frameOf(A.page).locator('.scr').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top + window.scrollY));
  await expect.poll(async () => { const t = await top(); return tops.some((y) => Math.abs(y - t) < 3); }).toBe(true);
  expect((await fsAsked(A.page)).asked).toHaveLength(2);
  expect((await presentState(A.page)).how).toBe('fullscreen');
  // leaving fullscreen by Esc ends the mode
  await A.page.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(false);
  expect((await presentState(A.page)).search).not.toContain('present=');
  await expect(B.page.getByTestId('banner')).toBeHidden();
  await A.close();
  await B.close();
});

test('?present=1, the first press on the board goes fullscreen; Esc or the exit button as the first gesture never do', async ({ browser }) => {
  const link = { query: { present: '1' }, initScript: fsProbe('first') };
  // a press on the board: fullscreen, asked from inside the pointerdown; the laser still points
  const A = await open(browser, 'Ana', newRoom('present-link-press'), link);
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fallback');
  await expectNoPrompt(A.page);
  await A.page.mouse.click(700, 450);
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fullscreen');
  expect((await fsAsked(A.page)).asked[1]).toBe('pointerdown');
  expect((await presentState(A.page)).tool).toBe('laser');
  await A.close();
  // Esc: the mode ends, nothing more asked, never fullscreen
  const E = await open(browser, 'Ana', newRoom('present-link-esc'), link);
  await expect.poll(async () => (await presentState(E.page)).how).toBe('fallback');
  await E.page.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(E.page)).mode).toBe(false);
  await E.page.waitForTimeout(300);
  expect(await fsAsked(E.page)).toMatchObject({ changes: 0 });
  expect((await fsAsked(E.page)).asked).toHaveLength(1);
  expect((await presentState(E.page)).fullscreen).toBe(false);
  await E.close();
  // the exit button: the same
  const X = await open(browser, 'Ana', newRoom('present-link-exit'), link);
  await expect.poll(async () => (await presentState(X.page)).how).toBe('fallback');
  await X.page.getByTestId('present-exit').click();
  await expect.poll(async () => (await presentState(X.page)).mode).toBe(false);
  await X.page.waitForTimeout(300);
  expect(await fsAsked(X.page)).toMatchObject({ changes: 0 });
  expect((await fsAsked(X.page)).asked).toHaveLength(1);
  expect((await presentState(X.page)).fullscreen).toBe(false);
  await X.close();
});

test('?present=1 on a page of links: the first press on a floating control goes fullscreen and sets its tool; a slide link still works, and a page opened from a link presents in the page, asking nothing', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('present-link-links'), { artifact: 'links.html', query: { present: '1' }, initScript: fsProbe('first') });
  const p = A.page;
  await expect.poll(async () => (await presentState(p)).how).toBe('fallback');
  await expectNoPrompt(p);
  // the first press, on the interact control: fullscreen from inside the pointerdown, and the tool
  await p.getByTestId('present-tool-interact').click();
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  expect((await fsAsked(p)).asked[1]).toBe('pointerdown');
  expect((await presentState(p)).tool).toBe('interact');
  // an anchor of the page brings its target to the top of the view (and back)
  expect(await nearTop(p, '#section-3')).toBe(false);
  await clickInFrame(p, '#anchor');
  await expect.poll(() => nearTop(p, '#section-3')).toBe(true);
  await clickInFrame(p, '#back');
  await expect.poll(() => nearTop(p, '#top')).toBe(true);
  // a link to another page opens it presenting: in the page (no gesture came with the load), nothing asked
  await clickInFrame(p, '#internal');
  await p.waitForURL(/\/_canvas\/links-b\.html\?.*present=1/);
  await ready(p);
  await expect.poll(async () => (await presentState(p)).mode).toBe(true);
  await expect.poll(async () => (await presentState(p)).how).toBe('fallback');
  await p.waitForTimeout(300);
  await expectNoPrompt(p);
  await p.keyboard.press('k');
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  expect((await fsAsked(p)).asked[1]).toBe('keydown');
  await A.close();
});
