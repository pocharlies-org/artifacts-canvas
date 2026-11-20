import { expect, test, type Browser, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, ready, wave } from './helpers';

/**
 * Canvas shown or hidden (ui/visibility.ts, ui/canvas-pref.ts): a first visit opens hidden, the
 * artifact looking like the original page; the toggle is remembered per user; ?canvas=1|0 and
 * ?present=1 force a visit; hidden, the pill counts the annotations and says who is annotating,
 * and the page's links and scrolling work as on the plain page.
 */

const state = (p: Page) => p.evaluate(() => {
  const e = (window as any).__canvas.editor;
  const f = e.frame.el as HTMLIFrameElement;
  const r = f.getBoundingClientRect();
  return {
    hidden: e.hidden as boolean,
    bodyHidden: document.body.classList.contains('canvas-hidden'),
    frame: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrolling: f.getAttribute('scrolling') },
    view: { w: innerWidth, h: innerHeight },
    pref: Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('artifacts-canvas:')).map((k) => [k, localStorage.getItem(k)])),
    presenting: e.presenting as boolean,
  };
});

/** The same browser profile across visits (localStorage kept): a context, a page per visit. */
async function profile(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return {
    ctx,
    async visit(room: string, query = '', artifact = 'sample-report.html'): Promise<Page> {
      const page = await ctx.newPage();
      await page.goto(`/_canvas/${artifact}?room=${room}&as=Ana${query ? `&${query}` : ''}`);
      await ready(page);
      return page;
    },
  };
}

test('a first visit opens hidden; the toggle shows and hides the canvas and is remembered per user', async ({ browser }) => {
  const P = await profile(browser);
  const room = newRoom('vis-first');
  const p = await P.visit(room);
  await expect.poll(async () => (await state(p)).bodyHidden).toBe(true);
  let s = await state(p);
  // the artifact as the original page: the whole view, scrolling on its own
  expect(s.frame).toEqual({ x: 0, y: 0, w: s.view.w, h: s.view.h, scrolling: 'auto' });
  for (const id of ['toolbar', 'present', 'style-panel', 'annotations-toggle']) await expect(p.getByTestId(id)).toBeHidden();
  await expect(p.getByTestId('canvas-show')).toBeVisible();
  await expect(p.getByTestId('canvas-show')).toHaveText('✏️ Canvas');
  await expect(p.getByTestId('canvas-show')).toHaveAttribute('aria-label', 'Mostrar canvas');
  await expect(p.getByTestId('canvas-original')).toHaveText('Ver original');
  await expect(p.getByTestId('canvas-original')).toHaveAttribute('href', '/_canvas/_/frame/sample-report.html?raw=1');
  expect(s.pref['artifacts-canvas:canvas:dev:Ana']).toBeUndefined();
  // shown
  await p.getByTestId('canvas-show').click();
  await expect.poll(async () => (await state(p)).bodyHidden).toBe(false);
  s = await state(p);
  expect(s.frame.w).toBe(980);
  expect(s.frame.scrolling).toBe('no');
  await expect(p.getByTestId('toolbar')).toBeVisible();
  await expect(p.getByTestId('canvas-show')).toBeHidden();
  expect(s.pref['artifacts-canvas:canvas:dev:Ana']).toBe('1');
  // the next visit, another artifact too: shown
  const p2 = await P.visit(newRoom('vis-first-2'), '', 'links.html');
  await expect.poll(async () => (await state(p2)).bodyHidden).toBe(false);
  await expect(p2.getByTestId('toolbar')).toBeVisible();
  // hidden again, and remembered
  await p2.getByTestId('canvas-hide').click();
  await expect.poll(async () => (await state(p2)).bodyHidden).toBe(true);
  expect((await state(p2)).pref['artifacts-canvas:canvas:dev:Ana']).toBe('0');
  const p3 = await P.visit(room);
  await expect.poll(async () => (await state(p3)).hidden).toBe(true);
  // another person on the same browser has their own choice (a first visit for them)
  const other = await P.ctx.newPage();
  await other.goto(`/_canvas/sample-report.html?room=${room}&as=Marta`);
  await ready(other);
  expect((await state(other)).hidden).toBe(true);
  await other.getByTestId('canvas-show').click();
  expect((await state(other)).pref).toMatchObject({ 'artifacts-canvas:canvas:dev:Ana': '0', 'artifacts-canvas:canvas:dev:Marta': '1' });
  await P.ctx.close();
});

