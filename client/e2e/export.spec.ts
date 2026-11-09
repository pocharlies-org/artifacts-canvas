import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { dragBox, newRoom, open } from './helpers';

test('export PNG and PDF of the current view and of the whole artifact', async ({ browser }) => {
  const A = await open(browser, 'Daniel Ibáñez', newRoom('export'));
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
