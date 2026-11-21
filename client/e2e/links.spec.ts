import { expect, test, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, ready, shapes } from './helpers';

/**
 * Links of the artifact (dev/artifacts/links.html): the interact tool hands the pointer to the
 * page; the reporter stops the frame's own navigation and the wrapper decides (artifact/links.ts):
 * another file of the artifact opens its canvas, another site opens in a new tab with
 * noopener/noreferrer, an anchor scrolls the canvas, anything not http(s) is blocked.
 */

const frameOf = (p: Page) => p.frameLocator('iframe.artifact-frame');
const frameTitle = (p: Page) => p.evaluate(() => (window as any).__canvas.editor.frame.title as string);

/** The external site of links.html, served locally so no test leaves the machine. */
async function serveExternal(p: Page) {
  await p.context().route('https://external.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>external</title><p>external page</p>' }));
}

test('interact tool: an internal link opens that page in the canvas, keeping the room parameters', async ({ browser }) => {
  const room = newRoom('links-internal');
  const A = await open(browser, 'Ana', room, { artifact: 'links.html' });
  await expect.poll(() => frameTitle(A.page)).toBe('Links test page');
  await A.page.keyboard.press('i');
  await expect(A.page.getByTestId('tool-interact')).toHaveClass(/\bon\b/);
  await expect(A.page.locator('iframe.artifact-frame')).toHaveClass(/\binteractive\b/);
  // the page's own button and inner scrolling work, nothing is drawn
  await frameOf(A.page).locator('#btn').click();
  await expect(frameOf(A.page).locator('#out')).toHaveText('button clicked');
  const scroller = frameOf(A.page).locator('#scroller');
  const sb = (await scroller.boundingBox())!;
  const cam0 = await A.page.evaluate(() => ({ ...(window as any).__canvas.editor.camera }));
  await A.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await A.page.mouse.wheel(0, 120);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.camera)).toEqual(cam0);
  // a wheel over the rest of the page pans the canvas, as on the canvas itself
  await A.page.mouse.move(700, 700);
  await A.page.mouse.wheel(0, 300);
  await expect.poll(() => A.page.evaluate(() => (window as any).__canvas.editor.camera.ty)).toBeLessThan(cam0.ty - 200);
  await A.page.mouse.wheel(0, -300);
  expect(await shapes(A.page)).toHaveLength(0);
  // the internal link
  await frameOf(A.page).locator('#internal').click();
  await A.page.waitForURL(/\/_canvas\/links-b\.html\?/);
  const url = new URL(A.page.url());
  expect(url.searchParams.get('as')).toBe('Ana');
  expect(url.searchParams.get('room')).toBe(room);
  expect(url.searchParams.get('present')).toBeNull();
  await ready(A.page);
  await expect.poll(() => frameTitle(A.page)).toBe('Links page B');
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.cfg.artifactPath)).toBe('links-b.html');
  await A.close();
});

test('interact tool: an external link opens a new tab with noopener and noreferrer; the canvas stays', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('links-external'), { artifact: 'links.html' });
  await serveExternal(A.page);
  const before = A.page.url();
  await A.page.keyboard.press('i');
  const [popup] = await Promise.all([
    A.page.context().waitForEvent('page'),
    frameOf(A.page).locator('#external').click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toBe('https://external.test/landing?from=canvas');
  expect(await popup.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: '' });
  expect(A.page.url()).toBe(before);
  await expect.poll(() => frameTitle(A.page)).toBe('Links test page');
  // target=_blank on an internal link: that page's canvas in a new tab
  const [tab] = await Promise.all([
    A.page.context().waitForEvent('page'),
    frameOf(A.page).locator('#blank').click(),
  ]);
  await tab.waitForLoadState('domcontentloaded');
  expect(new URL(tab.url()).pathname).toBe('/_canvas/links-b.html');
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  expect(A.page.url()).toBe(before);
  await A.close();
});

test('interact tool: an anchor scrolls the canvas to its target; data: and javascript: links open nothing', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('links-anchor'), { artifact: 'links.html' });
  const before = A.page.url();
  await A.page.keyboard.press('i');
  await frameOf(A.page).locator('#anchor').click();
  // section 3 comes to the top of the view, under the top panels
  await expect.poll(async () => Math.round((await frameOf(A.page).locator('#section-3').boundingBox())!.y)).toBe(70);
  expect(A.page.url()).toBe(before);
  await frameOf(A.page).locator('#back').click();
  await expect.poll(async () => Math.round((await frameOf(A.page).locator('#top').boundingBox())!.y)).toBeLessThan(140);
  // data: never navigates anything
  await frameOf(A.page).locator('#data').click();
  await expect(A.page.getByTestId('toast')).toHaveText('Ese enlace no se puede abrir desde el lienzo.');
  await A.page.waitForTimeout(300);
  expect(A.page.url()).toBe(before);
  await expect.poll(() => frameTitle(A.page)).toBe('Links test page');
  expect(A.page.context().pages()).toHaveLength(1);
  // javascript: is left to the frame (the browser does not run it in a sandboxed frame); the wrapper opens nothing
  await frameOf(A.page).locator('#js').click();
  await A.page.waitForTimeout(300);
  expect(A.page.url()).toBe(before);
  expect(A.page.context().pages()).toHaveLength(1);
  await expect.poll(() => frameTitle(A.page)).toBe('Links test page');
  await A.close();
});