test('?canvas=1, ?canvas=0 and ?present=1 decide the visit and are not remembered', async ({ browser }) => {
  const P = await profile(browser);
  const room = newRoom('vis-query');
  // stored: hidden
  const a = await P.visit(room);
  await expect.poll(async () => (await state(a)).hidden).toBe(true);
  await a.getByTestId('canvas-show').click();
  await a.getByTestId('canvas-hide').click();
  expect((await state(a)).pref['artifacts-canvas:canvas:dev:Ana']).toBe('0');
  const shown = await P.visit(room, 'canvas=1');
  await expect.poll(async () => (await state(shown)).hidden).toBe(false);
  await shown.waitForTimeout(500); // the identity check must not hide it again
  expect((await state(shown)).hidden).toBe(false);
  expect((await state(shown)).pref['artifacts-canvas:canvas:dev:Ana']).toBe('0');
  const presenting = await P.visit(room, 'present=1');
  await expect.poll(async () => (await state(presenting)).presenting).toBe(true);
  expect((await state(presenting)).hidden).toBe(false);
  // stored: shown; ?canvas=0 hides this visit only
  await shown.getByTestId('canvas-hide').click();
  await shown.getByTestId('canvas-show').click();
  expect((await state(shown)).pref['artifacts-canvas:canvas:dev:Ana']).toBe('1');
  const hidden = await P.visit(room, 'canvas=0');
  await hidden.waitForTimeout(500);
  expect((await state(hidden)).hidden).toBe(true);
  expect((await state(hidden)).pref['artifacts-canvas:canvas:dev:Ana']).toBe('1');
  await P.ctx.close();
});

test('hidden: the pill counts the annotations live, says who else is viewing and annotating, and this tab sends no cursor', async ({ browser }) => {
  const room = newRoom('vis-badge');
  const H = await open(browser, 'Ana', room, { query: { canvas: '0' } });
  const B = await open(browser, 'Marta', room);
  await expect(H.page.getByTestId('canvas-show')).toHaveText('✏️ Canvas');
  await expect(H.page.getByTestId('canvas-people')).toHaveText('👁 1 viendo · 1 anotando');
  await B.page.keyboard.press('d');
  for (let i = 0; i < 3; i++) await drawStroke(B.page, wave(420, 300 + i * 80, 12, 14));
  await expect(H.page.getByTestId('canvas-show')).toHaveText('✏️ Canvas · 3');
  // the hidden tab is quiet: Marta's canvas has no cursor, viewport or laser from it
  await H.page.mouse.move(700, 400);
  await H.page.mouse.move(720, 420);
  await H.page.waitForTimeout(400);
  const fromAna = await B.page.evaluate(() => {
    const aw = (window as any).__canvas.conn.awareness;
    return [...aw.getStates().entries()].filter(([id, st]: [number, any]) => id !== aw.clientID && st.user?.name === 'Ana').map(([, st]: [number, any]) => ({ cursor: st.cursor ?? null, viewport: st.viewport ?? null, laser: st.laser ?? null }));
  });
  expect(fromAna).toEqual([{ cursor: null, viewport: null, laser: null }]);
  await expect(B.page.getByTestId('remote-cursor')).toHaveCount(0);
  // Marta hides hers too: she still views, nobody annotates
  await B.page.getByTestId('canvas-hide').click();
  await expect(H.page.getByTestId('canvas-people')).toHaveText('👁 1 viendo');
  // she leaves: nobody else is here
  await B.close();
  await expect(H.page.getByTestId('canvas-people')).toBeHidden();
  await H.close();
});

test('hidden: the page scrolls itself and its links work as on the plain page', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('vis-links'), { artifact: 'links.html', query: { canvas: '0' } });
  const frame = A.page.frameLocator('iframe.artifact-frame');
  const scrollY = () => frame.locator('html').evaluate(() => window.scrollY);
  // a wheel scrolls the page inside the frame, the canvas camera does not move
  await A.page.mouse.move(700, 600);
  await A.page.mouse.wheel(0, 400);
  await expect.poll(scrollY).toBeGreaterThan(300);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.camera)).toEqual({ tx: 0, ty: 0, z: 1 });
  await A.page.mouse.wheel(0, -2000);
  await expect.poll(scrollY).toBe(0);
  // an anchor scrolls the page itself
  await frame.locator('#anchor').click();
  await expect.poll(scrollY).toBeGreaterThan(1000);
  await frame.locator('#back').click();
  await expect.poll(scrollY).toBeLessThan(100);
  // the button and an internal link
  await frame.locator('#btn').click();
  await expect(frame.locator('#out')).toHaveText('button clicked');
  await frame.locator('#internal').click();
  await A.page.waitForURL(/\/_canvas\/links-b\.html\?.*canvas=0/);
  await ready(A.page);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.hidden)).toBe(true);
  await A.close();
});
