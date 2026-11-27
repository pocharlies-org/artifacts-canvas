import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

/**
 * The desktop chrome over a page shown edge to edge (ui/chrome.ts autoHideSides, styles.css):
 * the side panels are hidden until the pointer comes to their edge, translucent when shown; the
 * bottom bars stay; showing the canvas does not shrink the page (editor.ts resetCamera, onReading).
 */

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');

const look = (p: Page, id: string) => p.getByTestId(id).evaluate((el) => {
  const cs = getComputedStyle(el);
  return { opacity: Number(cs.opacity), visibility: cs.visibility, bg: cs.backgroundColor, backdrop: cs.backdropFilter || (cs as any).webkitBackdropFilter || '' };
});
const shown = async (p: Page, id: string) => {
  const l = await look(p, id);
  return l.visibility === 'visible' && l.opacity === 1;
};
const gone = async (p: Page, id: string) => (await look(p, id)).visibility === 'hidden';

/** The alpha of an rgb()/rgba() colour. */
const alpha = (c: string) => {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  const parts = m ? m[1].split(/[,/ ]+/).filter(Boolean) : [];
  return parts.length === 4 ? Number(parts[3]) : 1;
};

/** Mean brightness of the brightest and the darkest 10 % of a region of the screen. */
async function contrast(page: Page, r: { x: number; y: number; width: number; height: number }): Promise<number> {
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
      const px = ctx.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height))).data;
      const v: number[] = [];
      for (let i = 0; i < px.length; i += 4) v.push((px[i] + px[i + 1] + px[i + 2]) / 3);
      v.sort((a, b) => a - b);
      const k = Math.max(1, Math.floor(v.length / 10));
      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      return avg(v.slice(-k)) - avg(v.slice(0, k));
    },
    { b64: png.toString('base64'), r },
  );
}

test('the side panels are hidden, come at their screen edge, stay while hovered and go a second after; the bottom bars stay', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('sides'), { fit: true });
  const p = A.page;
  await p.mouse.move(720, 450);
  for (const id of ['people-panel', 'style-panel']) expect(await gone(p, id)).toBe(true);
  for (const id of ['toolbar', 'zoom-in', 'bottom-left', 'minimap-panel']) await expect(p.getByTestId(id)).toBeVisible();
  // the left edge brings the left panel only
  await p.mouse.move(30, 450);
  await p.mouse.move(4, 450);
  await expect.poll(() => shown(p, 'people-panel')).toBe(true);
  expect(await gone(p, 'style-panel')).toBe(true);
  // onto the panel: it stays past the delay
  const box = (await p.getByTestId('people-panel').boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 4 });
  await p.waitForTimeout(1500);
  expect(await shown(p, 'people-panel')).toBe(true);
  // away from it: gone about a second later, not at once
  await p.mouse.move(720, 450, { steps: 4 });
  await p.waitForTimeout(300);
  expect(await shown(p, 'people-panel')).toBe(true);
  await expect.poll(() => gone(p, 'people-panel'), { timeout: 3000 }).toBe(true);
  // the right edge brings the style panel; the pointer on it keeps it, as on the left
  await p.mouse.move(1410, 450);
  await p.mouse.move(1437, 450);
  await expect.poll(() => shown(p, 'style-panel')).toBe(true);
  const sb = (await p.getByTestId('style-panel').boundingBox())!;
  await p.mouse.move(sb.x + sb.width / 2, sb.y + 30, { steps: 4 });
  await p.locator('.sw[data-color="red"]').click();
  expect(await p.evaluate(() => (window as any).__canvas.editor.style.color)).toBe('red');
  await p.mouse.move(720, 450, { steps: 4 });
  await expect.poll(() => gone(p, 'style-panel'), { timeout: 3000 }).toBe(true);
  // the bottom bars never went
  for (const id of ['toolbar', 'zoom-in', 'bottom-left', 'minimap-panel']) await expect(p.getByTestId(id)).toBeVisible();
  // a stroke drawn at the edge does not bring the panel (a button held)
  await p.keyboard.press('d');
  await p.mouse.move(200, 400);
  await p.mouse.down();
  await p.mouse.move(60, 420, { steps: 3 });
  await p.mouse.move(6, 430, { steps: 3 });
  await p.waitForTimeout(200);
  expect(await gone(p, 'people-panel')).toBe(true);
  await p.mouse.up();
  await A.close();
});

test('a tap on an edge handle toggles its panel (touch screens)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`/_canvas/sample-report.html?${new URLSearchParams({ room: newRoom('sides-touch'), as: 'Ana', canvas: '1' })}`);
  await page.waitForFunction(() => (window as any).__canvas?.editor?.status === 'synced');
  expect(await gone(page, 'people-panel')).toBe(true);
  await page.getByTestId('edge-left').tap();
  await expect.poll(() => shown(page, 'people-panel')).toBe(true);
  await page.waitForTimeout(1500);
  expect(await shown(page, 'people-panel')).toBe(true);
  await expect(page.getByTestId('edge-left')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('edge-left').tap();
  await expect.poll(() => gone(page, 'people-panel')).toBe(true);
  await page.getByTestId('edge-right').tap();
  await expect.poll(() => shown(page, 'style-panel')).toBe(true);
  await ctx.close();
});

