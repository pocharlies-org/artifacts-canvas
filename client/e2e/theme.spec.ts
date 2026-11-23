import { expect, test, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, shapes } from './helpers';

/**
 * The board follows the artifact's background (ui/theme.ts): dev/artifacts/dark.html is black
 * with a theme toggle, scheme.html follows prefers-color-scheme on body, sample-report.html is
 * white.
 */

const look = (p: Page) => p.evaluate(() => {
  const css = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : null);
  const e = (window as any).__canvas.editor;
  return {
    stage: css(document.querySelector('[data-testid="stage"]')),
    page: css(document.querySelector('.page')),
    frame: css(document.querySelector('iframe.artifact-frame')),
    body: css(document.body),
    toolbar: css(document.querySelector('[data-testid="toolbar"]')),
    topleft: css(document.querySelector('.panel.topleft')),
    authors: css(document.querySelector('.panel.people')),
    darkClass: document.body.classList.contains('theme-dark'),
    dark: e.dark as boolean,
    style: e.style.color as string,
  };
});

const frameBg = (p: Page) => p.frameLocator('iframe.artifact-frame').locator('html').evaluate((h) => {
  const c = getComputedStyle(h).backgroundColor;
  return c === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : c;
});

test('a dark artifact: the board takes its background, the chrome goes dark, the default black ink is drawn near-white', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('theme-dark'), { artifact: 'dark.html' });
  await expect.poll(async () => (await look(A.page)).dark).toBe(true);
  const l = await look(A.page);
  expect(await frameBg(A.page)).toBe('rgb(11, 11, 15)');
  for (const k of ['stage', 'page', 'frame', 'body'] as const) expect(l[k], k).toBe('rgb(11, 11, 15)');
  expect(l.darkClass).toBe(true);
  // dark panels: toolbar, top bar, the "who drew" / history box
  for (const k of ['toolbar', 'topleft', 'authors'] as const) expect(l[k], k).toBe('rgb(31, 41, 55)');
  // the default ink stays black and is drawn near-white on it (e2e/board-ink.spec.ts)
  expect(l.style).toBe('black');
  await A.page.keyboard.press('d');
  await drawStroke(A.page, [[500, 420], [560, 440], [620, 430], [680, 450]]);
  await expect.poll(async () => (await shapes(A.page)).map((s) => s.color)).toEqual(['black']);
  await expect(A.page.locator('svg.shapes [data-shape-type="draw"] path')).toHaveAttribute('fill', '#f1f3f5');
  // the laser dot stays the laser colour
  await A.page.keyboard.press('k');
  await A.page.mouse.move(600, 500);
  await A.page.mouse.down();
  for (let i = 0; i < 6; i++) await A.page.mouse.move(600 + i * 10, 500);
  await expect(A.page.getByTestId('laser-dot')).toHaveAttribute('fill', '#ff2d55');
  await A.page.mouse.up();
  await A.close();
});

test('a light artifact: a white board, light chrome, black default stroke, as before', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('theme-light'));
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(255, 255, 255)');
  const l = await look(A.page);
  expect(await frameBg(A.page)).toBe('rgb(255, 255, 255)');
  expect(l).toMatchObject({ darkClass: false, dark: false, style: 'black', toolbar: 'rgb(255, 255, 255)', topleft: 'rgb(255, 255, 255)' });
  await A.page.keyboard.press('d');
  await drawStroke(A.page, [[500, 420], [560, 440], [620, 430]]);
  await expect.poll(async () => (await shapes(A.page)).map((s) => s.color)).toEqual(['black']);
  await A.close();
});

test("the artifact's theme toggle changes the board live; the colour in use never changes with it", async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('theme-toggle'), { artifact: 'dark.html' });
  await expect.poll(async () => (await look(A.page)).dark).toBe(true);
  // the artifact's own "Theme" button, with the interact tool
  await A.page.keyboard.press('i');
  await A.page.frameLocator('iframe.artifact-frame').locator('#theme').click();
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(250, 250, 250)');
  expect(await look(A.page)).toMatchObject({ darkClass: false, dark: false, style: 'black', toolbar: 'rgb(255, 255, 255)' });
  await A.page.frameLocator('iframe.artifact-frame').locator('#theme').click();
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(11, 11, 15)');
  expect(await look(A.page)).toMatchObject({ darkClass: true, style: 'black' });
  // a colour picked by hand is kept across theme changes
  await A.page.locator('[data-testid="swatches"] [data-color="red"]').click();
  await A.page.frameLocator('iframe.artifact-frame').locator('#theme').click();
  await expect.poll(async () => (await look(A.page)).darkClass).toBe(false);
  expect((await look(A.page)).style).toBe('red');
  // how often the page told the board: only on change, a few at most
  await A.close();
});

test('prefers-color-scheme: a page that follows the system scheme moves the board with it', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('theme-scheme'), { artifact: 'scheme.html', colorScheme: 'light' });
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(255, 255, 255)');
  await A.page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(16, 20, 24)');
  expect((await look(A.page)).darkClass).toBe(true);
  await A.page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(async () => (await look(A.page)).stage).toBe('rgb(255, 255, 255)');
  await A.close();
});

test('the reporter posts the background only when it changes, paced', async ({ browser }) => {
  // count the bg messages the wrapper receives while the artifact flips its theme 20 times in 1 s
  const count = `window.__bg = 0; addEventListener('message', (e) => { if (e.data && e.data.type === 'bg') window.__bg++; }, true);`;
  const A = await open(browser, 'Ana', newRoom('theme-pace'), { artifact: 'dark.html', initScript: count });
  await expect.poll(async () => (await look(A.page)).dark).toBe(true);
  const before = await A.page.evaluate(() => (window as any).__bg as number);
  await A.page.frameLocator('iframe.artifact-frame').locator('html').evaluate(async (h) => {
    for (let i = 0; i < 20; i++) {
      h.classList.toggle('dark');
      h.classList.toggle('light');
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  await A.page.waitForTimeout(1500);
  const sent = (await A.page.evaluate(() => (window as any).__bg as number)) - before;
  // 20 flips in 1 s, an even number: at most 4 checks a second, each posting only a change
  expect(sent).toBeGreaterThanOrEqual(1);
  expect(sent).toBeLessThanOrEqual(8);
  expect((await look(A.page)).dark).toBe(true);
  await A.close();
});
