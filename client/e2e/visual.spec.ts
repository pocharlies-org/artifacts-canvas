import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { dragBox, drawStroke, newRoom, open } from './helpers';

const OUT = process.env.SCREENSHOT_DIR ?? 'screenshots';

// Recreates the meeting of the approved mockup: 3 people, notes, a circled chart, a highlight, an arrow.
test('screenshots at 1440x900 and 390x844', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const room = newRoom('visual');
  const D = await open(browser, 'Daniel Ibáñez', room);
  const M = await open(browser, 'Marta Ruiz', room);
  const I = await open(browser, 'Iván Pérez', room);
  const d = D.page;
  // Daniel: red circle around the hot bars, red hand text
  await d.locator('.sw[data-color="red"]').click();
  await d.keyboard.press('d');
  const ring: [number, number][] = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2.1;
    ring.push([1022 + Math.cos(a) * 150, 430 + Math.sin(a) * 95]);
  }
  await drawStroke(d, ring);
  await d.keyboard.press('t');
  await d.mouse.click(1020, 300);
  await expect(d.getByTestId('text-editor')).toBeFocused();
  await d.keyboard.type('¡¡se triplica!!');
  await d.keyboard.press('Escape');
  await d.keyboard.press('Escape');
  // Daniel: highlight the rows of the failing node
  await d.locator('.sw[data-color="yellow"]').click();
  await d.keyboard.press('Shift+D');
  await drawStroke(d, [[285, 605], [700, 605], [1150, 605]]);
  await drawStroke(d, [[285, 640], [700, 640], [1150, 640]]);
  await d.keyboard.press('v');
  // Iván: dashed rectangle over the failed KPI
  const i = I.page;
  await i.locator('.sw[data-color="blue"]').click();
  await i.getByTestId('seg-dash').locator('[data-value="dashed"]').click();
  await i.getByTestId('seg-fill').locator('[data-value="semi"]').click();
  await i.keyboard.press('r');
  await dragBox(i, 498, 186, 718, 282);
  await i.keyboard.press('Escape');
  // Marta: a note and an arrow
  const m = M.page;
  await m.locator('.sw[data-color="yellow"]').click();
  await m.keyboard.press('n');
  await m.mouse.click(1240, 690);
  await expect(m.getByTestId('text-editor')).toBeFocused();
  await m.keyboard.type('¿Coincide con el cambio de nodo del 06/11?');
  await m.keyboard.press('Escape');
  await m.keyboard.press('Escape');
  await m.locator('.sw[data-color="orange"]').click();
  await m.keyboard.press('a');
  await dragBox(m, 1150, 660, 770, 640);
  await m.keyboard.press('v');
  await m.mouse.move(905, 520);
  await i.mouse.move(640, 420);
  await d.mouse.move(470, 238);
  await d.waitForTimeout(600);
  await d.screenshot({ path: `${OUT}/desktop-1440x900.png` });

  // phone
  const P = await open(browser, 'Iván Pérez', room, { viewport: { width: 390, height: 844 } });
  await P.page.waitForTimeout(600);
  await P.page.screenshot({ path: `${OUT}/phone-390x844.png` });
  await P.page.locator('.panels-btn').click();
  await P.page.waitForTimeout(200);
  await P.page.screenshot({ path: `${OUT}/phone-390x844-panels.png` });
  // the chrome must fit on the phone: nothing wider than the viewport
  const overflow = await P.page.evaluate(() => [...document.querySelectorAll('.panel')].filter((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && (r.right > window.innerWidth + 1 || r.left < -1);
  }).map((el) => el.className));
  expect(overflow).toEqual([]);
  for (const o of [D, M, I, P]) await o.close();
});
