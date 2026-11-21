/**
 * Message rate in a REAL browser against the REAL server (stack.ts), with the server's default
 * limits (MSG_RATE_PER_SEC 120, MSG_BURST 240: the chart's defaults too).
 *
 * The display is simulated: requestAnimationFrame runs once per frame of a `hz` clock, and one
 * pointermove per frame goes through the editor's own handler (cursor presence + tool), as a
 * browser delivers them. Before the send cadence was fixed (collab/pacer.ts), the editor sent a
 * content update and an awareness update per animation frame, and a stroke on a 120 Hz screen was
 * closed 4429 after ~2 s, leaving the tab read-only until a reload.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import { allowUser, openAs, startStack, waitFor, type Stack } from './stack';

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Init script: a display at `hz`, and every canvas WebSocket send recorded as [time, type]. */
function display(hz: number) {
  const w = window as unknown as W;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let nextId = 1;
  const step = 1000 / hz;
  let next = performance.now() + step;
  w.__frames = 0;
  w.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  w.cancelAnimationFrame = (id: number) => {
    queue = queue.filter((q) => q.id !== id);
  };
  setInterval(() => {
    const now = performance.now();
    while (next <= now) {
      const run = queue;
      queue = [];
      w.__frames++;
      for (const q of run) {
        try {
          q.cb(next);
        } catch (e) {
          console.error(e);
        }
      }
      next += step;
    }
  }, 1);
  w.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (String(this.url).includes('/_canvas/_/ws/')) {
      const b = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      w.__sent.push([performance.now(), b ? b[0] : -1]);
    }
    return send.call(this, data as never);
  };
}

/** Largest number of sends inside any one-second window. */
function peakPerSecond(times: number[]): number {
  let peak = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}

/** Sends the server's bucket (120/s, burst 240; server/src/limits.ts) would refuse. */
function refusedByServer(times: number[], rate = 120, burst = 240): number {
  let tokens = burst;
  let last = times[0] ?? 0;
  let refused = 0;
  for (const t of times) {
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate);
    last = t;
    if (tokens < 1) refused++;
    else tokens -= 1;
  }
  return refused;
}

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

/** In the page: drive the active tool from `start` with one pointermove per simulated frame. */
const DRIVE = async ({ seconds, start, path }: { seconds: number; start: { x: number; y: number }; path: 'stroke' | 'drag' }) => {
  const w = window as unknown as W;
  const ed = w.__canvas.editor;
  const rect = ed.stage.getBoundingClientRect();
  const at = (i: number) =>
    path === 'stroke'
      ? { x: start.x + (i % 700), y: start.y + Math.sin(i / 20) * 120 + Math.floor(i / 700) * 30 }
      : { x: start.x + Math.sin(i / 50) * 300, y: start.y + Math.sin(i / 70) * 150 };
  const info = (pt: { x: number; y: number }) => ({ screen: pt, world: ed.toWorld(pt), shift: false, alt: false, mod: false, pressure: 0.5, pen: false, button: 0 });
  const sentFrom = w.__sent.length;
  const f0 = w.__frames;
  const t0 = performance.now();
  ed.activeTool.down(info(at(0)));
  let i = 0;
  await new Promise<void>((resolve) => {
    const frame = () => {
      i++;
      const pt = at(i);
      ed.stage.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + pt.x, clientY: rect.top + pt.y, pointerId: 1, pointerType: 'mouse', buttons: 1, pressure: 0.5, bubbles: true }));
      if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  const last = at(i);
  ed.activeTool.up(info(last));
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  return {
    moves: i,
    frames: w.__frames - f0,
    ms,
    sent: (w.__sent as [number, number][]).slice(sentFrom).map(([t, type]) => [t - t0, type] as [number, number]),
    status: ed.status as string,
    closes: w.__wsCloses as number[],
    notice: ed.notice as unknown,
    final: ed.toWorld(last) as { x: number; y: number },
  };
};