test('the pen draws over a link instead of following it; the select tool follows it with a click', async ({ browser }) => {
  const room = newRoom('links-pen');
  const A = await open(browser, 'Ana', room, { artifact: 'links.html' });
  const before = A.page.url();
  const link = (await frameOf(A.page).locator('#internal').boundingBox())!;
  const y = link.y + link.height / 2;
  await A.page.keyboard.press('d');
  await drawStroke(A.page, [[link.x + 4, y], [link.x + link.width / 3, y + 2], [link.x + link.width - 4, y - 2]]);
  await expect.poll(async () => (await shapes(A.page)).length).toBe(1);
  // a plain click with the pen draws (or does nothing), it never navigates
  await A.page.mouse.click(link.x + link.width / 2, y + 6);
  await A.page.waitForTimeout(500);
  expect(A.page.url()).toBe(before);
  expect((await shapes(A.page)).length).toBeGreaterThanOrEqual(1);
  // clear the drawings so nothing lies over the link
  await A.page.keyboard.press('v');
  await A.page.keyboard.press('Meta+a');
  await A.page.keyboard.press('Delete');
  await expect.poll(async () => (await shapes(A.page)).length).toBe(0);
  // the select tool: a pointer over the link, and a click follows it
  await A.page.mouse.move(link.x + link.width / 2 - 5, y);
  await A.page.mouse.move(link.x + link.width / 2, y);
  await expect(A.page.getByTestId('stage')).toHaveAttribute('data-cursor', 'pointer');
  await A.page.mouse.move(link.x + link.width / 2, y + 200);
  await expect(A.page.getByTestId('stage')).not.toHaveAttribute('data-cursor', 'pointer');
  await A.page.mouse.click(link.x + link.width / 2, y);
  await A.page.waitForURL(/\/_canvas\/links-b\.html\?/);
  await A.close();
});

test('while presenting, an internal link keeps presentation mode on the next page', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('links-present'), { artifact: 'links.html' });
  await A.page.getByTestId('present').click();
  await expect.poll(() => A.page.evaluate(() => document.body.classList.contains('present-mode'))).toBe(true);
  await A.page.getByTestId('present-tool-interact').click();
  await frameOf(A.page).locator('#internal').click();
  await A.page.waitForURL(/\/_canvas\/links-b\.html\?.*present=1/);
  await ready(A.page);
  await expect.poll(() => A.page.evaluate(() => (window as any).__canvas.editor.presenting)).toBe(true);
  await expect(A.page.getByTestId('present-badge')).toBeVisible();
  await A.close();
});

test("the artifact's own script cannot navigate, open, pan or press keys through the reporter's messages", async ({ browser }) => {
  // links-forge.html posts link, anchor, wheel and key messages every 400 ms, on its own
  const A = await open(browser, 'Ana', newRoom('links-forge'), { artifact: 'links-forge.html' });
  await serveExternal(A.page);
  const before = A.page.url();
  const forged = () => frameOf(A.page).locator('#forged').textContent().then(Number);
  // the interact tool, and a click on the canvas beside the page: this page has a user gesture,
  // but the user is not acting on the artifact
  await A.page.keyboard.press('i');
  await A.page.mouse.click(1330, 450);
  const cam = await A.page.evaluate(() => ({ ...(window as any).__canvas.editor.camera }));
  const n0 = await forged();
  await expect.poll(forged, { timeout: 6000 }).toBeGreaterThan(n0 + 4);
  expect(A.page.url()).toBe(before);
  expect(A.page.context().pages()).toHaveLength(1);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.camera)).toEqual(cam);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.tool)).toBe('interact');
  // the select tool: still nothing
  await A.page.keyboard.press('v');
  const n1 = await forged();
  await expect.poll(forged, { timeout: 6000 }).toBeGreaterThan(Math.min(19, n1 + 3));
  expect(A.page.url()).toBe(before);
  expect(A.page.context().pages()).toHaveLength(1);
  expect(await A.page.evaluate(() => (window as any).__canvas.editor.camera)).toEqual(cam);
  await A.close();
});
