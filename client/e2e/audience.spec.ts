import { expect, test, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, wave } from './helpers';

/**
 * Who else is here (collab/presence.ts audienceOf, ui/visibility.ts, ui/chrome.ts): the hidden
 * canvas's pill and the shown canvas's top bar say how many other people view the artifact and how
 * many of them annotate (the canvas shown), by person, never counting this user. A hidden tab's
 * presence is the user and the viewing status only: no cursor, viewport, laser, following or
 * presentation, ever, whatever its editor is asked to publish (editor.ts publishPresence).
 */

/** Init script: every awareness message the canvas socket sends, decoded: [time, states]. */
const TAP = `(() => {
  window.__awSent = [];
  const rv = (b, p) => { let n = 0, s = 0, c; do { c = b[p.i++]; n += (c & 127) * 2 ** s; s += 7; } while (c & 128); return n; };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    const b = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
    if (b && b[0] === 1) {
      const p = { i: 1 }; rv(b, p); const states = [];
      for (let n = rv(b, p); n > 0; n--) { rv(b, p); rv(b, p); const len = rv(b, p); states.push(JSON.parse(new TextDecoder().decode(b.subarray(p.i, p.i + len)))); p.i += len; }
      window.__awSent.push([performance.now(), states]);
    }
    return send.call(this, d);
  };
})();`;

const pill = (p: Page) => p.getByTestId('canvas-people');
const bar = (p: Page) => p.getByTestId('audience');
/** The top bar's full text (a phone shows the short one: "👁 2"). */
const barText = (p: Page) => p.getByTestId('audience').locator('.lbl-full');
const sent = (p: Page) => p.evaluate(() => (window as any).__awSent as [number, any[]][]);
const here = (p: Page) => p.getByTestId('here-row').evaluateAll((rows) => rows.map((r) => `${(r as HTMLElement).dataset.user}:${(r as HTMLElement).dataset.activity}`));
const meId = (p: Page) => p.evaluate(() => (window as any).__canvas.editor.me.id as string);
const followingId = (p: Page) => p.evaluate(() => (window as any).__canvas.editor.followingUserId as string | null);
const setPresenting = (p: Page, on: boolean) => p.evaluate((v) => (window as any).__canvas.editor.setPresenting(v), on);
/** The last state this tab sent. */
const lastSent = async (p: Page) => (await sent(p)).at(-1)?.[1].at(-1);
/** A renewal of an unchanged awareness state goes out every 15 s (y-protocols). */
const RENEWAL_MS = 15_000;
const PRESENCE_KEYS = new Set(['user', 'status', 'cursor', 'viewport', 'laser', 'following', 'presenting']);

/** The states this tab sent from `since` (its performance.now()), and how long that window is. */
async function sentSince(p: Page, since: number): Promise<{ states: any[]; messages: number; windowMs: number }> {
  const all = await sent(p);
  const after = all.filter(([t]) => t >= since);
  const now = await p.evaluate(() => performance.now());
  return { states: after.flatMap(([, states]) => states), messages: after.length, windowMs: now - since };
}

/**
 * A hidden tab's presence is one state: its user and the viewing status, with no cursor, viewport,
 * laser, following or presentation. Every state it sent is that one.
 */
function expectViewingOnly(states: any[], name: string) {
  for (const st of states) {
    expect(st.user?.name).toBe(name);
    expect(st.status).toBe('cursor.viewing');
    expect(st.cursor ?? null).toBeNull();
    expect(st.viewport ?? null).toBeNull();
    expect(st.laser ?? null).toBeNull();
    expect(st.following ?? null).toBeNull();
    expect(st.presenting ?? false).toBe(false);
    expect(Object.keys(st).filter((k) => !PRESENCE_KEYS.has(k))).toEqual([]);
    expect(st).toEqual(states[0]);
  }
}

/** ...and it sent no more messages than its renewals allow, plus one (the hide): a bound, not a race with the renewal. */
function expectQuiet(got: { messages: number; windowMs: number }) {
  expect(got.messages).toBeLessThanOrEqual(Math.ceil(got.windowMs / RENEWAL_MS) + 1);
}

/** Hide the canvas with the top bar's button; returns the tab's clock just before the click. */
const hide = (p: Page) => p.evaluate(() => {
  const t = performance.now();
  document.querySelector<HTMLElement>('[data-testid="canvas-hide"]')!.click();
  return t;
});

/**
 * Drive a hidden tab's editor as a hand on the stage would: the laser pressed, moved and released,
 * and the pointer moving over the stage (the hidden page covers the stage, so the events go to it
 * directly). Returns how many laser points the editor took: the laser tool did run.
 */
const driveHidden = (p: Page) => p.evaluate(async () => {
  const ed = (window as any).__canvas.editor;
  const st = document.querySelector<HTMLElement>('.stage')!;
  const fire = (type: string, x: number, y: number) => st.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
  fire('pointerdown', 300, 300);
  let points = ed.laser.length;
  for (let i = 0; i < 30; i++) {
    fire('pointermove', 300 + i * 8, 300 + (i % 5) * 6);
    points = Math.max(points, ed.laser.length);
    await new Promise((r) => setTimeout(r, 16));
  }
  fire('pointerup', 540, 300);
  for (let i = 0; i < 10; i++) fire('pointermove', 600 + i * 5, 400);
  await new Promise((r) => setTimeout(r, 500)); // past the awareness pace
  return points;
});