for (const hz of [120, 240]) {
  test(`a stroke drawn at ${hz} Hz stays under the server's message limit: no 4429, the tab stays live, every point reaches the room`, async ({ browser }) => {
    const key = `reports/rate-stroke-${hz}.html`;
    allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
    const a = await openAs(stack, browser, 'ana', key, (ctx: BrowserContext) => ctx.addInitScript(display, hz));
    await a.page.evaluate(() => (window as unknown as W).__canvas.editor.setTool('draw'));
    const seconds = 6;
    const r = await a.page.evaluate(DRIVE, { seconds, start: { x: 300, y: 300 }, path: 'stroke' as const });
    const times = r.sent.map(([t]) => t);
    const peak = peakPerSecond(times);
    const content = r.sent.filter(([, type]) => type === 0).length;
    const awareness = r.sent.filter(([, type]) => type === 1).length;
    console.log(`[rate] stroke ${hz} Hz: ${r.frames} frames, ${r.moves} moves in ${Math.round(r.ms)} ms; sent ${r.sent.length} (content ${content}, awareness ${awareness}), peak ${peak}/s, closes ${JSON.stringify(r.closes)}`);
    // the simulated display really ran at its rate, and the pointer moved far more often than the
    // send rate (each move is a local edit of the tab's document: how many fit depends on the host)
    expect(r.frames).toBeGreaterThan(0.8 * hz * seconds);
    expect(r.moves).toBeGreaterThan(0.3 * hz * seconds);
    // never closed, never read-only
    expect(r.closes).toEqual([]);
    expect(r.status).toBe('synced');
    expect(r.notice).toBeNull();
    // the cadence: two streams at 30/s (plus the stroke's create and final update), far under 120/s
    expect(peak).toBeLessThanOrEqual(65);
    expect(refusedByServer(times)).toBe(0);
    const mine = await a.page.evaluate(() => {
      const s = (window as unknown as W).__canvas.editor.doc.all().find((x: W) => x.type === 'draw');
      return { id: s.id, points: s.points.length, done: s.done };
    });
    expect(mine.done).toBe(true);
    expect(mine.points).toBe(3 * (r.moves + 1));
    // the room has the whole stroke, finished
    allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
    const b = await openAs(stack, browser, 'bob', key);
    await waitFor(async () => (await b.page.evaluate((id) => {
      const s = (window as unknown as W).__canvas.editor.doc.get(id);
      return s ? `${s.points.length}/${s.done}` : '';
    }, mine.id)) === `${mine.points}/true`, 10_000, 'the whole stroke in the room');
    await a.close();
    await b.close();
  });
}

