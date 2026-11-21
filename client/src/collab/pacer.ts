import * as Y from 'yjs';

/**
 * Send cadence of a tab. The server takes every message of a connection, a content update and an
 * awareness (cursor) update alike, from one token bucket: MSG_RATE_PER_SEC 120 with MSG_BURST 240
 * for a signed-in user, 30 with 60 for an anonymous visitor (docs/protocol.md §10). An empty
 * bucket closes the connection 4429.
 *
 * The editor used to send one content update and one awareness update per animation frame, so
 * the rate followed the display: about 120 messages/s on a 60 Hz screen, 240 on a 120 Hz one and
 * 480 on a 240 Hz one. One honest stroke on a 120 Hz screen was closed after about 2 s, and so was
 * a drag (the select tool wrote on every pointermove). Now the tab still edits its own document
 * at the display rate (the stroke and the dragged shape follow the pointer frame by frame), but
 * what goes on the wire is paced, whatever the display: the content updates made within one send
 * interval are merged into one message (UpdateBatcher, in the connection), and awareness is
 * published at most once per interval (the editor). SEND_HZ per stream: at most 2 x SEND_HZ
 * messages/s while drawing and moving the pointer, 60/s signed in (half the server's limit) and
 * 24/s anonymous (under its 30/s).
 */
export const SEND_HZ = { signedIn: 30, anonymous: 12 } as const;

/** Milliseconds between two messages of one stream. */
export function sendIntervalMs(anonymous: boolean): number {
  return 1000 / (anonymous ? SEND_HZ.anonymous : SEND_HZ.signedIn);
}

/**
 * Run a pending action at most once per interval: the first call after a quiet interval runs at
 * once (no added latency for a click or the start of a drag), later calls inside the interval are
 * folded into one run at its end, and the latest action wins. Driven by timers, never by
 * requestAnimationFrame, so the rate does not depend on the display's refresh rate.
 */
export class Throttle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = -Infinity;
  private fn: (() => void) | null = null;

  constructor(
    private readonly interval: () => number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Queue `fn` (replacing a queued one); it runs at once when the last run is an interval ago. */
  schedule(fn: () => void): void {
    this.fn = fn;
    if (this.timer) return;
    const wait = this.last + this.interval() - this.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
  }

  /** Run the queued action now (the end of a gesture sends its final state with it). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.run();
  }

  /** Drop the queued action. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fn = null;
  }

  get pending(): boolean {
    return this.fn !== null;
  }

  private run(): void {
    const fn = this.fn;
    this.fn = null;
    if (!fn) return;
    this.last = this.now();
    fn();
  }
}

/**
 * Transaction meta key: the update of this transaction goes on the wire as one message of its own,
 * never merged with others. CanvasDoc.delete sets it on the batches of a big delete, which are split
 * on purpose (the server refuses a delete it would need too long to apply at once, protocol §10).
 */
export const SEND_ALONE = 'artifacts-canvas:send-alone';

/**
 * Largest merged message (bytes of the updates merged). An update this big (an image) goes alone:
 * merging two images could pass the server's message cap (MAX_MESSAGE_BYTES, 4 MiB).
 */
export const MERGE_MAX_BYTES = 64 * 1024;

/**
 * Local content updates on their way to the server, merged per send interval (Throttle): the first
 * update after a quiet interval goes at once, the ones made within the interval go together at its
 * end as one merged update (Y.mergeUpdates), in order. An update marked `alone` or bigger than
 * MERGE_MAX_BYTES goes as its own message, after what was waiting.
 */
export class UpdateBatcher {
  private pending: Uint8Array[] = [];
  private bytes = 0;
  private readonly pace: Throttle;

  constructor(
    private readonly send: (update: Uint8Array) => void,
    interval: () => number,
    now?: () => number,
  ) {
    this.pace = new Throttle(interval, now);
  }

  push(update: Uint8Array, alone = false): void {
    if (alone || update.byteLength > MERGE_MAX_BYTES) {
      this.sendPending();
      this.send(update);
      return;
    }
    if (this.bytes + update.byteLength > MERGE_MAX_BYTES) this.sendPending();
    this.pending.push(update);
    this.bytes += update.byteLength;
    this.pace.schedule(() => this.sendPending());
  }

  /** Send what is waiting now. */
  flush(): void {
    this.pace.cancel();
    this.sendPending();
  }

  /** Forget what is waiting (the connection dropped: the next join's step-2 answer carries it). */
  drop(): void {
    this.pace.cancel();
    this.pending = [];
    this.bytes = 0;
  }

  get waiting(): number {
    return this.pending.length;
  }

  private sendPending(): void {
    if (!this.pending.length) return;
    const u = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.bytes = 0;
    this.send(u);
  }
}