test('three sessions, one shown and two hidden: every tab counts the others right, and a hidden tab sends only its viewing state', async ({ browser }) => {
  const room = newRoom('audience');
  const ana = await open(browser, 'Ana', room);
  // Bea starts with the canvas shown, the laser on, and follows Ana's presentation: a cursor, a
  // viewport, a laser and someone followed, all of which must go when she hides the canvas
  const bea = await open(browser, 'Bea', room, { initScript: TAP });
  const carl = await open(browser, 'Carl', room, { query: { canvas: '0' }, initScript: TAP });
  const anaId = await meId(ana.page);
  await bea.page.keyboard.press('k');
  await setPresenting(ana.page, true);
  await expect.poll(() => followingId(bea.page)).toBe(anaId);
  await expect.poll(() => lastSent(bea.page)).toMatchObject({ following: anaId, status: 'cursor.laser', viewport: expect.any(Object) });

  // hidden, twice: the hide and everything after it is the one viewing state, laser and pointer included
  for (let round = 0; round < 2; round++) {
    const at = await hide(bea.page);
    await expect(pill(bea.page)).toBeVisible();
    expect(await driveHidden(bea.page), 'the laser tool ran on the hidden tab').toBeGreaterThan(0);
    const got = await sentSince(bea.page, at);
    expect(got.messages, 'the hide went out').toBeGreaterThan(0);
    expectViewingOnly(got.states, 'Bea');
    expectQuiet(got);
    if (round === 0) {
      // shown again: she follows Ana again, with a viewport
      await bea.page.getByTestId('canvas-show').click();
      await expect.poll(() => followingId(bea.page)).toBe(anaId);
      await expect.poll(() => lastSent(bea.page)).toMatchObject({ following: anaId, viewport: expect.any(Object) });
    }
  }
  await setPresenting(ana.page, false);

  // hidden tabs: the two others view, and one of them (Ana) annotates
  for (const p of [bea.page, carl.page]) {
    await expect(pill(p)).toHaveText('👁 2 viendo · 1 anotando');
    await expect(pill(p)).toHaveAttribute('data-viewing', '2');
    await expect(pill(p)).toHaveAttribute('data-annotating', '1');
    await expect(pill(p)).toHaveAttribute('title', /Tú no cuentas/);
    // and it says that the others see this user as viewing, the canvas hidden or not
    await expect(pill(p)).toHaveAttribute('title', /Los demás te ven como «viendo» mientras tengas abierto el artefacto, aunque ocultes el canvas\./);
  }
  // the shown tab: the same count in the top bar (Bea and Carl view, nobody else annotates)
  await expect(barText(ana.page)).toHaveText('👁 2 viendo');
  await expect(bar(ana.page)).toHaveAttribute('data-annotating', '0');
  // and its panel lists them as viewers, apart from annotators
  await expect.poll(() => here(ana.page)).toEqual(['Bea:viewing', 'Carl:viewing']);

  // Carl was hidden from the start: everything he ever sent is his viewing state
  // (y-websocket's first message on a socket: the empty state y-protocols starts with)
  const carlAll = (await sent(carl.page)).flatMap(([, states]) => states);
  expect(carlAll.length).toBeGreaterThan(0);
  expectViewingOnly(carlAll.filter((st) => Object.keys(st).length), 'Carl');

  // Ana works for a while: the hidden tabs stay quiet (their viewing state, renewals at most)
  const marks = await Promise.all([bea.page, carl.page].map((p) => p.evaluate(() => performance.now())));
  await ana.page.keyboard.press('d');
  for (let i = 0; i < 3; i++) await drawStroke(ana.page, wave(420, 300 + i * 80, 12, 14));
  for (let i = 0; i < 40; i++) await ana.page.mouse.move(500 + i * 8, 400 + (i % 5) * 10);
  await ana.page.keyboard.press('k');
  for (let i = 0; i < 30; i++) await ana.page.mouse.move(600 + i * 6, 300);
  await ana.page.waitForTimeout(500);
  for (const [i, [p, name]] of ([[bea.page, 'Bea'], [carl.page, 'Carl']] as const).entries()) {
    const got = await sentSince(p, marks[i]);
    expectViewingOnly(got.states, name);
    expectQuiet(got);
  }

  // a second tab of Bea, hidden: still one person
  const bea2 = await open(browser, 'Bea', room, { query: { canvas: '0' } });
  await expect(pill(bea2.page)).toHaveText('👁 2 viendo · 1 anotando');
  await ana.page.waitForTimeout(300);
  await expect(barText(ana.page)).toHaveText('👁 2 viendo');
  await expect(pill(carl.page)).toHaveText('👁 2 viendo · 1 anotando');
  // Bea shows the canvas in one of them: she annotates, whatever her other tab does
  await bea2.page.getByTestId('canvas-show').click();
  await expect(barText(ana.page)).toHaveText('👁 2 viendo · 1 anotando');
  await expect(pill(carl.page)).toHaveText('👁 2 viendo · 2 anotando');
  await expect(pill(bea.page)).toHaveText('👁 2 viendo · 1 anotando'); // Ana and Carl; Bea's own tabs never count
  await expect.poll(() => here(ana.page)).toEqual(['Bea:annotating', 'Carl:viewing']);

  // English, and someone leaving
  const dora = await open(browser, 'Dora', room, { query: { canvas: '0', lang: 'en' } });
  await expect(pill(dora.page)).toHaveText('👁 3 viewing · 2 annotating');
  await expect(pill(dora.page)).toHaveAttribute('title', /You are not counted/);
  await expect(pill(dora.page)).toHaveAttribute('title', /Others see you as viewing while this artifact is open, even with the canvas hidden\./);
  await carl.close();
  await expect(pill(dora.page)).toHaveText('👁 2 viewing · 2 annotating');
  await expect(barText(ana.page)).toHaveText('👁 2 viendo · 1 anotando'); // Bea and Dora

  for (const o of [ana, bea, bea2, dora]) await o.close();
});
