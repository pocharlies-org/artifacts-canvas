/**
 * Product sanity on the full system after the content/ledger split (the third verifier's
 * fv3-sanity.spec.ts as a permanent check): two Dex users draw, the 390 px phone sees the
 * shapes with their authors, names and tags come from the ledger, the history panel and the
 * authors panel are filled, PNG + PDF export work. Screenshots at 1440 and 390 land in
 * SYSTEM_SHOTS (default client/test-results/system/shots).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO, USERS, editorReady, newContext, openWithLogin, publish, waitFor } from './lib';

const OUT = process.env.SYSTEM_SHOTS ?? path.join(REPO, 'client', 'test-results', 'system', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('sanity: draw, names, tags, authors + history panels, screenshots 1440/390, PNG + PDF export', async ({ browser }) => {
  const P = publish({ users: [USERS.user1.email, USERS.user2.email] }, `sanity-${Date.now().toString(36)}`);
  const c1 = await newContext(browser);
  const p1 = await c1.newPage();
  const errors: string[] = [];
  p1.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await openWithLogin(p1, P.canvas, 'user1');
  await editorReady(p1);
  const c2 = await newContext(browser, { width: 390, height: 844 });
  const p2 = await c2.newPage();
  p2.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await openWithLogin(p2, P.canvas, 'user2');
  await editorReady(p2);
  // user1 draws a stroke, a rectangle and a note
  await p1.keyboard.press('d');
  await p1.mouse.move(300, 300);
  await p1.mouse.down();
  for (let i = 1; i <= 12; i++) await p1.mouse.move(300 + i * 15, 300 + (i % 3) * 12);
  await p1.mouse.up();
  await p1.keyboard.press('r');
  await p1.mouse.move(500, 380);
  await p1.mouse.down();
  await p1.mouse.move(700, 480, { steps: 6 });
  await p1.mouse.up();
  await p1.keyboard.press('n');
  await p1.mouse.click(820, 320);
  await p1.keyboard.type('fv3 note');
  await p1.keyboard.press('Escape');
  await p1.keyboard.press('v');
  await p1.mouse.move(640, 600);
  await waitFor(async () => (await p2.evaluate(() => (window as any).__canvas.editor.doc.all().length)) >= 3, 15_000, 'user2 sees 3 shapes');
  await waitFor(async () => (await p1.evaluate(() => document.querySelectorAll('[data-testid="history-entry"]').length)) >= 3, 15_000, 'history');
  await sleep(800);
  const s = {
    user1Me: await p1.evaluate(() => (window as any).__canvas.editor.me.name),
    user2Me: await p2.evaluate(() => (window as any).__canvas.editor.me.name),
    user2SeesShapes: await p2.evaluate(() => (window as any).__canvas.editor.doc.all().length),
    user2SeesAuthors: await p2.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('[data-author]')).map((e) => e.getAttribute('data-author'))))),
    tags: await p1.evaluate(() => Array.from(document.querySelectorAll('.name-tag text')).map((e) => e.textContent)),
    ledgerUsers: await p2.evaluate(() => (window as any).__canvas.ledger.getMap('users').toJSON()),
    contentRoots: await p2.evaluate(() => Array.from((window as any).__canvas.ydoc.share.keys() as Iterable<string>).sort()),
    authorRows: await p1.evaluate(() => Array.from(document.querySelectorAll('[data-testid="author-row"]')).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())),
    history: await p1.evaluate(() => Array.from(document.querySelectorAll('[data-testid="history-entry"]')).map((e) => (e.textContent ?? '').trim())),
  };
  console.log('[sanity]', JSON.stringify(s));
  await p1.screenshot({ path: `${OUT}/sanity-1440.png` });
  await p2.screenshot({ path: `${OUT}/sanity-390.png` });
  expect(s.user1Me).toBe(USERS.user1.name);
  expect(s.user2Me).toBe(USERS.user2.name);
  expect(s.user2SeesShapes).toBe(3);
  expect(s.user2SeesAuthors).toEqual([USERS.user1.email]);
  expect(s.tags.length).toBeGreaterThanOrEqual(1);
  expect(s.tags.every((t) => t === 'Test O.')).toBe(true); // shortName of "Test One"
  expect(s.ledgerUsers[USERS.user1.email]).toMatchObject({ name: USERS.user1.name, anonymous: false });
  expect(s.contentRoots.filter((k: string) => !['assets', 'meta', 'shapes'].includes(k))).toEqual([]);
  expect(s.authorRows.some((r) => r.includes(USERS.user1.name) && r.includes('3'))).toBe(true);
  expect(s.history.length).toBeGreaterThanOrEqual(3);
  expect(s.history.every((h) => h.includes('Test'))).toBe(true);
  for (const id of ['export-png-full', 'export-pdf-view']) {
    await p1.getByTestId('export').click();
    const dl = p1.waitForEvent('download', { timeout: 20000 });
    await p1.getByTestId(id).click();
    const d = await dl;
    const file = `${OUT}/${d.suggestedFilename()}`;
    await d.saveAs(file);
    const head = fs.readFileSync(file).subarray(0, 8).toString('latin1');
    console.log('[sanity] export', id, d.suggestedFilename(), fs.statSync(file).size, 'bytes', JSON.stringify(head));
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    expect(head.startsWith(id.includes('png') ? '\x89PNG' : '%PDF')).toBe(true);
  }
  expect(errors).toEqual([]);
  await c1.close();
  await c2.close();
});
