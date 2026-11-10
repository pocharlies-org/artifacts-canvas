import { expect, test } from '@playwright/test';
import { camera, dragBox, drawStroke, newRoom, open, shapes, wave } from './helpers';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('every tool creates its shape, with its shortcut', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('tools'));
  const p = A.page;
  const last = async () => (await shapes(p)).sort((a, b) => a.index - b.index).at(-1);

  await p.keyboard.press('d');
  await drawStroke(p, wave(300, 200, 10));
  expect(await last()).toMatchObject({ type: 'draw', highlight: false, done: true });

  await p.keyboard.press('Shift+D');
  await drawStroke(p, wave(300, 260, 10));
  expect((await shapes(p)).find((s) => s.highlight)).toMatchObject({ type: 'draw', highlight: true });

  await p.keyboard.press('l');
  await dragBox(p, 300, 320, 450, 320);
  expect(await last()).toMatchObject({ type: 'line' });

  await p.keyboard.press('t');
  await p.mouse.click(500, 200);
  await expect(p.getByTestId('text-editor')).toBeFocused();
  await p.keyboard.type('¡¡se triplica!!');
  await p.keyboard.press('Escape');
  expect(await last()).toMatchObject({ type: 'text', text: '¡¡se triplica!!' });

  await p.keyboard.press('f');
  await dragBox(p, 700, 150, 1000, 300);
  expect(await last()).toMatchObject({ type: 'frame', name: 'Marco 1' });

  for (const [key, geo] of [['r', 'rectangle'], ['o', 'ellipse']] as const) {
    await p.keyboard.press(key);
    await dragBox(p, 300, 500, 380, 560);
    expect(await last()).toMatchObject({ type: 'geo', geo });
  }
  // the more-shapes menu
  for (const geo of ['triangle', 'diamond', 'star', 'cloud', 'check-box', 'x-box', 'heart', 'hexagon']) {
    await p.getByTestId('tool-more').click();
    await p.getByTestId(`geo-${geo}`).click();
    await dragBox(p, 600, 500, 680, 570);
    expect(await last()).toMatchObject({ type: 'geo', geo });
  }

  // image via drop
  await p.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector('.stage')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 900, clientY: 600, bubbles: true, cancelable: true }));
  }, PNG_1x1.toString('base64'));
  await expect.poll(async () => (await shapes(p)).some((s) => s.type === 'image')).toBe(true);
  const img = (await shapes(p)).find((s) => s.type === 'image');
  expect(await p.evaluate((id) => (window as any).__canvas.editor.doc.assets.has(id), img.assetId)).toBe(true);
  await A.close();
});

test('arrows bind to shapes and follow them when the shape moves', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('bind'));
  const B = await open(browser, 'Marta', A.page.url().match(/room=([^&]+)/)![1]);
  const p = A.page;
  await p.keyboard.press('r');
  await dragBox(p, 600, 400, 760, 480);
  await p.keyboard.press('a');
  await dragBox(p, 350, 300, 680, 440);
  const arrow = (await shapes(p)).find((s) => s.type === 'arrow');
  const rect = (await shapes(p)).find((s) => s.type === 'geo');
  expect(arrow.end.bind.shapeId).toBe(rect.id);
  const tip = async (page = B.page) => page.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const a = e.doc.all().find((s: any) => s.type === 'arrow');
    const pts = e.renderer.elementFor(a.id).querySelector('path').getAttribute('d');
    return pts;
  });
  const before = await tip();
  // move the rectangle in A; B's arrow follows
  await p.keyboard.press('v');
  await p.mouse.move(740, 470);
  await p.mouse.down();
  await p.mouse.move(800, 600, { steps: 6 });
  await p.mouse.up();
  await expect.poll(tip).not.toBe(before);
  const g = await B.page.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const a = e.doc.all().find((s: any) => s.type === 'arrow');
    const r = e.doc.all().find((s: any) => s.type === 'geo');
    return { r, end: a.end };
  });
  expect(g.end.bind.shapeId).toBe(g.r.id);
  await A.close();
  await B.close();
});

