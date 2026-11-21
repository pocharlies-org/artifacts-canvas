/**
 * Image data and the room budget in a REAL browser against the REAL server (stack.ts), with a
 * 1 MiB room cap. Deleting images frees their data: the editor says the canvas is full while it
 * is, asks to wait a moment right after a delete (the server measures the room again at its next
 * save), and then takes new images, with no 4413. Before, the data of deleted images stayed in the
 * room and "delete something first" could not be satisfied.
 */
import { expect, test } from '@playwright/test';
import { allowUser, openAs, s3CanvasObject, startStack, waitFor, type Stack } from './stack';

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CAP = 1024 * 1024;
let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MAX_DOC_BYTES: String(CAP), ANON_MAX_DOC_BYTES: String(256 * 1024) });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('deleting images frees the room: full, then "wait a moment" right after the delete, then new images fit; no 4413', async ({ browser }) => {
  const key = 'reports/assets-room.html';
  allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
  const a = await openAs(stack, browser, 'ana', key);
  const insert = (c: string) => a.page.evaluate((c) => {
    const ed = (window as unknown as W).__canvas.editor;
    return ed.insertImageData('data:image/png;base64,' + c.repeat(400 * 1024), 800, 600) as string | null;
  }, c);
  const toast = () => a.page.getByTestId('toast').textContent();

  expect(await a.page.evaluate(() => (window as unknown as W).__canvas.editor.cfg.maxDocBytes)).toBe(CAP);
  const first = await insert('A');
  const second = await insert('B');
  expect(first && second).toBeTruthy();
  // a third does not fit
  expect(await insert('C')).toBeNull();
  expect(await toast()).toBe('El lienzo está lleno: esta imagen superaría su tamaño máximo (1.00 MB). Borra algo antes.');

  // delete both: their data goes with them
  await a.page.evaluate(([x, y]) => {
    const ed = (window as unknown as W).__canvas.editor;
    ed.select([x, y]);
    ed.deleteSelection();
  }, [first, second]);
  const left = await a.page.evaluate(() => (window as unknown as W).__canvas.editor.doc.assets.size);
  expect(left).toBe(0);
  // right after the delete the server still counts the data until its next save: wait a moment
  expect(await insert('C')).toBeNull();
  expect(await toast()).toBe('Se está liberando el espacio de lo que acabas de borrar. Vuelve a intentarlo en unos segundos.');

  await a.page.waitForTimeout(10_500);
  const third = await insert('C');
  const fourth = await insert('D');
  expect(third && fourth).toBeTruthy();
  await a.page.waitForTimeout(1_000);
  const st = await a.page.evaluate(() => {
    const w = window as unknown as W;
    return { status: w.__canvas.editor.status, closes: w.__wsCloses, refusals: w.__canvas.editor.canvasFullRefusals };
  });
  expect(st.closes).toEqual([]);
  expect(st.status).toBe('synced');
  expect(st.refusals).toBe(2);

  // the room holds the two new images and only their data; the stored object is under the cap
  allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
  const b = await openAs(stack, browser, 'bob', key);
  await waitFor(async () => (await b.page.evaluate(() => {
    const ed = (window as unknown as W).__canvas.editor;
    return `${ed.doc.all().filter((s: W) => s.type === 'image').length}/${ed.doc.assets.size}`;
  })) === '2/2', 10_000, 'two images and two assets in the room');
  const stored = await s3CanvasObject(stack, key);
  expect(stored).not.toBeNull();
  console.log(`[assets] stored room ${Math.round(stored!.byteLength / 1024)} KiB (cap ${CAP / 1024} KiB) after 4 images of 400 KiB, 2 deleted`);
  expect(stored!.byteLength).toBeLessThan(CAP);
  expect(stored!.byteLength).toBeGreaterThan(800 * 1024);
  await a.close();
  await b.close();
});
