import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

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

test('Presentar enters presentation mode: fullscreen, chrome hidden, laser, badge; Esc leaves it', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('present-mode'));
  const p = A.page;
  await p.keyboard.press('e');
  await expect(p.getByTestId('present')).toHaveAttribute('title', /pantalla completa.*siguen tu vista/);
  await p.getByTestId('present').click();
  await expect.poll(async () => (await presentState(p)).mode).toBe(true);
  // the click is the gesture fullscreen needs (the refused and missing cases: the next test)
  await expect.poll(async () => (await presentState(p)).how).toBe('fullscreen');
  const st = await presentState(p);
  expect(st.fullscreen).toBe(true);
  await expect(p.getByTestId('present-fullscreen')).toBeHidden();
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

test('presentation mode falls back to an in-page view where fullscreen is refused or missing', async ({ browser }) => {
  // refused (a policy, no gesture): the in-page view and a one-click prompt
  const refuse = 'Element.prototype.requestFullscreen = function () { return Promise.reject(new TypeError("denied")); };';
  const A = await open(browser, 'Ana', newRoom('present-refused'), { initScript: refuse });
  await A.page.getByTestId('present').click();
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fallback');
  await expect(A.page.getByTestId('present-badge')).toBeVisible();
  await expect(A.page.getByTestId('present-fullscreen')).toBeVisible();
  await expect(A.page.getByTestId('toolbar')).toBeHidden();
  await A.page.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(false);
  await expect(A.page.getByTestId('present-fullscreen')).toBeHidden();
  await A.close();
  // no Fullscreen API at all (an iPhone): the in-page view, no prompt
  const none = "Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false }); Element.prototype.requestFullscreen = undefined;";
  const B = await open(browser, 'Ana', newRoom('present-none'), { initScript: none, viewport: { width: 390, height: 844 }, mobile: true });
  await B.page.evaluate(() => (window as any).__canvas.editor.setTool('select'));
  await B.page.getByTestId('present').tap();
  await expect.poll(async () => (await presentState(B.page)).how).toBe('fallback');
  await expect(B.page.getByTestId('present-fullscreen')).toBeHidden();
  await expect(B.page.getByTestId('present-controls')).toBeVisible();
  await B.page.getByTestId('present-exit').tap();
  await expect.poll(async () => (await presentState(B.page)).mode).toBe(false);
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

test('?present=1 opens in presentation mode after load and offers one click for fullscreen', async ({ browser }) => {
  const room = newRoom('present-link');
  const B = await open(browser, 'Marta', room);
  // A browser refuses fullscreen without a user gesture, and a page load is none. The test
  // driver's own calls count as gestures, so the refusal is made certain: the first request
  // fails as the browser's would, later ones go to the real API.
  const refuseFirst = `(() => {
    const real = Element.prototype.requestFullscreen;
    let first = true;
    Element.prototype.requestFullscreen = function (o) {
      if (first) { first = false; return Promise.reject(new TypeError('Permissions check failed')); }
      return real.call(this, o);
    };
  })();`;
  const A = await open(browser, 'Ana', room, { query: { present: '1' }, initScript: refuseFirst });
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(true);
  const st = await presentState(A.page);
  expect(st).toMatchObject({ presenting: true, tool: 'laser' });
  // refused: the in-page view, and a one-click prompt asks for fullscreen
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fallback');
  await expect(A.page.getByTestId('present-fullscreen')).toHaveText('⛶ Entrar en pantalla completa');
  await A.page.getByTestId('present-fullscreen').click();
  await expect.poll(async () => (await presentState(A.page)).how).toBe('fullscreen');
  await expect(A.page.getByTestId('present-fullscreen')).toBeHidden();
  await expect(B.page.getByTestId('banner-text')).toHaveText('Ana está presentando');
  // leaving fullscreen by Esc ends the mode
  await A.page.keyboard.press('Escape');
  await expect.poll(async () => (await presentState(A.page)).mode).toBe(false);
  expect((await presentState(A.page)).search).not.toContain('present=');
  await expect(B.page.getByTestId('banner')).toBeHidden();
  await A.close();
  await B.close();
});
