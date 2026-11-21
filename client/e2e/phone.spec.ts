import { expect, test, type Page } from '@playwright/test';
import { newRoom, open, type Opened } from './helpers';

/**
 * Every tool of the bottom toolbar must be reachable on a phone, the way a person reaches
 * it: by paging the bar with its visible chevrons (no hidden scrollbar tricks, no
 * Playwright auto-scroll). For each button we page until it is fully visible and not under
 * a chevron, check that it is the element at its own centre, and click it there.
 */
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];

interface Box { left: number; right: number; top: number; bottom: number }

async function toolIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="toolbar"] .tool').evaluateAll((els) =>
    els.filter((e) => !e.closest('.popover')).map((e) => (e as HTMLElement).dataset.testid!));
}

/** Visible, unobstructed horizontal band of the bar (minus any visible chevron). */
async function freeBand(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="toolbar"]')!.getBoundingClientRect();
    const band = { left: Math.max(0, bar.left), right: Math.min(window.innerWidth, bar.right), top: bar.top, bottom: bar.bottom };
    for (const id of ['toolbar-prev', 'toolbar-next']) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (id === 'toolbar-prev') band.left = Math.max(band.left, r.right);
      else band.right = Math.min(band.right, r.left);
    }
    return band;
  });
}

const scrollX = (page: Page): Promise<number> => page.getByTestId('toolbar').evaluate((b) => b.scrollLeft);

/** Wait until the bar has moved away from `from` (smooth scroll started) and then stopped. */
async function settle(page: Page, from?: number): Promise<void> {
  if (from !== undefined) {
    for (let i = 0; i < 40 && (await scrollX(page)) === from; i++) await page.waitForTimeout(25);
  }
  let last = await scrollX(page);
  let still = 0;
  for (let i = 0; i < 80 && still < 4; i++) {
    await page.waitForTimeout(40);
    const x = await scrollX(page);
    still = x === last ? still + 1 : 0;
    last = x;
  }
}

async function clickChevron(page: Page, id: 'toolbar-prev' | 'toolbar-next'): Promise<void> {
  const nav = page.getByTestId(id);
  await expect(nav, `${id} visible when tools are hidden on that side`).toBeVisible();
  const r = (await nav.boundingBox())!;
  const before = await scrollX(page);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await settle(page, before);
}

