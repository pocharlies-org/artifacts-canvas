import { expect, test } from '@playwright/test';
import { camera, drawStroke, dragBox, newRoom, open, shapes, wave } from './helpers';

test('a stroke drawn in A appears in B before the mouse is released', async ({ browser }) => {
  const room = newRoom('live');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.keyboard.press('d');
  await drawStroke(A.page, wave(600, 300), false);
  // mouse still down in A
  await expect.poll(async () => {
    const s = await shapes(B.page);
    return s.length === 1 && s[0].type === 'draw' && !s[0].done ? s[0].points.length : 0;
  }).toBeGreaterThan(30);
  // and it is on B's screen as an SVG element
  await expect(B.page.locator('svg.shapes g[data-shape-type="draw"] path')).toHaveCount(1);
  await A.page.mouse.up();
  await expect.poll(async () => (await shapes(B.page))[0]?.done).toBe(true);
  await A.close();
  await B.close();
});

test('attribution: names, counts, tags, hover card and history are right', async ({ browser }) => {
  const room = newRoom('attr');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.keyboard.press('r');
  await dragBox(A.page, 450, 400, 650, 480);
  await A.page.keyboard.press('d');
  await drawStroke(A.page, wave(700, 250, 12));
  await B.page.keyboard.press('o');
  await dragBox(B.page, 800, 500, 900, 580);

  const rows = B.page.getByTestId('author-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Daniel Ibáñez');
  await expect(rows.nth(0).getByTestId('author-count')).toHaveText('2');
  await expect(rows.nth(1)).toContainText('Marta Ruiz');
  await expect(rows.nth(1).getByTestId('author-count')).toHaveText('1');

  // coloured name tags
  await expect(B.page.locator('g.name-tag', { hasText: 'Daniel I.' })).toHaveCount(2);
  await expect(A.page.locator('g.name-tag', { hasText: 'Marta R.' })).toHaveCount(1);

  // B moves A's rectangle: history says so, hover card shows both names
  await B.page.keyboard.press('v');
  await B.page.mouse.move(452, 440);
  await B.page.mouse.down();
  await B.page.mouse.move(500, 470, { steps: 5 });
  await B.page.mouse.up();
  await expect(A.page.getByTestId('history-entry').first()).toContainText('Marta movió un rectángulo de Daniel');
  await A.page.keyboard.press('v');
  await A.page.mouse.move(800, 520);
  await A.page.mouse.move(500, 470);
  const card = A.page.getByTestId('hovercard');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Rectángulo · dibujado por Daniel I.');
  await expect(card).toContainText('editado por Marta R.');

  // the eye toggle hides Marta's shapes in my view only
  await A.page.locator('[data-testid="author-row"]', { hasText: 'Marta' }).getByTestId('author-eye').click();
  await expect(A.page.locator('svg.shapes g[data-shape-type="geo"]')).toHaveCount(1);
  await expect(B.page.locator('svg.shapes g[data-shape-type="geo"]')).toHaveCount(2);

  // live cursors with names
  await B.page.mouse.move(300, 300);
  await expect(A.page.getByTestId('remote-cursor')).toContainText('Marta R.');
  await A.close();
  await B.close();
});

test('sticky note text syncs while typing', async ({ browser }) => {
  const room = newRoom('note');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.keyboard.press('n');
  await A.page.mouse.click(1000, 600);
  await expect(A.page.getByTestId('text-editor')).toBeFocused();
  await A.page.keyboard.type('¿Coincide con el cambio de nodo?');
  await expect.poll(async () => (await shapes(B.page)).find((s) => s.type === 'note')?.text).toBe('¿Coincide con el cambio de nodo?');
  // B sees "writing a note" next to A's cursor
  await expect(B.page.getByTestId('remote-cursor')).toContainText('escribiendo nota');
  await A.page.keyboard.press('Escape');
  await expect(B.page.locator('svg.shapes g[data-shape-type="note"] text')).toContainText('Coincide');
  // B edits the same note; A sees it
  await B.page.mouse.dblclick(1000, 600);
  await expect(B.page.getByTestId('text-editor')).toBeFocused();
  await B.page.keyboard.press('End');
  await B.page.keyboard.type(' Sí.');
  await expect.poll(async () => (await shapes(A.page)).find((s) => s.type === 'note')?.text).toBe('¿Coincide con el cambio de nodo? Sí.');
  await A.close();
  await B.close();
});

