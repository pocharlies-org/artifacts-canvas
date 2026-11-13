/**
 * IncomingFrames (review S8): follows the RFC 6455 frame headers of what a client sends, to tell
 * the sweep when a connection holds part of a message and not its end. The end-to-end variant (a
 * real server dropping fragment holders after the deadline) is in fv9-review.test.ts, "S8".
 */
import { describe, expect, it } from 'vitest';
import { IncomingFrames } from '../src/incoming.js';
import { incomingDeadlineMs, loadConfig, wsMaxPayload, WS_PAYLOAD_SLACK } from '../src/config.js';

/** A client frame (always masked): FIN, opcode, payload; length in 7, 16 or 64 bits as RFC 6455 says. */
function frame(fin: boolean, opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const ext = n < 126 ? 0 : n < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + ext + 4 + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out[1] = 0x80 | (ext === 0 ? n : ext === 2 ? 126 : 127);
  const dv = new DataView(out.buffer);
  if (ext === 2) dv.setUint16(2, n);
  if (ext === 8) {
    dv.setUint32(2, Math.floor(n / 2 ** 32));
    dv.setUint32(6, n >>> 0);
  }
  out.set([1, 2, 3, 4], 2 + ext); // mask key (the payload is not unmasked: only lengths matter)
  out.set(payload, 2 + ext + 4);
  return out;
}
const bytes = (n: number) => new Uint8Array(n).fill(7);
const BIN = 0x2;
const CONT = 0x0;
const PING = 0x9;
const PONG = 0xa;

describe('IncomingFrames', () => {
  it('a whole message in one read leaves nothing unfinished; one split anywhere is unfinished until its last byte', () => {
    for (const size of [0, 5, 125, 126, 300, 65535, 65536, 200_000]) {
      const f = frame(true, BIN, bytes(size));
      const whole = new IncomingFrames();
      whole.feed(f, 1);
      expect([whole.held, whole.since]).toEqual([0, 0]);
      for (const cut of [1, 2, Math.min(5, f.length - 1), Math.floor(f.length / 2), f.length - 1]) {
        if (cut <= 0 || cut >= f.length) continue;
        const t = new IncomingFrames();
        t.feed(f.subarray(0, cut), 10);
        expect(t.since).toBe(10);
        t.feed(f.subarray(cut), 20);
        expect([t.held, t.since]).toEqual([0, 0]);
      }
    }
  });

  it('fragments without the last one are held, with control frames between them; the last fragment ends the message', () => {
    const t = new IncomingFrames();
    t.feed(frame(false, BIN, bytes(1000)), 100);
    expect([t.held, t.since]).toEqual([1000, 100]);
    // a pong (and a ping) between fragments: allowed by the RFC, and neither ends nor restarts the message
    t.feed(frame(true, PONG, bytes(0)), 200);
    t.feed(frame(true, PING, bytes(4)), 300);
    expect([t.held, t.since]).toEqual([1000, 100]);
    t.feed(frame(false, CONT, bytes(70_000)), 400);
    expect([t.held, t.since]).toEqual([71_000, 100]);
    // half of the last fragment: still unfinished, its bytes counted as they come
    const last = frame(true, CONT, bytes(10));
    t.feed(last.subarray(0, 8), 500);
    expect([t.held, t.since]).toEqual([71_000 + 2, 100]);
    t.feed(last.subarray(8), 600);
    expect([t.held, t.since]).toEqual([0, 0]);
  });

  it('a control frame between messages leaves nothing unfinished; a 64-bit length is read', () => {
    const t = new IncomingFrames();
    t.feed(frame(true, PONG, bytes(0)), 1);
    expect([t.held, t.since]).toEqual([0, 0]);
    const f64 = frame(true, BIN, bytes(70_000)); // over 65 535: the 64-bit length
    expect(f64[1] & 0x7f).toBe(127);
    t.feed(f64.subarray(0, 9), 2); // a header split inside its length
    expect(t.since).toBe(2);
    t.feed(f64.subarray(9), 3);
    expect([t.held, t.since]).toEqual([0, 0]);
  });

  it('any sequence of messages cut into reads anywhere: unfinished exactly while a message is cut, and held is what was read of it', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      // a stream of messages (some fragmented, with pongs between fragments), and where each message ends
      const parts: Uint8Array[] = [];
      const ends: number[] = [];
      const payloadOffsets: { from: number; to: number; message: number }[] = [];
      let at = 0;
      const msgs = 1 + rnd(6);
      for (let m = 0; m < msgs; m++) {
        const frags = 1 + rnd(3);
        for (let k = 0; k < frags; k++) {
          const size = [0, 3, 125, 130, 1000, 70_000][rnd(6)];
          const f = frame(k === frags - 1, k === 0 ? BIN : CONT, bytes(size));
          payloadOffsets.push({ from: at + f.length - size, to: at + f.length, message: m });
          parts.push(f);
          at += f.length;
          if (k < frags - 1 && rnd(2)) {
            const p = frame(true, PONG, bytes(rnd(10)));
            parts.push(p);
            at += p.length;
          }
        }
        ends.push(at);
      }
      const all = new Uint8Array(at);
      let o = 0;
      for (const p of parts) all.set(p, (o += p.length) - p.length);
      const t = new IncomingFrames();
      let pos = 0;
      while (pos < all.length) {
        const next = Math.min(all.length, pos + 1 + rnd(4000));
        t.feed(all.subarray(pos, next), 1);
        pos = next;
        const done = ends.includes(pos);
        // the message being read: payload bytes of its frames read so far
        const current = ends.filter((e) => e < pos).length;
        const read = payloadOffsets.filter((p) => p.message === current).reduce((a, p) => a + Math.max(0, Math.min(pos, p.to) - p.from), 0);
        if (done) expect([t.held, t.since]).toEqual([0, 0]);
        else {
          expect(t.since).toBe(1);
          expect(t.held).toBe(read);
        }
      }
    }
  });

  it('maxPayload is the largest message cap plus the slack, after the memory sizing; the deadline grows with what is held', () => {
    const env = { GATE_AUTHZ_URL: 'http://c/', ARTIFACT_BASE_URL: 'http://c/', S3_BUCKET: 'b', METRICS_PORT: '0' };
    const cfg = loadConfig({ ...env, HEAP_LIMIT_MB: '1776' });
    expect(wsMaxPayload(cfg)).toBe(4 * 1024 * 1024 + WS_PAYLOAD_SLACK);
    expect(wsMaxPayload(loadConfig({ ...env, HEAP_LIMIT_MB: '1776', MAX_MESSAGE_BYTES: String(1 << 20) }))).toBe((1 << 20) + WS_PAYLOAD_SLACK);
    expect(cfg.wsIncomingTimeoutMs).toBe(30_000);
    expect(cfg.wsIncomingMinBytesPerSec).toBe(32 * 1024);
    expect(incomingDeadlineMs(0, cfg)).toBe(30_000);
    // a 4 MiB message at the slowest rate allowed: 30 s + 128 s
    expect(incomingDeadlineMs(4 * 1024 * 1024, cfg)).toBe(158_000);
  });
});
