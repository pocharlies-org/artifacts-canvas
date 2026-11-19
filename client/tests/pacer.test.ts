/**
 * Send cadence (collab/pacer.ts). The server takes every message of a connection, content and
 * awareness alike, from one bucket (server/src/limits.ts TokenBucket; MSG_RATE_PER_SEC 120 with
 * MSG_BURST 240, anonymous 30 with 60: the server's and the chart's defaults) and closes 4429
 * when it is empty. A stroke or a drag must stay under it at any display refresh rate: on a
 * 120 Hz screen the editor used to send ~240 messages/s (one content update and one awareness
 * update per animation frame) and was closed after ~2 s.
 *
 * The tab still edits its own document once per frame (as the editor does: a stroke appends its
 * points every animation frame, a drag writes every pointermove); what the wire carries is merged
 * per send interval (UpdateBatcher, as the connection does) and awareness is throttled (Throttle,
 * as Editor.publishPresence does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc } from '../src/model/doc';
import { MERGE_MAX_BYTES, SEND_ALONE, SEND_HZ, Throttle, UpdateBatcher, sendIntervalMs } from '../src/collab/pacer';
import type { DrawShape, Shape } from '../src/model/types';

/** The server's per-connection message bucket, as server/src/limits.ts TokenBucket computes it. */
class ServerBucket {
  private tokens: number;
  private last: number;
  refused = 0;
  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): void {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) this.refused++;
    else this.tokens -= 1;
  }
}

const SERVER_LIMIT = { signedIn: { rate: 120, burst: 240 }, anonymous: { rate: 30, burst: 60 } };

/** Largest number of timestamps inside any one-second window. */
function peakPerSecond(times: number[]): number {
  let peak = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}

/**
 * A tab's document wired like Connection does: local updates through an UpdateBatcher into `wire`,
 * which a second document (the room) applies, every message timed.
 */
function wired(anonymous: boolean) {
  const doc = new CanvasDoc();
  const room = new Y.Doc();
  const sent: { at: number; bytes: number }[] = [];
  const batcher = new UpdateBatcher((u) => {
    sent.push({ at: performance.now(), bytes: u.byteLength });
    Y.applyUpdate(room, u, 'wire');
  }, () => sendIntervalMs(anonymous));
  doc.doc.on('update', (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => batcher.push(u, tr.meta.get(SEND_ALONE) === true));
  return { doc, room, sent, batcher };
}

/** Advance the fake clock frame by frame at `hz` for `seconds`, running `frame(i)` on each. */
function frames(hz: number, seconds: number, frame: (i: number) => void): number {
  const n = Math.round(hz * seconds);
  let now = 0;
  for (let i = 1; i <= n; i++) {
    const at = Math.round((i * 1000) / hz);
    vi.advanceTimersByTime(at - now);
    now = at;
    frame(i);
  }
  return n;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Throttle', () => {
  it('runs the first call at once, folds the calls inside the interval into one run at its end, and the latest wins', () => {
    const runs: string[] = [];
    const th = new Throttle(() => 100);
    th.schedule(() => runs.push('a'));
    expect(runs).toEqual(['a']);
    th.schedule(() => runs.push('b'));
    th.schedule(() => runs.push('c'));
    expect(runs).toEqual(['a']);
    expect(th.pending).toBe(true);
    vi.advanceTimersByTime(99);
    expect(runs).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual(['a', 'c']);
    // flush runs what is queued at once; cancel drops it
    th.schedule(() => runs.push('d'));
    th.flush();
    expect(runs).toEqual(['a', 'c', 'd']);
    th.schedule(() => runs.push('e'));
    th.cancel();
    vi.advanceTimersByTime(500);
    expect(runs).toEqual(['a', 'c', 'd']);
    expect(th.pending).toBe(false);
    // flush with nothing queued is a no-op
    th.flush();
    expect(runs).toEqual(['a', 'c', 'd']);
  });

  it('the rate is fixed per stream: 30/s signed in, 12/s anonymous', () => {
    expect(SEND_HZ).toEqual({ signedIn: 30, anonymous: 12 });
    expect(sendIntervalMs(false)).toBeCloseTo(1000 / 30);
    expect(sendIntervalMs(true)).toBeCloseTo(1000 / 12);
  });
});

