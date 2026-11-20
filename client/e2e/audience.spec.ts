import { expect, test, type Page } from '@playwright/test';
import { drawStroke, newRoom, open, wave } from './helpers';

/**
 * Who else is here (collab/presence.ts audienceOf, ui/visibility.ts, ui/chrome.ts): the hidden
 * canvas's pill and the shown canvas's top bar say how many other people view the artifact and how
 * many of them annotate (the canvas shown), by person, never counting this user. A hidden tab's
 * presence is the user and the viewing status only: no cursor, viewport or laser, ever.
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

test('three sessions, one shown and two hidden: every tab counts the others right, and the hidden tabs send no cursor or viewport', async ({ browser }) => {
  const room = newRoom('audience');
  const ana = await open(browser, 'Ana', room);
  const bea = await open(browser, 'Bea', room, { query: { canvas: '0' }, initScript: TAP });
  const carl = await open(browser, 'Carl', room, { query: { canvas: '0' }, initScript: TAP });

  // hidden tabs: the two others view, and one of them (Ana) annotates
  for (const p of [bea.page, carl.page]) {
    await expect(pill(p)).toHaveText('👁 2 viendo · 1 anotando');
    await expect(pill(p)).toHaveAttribute('data-viewing', '2');
    await expect(pill(p)).toHaveAttribute('data-annotating', '1');
    await expect(pill(p)).toHaveAttribute('title', /Tú no cuentas/);
  }
  // the shown tab: the same count in the top bar (Bea and Carl view, nobody else annotates)
  await expect(barText(ana.page)).toHaveText('👁 2 viendo');
  await expect(bar(ana.page)).toHaveAttribute('data-annotating', '0');
  // and its panel lists them as viewers, apart from annotators
  await expect.poll(() => here(ana.page)).toEqual(['Bea:viewing', 'Carl:viewing']);

  // Ana works for a while: the hidden tabs stay quiet
  const marks = await Promise.all([bea.page, carl.page].map((p) => p.evaluate(() => performance.now())));
  await ana.page.keyboard.press('d');
  for (let i = 0; i < 3; i++) await drawStroke(ana.page, wave(420, 300 + i * 80, 12, 14));
  for (let i = 0; i < 40; i++) await ana.page.mouse.move(500 + i * 8, 400 + (i % 5) * 10);
  await ana.page.keyboard.press('k');
  for (let i = 0; i < 30; i++) await ana.page.mouse.move(600 + i * 6, 300);
  await ana.page.waitForTimeout(500);
  for (const [i, p] of [bea.page, carl.page].entries()) {
    const all = await sent(p);
    // everything a hidden tab ever sent: its user and the viewing status, nothing else
    expect(all.length).toBeGreaterThan(0);
    for (const [, states] of all) {
      for (const st of states) {
        // y-websocket's first message on a socket: the empty state y-protocols starts with
        if (Object.keys(st).length === 0) continue;
        expect(st.cursor ?? null).toBeNull();
        expect(st.viewport ?? null).toBeNull();
        expect(st.laser ?? null).toBeNull();
        expect(st.following ?? null).toBeNull();
        expect(st.presenting ?? false).toBe(false);
        expect(st.status).toBe('cursor.viewing');
      }
    }
    // while Ana drew, moved and used the laser: nothing (a renewal every 15 s at most)
    expect(all.filter(([t]) => t >= marks[i]).length).toBeLessThanOrEqual(1);
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
  await carl.close();
  await expect(pill(dora.page)).toHaveText('👁 2 viewing · 2 annotating');
  await expect(barText(ana.page)).toHaveText('👁 2 viendo · 1 anotando'); // Bea and Dora

  for (const o of [ana, bea, bea2, dora]) await o.close();
});