test('dragging a shape at 240 Hz is batched: no 4429, the final position reaches the room', async ({ browser }) => {
  const key = 'reports/rate-drag.html';
  allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
  const a = await openAs(stack, browser, 'ana', key, (ctx: BrowserContext) => ctx.addInitScript(display, 240));
  const start = await a.page.evaluate(() => {
    const ed = (window as unknown as W).__canvas.editor;
    const c = ed.toWorld({ x: 600, y: 400 });
    const id = ed.doc.create({ type: 'note', x: c.x - 100, y: c.y - 100, w: 200, h: 200, text: 'drag me' });
    ed.doc.endGesture();
    ed.setTool('select');
    (window as unknown as W).__noteId = id;
    return { x: 600, y: 400 };
  });
  await a.page.waitForTimeout(500);
  const r = await a.page.evaluate(DRIVE, { seconds: 4, start, path: 'drag' as const });
  const times = r.sent.map(([t]) => t);
  const peak = peakPerSecond(times);
  console.log(`[rate] drag 240 Hz: ${r.frames} frames, ${r.moves} moves; sent ${r.sent.length}, peak ${peak}/s, closes ${JSON.stringify(r.closes)}`);
  expect(r.moves).toBeGreaterThan(0.3 * 240 * 4);
  expect(r.closes).toEqual([]);
  expect(r.status).toBe('synced');
  expect(peak).toBeLessThanOrEqual(65);
  expect(refusedByServer(times)).toBe(0);
  const mine = await a.page.evaluate(() => {
    const w = window as unknown as W;
    const s = w.__canvas.editor.doc.get(w.__noteId);
    return { id: s.id, x: Math.round(s.x), y: Math.round(s.y) };
  });
  // the note moved with the pointer: its centre is where the drag ended
  expect(Math.abs(mine.x + 100 - r.final.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(mine.y + 100 - r.final.y)).toBeLessThanOrEqual(1);
  allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
  const b = await openAs(stack, browser, 'bob', key);
  await waitFor(async () => (await b.page.evaluate((id) => {
    const s = (window as unknown as W).__canvas.editor.doc.get(id);
    return s ? `${Math.round(s.x)},${Math.round(s.y)}` : '';
  }, mine.id)) === `${mine.x},${mine.y}`, 10_000, 'the final position in the room');
  await a.close();
  await b.close();
});

test.describe('after a 4429', () => {
  let low: Stack;
  test.beforeAll(async () => {
    // a low limit, so that a burst of honest edits hits it
    low = await startStack({ MSG_RATE_PER_SEC: '10', MSG_BURST: '20' });
  });
  test.afterAll(async () => {
    await low?.stop();
  });

  test('the tab is not left read-only: it says it reconnects, waits, joins again and keeps the edits made meanwhile', async ({ browser }) => {
    const key = 'reports/rate-4429.html';
    allowUser(low.core, key, 'ana', 'u-ana', 'Ana');
    const a = await openAs(low, browser, 'ana', key);
    await a.page.evaluate(() => {
      const w = window as unknown as W;
      const ed = w.__canvas.editor;
      w.__noteId = ed.doc.create({ type: 'note', x: 200, y: 200, w: 200, h: 200, text: 'n' });
      ed.doc.endGesture();
    });
    await a.page.evaluate(() => {
      const w = window as unknown as W;
      w.__canvas.editor.doc.update(w.__noteId, { x: 260 });
    });
    await a.page.waitForTimeout(2500); // saved, and the bucket refills
    const t0 = Date.now();
    // 60 awareness messages at once (the tab's own awareness, without the editor's throttle) against
    // a bucket of 20: content edits are merged on the wire, so they cannot flood it any more
    await a.page.evaluate(() => {
      const aw = (window as unknown as W).__canvas.editor.conn.awareness;
      for (let i = 1; i <= 60; i++) aw.setLocalStateField('status', i % 2 ? 'cursor.typing' : null);
    });
    await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__wsCloses as number[])).includes(4429), 8_000, 'the 4429');
    const waiting = await a.page.evaluate(() => {
      const w = window as unknown as W;
      const ed = w.__canvas.editor;
      // an edit while waiting
      ed.doc.update(w.__noteId, { text: 'kept' });
      return { status: ed.status, readOnly: ed.readOnly, notice: ed.notice?.kind, banner: document.querySelector('[data-testid="banner"]')?.textContent, retryAt: ed.conn.retryAt };
    });
    expect(waiting.status).not.toBe('closed');
    expect(waiting.readOnly).toBe(false);
    expect(waiting.notice).toBe('rate-limited');
    expect(waiting.banner).toBe('Demasiados cambios seguidos: el servidor ha pausado la conexión. Se reconecta sola en unos segundos y tus cambios se conservan.');
    expect(waiting.retryAt).not.toBeNull();
    await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__canvas.editor.status)) === 'synced', 15_000, 'joined again');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    const after = await a.page.evaluate(() => {
      const ed = (window as unknown as W).__canvas.editor;
      return { notice: ed.notice, banner: document.querySelector('[data-testid="banner"]')?.classList.contains('show'), closes: (window as unknown as W).__wsCloses };
    });
    expect(after.notice).toBeNull();
    expect(after.banner).toBe(false);
    expect(after.closes).toEqual([4429]);
    // the room has the edit made before and the one made while waiting
    allowUser(low.core, key, 'bob', 'u-bob', 'Bob');
    const b = await openAs(low, browser, 'bob', key);
    await waitFor(async () => (await b.page.evaluate(() => {
      const s = (window as unknown as W).__canvas.editor.doc.all().find((x: W) => x.type === 'note');
      return s ? `${s.x}/${s.text}` : '';
    })) === '260/kept', 10_000, 'the edits in the room');
    await a.close();
    await b.close();
  });
});