describe('UpdateBatcher', () => {
  it('merges the updates of one interval into one message, in order; the room ends equal to the tab', () => {
    const { doc, room, sent } = wired(false);
    const id = doc.create({ type: 'note', x: 0, y: 0, w: 100, h: 100, text: '' } as Partial<Shape> & { type: 'note' });
    expect(sent.length).toBe(1); // the first update after a quiet interval goes at once
    for (let i = 1; i <= 20; i++) doc.update(id, { x: i, text: 'x'.repeat(i) });
    expect(sent.length).toBe(1);
    vi.advanceTimersByTime(40);
    expect(sent.length).toBe(2); // 20 updates, one message
    expect(Y.encodeStateVector(room)).toEqual(Y.encodeStateVector(doc.doc));
    expect((room.getMap('shapes').get(id) as Y.Map<unknown>).get('x')).toBe(20);
  });

  it('an update marked alone, or bigger than MERGE_MAX_BYTES, is a message of its own, after what was waiting', () => {
    const out: Uint8Array[] = [];
    const b = new UpdateBatcher((u) => out.push(u), () => 1000);
    const src = new Y.Doc();
    const updates: Uint8Array[] = [];
    src.on('update', (u: Uint8Array) => updates.push(u));
    for (let i = 0; i < 4; i++) src.getMap('m').set(`k${i}`, i);
    src.getMap('m').set('big', 'z'.repeat(MERGE_MAX_BYTES + 10));
    b.push(updates[0]);
    b.push(updates[1]);
    b.push(updates[2]);
    expect(out.length).toBe(1);
    b.push(updates[3], true);
    // the waiting one (2) went first, then the alone one
    expect(out.length).toBe(3);
    expect(out[2]).toBe(updates[3]);
    b.push(updates[4]);
    expect(out.length).toBe(4);
    expect(out[3]).toBe(updates[4]);
    // inside the interval of the first send, both wait; drop forgets them
    b.push(updates[0]);
    b.push(updates[1]);
    expect(b.waiting).toBe(2);
    b.drop();
    vi.advanceTimersByTime(2000);
    expect(out.length).toBe(4);
  });

  it('the batches of a big delete stay apart on the wire (the server refuses a delete too big to apply at once)', () => {
    const { doc, sent } = wired(false);
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < 2500; i++) ids.push(doc.create({ type: 'geo', geo: 'rectangle', x: i, y: 0, w: 1, h: 1 } as Partial<Shape> & { type: 'geo' }));
    });
    doc.endGesture();
    vi.advanceTimersByTime(100);
    const before = sent.length;
    doc.delete(ids);
    vi.advanceTimersByTime(100);
    expect(sent.length - before).toBe(3); // DELETE_BATCH 1000: three messages, never merged
  });
});

for (const anonymous of [false, true]) {
  const who = anonymous ? 'anonymous' : 'signed in';
  for (const hz of [60, 120, 240]) {
    it(`a ${hz} Hz stroke (${who}): points appended every frame, the cursor published every frame; the wire stays under the server's bucket and the room gets every point`, () => {
      const { doc, room, sent, batcher } = wired(anonymous);
      // the awareness stream: Editor.publishPresence schedules one flush per pointer event
      const presence = new Throttle(() => sendIntervalMs(anonymous));
      const t0 = performance.now();
      const id = doc.create({ type: 'draw', x: 0, y: 0, w: 0, h: 0, points: [0, 0, 0.5], done: false } as Partial<DrawShape> & { type: 'draw' });
      const n = frames(hz, 6, (i) => {
        doc.appendPoints(id, [i, Math.round(Math.sin(i / 10) * 50), 0.5]);
        presence.schedule(() => sent.push({ at: performance.now(), bytes: 0 }));
      });
      doc.update(id, { done: true });
      vi.advanceTimersByTime(1000);
      batcher.flush();
      const limit = anonymous ? SERVER_LIMIT.anonymous : SERVER_LIMIT.signedIn;
      const times = sent.map((s) => s.at).sort((a, b) => a - b);
      const bucket = new ServerBucket(limit.rate, limit.burst, t0);
      for (const t of times) bucket.take(t);
      expect(bucket.refused).toBe(0);
      const hzSend = anonymous ? SEND_HZ.anonymous : SEND_HZ.signedIn;
      expect(peakPerSecond(times)).toBeLessThanOrEqual(2 * hzSend + 2);
      expect(peakPerSecond(times)).toBeLessThan(limit.rate);
      // the tab drew every frame, the room has the same stroke
      const pts = (room.getMap('shapes').get(id) as Y.Map<unknown>).get('points') as Y.Array<number>;
      expect(pts.length).toBe(3 * (n + 1));
      expect(pts.toArray()).toEqual((doc.get(id) as DrawShape).points);
      expect((room.getMap('shapes').get(id) as Y.Map<unknown>).get('done')).toBe(true);
    });
  }
}

it('before: one message per stream per animation frame overflows the bucket within seconds at 120 Hz (the cadence this replaces)', () => {
  // the same 120 Hz stroke, with the old cadence modelled: a content update and an awareness
  // update on every frame
  const bucket = new ServerBucket(120, 240, 0);
  let firstRefusal = -1;
  for (let i = 1; i <= 120 * 6; i++) {
    const t = (i * 1000) / 120;
    bucket.take(t);
    bucket.take(t);
    if (bucket.refused && firstRefusal < 0) firstRefusal = t;
  }
  expect(firstRefusal).toBeGreaterThan(1500);
  expect(firstRefusal).toBeLessThan(2500); // the live test saw the close after ~2.2 s
});

for (const hz of [120, 240]) {
  it(`a ${hz} Hz drag of a shape writes the tab's document every frame and the wire once per send interval; the room gets the final position`, () => {
    const { doc, room, sent } = wired(false);
    const id = doc.create({ type: 'note', x: 0, y: 0, w: 200, h: 200, text: 'n' } as Partial<Shape> & { type: 'note' });
    doc.endGesture();
    vi.advanceTimersByTime(100);
    const from = sent.length;
    let local = 0;
    doc.doc.on('update', () => local++);
    const n = frames(hz, 4, (i) => doc.update(id, { x: i, y: i / 2 }));
    doc.endGesture();
    vi.advanceTimersByTime(100);
    const wire = sent.slice(from).map((s) => s.at);
    expect(local).toBe(n);
    expect(peakPerSecond(wire)).toBeLessThanOrEqual(SEND_HZ.signedIn + 2);
    expect(wire.length).toBeLessThan(n / 3);
    const m = room.getMap('shapes').get(id) as Y.Map<unknown>;
    expect([m.get('x'), m.get('y')]).toEqual([n, n / 2]);
  });
}
