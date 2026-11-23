import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, shapes } from './helpers';

/**
 * The highlighter and the default ink follow the board (model/colors.ts). On a light page a
 * highlighter multiplies: the page under it gets darker, like a marker on paper. On a dark page it
 * screens in a fluorescent ink: the page under it gets brighter, a band in front of the text, and
 * the text stays bright (multiply turned a dark page almost black, so the stroke looked behind
 * the text). `black`, the default ink, is black on a light board and near-white on a dark one,
 * from the same stored colour. The export paints the same way as the screen.
 * dev/artifacts/dark.html is dark (#0b0b0f) with a theme toggle; sample-report.html is white.
 */

type Box = { x: number; y: number; w: number; h: number };
type Shot = { mean: number; top: number; bottom: number };

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');

/** The title's text (not its block) on the screen, in viewport px. */
async function titleBox(page: Page): Promise<Box> {
  const h1 = frameOf(page).locator('h1');
  const bb = (await h1.boundingBox())!;
  // the text's own width, as a share of the h1 block (the frame may be scaled by the camera)
  const share = await h1.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width / el.getBoundingClientRect().width;
  });
  return { x: bb.x, y: bb.y, w: bb.width * share, h: bb.height };
}

/** Mean brightness (0..255, mean of R, G and B) of a region of a PNG, and of its brightest and darkest 10 %. */
function brightness(page: Page, png: Buffer, r: Box): Promise<Shot> {
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
      return { mean: avg(v), top: avg(v.slice(-k)), bottom: avg(v.slice(0, k)) };
    },
    { b64: png.toString('base64'), r },
  );
}

/** A screenshot of the viewport, measured in `r` (viewport px; the e2e browser runs at device scale 1). */
async function screen(page: Page, r: Box): Promise<Shot> {
  return brightness(page, await page.screenshot(), r);
}

/** PNG of the current view (the export menu), measured in `r` (viewport px). */
async function exported(page: Page, r: Box, name: string): Promise<Shot> {
  const stage = await page.evaluate(() => {
    const b = (window as any).__canvas.editor.stage.getBoundingClientRect();
    return { x: b.left, y: b.top };
  });
  await page.getByTestId('export').click();
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.getByTestId('export-png-view').click();
  const file = (await (await dl).path())!;
  fs.copyFileSync(file, `test-results/${name}.png`);
  return brightness(page, fs.readFileSync(file), { ...r, x: r.x - stage.x, y: r.y - stage.y });
}

/** The rendered element of the last shape, its computed blend and paint. */
function lastShapeLook(page: Page) {
  return page.evaluate(() => {
    const ed = (window as any).__canvas.editor;
    const all = ed.doc.all();
    const s = all[all.length - 1];
    const g = document.querySelector(`svg.shapes [data-shape-id="${s.id}"]`)!;
    const el = g.querySelector('path, circle') as SVGElement;
    const cs = getComputedStyle(el);
    return { color: s.color as string, highlight: s.highlight as boolean, blend: cs.mixBlendMode, stroke: el.getAttribute('stroke'), fill: el.getAttribute('fill') };
  });
}

/** Draws a highlight through the middle of the title and past its end, over the blank page. */
async function highlightTitle(page: Page, t: Box) {
  const y = Math.round(t.y + t.h / 2);
  await page.keyboard.press('Shift+D');
  await drawStroke(page, Array.from({ length: 16 }, (_, i) => [Math.round(t.x - 10 + i * ((t.w + 190) / 15)), y] as [number, number]));
  await page.keyboard.press('Escape');
  // nothing hovered or selected on top of the stroke when the pixels are read
  await page.mouse.move(5, 300);
  await page.evaluate(() => (window as any).__canvas.editor.renderer.flush());
}

/** The two regions read under the stroke: across the title's text, and the blank page right of it. */
function regions(t: Box): { text: Box; blank: Box } {
  const y = Math.round(t.y + t.h / 2) - 5;
  return {
    text: { x: Math.round(t.x + 2), y, w: Math.round(t.w - 4), h: 10 },
    blank: { x: Math.round(t.x + t.w + 50), y, w: 100, h: 10 },
  };
}

test('dark page: the highlighter screens, a bright fluorescent band in front of the text; the export matches', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('ink-hl-dark'), { artifact: 'dark.html' });
  const page = A.page;
  await expect.poll(() => page.evaluate(() => (window as any).__canvas.editor.dark)).toBe(true);
  const t = await titleBox(page);
  const r = regions(t);
  const before = { text: await screen(page, r.text), blank: await screen(page, r.blank) };
  await highlightTitle(page, t);
  const look = await lastShapeLook(page);
  // the default ink is black; the highlighter turns it into yellow, in its dark-board ink
  expect(look).toMatchObject({ color: 'yellow', highlight: true, blend: 'screen', stroke: '#ffe81a' });
  const after = { text: await screen(page, r.text), blank: await screen(page, r.blank) };
  await page.screenshot({ path: 'test-results/ink-highlight-dark.png', clip: { x: t.x - 40, y: t.y - 40, width: t.w + 320, height: t.h + 80 } });
  console.log('dark highlight', { t, before, after });
  // the blank page under the stroke: from near-black to a bright band
  expect(after.blank.mean).toBeGreaterThan(before.blank.mean + 80);
  // over the title: brighter overall, and the light text keeps its brightness (it is not covered by a dark smear)
  expect(after.text.mean).toBeGreaterThan(before.text.mean + 40);
  expect(after.text.top).toBeGreaterThanOrEqual(before.text.top - 3);
  // the export paints the highlighter the same way (screen, over the artifact)
  const png = await exported(page, r.blank, 'ink-highlight-dark-export');
  console.log('dark highlight export', png);
  expect(png.mean).toBeGreaterThan(before.blank.mean + 80);
  expect(Math.abs(png.mean - after.blank.mean)).toBeLessThan(20);
  await A.close();
});

