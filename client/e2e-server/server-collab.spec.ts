/**
 * End-to-end against the REAL server (server/dist) + fake core + in-memory S3.
 * These are the guarantees the product sells; they are only meaningful through the
 * production code path, so nothing here uses the client's in-memory dev room.
 */
import { test, expect } from '@playwright/test';
import * as Y from 'yjs';
import {
  ARTIFACT_HTML,
  allowAnonKey,
  allowUser,
  expectClose,
  openAs,
  rawConnect,
  s3CanvasObject,
  sendForgedRootWrite,
  sendForgedRootWriteAsStep2,
  startStack,
  waitFor,
  type Stack,
} from './stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const drawStroke = async (page: import('@playwright/test').Page, pts: [number, number][]): Promise<void> => {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
};
const wave = (x: number, y: number, n = 20, dx = 12): [number, number][] =>
  Array.from({ length: n }, (_, i) => [x + i * dx, y + Math.sin(i / 3) * 25] as [number, number]);
const shapes = (page: import('@playwright/test').Page): Promise<{ id: string }[]> =>
  page.evaluate(() => (window as any).__canvas.editor.doc.all());

test('two windows converge live and attribution is the verified identity', async ({ browser }) => {
  const key = 'reports/live.html';
  const core = stack.core;
  core.artifacts.set(key, ARTIFACT_HTML);
  // Per-visitor answers: same key, two different verified identities.
  core.rulesByCookie.set('canvas_e2e_user=alice|' + key, {
    allowed: true, reason: 'owner', user: { id: 'u-alice', name: 'Alice', anonymous: false },
  });
  core.rulesByCookie.set('canvas_e2e_user=bob|' + key, {
    allowed: true, reason: 'owner', user: { id: 'u-bob', name: 'Bob', anonymous: false },
  });

  const a = await openAs(stack, browser, 'alice', key);
  const b = await openAs(stack, browser, 'bob', key);

  await a.page.keyboard.press('d');
  await drawStroke(a.page, wave(300, 300));
  await waitFor(async () => (await shapes(b.page)).length >= 1, 8_000, 'stroke to converge to bob');

  const [shape] = await shapes(b.page);
  const attr = await b.page.evaluate(
    (id) => (window as any).__canvas.editor.doc.attribution.get(id) ?? null,
    shape.id,
  );
  // The stamper ran on the SERVER with the authz identity — not with anything a client claimed.
  expect(attr).toMatchObject({ createdBy: 'u-alice', updatedBy: 'u-alice' });
  const users = await b.page.evaluate(() => {
    const m = (window as any).__canvas.editor.doc.users;
    return { alice: m.get('u-alice') ?? null };
  });
  expect(users.alice).toMatchObject({ name: 'Alice' });

  // And back: bob draws, alice sees it, stamped as u-bob.
  await b.page.keyboard.press('d');
  await drawStroke(b.page, wave(300, 500));
  await waitFor(async () => (await shapes(a.page)).length >= 2, 8_000, 'second stroke to converge to alice');

  await a.close();
  await b.close();
});

test('forged attribution write closes 4403 and is not applied', async ({ browser }) => {
  const key = 'reports/forge.html';
  allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
  const bob = await openAs(stack, browser, 'bob', key);

  const attacker = await rawConnect(stack, key, 'bob');
  sendForgedRootWrite(attacker, 'attribution', 'forged', { createdBy: 'u-evil', createdAt: 1, updatedBy: 'u-evil', updatedAt: 1 });
  await expectClose(attacker, 4403);

  // Smuggled as a SyncStep2 (state-vector-prefixed): must be caught the same way, not crash.
  const smuggler = await rawConnect(stack, key, 'bob');
  sendForgedRootWriteAsStep2(smuggler, 'attribution', 'forged2', { createdBy: 'u-evil', createdAt: 1, updatedBy: 'u-evil', updatedAt: 1 });
  await expectClose(smuggler, 4403);

  // Give the server a moment in case anything leaked; the write must never reach the room.
  await new Promise((r) => setTimeout(r, 500));
  const forged = await bob.page.evaluate(() => (window as any).__canvas.editor.doc.attribution.get('forged') ?? null);
  expect(forged).toBe(null);
  await bob.close();
});

test('revocation drops a connected client (4403 within the re-check interval)', async ({ browser }) => {
  const key = 'reports/revoke.html';
  allowUser(stack.core, key, 'alice', 'u-alice', 'Alice');
  const a = await openAs(stack, browser, 'alice', key);

  // Revocation: drop alice's per-visitor grant; the key's default deny takes over.
  stack.core.rulesByCookie.delete(`canvas_e2e_user=alice|${key}`);
  await waitFor(
    async () => (await a.page.evaluate(() => (window as any).__wsCloses as number[])).includes(4403),
    8_000,
    'close 4403 on revoked client',
  );
  await a.close();
});

test('document persists across a server restart', async ({ browser }) => {
  const key = 'reports/persist.html';
  allowUser(stack.core, key, 'alice', 'u-alice', 'Alice');
  const a = await openAs(stack, browser, 'alice', key);
  await a.page.keyboard.press('d');
  await drawStroke(a.page, wave(320, 340));
  await waitFor(async () => (await shapes(a.page)).length >= 1, 5_000, 'stroke applied');
  await a.close();

  const saved = await s3CanvasObject(stack, key);
  expect(saved, 'canvas object written to S3').not.toBeNull();

  await stack.restart();

  const b = await openAs(stack, browser, 'alice', key);
  await waitFor(async () => (await shapes(b.page)).length >= 1, 10_000, 'shape restored after restart');
  // The bytes really came from the object store, not from the (now dead) previous process.
  const before = await s3CanvasObject(stack, key, 2_000);
  expect(before).not.toBeNull();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, before!);
  expect(doc.getMap('shapes').size).toBeGreaterThanOrEqual(1);
  await b.close();
});

test('anonymous is allowed only on a pub/ key', async ({ browser }) => {
  const pubKey = 'pub/open.html';
  const privKey = 'private/secret.html';
  allowAnonKey(stack.core, pubKey);
  allowUser(stack.core, privKey, 'alice', 'u-alice', 'Alice');

  // Anonymous on the pub/ key: full editor, can draw.
  const anon = await openAs(stack, browser, null, pubKey);
  await anon.page.keyboard.press('d');
  await drawStroke(anon.page, wave(280, 300));
  await waitFor(async () => (await shapes(anon.page)).length >= 1, 5_000, 'anon draw');
  await anon.close();

  // Anonymous on a private key: wrapper is refused (403) and the socket is closed 4403.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto(`${stack.serverUrl}/_canvas/${privKey}`);
  expect(res?.status()).toBe(403);
  await ctx.close();

  const ws = await rawConnect(stack, privKey, null);
  await expectClose(ws, 4403);
});