test('select, marquee, move, resize, rotate, style, group, lock, eraser, delete', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('select'));
  const p = A.page;
  await p.keyboard.press('r');
  await dragBox(p, 400, 400, 500, 480);
  await p.keyboard.press('o');
  await dragBox(p, 600, 400, 700, 480);
  await p.keyboard.press('v');
  // marquee both
  await dragBox(p, 380, 380, 720, 500);
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.selection.size)).toBe(2);
  // style panel applies to the selection
  await p.locator('.sw[data-color="red"]').click();
  await p.getByTestId('seg-fill').locator('[data-value="pattern"]').click();
  await p.getByTestId('seg-dash').locator('[data-value="draw"]').click();
  await p.getByTestId('seg-size').locator('[data-value="xl"]').click();
  for (const s of await shapes(p)) expect(s).toMatchObject({ color: 'red', fill: 'pattern', dash: 'draw', size: 'xl' });
  // group, then clicking one selects both
  await p.getByTestId('group').click();
  await p.mouse.click(1100, 700);
  await p.mouse.click(402, 440);
  await expect.poll(() => p.evaluate(() => (window as any).__canvas.editor.selection.size)).toBe(2);
  await p.keyboard.press('Meta+Shift+g');
  await p.mouse.click(1100, 700);
  // move the rectangle
  await p.mouse.move(402, 440);
  await p.mouse.down();
  await p.mouse.move(452, 470, { steps: 4 });
  await p.mouse.up();
  const r = (await shapes(p)).find((s) => s.geo === 'rectangle');
  expect(Math.round(r.x)).toBe(Math.round((await p.evaluate(() => (window as any).__canvas.editor.toWorld({ x: 450, y: 0 }).x))));
  // resize from the bottom-right handle
  const handle = await p.evaluate((id) => {
    const e = (window as any).__canvas.editor;
    const s = e.doc.get(id);
    return e.toScreen({ x: s.x + s.w, y: s.y + s.h });
  }, r.id);
  await p.mouse.move(handle.x, handle.y);
  await p.mouse.down();
  await p.mouse.move(handle.x + 60, handle.y + 40, { steps: 4 });
  await p.mouse.up();
  const r2 = (await shapes(p)).find((s) => s.id === r.id);
  expect(Math.round(r2.w)).toBe(160);
  expect(Math.round(r2.h)).toBe(120);
  // rotate with the top handle
  const top = await p.evaluate((id) => {
    const e = (window as any).__canvas.editor;
    const s = e.doc.get(id);
    return e.toScreen({ x: s.x + s.w / 2, y: s.y });
  }, r.id);
  await p.mouse.move(top.x, top.y - 22);
  await p.mouse.down();
  await p.mouse.move(top.x + 150, top.y + 60, { steps: 6 });
  await p.mouse.up();
  expect((await shapes(p)).find((s) => s.id === r.id).rotation).toBeGreaterThan(0.3);
  // lock: cannot move or delete
  await p.keyboard.press('Shift+l');
  expect((await shapes(p)).find((s) => s.id === r.id).locked).toBe(true);
  await p.keyboard.press('Backspace');
  expect((await shapes(p)).some((s) => s.id === r.id)).toBe(true);
  await p.getByTestId('lock').click();
  // eraser removes the ellipse
  await p.keyboard.press('e');
  await drawStroke(p, [[650, 380], [650, 420], [650, 500]]);
  await expect.poll(async () => (await shapes(p)).some((s) => s.geo === 'ellipse')).toBe(false);
  // delete with the keyboard
  await p.keyboard.press('v');
  await p.keyboard.press('Meta+a');
  await p.keyboard.press('Delete');
  await expect.poll(async () => (await shapes(p)).length).toBe(0);
  await A.close();
});

test('camera: space-pan, hand, zoom buttons, zoom to fit, minimap, annotations toggle', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('camera'));
  const p = A.page;
  await p.keyboard.press('d');
  await drawStroke(p, wave(400, 300, 8));
  const c0 = await camera(p);
  await p.keyboard.down('Space');
  await dragBox(p, 700, 500, 600, 400);
  await p.keyboard.up('Space');
  const c1 = await camera(p);
  expect(c1.tx - c0.tx).toBeCloseTo(-100, 0);
  expect((await shapes(p)).length).toBe(1); // space-drag drew nothing
  await p.keyboard.press('h');
  await dragBox(p, 600, 400, 600, 500);
  expect((await camera(p)).ty - c1.ty).toBeCloseTo(100, 0);
  await p.getByTestId('zoom-in').click();
  await expect(p.getByTestId('zoom-pct')).toHaveText('125%');
  await p.getByTestId('zoom-out').click();
  await p.getByTestId('zoom-out').click();
  await expect(p.getByTestId('zoom-pct')).toHaveText('90%');
  await p.getByTestId('zoom-fit').click();
  const fit = await p.evaluate(() => {
    const e = (window as any).__canvas.editor;
    const v = e.visibleWorld();
    return { v, h: e.pageHeight };
  });
  expect(fit.v.h).toBeGreaterThanOrEqual(fit.h);
  // minimap click centres the camera there
  const mm = (await p.getByTestId('minimap').boundingBox())!;
  await p.mouse.click(mm.x + mm.width / 2, mm.y + mm.height - 8);
  const after = await p.evaluate(() => (window as any).__canvas.editor.visibleWorld());
  expect(after.y + after.h / 2).toBeGreaterThan(fit.h / 2);
  // hide/show annotations
  await p.getByTestId('annotations-toggle').click();
  await p.getByTestId('annotations-hide').click();
  await expect(p.locator('svg.shapes')).toBeHidden();
  await expect(p.getByTestId('annotations-toggle')).toContainText('Anotaciones: ocultas');
  await p.getByTestId('annotations-toggle').click();
  await p.getByTestId('annotations-show').click();
  await expect(p.locator('svg.shapes')).toBeVisible();
  await A.close();
});

test('English UI is available', async ({ browser }) => {
  const A = await open(browser, 'Ana', newRoom('en'), { lang: 'en' });
  await expect(A.page.getByTestId('present')).toHaveText('▶ Present');
  await expect(A.page.getByTestId('live')).toHaveText('Live');
  await A.close();
});