test('light page: the highlighter multiplies, the page under it gets darker, as before; the export matches', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('ink-hl-light'));
  const page = A.page;
  await expect.poll(() => page.evaluate(() => (window as any).__canvas.editor.board.r)).toBe(255);
  expect(await page.evaluate(() => (window as any).__canvas.editor.dark)).toBe(false);
  const t = await titleBox(page);
  const r = regions(t);
  const before = { text: await screen(page, r.text), blank: await screen(page, r.blank) };
  await highlightTitle(page, t);
  const look = await lastShapeLook(page);
  expect(look).toMatchObject({ color: 'yellow', highlight: true, blend: 'multiply', stroke: '#fab005' });
  const after = { text: await screen(page, r.text), blank: await screen(page, r.blank) };
  await page.screenshot({ path: 'test-results/ink-highlight-light.png', clip: { x: t.x - 40, y: t.y - 40, width: t.w + 320, height: t.h + 80 } });
  console.log('light highlight', { t, before, after });
  expect(after.blank.mean).toBeLessThan(before.blank.mean - 25);
  expect(after.text.mean).toBeLessThan(before.text.mean - 15);
  // the dark text stays dark under it
  expect(after.text.bottom).toBeLessThanOrEqual(before.text.bottom + 3);
  const png = await exported(page, r.blank, 'ink-highlight-light-export');
  console.log('light highlight export', png);
  expect(png.mean).toBeLessThan(before.blank.mean - 25);
  expect(Math.abs(png.mean - after.blank.mean)).toBeLessThan(20);
  await A.close();
});

test('black ink: near-white on a dark page, black on a light one, the same stored colour; the swatch follows', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('ink-black'), { artifact: 'dark.html' });
  const page = A.page;
  await expect.poll(() => page.evaluate(() => (window as any).__canvas.editor.dark)).toBe(true);
  const swatch = () => page.locator('[data-testid="swatches"] [data-color="black"]').evaluate((b) => getComputedStyle(b).backgroundColor);
  // the default ink is black, on a dark board too
  expect(await page.evaluate(() => (window as any).__canvas.editor.style.color)).toBe('black');
  expect(await swatch()).toBe('rgb(241, 243, 245)');
  const t = await titleBox(page);
  // a straight pen stroke on the blank page right of the title
  const y = Math.round(t.y + t.h / 2);
  const x0 = Math.round(t.x + t.w + 60);
  await page.keyboard.press('d');
  await drawStroke(page, Array.from({ length: 12 }, (_, i) => [x0 + i * 20, y] as [number, number]));
  await page.mouse.move(5, 300);
  await page.evaluate(() => (window as any).__canvas.editor.renderer.flush());
  expect((await shapes(page)).map((s) => s.color)).toEqual(['black']);
  expect(await lastShapeLook(page)).toMatchObject({ color: 'black', highlight: false, fill: '#f1f3f5' });
  const ink: Box = { x: x0 + 60, y: y - 1, w: 100, h: 3 };
  // the page's top padding, above the title: nothing there
  const blank: Box = { x: x0 + 60, y: Math.round(t.y - 8), w: 100, h: 3 };
  const onDark = { ink: await screen(page, ink), blank: await screen(page, blank) };
  await page.screenshot({ path: 'test-results/ink-black-dark.png', clip: { x: t.x - 40, y: t.y - 40, width: t.w + 360, height: t.h + 80 } });
  console.log('black ink on dark', onDark);
  expect(onDark.ink.mean).toBeGreaterThan(200);
  expect(onDark.blank.mean).toBeLessThan(30);
  // the export draws it the same way, on the page's dark background
  const png = { ink: await exported(page, ink, 'ink-black-dark-export'), blank: await exported(page, blank, 'ink-black-dark-export-2') };
  console.log('black ink on dark, export', png);
  expect(png.ink.mean).toBeGreaterThan(200);
  expect(png.blank.mean).toBeLessThan(30);
  // the artifact's own theme toggle: the board turns light and the same stroke is drawn black
  await page.keyboard.press('i');
  await frameOf(page).locator('#theme').click();
  await expect.poll(() => page.evaluate(() => (window as any).__canvas.editor.dark)).toBe(false);
  await page.mouse.move(5, 300);
  await page.evaluate(() => (window as any).__canvas.editor.renderer.flush());
  expect(await lastShapeLook(page)).toMatchObject({ color: 'black', fill: '#1d1d1f' });
  expect(await swatch()).toBe('rgb(29, 29, 31)');
  const onLight = { ink: await screen(page, ink), blank: await screen(page, blank) };
  console.log('black ink on light', onLight);
  expect(onLight.ink.mean).toBeLessThan(60);
  expect(onLight.blank.mean).toBeGreaterThan(240);
  // and back: the board's toggle re-renders it near-white again
  await frameOf(page).locator('#theme').click();
  await expect.poll(() => page.evaluate(() => (window as any).__canvas.editor.dark)).toBe(true);
  await expect.poll(async () => (await lastShapeLook(page)).fill).toBe('#f1f3f5');
  expect((await shapes(page)).map((s) => s.color)).toEqual(['black']);
  await A.close();
});