test('the style panel shows while shapes are selected, to style them', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('sides-sel'), { fit: true });
  const p = A.page;
  expect(await gone(p, 'style-panel')).toBe(true);
  await p.keyboard.press('r');
  await p.mouse.move(400, 300);
  await p.mouse.down();
  await p.mouse.move(520, 380, { steps: 4 });
  await p.mouse.up();
  await p.keyboard.press('v');
  await p.mouse.click(460, 300);
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.selection.size)).toBe(1);
  await expect.poll(() => shown(p, 'style-panel')).toBe(true);
  await p.locator('.sw[data-color="blue"]').click();
  const s = await p.evaluate(() => (window as any).__canvas.editor.doc.all()[0]);
  expect(s.color).toBe('blue');
  // nothing selected: it goes, as after the pointer leaves
  await p.mouse.move(720, 600);
  await p.keyboard.press('Escape');
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.selection.size)).toBe(0);
  await expect.poll(() => gone(p, 'style-panel'), { timeout: 3000 }).toBe(true);
  await A.close();
});

for (const page of [{ name: 'light', artifact: 'sample-report.html', rgb: '255, 255, 255' }, { name: 'dark', artifact: 'dark.html', rgb: '31, 41, 55' }]) {
  test(`the side panels and the title bar are near-opaque with no blur, and their text stays legible (${page.name} page)`, async ({ browser }) => {
    const A = await open(browser, 'Ana', newRoom(`glass-${page.name}`), { artifact: page.artifact, fit: true });
    const p = A.page;
    await expect.poll(() => p.evaluate(() => document.body.classList.contains('theme-dark'))).toBe(page.name === 'dark');
    await p.mouse.move(4, 450);
    await expect.poll(() => shown(p, 'people-panel')).toBe(true);
    const side = await look(p, 'people-panel');
    expect(side.bg).toContain(page.rgb);
    expect(alpha(side.bg)).toBeCloseTo(0.88, 2); // --chrome-alpha
    // no backdrop-filter: a blur behind a panel made every step of a pan draw the whole window again
    expect(['', 'none']).toContain(side.backdrop);
    const bar = await p.locator('.panel.topleft').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, backdrop: cs.backdropFilter || (cs as any).webkitBackdropFilter || '' };
    });
    expect(alpha(bar.bg)).toBeCloseTo(0.94, 2); // a little stronger
    expect(['', 'none']).toContain(bar.backdrop);
    // the top right bar is as it was (opaque)
    expect(alpha(await p.locator('.panel.topright').evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
    // legible: the heading and the title stand out of what is behind them
    const h4 = (await p.getByTestId('people-panel').locator('h4').first().boundingBox())!;
    expect(await contrast(p, h4)).toBeGreaterThan(60);
    const title = (await p.getByTestId('title').boundingBox())!;
    expect(await contrast(p, title)).toBeGreaterThan(90);
    await p.screenshot({ path: `screenshots/chrome-glass-${page.name}.png` });
    await A.close();
  });
}

test('opened with the canvas shown, the page is as wide as the view; the layout stays the room\'s', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    const A = await open(browser, 'Ana', newRoom('fit'), { viewport, fit: true });
    const cam = await A.page.evaluate(() => ({ ...(window as any).__canvas.editor.camera, w: (window as any).__canvas.editor.pageWidth }));
    expect(cam.w).toBe(980);
    expect(cam.z).toBeCloseTo(viewport.width / 980, 3);
    expect(Math.abs(cam.tx)).toBeLessThan(1);
    expect(cam.ty).toBe(0);
    await A.close();
  }
});

const PAGES = [
  { name: 'report', artifact: 'sample-report.html', el: '#target' },
  { name: 'deck', artifact: 'scroll-deck.html', el: '#s3 h2' },
  { name: 'column', artifact: 'column.html', el: '#p-e' },
];
for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  for (const pg of PAGES) {
    test(`showing the canvas does not shrink the page: the block being read keeps its place and size (${pg.name}, ${viewport.width}x${viewport.height})`, async ({ browser }) => {
      const A = await open(browser, 'Ana', newRoom(`no-shrink-${pg.name}`), { artifact: pg.artifact, viewport, query: { canvas: '0' } });
      const p = A.page;
      await expect(p.getByTestId('canvas-show')).toBeVisible();
      const f = frameOf(p);
      // the page as itself: scroll it so the block is in the upper part of the view
      await f.locator('html').evaluate((_h, args) => {
        const el = document.querySelector(args.sel)!;
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.12);
      }, { sel: pg.el });
      await p.waitForTimeout(500);
      const before = (await f.locator(pg.el).boundingBox())!;
      await p.screenshot({ path: `screenshots/canvas-on-${pg.name}-${viewport.width}-hidden.png` });
      await p.getByTestId('canvas-show').click();
      await expect(p.getByTestId('toolbar')).toBeVisible();
      // the reporter's reading position moves the camera once the canvas layout is in place
      await expect.poll(async () => {
        const b = await f.locator(pg.el).boundingBox();
        return !!b && Math.abs(b.y - before.y) < 30 && Math.abs(b.width / before.width - 1) <= 0.15;
      }, { timeout: 8000 }).toBe(true);
      await p.waitForTimeout(300);
      const after = (await f.locator(pg.el).boundingBox())!;
      await p.screenshot({ path: `screenshots/canvas-on-${pg.name}-${viewport.width}-shown.png` });
      console.log(`no-shrink ${pg.name} ${viewport.width}: width ${before.width.toFixed(1)} -> ${after.width.toFixed(1)} (${((after.width / before.width - 1) * 100).toFixed(1)} %), y ${before.y.toFixed(1)} -> ${after.y.toFixed(1)}, z ${await p.evaluate(() => (window as any).__canvas.editor.camera.z.toFixed(3))}`);
      expect(Math.abs(after.width / before.width - 1)).toBeLessThanOrEqual(0.15);
      expect(Math.abs(after.y - before.y)).toBeLessThan(30);
      // never wider than the view
      const page = await p.locator('.page').boundingBox();
      expect(page!.width).toBeLessThanOrEqual(viewport.width + 1);
      await A.close();
    });
  }
}
