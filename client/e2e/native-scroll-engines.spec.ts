import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

/**
 * Native scroll (`?scroll=native`) in every engine (it runs in Chromium, Firefox and WebKit: client/playwright.config.ts):
 * the reporter scrolls the artifact's document, whose root has no scrollbar and no overflow, in a
 * sandboxed frame; the frame stays put and a drawing stays on the page (e2e/native-scroll.spec.ts
 * has the rest, in Chromium).
 */
const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');

test('the default view scrolls the artifact\'s own document, and a drawing stays on the page', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('native-engines'), { artifact: 'sections.html', fit: true, query: { scroll: 'native' } });
  const p = A.page;
  const native = () => p.evaluate(() => (window as any).__canvas.editor.nativeScrolling as boolean);
  await expect.poll(native).toBe(true);
  const box = async () => (await p.locator('iframe.artifact-frame').boundingBox())!;
  const f0 = await box();
  // a stroke on the first section's heading
  await p.keyboard.press('d');
  await p.mouse.move(300, 120);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(300 + i * 25, 120 + (i % 2) * 8);
  await p.mouse.up();
  const strokeY = async () => (await p.locator('svg.shapes [data-shape-type="draw"]').first().boundingBox())!.y;
  const headY = async () => {
    const f = await box();
    const r = await frameOf(p).locator('#s1 h2').evaluate((el) => ({ y: el.getBoundingClientRect().y, vw: window.innerWidth }));
    return f.y + r.y * (f.width / r.vw);
  };
  const o0 = (await strokeY()) - (await headY());
  // scroll a screen down, by the camera's own API (the same path as a wheel)
  await p.evaluate(() => (window as any).__canvas.editor.panBy(0, -600));
  const scrolled = () => frameOf(p).locator('html').evaluate(() => window.scrollY);
  await expect.poll(scrolled).toBeGreaterThan(300);
  await expect.poll(async () => {
    const e = await p.evaluate(() => (window as any).__canvas.editor.visibleWorld().y as number);
    return Math.abs(e - (await scrolled()));
  }).toBeLessThan(0.5);
  expect(await native()).toBe(true);
  const f1 = await box();
  expect(Math.abs(f1.y - f0.y)).toBeLessThan(0.01);
  expect(Math.abs(f1.height - f0.height)).toBeLessThan(0.01);
  await expect.poll(async () => Math.abs((await strokeY()) - (await headY()) - o0)).toBeLessThan(1.5);
  await A.close();
});