test('undo is per user: it only reverts my own change', async ({ browser }) => {
  const room = newRoom('undo');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.keyboard.press('r');
  await dragBox(A.page, 400, 300, 500, 380);
  await B.page.keyboard.press('o');
  await dragBox(B.page, 700, 300, 800, 380);
  await expect.poll(async () => (await shapes(A.page)).length).toBe(2);
  await A.page.keyboard.press('Meta+z');
  await expect.poll(async () => (await shapes(B.page)).map((s) => s.geo)).toEqual(['ellipse']);
  await expect.poll(async () => (await shapes(A.page)).map((s) => s.geo)).toEqual(['ellipse']);
  // redo brings it back for everyone
  await A.page.keyboard.press('Meta+Shift+z');
  await expect.poll(async () => (await shapes(B.page)).length).toBe(2);
  // B's undo removes B's ellipse only
  await B.page.getByTestId('undo').click();
  await expect.poll(async () => (await shapes(A.page)).map((s) => s.geo)).toEqual(['rectangle']);
  await A.close();
  await B.close();
});

test('the laser pointer is live for others and never stored', async ({ browser }) => {
  const room = newRoom('laser');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.keyboard.press('k');
  await A.page.mouse.move(500, 300);
  await A.page.mouse.down();
  for (let i = 0; i < 15; i++) await A.page.mouse.move(500 + i * 12, 300 + i * 4);
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(1);
  await expect(B.page.locator('svg.laser')).toContainText('láser · Daniel I.');
  await A.page.mouse.up();
  expect(await shapes(A.page)).toHaveLength(0);
  expect(await A.page.evaluate(() => (window as any).__canvas.ydoc.getMap('shapes').size)).toBe(0);
  // the trail fades away by itself
  await expect(B.page.getByTestId('laser-dot')).toHaveCount(0, { timeout: 4000 });
  await A.page.reload();
  await A.page.waitForFunction(() => (window as any).__canvas?.editor?.status === 'synced');
  expect(await shapes(A.page)).toHaveLength(0);
  expect(await shapes(B.page)).toHaveLength(0);
  await A.close();
  await B.close();
});

test('Presentar: the others follow the presenter until they pan themselves', async ({ browser }) => {
  const room = newRoom('present');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const B = await open(browser, 'Marta Ruiz', room);
  await A.page.getByTestId('present').click();
  await expect(A.page.getByTestId('present')).toContainText('Dejar de presentar');
  await expect(B.page.getByTestId('banner')).toContainText('Daniel I. está presentando');
  // presenter scrolls and zooms
  await A.page.mouse.move(700, 450);
  await A.page.mouse.wheel(0, 900);
  await A.page.getByTestId('zoom-in').click();
  const centre = async (p: typeof A.page) => p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const v = e.visibleWorld();
    return { x: v.x + v.w / 2, y: v.y + v.h / 2, z: e.camera.z };
  });
  await expect.poll(async () => {
    const [a, b] = [await centre(A.page), await centre(B.page)];
    return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.z - b.z) < 0.01;
  }).toBe(true);
  // B pans: stops following
  await B.page.mouse.move(700, 450);
  await B.page.mouse.wheel(0, 300);
  await expect(B.page.getByTestId('banner')).toBeHidden();
  const bBefore = await camera(B.page);
  await A.page.mouse.wheel(0, 600);
  await A.page.waitForTimeout(300);
  expect(await camera(B.page)).toEqual(bBefore);
  // "Seguir a Daniel" follows again
  await B.page.getByTestId('follow').click();
  await expect.poll(async () => Math.abs((await centre(A.page)).y - (await centre(B.page)).y) < 2).toBe(true);
  await A.close();
  await B.close();
});

test('strokes stay anchored to the artifact element after scrolling', async ({ browser }) => {
  const room = newRoom('anchor');
  const A = await open(browser, 'Daniel Ibáñez', room);
  const frame = A.page.frameLocator('iframe.artifact-frame');
  const row = frame.locator('#row-billing');
  const before = (await row.boundingBox())!;
  await A.page.keyboard.press('d');
  await drawStroke(A.page, [[before.x + 10, before.y + before.height / 2], [before.x + 200, before.y + before.height / 2], [before.x + 400, before.y + before.height / 2]]);
  const stroke = A.page.locator('svg.shapes g[data-shape-type="draw"]');
  const s0 = (await stroke.boundingBox())!;
  const offset0 = { x: s0.x - before.x, y: s0.y - before.y };
  // scroll the artifact (wheel) and zoom
  await A.page.mouse.move(700, 450);
  await A.page.mouse.wheel(0, 350);
  await A.page.waitForTimeout(200);
  const after = (await row.boundingBox())!;
  expect(after.y).toBeLessThan(before.y - 300);
  const s1 = (await stroke.boundingBox())!;
  expect(Math.abs(s1.x - after.x - offset0.x)).toBeLessThan(1.5);
  expect(Math.abs(s1.y - after.y - offset0.y)).toBeLessThan(1.5);
  await A.close();
});
