import type { Browser, Page } from '@playwright/test';

export interface Opened {
  page: Page;
  close: () => Promise<void>;
}

let roomCounter = 0;
export function newRoom(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${roomCounter++}`;
}

/**
 * Open the wrapper as `name` (dev identity) in its own browser context. The canvas is shown
 * (`?canvas=1`) unless `opts.query` sets `canvas` or `opts.firstVisit` asks for a visit with no
 * query and no stored choice (a first visit opens the canvas hidden: src/ui/canvas-pref.ts).
 * `hash` ends the URL (`#s3`); `delayFrame` holds the artifact's frame back that many ms, so the
 * room is joined well before the page's load event.
 */
export async function open(browser: Browser, name: string, room: string, opts: { artifact?: string; viewport?: { width: number; height: number }; lang?: string; deviceScaleFactor?: number; prodCsp?: boolean; query?: Record<string, string>; mobile?: boolean; initScript?: string; firstVisit?: boolean; colorScheme?: 'light' | 'dark'; fit?: boolean; hash?: string; delayFrame?: number } = {}): Promise<Opened> {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: opts.deviceScaleFactor, acceptDownloads: true,
    ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  const delay = opts.delayFrame;
  if (delay) {
    await ctx.route('**/_canvas/_/frame/**', async (r) => {
      await new Promise((res) => setTimeout(res, delay));
      await r.continue();
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  const q = new URLSearchParams({ room, as: name });
  if (opts.lang) q.set('lang', opts.lang);
  if (opts.prodCsp) q.set('csp', 'prod'); // the dev server then sends the production wrapper CSP
  if (!opts.firstVisit && !opts.query?.present) q.set('canvas', '1');
  for (const [k, v] of Object.entries(opts.query ?? {})) q.set(k, v);
  await page.goto(`/_canvas/${opts.artifact ?? 'sample-report.html'}?${q}${opts.hash ?? ''}`);
  await ready(page);
  // a desktop opened with the canvas shown: the earlier 100 % camera, which the screen geometry of
  // most specs was written for, unless the spec asks for the default one (`fit`: e2e/chrome-ui.spec.ts)
  const shown = !opts.firstVisit && opts.query?.canvas !== '0' && !opts.query?.present;
  if (shown && !opts.fit && !opts.mobile && (opts.viewport?.width ?? 1440) >= 760) await classicCamera(page);
  return { page, close: () => ctx.close() };
}

export async function ready(page: Page) {
  await page.waitForFunction(() => {
    const c = (window as any).__canvas;
    return c?.editor?.me && c.editor.status === 'synced' && c.editor.pageHeight > 1000;
  });
}

/**
 * The camera of the earlier default: 100 %, the page centred, its top under the top bars. The
 * default now shows the page as wide as the view (editor.ts resetCamera); tests whose screen
 * geometry was written for 100 % (a point beside the page, a band of a given width) set this one.
 */
export async function classicCamera(page: Page) {
  await page.evaluate(() => {
    const e = (window as any).__canvas.editor;
    e.setCamera({ z: 1, tx: (e.viewW - e.pageWidth) / 2, ty: 70 }, 'system');
  });
}

/** Bring a side panel on a desktop (the mouse at its screen edge) and keep it (the mouse on it). */
export async function showSide(page: Page, side: 'left' | 'right') {
  const vp = page.viewportSize()!;
  const id = side === 'left' ? 'people-panel' : 'style-panel';
  await page.mouse.move(side === 'left' ? 3 : vp.width - 3, vp.height / 2);
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return !!el && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '1';
  }, id);
  const b = (await page.getByTestId(id).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 12, { steps: 3 });
}

export function shapes(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__canvas.editor.doc.all());
}

export function camera(page: Page): Promise<{ tx: number; ty: number; z: number }> {
  return page.evaluate(() => (window as any).__canvas.editor.camera);
}

export async function drawStroke(page: Page, pts: [number, number][], release = true) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  if (release) await page.mouse.up();
}

export async function dragBox(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await page.mouse.move(x1, y1, { steps: 3 });
  await page.mouse.up();
}

export function wave(x: number, y: number, n = 25, dx = 10): [number, number][] {
  return Array.from({ length: n }, (_, i) => [x + i * dx, y + Math.sin(i / 3) * 25] as [number, number]);
}