for (const vp of PHONES) {
  test(`every toolbar tool is reachable and clickable at ${vp.width}x${vp.height}`, async ({ browser }) => {
    const P = await open(browser, 'Phone Tester', newRoom('phone'), { viewport: vp });
    const page = P.page;
    // The bar must not stick out of the screen, and it overflows here: the affordance shows.
    const bar = (await page.getByTestId('toolbar').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(vp.width + 1);
    await expect(page.getByTestId('toolbar-next')).toBeVisible();
    await expect(page.getByTestId('toolbar-prev')).toBeHidden();

    const ids = await toolIds(page);
    expect(ids).toEqual(expect.arrayContaining(["tool-select", "tool-interact", "tool-note", "tool-more", "tool-frame", "tool-image", "tool-laser"]));
    expect(ids.length).toBe(16);
    for (const id of ids) {
      const btn = page.locator(`[data-testid="toolbar"] [data-testid="${id}"]`);
      // Page with the chevrons until the button sits fully in the free band.
      for (let i = 0; i < 12; i++) {
        const r = (await btn.boundingBox())!;
        const band = await freeBand(page);
        if (r.x >= band.left - 0.5 && r.x + r.width <= band.right + 0.5) break;
        await clickChevron(page, r.x + r.width > band.right ? 'toolbar-next' : 'toolbar-prev');
      }
      const r = (await btn.boundingBox())!;
      const band = await freeBand(page);
      expect(r.x, `${id} left edge visible`).toBeGreaterThanOrEqual(band.left - 0.5);
      expect(r.x + r.width, `${id} right edge visible`).toBeLessThanOrEqual(band.right + 0.5);
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const hit = await page.evaluate(([x, y, tid]) => {
        const el = document.elementFromPoint(x as number, y as number);
        return !!el && !!el.closest(`[data-testid="${tid}"]`);
      }, [cx, cy, id] as const);
      expect(hit, `${id} is the element under its own centre`).toBe(true);

      if (id === 'tool-more') {
        await page.mouse.click(cx, cy);
        await expect(page.getByTestId('geo-menu')).toHaveClass(/open/);
        await page.getByTestId('geo-star').click(); // inside the fixed phone grid
        await expect(page.getByTestId('geo-menu')).not.toHaveClass(/open/);
        expect(await page.evaluate(() => [(window as any).__canvas.editor.tool, (window as any).__canvas.editor.geoKind])).toEqual(['geo', 'star']);
      } else {
        await page.mouse.click(cx, cy);
        await expect(btn, `${id} became the active tool`).toHaveAttribute('aria-pressed', 'true');
      }
    }

    // Paged to the far end: the last tool is in view and the right chevron is gone.
    await expect(page.getByTestId('toolbar-prev')).toBeVisible();
    await expect(page.getByTestId('toolbar-next')).toBeHidden();
    const end = await scrollX(page);
    await page.keyboard.press('v'); // shortcut back to the first tool scrolls it into view
    await settle(page, end);
    const sel = (await page.getByTestId('tool-select').boundingBox())!;
    const band = await freeBand(page);
    expect(sel.x).toBeGreaterThanOrEqual(band.left - 0.5);
    await P.close();
  });
}

test('wide desktop shows no toolbar chevrons', async ({ browser }) => {
  const D = await open(browser, 'Desk', newRoom('desk'));
  await expect(D.page.getByTestId('toolbar-next')).toBeHidden();
  await expect(D.page.getByTestId('toolbar-prev')).toBeHidden();
  await D.close();
});

/**
 * The top bar with a full room (ui/chrome.ts topRight): a phone shows 3 avatars of the others and
 * a "+N" chip whose label names the rest, the follow button as an icon, and the whole row fits, so
 * "▶ Presentar" is never cut and nothing scrolls sideways. A desktop keeps its stack as it was: the
 * first 6 people, this user included, and its own "+N" past them.
 */
const OTHERS = ['Ana López', 'Bea Ruiz', 'Carl Ortiz', 'Dora Gil', 'Eva Martín', 'Fran Soto'];

/** The avatars a person sees (not the chips), by name. */
const shownAvatars = (p: Page) => p.locator('[data-testid="avatars"] .av:not(.more)').filter({ visible: true })
  .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.user!));
const chip = (p: Page) => p.getByTestId('avatars-more');
/** The names in the chip's label: "Y 3 más: Dora Gil, Eva Martín, Fran Soto". */
const chipNames = async (p: Page) => ((await chip(p).getAttribute('aria-label')) ?? '').replace(/^Y \d+ más: /, '').split(', ').sort();

async function topBarFits(p: Page, vp: { width: number; height: number }) {
  const present = (await p.getByTestId('present').boundingBox())!;
  expect(present.x, 'Presentar starts on screen').toBeGreaterThanOrEqual(0);
  expect(present.x + present.width, 'Presentar ends on screen').toBeLessThanOrEqual(vp.width);
  expect(present.y).toBeGreaterThanOrEqual(0);
  const hit = await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="present"]'),
    [present.x + present.width / 2, present.y + present.height / 2]);
  expect(hit, 'Presentar is the element under its own centre').toBe(true);
  const bar = await p.locator('.panel.topright').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right }));
  expect(bar.sw, 'the top bar does not scroll sideways').toBeLessThanOrEqual(bar.cw);
  expect(bar.right).toBeLessThanOrEqual(vp.width);
  // nothing dropped: the hide button and the count are there, and the follow icon keeps its label
  await expect(p.getByTestId('canvas-hide')).toBeVisible();
  await expect(p.getByTestId('audience')).toBeVisible();
  await expect(p.getByTestId('follow')).toBeVisible();
  await expect(p.getByTestId('follow')).toHaveAttribute('aria-label', 'Seguir a…');
}

