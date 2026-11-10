import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { dragBox, newRoom, open } from './helpers';

test('export PNG and PDF of the current view and of the whole artifact', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('export'));
  const page = A.page;
  await page.keyboard.press('r');
  await dragBox(page, 450, 300, 700, 420);
  await page.keyboard.press('Escape');
  const cases: [string, string, number][] = [
    ['export-png-view', '.png', 0x89],
    ['export-png-full', '.png', 0x89],
    ['export-pdf-view', '.pdf', 0x25],
    ['export-pdf-full', '.pdf', 0x25],
  ];
  for (const [id, ext, magic] of cases) {
    await page.getByTestId('export').click();
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await page.getByTestId(id).click();
    const d = await dl;
    expect(d.suggestedFilename()).toBe(`sample-report-anotado${ext}`);
    const file = await d.path();
    const buf = fs.readFileSync(file!);
    expect(buf[0]).toBe(magic);
    if (ext === '.png') {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (id.endsWith('full')) expect(h).toBeGreaterThan(w); // whole (tall) artifact
      else expect(w / h).toBeCloseTo(1440 / 900, 1);
      fs.copyFileSync(file!, `test-results/${id}.png`);
    } else {
      const txt = buf.toString('latin1');
      expect(txt.startsWith('%PDF-1.4')).toBe(true);
      const pages = Number(txt.match(/\/Count (\d+)/)![1]);
      if (id.endsWith('full')) expect(pages).toBeGreaterThan(1);
      else expect(pages).toBe(1);
    }
  }
  await A.close();
});

type ColorBox = { x0: number; y0: number; x1: number; y1: number; n: number; cx: number; cy: number };

/** Decode a PNG in the page and return the bounding box of the pixels within `tol` of `rgb` inside `win`. */
function colorBox(page: import('@playwright/test').Page, png: Buffer, rgb: [number, number, number], tol: number, win?: { x: number; y: number; w: number; h: number }): Promise<ColorBox & { w: number; h: number }> {
  return page.evaluate(
    async ({ b64, rgb, tol, win }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      const r = win ?? { x: 0, y: 0, w: c.width, h: c.height };
      // Bounds from rows/columns with at least MIN matching pixels: a stray anti-aliased pixel
      // of another element in the same colour (seen on Linux at a shape's edge) must not move them.
      const MIN = 3;
      const cols = new Map<number, number>();
      const rows = new Map<number, number>();
      let n = 0, sx = 0, sy = 0;
      for (let y = Math.max(0, r.y); y < Math.min(c.height, r.y + r.h); y++) {
        for (let x = Math.max(0, r.x); x < Math.min(c.width, r.x + r.w); x++) {
          const i = (y * c.width + x) * 4;
          if (Math.abs(px[i] - rgb[0]) <= tol && Math.abs(px[i + 1] - rgb[1]) <= tol && Math.abs(px[i + 2] - rgb[2]) <= tol) {
            n++;
            sx += x;
            sy += y;
            cols.set(x, (cols.get(x) ?? 0) + 1);
            rows.set(y, (rows.get(y) ?? 0) + 1);
          }
        }
      }
      const keep = (m: Map<number, number>) => [...m].filter(([, k]) => k >= MIN).map(([v]) => v);
      const xs = keep(cols);
      const ys = keep(rows);
      const x0 = xs.length ? Math.min(...xs) : Infinity, x1 = xs.length ? Math.max(...xs) : -Infinity;
      const y0 = ys.length ? Math.min(...ys) : Infinity, y1 = ys.length ? Math.max(...ys) : -Infinity;
      return { x0, y0, x1, y1, n, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN, w: c.width, h: c.height };
    },
    { b64: png.toString('base64'), rgb, tol, win },
  );
}

