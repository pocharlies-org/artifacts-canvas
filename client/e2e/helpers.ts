import type { Browser, Page } from '@playwright/test';

export interface Opened {
  page: Page;
  close: () => Promise<void>;
}

let roomCounter = 0;
export function newRoom(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${roomCounter++}`;
}

/** Open the wrapper as `name` (dev identity) in its own browser context. */
export async function open(browser: Browser, name: string, room: string, opts: { artifact?: string; viewport?: { width: number; height: number }; lang?: string } = {}): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  const q = new URLSearchParams({ room, as: name });
  if (opts.lang) q.set('lang', opts.lang);
  await page.goto(`/_canvas/${opts.artifact ?? 'sample-report.html'}?${q}`);
  await ready(page);
  return { page, close: () => ctx.close() };
}

export async function ready(page: Page) {
  await page.waitForFunction(() => {
    const c = (window as any).__canvas;
    return c?.editor?.me && c.editor.status === 'synced' && c.editor.pageHeight > 1000;
  });
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
