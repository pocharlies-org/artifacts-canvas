import { expect, test, type Page } from '@playwright/test';
import { newRoom, open } from './helpers';

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
    expect(ids).toEqual(expect.arrayContaining(["tool-select", "tool-note", "tool-more", "tool-frame", "tool-image", "tool-laser"]));
    expect(ids.length).toBe(15);
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