// Regression: the "current view" PNG must be the visible viewport (same size x pixel ratio, same world region).
for (const dpr of [1, 2]) test(`PNG of the current view matches the visible viewport at any pan and zoom (devicePixelRatio ${dpr})`, async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('export-view'), { deviceScaleFactor: dpr });
  const page = A.page;
  // a known camera: zoomed in to 150% and panned
  await page.evaluate(() => (window as any).__canvas.editor.setCamera({ z: 1.5, tx: -260, ty: -180 }));
  // a solid violet rectangle at a known screen position
  await page.locator('.sw[data-color="violet"]').click();
  await page.getByTestId('seg-fill').locator('[data-value="solid"]').click();
  await page.keyboard.press('r');
  await dragBox(page, 600, 400, 840, 560);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  const info = await page.evaluate(() => {
    const ed = (window as any).__canvas.editor;
    const s = ed.doc.all().find((x: any) => x.type === 'geo');
    const a = ed.toScreen({ x: s.x, y: s.y });
    const b = ed.toScreen({ x: s.x + s.w, y: s.y + s.h });
    const r = ed.stage.getBoundingClientRect();
    return { a, b, viewW: ed.viewW, viewH: ed.viewH, left: r.left, top: r.top, dpr: window.devicePixelRatio, z: ed.camera.z };
  });
  const ratio = Math.min(2, Math.max(1, info.dpr));
  await page.getByTestId('export').click();
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.getByTestId('export-png-view').click();
  const file = await (await dl).path();
  const buf = fs.readFileSync(file!);
  fs.copyFileSync(file!, `test-results/export-png-view-camera-dpr${dpr}.png`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  // tint('#7048e8', 0.45) = the solid fill of a violet geo shape
  const fill: [number, number, number] = [0xb0, 0x9a, 0xf2];
  const box = await colorBox(page, buf, fill, 6);
  console.log('export view', { w, h, viewW: info.viewW, viewH: info.viewH, ratio, z: info.z, box, expected: { a: info.a, b: info.b } });
  expect(w).toBe(Math.round(info.viewW * ratio));
  expect(h).toBe(Math.round(info.viewH * ratio));
  expect(box.n).toBeGreaterThan(1000);
  const tol = 8 * ratio;
  expect(Math.abs(box.x0 - info.a.x * ratio)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.y0 - info.a.y * ratio)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.x1 - info.b.x * ratio)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.y1 - info.b.y * ratio)).toBeLessThanOrEqual(tol);
  // and the same place as on the screen itself
  const shot = await page.screenshot({ clip: { x: info.left, y: info.top, width: info.viewW, height: info.viewH } });
  const k = shot.readUInt32BE(16) / info.viewW; // screenshot device scale
  // look only around the shape: the style panel shows the same violet
  const pad = 60;
  const sbox = await colorBox(page, shot, fill, 6, {
    x: Math.round((info.a.x - pad) * k), y: Math.round((info.a.y - pad) * k),
    w: Math.round((info.b.x - info.a.x + 2 * pad) * k), h: Math.round((info.b.y - info.a.y + 2 * pad) * k),
  });
  console.log('screen', { sbox, k });
  // The hand-drawn edge rasterises slightly differently on screen and in the export image
  // (a few px on Linux): the edges get 8 css px, the fill's centre and area must agree closely.
  // The bug this guards was a 2/3 scale and a ~100 px shift.
  expect(Math.abs(box.x0 / ratio - sbox.x0 / k)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.y0 / ratio - sbox.y0 / k)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.x1 / ratio - sbox.x1 / k)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.y1 / ratio - sbox.y1 / k)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.cx / ratio - sbox.cx / k)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.cy / ratio - sbox.cy / k)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.n / (ratio * ratio) - sbox.n / (k * k)) / (sbox.n / (k * k))).toBeLessThan(0.05);
  // the artifact page lines up too: the red bars of the sample chart (#f87171), right of the shape
  const red: [number, number, number] = [0xf8, 0x71, 0x71];
  const win = { x: 860, y: 200, w: 340, h: 280 };
  const scaled = (f: number) => ({ x: Math.round(win.x * f), y: Math.round(win.y * f), w: Math.round(win.w * f), h: Math.round(win.h * f) });
  const rExp = await colorBox(page, buf, red, 8, scaled(ratio));
  const rScr = await colorBox(page, shot, red, 8, scaled(k));
  console.log('artifact bars', { rExp, rScr });
  expect(rScr.n).toBeGreaterThan(1000);
  expect(Math.abs(rExp.x0 / ratio - rScr.x0 / k)).toBeLessThanOrEqual(4);
  expect(Math.abs(rExp.y0 / ratio - rScr.y0 / k)).toBeLessThanOrEqual(4);
  expect(Math.abs(rExp.x1 / ratio - rScr.x1 / k)).toBeLessThanOrEqual(4);
  expect(Math.abs(rExp.y1 / ratio - rScr.y1 / k)).toBeLessThanOrEqual(4);
  // the PDF of the current view goes through the same renderer: one page image of the same size
  await page.getByTestId('export').click();
  const dlPdf = page.waitForEvent('download', { timeout: 30000 });
  await page.getByTestId('export-pdf-view').click();
  const pdf = fs.readFileSync((await (await dlPdf).path())!).toString('latin1');
  const im = pdf.match(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/)!;
  console.log('pdf view image', im[1], im[2]);
  expect(Number(im[1])).toBe(Math.round(info.viewW * ratio));
  expect(Number(im[2])).toBe(Math.round(info.viewH * ratio));
  await A.close();
});

// The "draw" hand font is bundled (Shantell Sans, same-origin woff2) and also used inside exports.
test('bundled hand font loads under the wrapper CSP and is embedded in exports', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('export-font'), { prodCsp: true });
  const page = A.page;
  // the CSP really is on the wrapper document
  const hdr = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
  expect(hdr).toContain("default-src 'self'");
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.waitForFunction(() => document.fonts.check('16px "Shantell Sans"', 'Anónimo ¿nota? ñ'));
  const faces = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Shantell Sans').map((f) => f.status),
  );
  expect(faces).toEqual(['loaded', 'loaded']);
  // a hand-font text shape (draw is the default font)
  await page.keyboard.press('t');
  await page.mouse.click(500, 300);
  await expect(page.getByTestId('text-editor')).toBeFocused();
  await page.keyboard.type('Anónimo ¿nota?');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const res = await page.evaluate(async () => {
    const ed = (window as any).__canvas.editor;
    const mod = await import(/* @vite-ignore */ `${location.origin}/_canvas/_/src/export/export.ts`);
    const rect = ed.visibleWorld();
    const withFont: string = await mod.annotationsSvg(ed, rect, 1);
    // rasterise the same text with the embedded faces and without them (system fallback)
    const raster = async (svg: string) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 60;
      c.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      return c.toDataURL();
    };
    const text = (css: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><defs>${css}</defs><text x="4" y="40" font-size="32" font-family="&quot;Shantell Sans&quot;,serif">Anónimo ¿nota?</text></svg>`;
    const css = withFont.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';
    return {
      hasFace: withFont.includes('@font-face') && withFont.includes('data:font/woff2;base64,'),
      faces: (withFont.match(/@font-face/g) ?? []).length,
      usesFamily: withFont.includes('Shantell Sans'),
      differs: (await raster(text(css))) !== (await raster(text(''))),
    };
  });
  expect(res).toEqual({ hasFace: true, faces: 2, usesFamily: true, differs: true });
  // and the real PNG export still works under the CSP
  await page.getByTestId('export').click();
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.getByTestId('export-png-view').click();
  const file = await (await dl).path();
  fs.copyFileSync(file!, 'test-results/export-png-view-font.png');
  expect(violations).toEqual([]);
  await A.close();
});
