/**
 * A presentation in a REAL browser against the REAL server (stack.ts), default limits (120
 * messages/s, burst 240): one presenter and five followers.
 *
 * Before (protocol §4.2): y-websocket 3.1.0 sent every awareness state a tab received back to the
 * server, and every follower republished its viewport on each update of the presenter, so every
 * tab sent the whole room's traffic: 10 tabs with a moving laser were all closed 4429. Now each
 * tab sends only its own state, a follower sends nothing while the presenter's laser moves and one
 * viewport once the presenter's camera stops, and the room carries the presenter's stream alone.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { allowUser, openAs, startStack, waitFor, type Stack } from './stack';

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FOLLOWERS = 5;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Init script: every awareness message sent on the canvas socket, as [time, client ids]. */
function tapAwareness() {
  const w = window as unknown as W;
  w.__aw = [];
  const varUint = (b: Uint8Array, p: { i: number }) => {
    let n = 0;
    let s = 0;
    let c: number;
    do {
      c = b[p.i++];
      n += (c & 127) * 2 ** s;
      s += 7;
    } while (c & 128);
    return n;
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, d: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const b = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
    if (b && b[0] === 1 && String(this.url).includes('/_canvas/_/ws/')) {
      const p = { i: 1 };
      varUint(b, p); // length of the update
      const ids: number[] = [];
      for (let n = varUint(b, p); n > 0; n--) {
        ids.push(varUint(b, p));
        varUint(b, p);
        p.i += varUint(b, p);
      }
      w.__aw.push([performance.now(), ids]);
    }
    return send.call(this, d as never);
  };
}

const peakPerSecond = (ts: number[]) => {
  let peak = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
};

test('a presentation of 6 tabs: each tab sends only its own awareness, followers stay quiet while the laser moves, nobody is closed', async ({ browser }) => {
  test.setTimeout(180_000);
  const key = 'reports/present-room.html';
  const names = ['ana', ...Array.from({ length: FOLLOWERS }, (_, i) => `f${i}`)];
  for (const n of names) allowUser(stack.core, key, n, `u-${n}`, n);
  const tabs: { page: Page; close: () => Promise<void> }[] = [];
  for (const n of names) tabs.push(await openAs(stack, browser, n, key, (c: BrowserContext) => c.addInitScript(tapAwareness)));
  const [ana, ...followers] = tabs;
  await ana.page.getByTestId('present').click();
  for (const f of followers) await waitFor(() => f.page.evaluate(() => (window as unknown as W).__canvas.editor.followingUserId === 'u-ana'), 10_000, 'following');
  await ana.page.waitForTimeout(1500); // the followers' own viewport and `following` went out
  const marks = await Promise.all(tabs.map((t) => t.page.evaluate(() => performance.now())));

  // 1. the laser moves for 5 s at ~125 moves/s
  await ana.page.evaluate(async () => {
    const ed = (window as unknown as W).__canvas.editor;
    const info = (pt: { x: number; y: number }) => ({ screen: pt, world: ed.toWorld(pt), shift: false, alt: false, mod: false, pressure: 0.5, pen: false, button: 0 });
    ed.activeTool.down(info({ x: 500, y: 400 }));
    let i = 0;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        i++;
        ed.activeTool.move(info({ x: 500 + (i % 400), y: 400 + Math.sin(i / 20) * 120 }));
        if (performance.now() - t0 > 5000) {
          clearInterval(iv);
          resolve();
        }
      }, 8);
    });
    ed.activeTool.up(info({ x: 500, y: 400 }));
  });
  await ana.page.waitForTimeout(1000);
  const afterLaser = await Promise.all(tabs.map((t) => t.page.evaluate(() => (window as unknown as W).__aw.length as number)));

  // 2. the presenter scrolls down for 2 s (60 steps): the followers' cameras follow it
  await ana.page.evaluate(async () => {
    const ed = (window as unknown as W).__canvas.editor;
    for (let i = 0; i < 60; i++) {
      ed.panBy(0, -10);
      await new Promise((r) => setTimeout(r, 33));
    }
  });
  const anaView = await ana.page.evaluate(() => {
    const v = (window as unknown as W).__canvas.editor.visibleWorld();
    return v.y + v.h / 2;
  });
  for (const f of followers) {
    await waitFor(async () => Math.abs((await f.page.evaluate(() => {
      const v = (window as unknown as W).__canvas.editor.visibleWorld();
      return v.y + v.h / 2;
    })) - anaView) < 2, 5000, 'follower camera');
  }
  await ana.page.waitForTimeout(1500); // the followers' viewport goes out once their camera stood still

  const rows = [];
  for (let i = 0; i < tabs.length; i++) {
    const p = tabs[i].page;
    const r = await p.evaluate((mark) => {
      const w = window as unknown as W;
      const me = w.__canvas.editor.conn.awareness.clientID as number;
      const sent = (w.__aw as [number, number[]][]).filter(([t]) => t >= mark);
      return {
        me,
        times: sent.map(([t]) => t),
        foreign: sent.filter(([, ids]) => ids.some((x) => x !== me)).length,
        closes: w.__wsCloses as number[],
        status: w.__canvas.editor.status as string,
        total: (w.__aw as unknown[]).length,
      };
    }, marks[i]);
    rows.push({ ...r, peak: peakPerSecond(r.times), sent: r.times.length });
  }
  const laserSent = rows.map((r, i) => afterLaser[i] - (r.total - r.sent));
  console.log('[presence]', JSON.stringify(rows.map((r, i) => ({ tab: names[i], sent: r.sent, duringLaser: laserSent[i], peak: r.peak, foreign: r.foreign, closes: r.closes }))));
  for (const r of rows) {
    expect(r.closes).toEqual([]);
    expect(r.status).toBe('synced');
    expect(r.foreign).toBe(0); // never another tab's state
    // the awareness pace (SEND_HZ 30/s signed in), whatever the room's size; before: up to 255/s
    expect(r.peak).toBeLessThanOrEqual(35);
  }
  const [presenter, ...rest] = rows;
  expect(presenter.sent).toBeGreaterThan(50);
  for (let i = 1; i < rows.length; i++) {
    expect(laserSent[i]).toBe(0); // the presenter's laser makes a follower send nothing
    // one viewport once the camera stood still (a slow runner may split the scroll in two or three)
    expect(rest[i - 1].sent).toBeLessThanOrEqual(3);
  }
  for (const t of tabs) await t.close();
});