for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
  test(`the top bar at ${vp.width}x${vp.height} with six others: 3 avatars, a "+3" chip naming the rest, and Presentar whole`, async ({ browser }) => {
    const room = newRoom('topbar');
    // Ana on a desktop, the others with the canvas hidden (they count the same: people, not tabs)
    const ana = await open(browser, OTHERS[0], room);
    const rest = new Map<string, Opened>();
    for (const n of OTHERS.slice(1)) rest.set(n, await open(browser, n, room, { query: { canvas: '0' } }));
    const me = await open(browser, 'Gus Vidal', room, { viewport: vp });
    const p = me.page;
    await expect(p.getByTestId('audience')).toHaveAttribute('data-viewing', '6');

    // six others: 3 avatars (not mine) and "+3", whose label names the 3 not shown
    await expect.poll(() => shownAvatars(p)).toHaveLength(3);
    const shown = await shownAvatars(p);
    expect(shown).not.toContain('Gus Vidal');
    await expect(chip(p)).toBeVisible();
    await expect(chip(p)).toHaveText('+3');
    await expect(p.locator('[data-testid="avatars"] .av.more').filter({ visible: true })).toHaveCount(1);
    expect(await chipNames(p)).toEqual(OTHERS.filter((n) => !shown.includes(n)).sort());
    await expect(chip(p)).toHaveAttribute('title', (await chip(p).getAttribute('aria-label'))!);
    await topBarFits(p, vp);

    // the desktop stack is as before: 6 of the 7 people (Ana's own first) and its "+1", no phone chip
    await expect.poll(() => shownAvatars(ana.page)).toHaveLength(6);
    expect((await shownAvatars(ana.page))[0]).toBe(OTHERS[0]);
    await expect(ana.page.locator('[data-testid="avatars"] .av.more').filter({ visible: true })).toHaveText(['+1']);
    await expect(chip(ana.page)).toBeHidden();
    await expect(ana.page.getByTestId('follow').locator('.lbl-full')).toBeVisible(); // the label, not the icon
    await expect(ana.page.getByTestId('follow').locator('.lbl-full')).toHaveText('Seguir a…');
    await expect(ana.page.getByTestId('follow').locator('.lbl-short')).toBeHidden();

    // the chip opens the people panel, where "Ahora aquí" lists all six
    await chip(p).click();
    await expect(p.locator('.panel.people')).toBeVisible();
    await expect(p.getByTestId('here-row')).toHaveCount(6);
    await p.evaluate(() => document.body.classList.remove('panels-open'));

    // two of the hidden ones leave: "+1", naming the one left out
    const hiddenNow = OTHERS.filter((n) => !shown.includes(n) && n !== OTHERS[0]);
    for (const n of hiddenNow.slice(0, 2)) await rest.get(n)!.close();
    await expect(p.getByTestId('audience')).toHaveAttribute('data-viewing', '4');
    await expect(chip(p)).toHaveText('+1');
    const shown4 = await shownAvatars(p);
    expect(shown4).toHaveLength(3);
    const left = OTHERS.filter((n) => !hiddenNow.slice(0, 2).includes(n));
    expect(await chipNames(p)).toEqual(left.filter((n) => !shown4.includes(n)));
    await topBarFits(p, vp);
    // and the desktop: all 5 people, no chip at all
    await expect.poll(() => shownAvatars(ana.page)).toHaveLength(5);
    await expect(ana.page.locator('[data-testid="avatars"] .av.more').filter({ visible: true })).toHaveCount(0);

    // one more leaves: 3 others, 3 avatars, no chip
    const third = left.find((n) => n !== OTHERS[0] && rest.has(n) && !hiddenNow.slice(0, 2).includes(n))!;
    await rest.get(third)!.close();
    await expect(p.getByTestId('audience')).toHaveAttribute('data-viewing', '3');
    await expect(chip(p)).toHaveCount(0);
    await expect.poll(() => shownAvatars(p)).toHaveLength(3);
    await topBarFits(p, vp);

    for (const [n, o] of rest) if (n !== third && !hiddenNow.slice(0, 2).includes(n)) await o.close();
    await ana.close();
    await me.close();
  });
}
