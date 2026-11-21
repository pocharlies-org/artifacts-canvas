/**
 * The connection's side of the send rate, against the reference dev room (dev/yroom.ts) through a
 * real WebSocket server:
 *   - local edits are merged on the wire per send interval (collab/pacer.ts UpdateBatcher), while
 *     the tab's own document changes at once;
 *   - a 4429 (rate limited) close is not final: the connection waits (RATE_LIMIT_BACKOFF) and joins
 *     again, the tab is never left read-only, and edits made while waiting reach the room. Every
 *     other 44xx close stays final. The server closes the connection itself here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import WebSocket, { WebSocketServer } from 'ws';
import { devIdentity, getRoom } from '../dev/yroom';
import { Connection, RATE_LIMIT_BACKOFF, rateLimitDelay } from '../src/collab/connection';
import { CanvasDoc } from '../src/model/doc';
import { encodeNotice } from '../src/collab/protocol';

let server: http.Server;
let url = '';
/** Server-side sockets per room, in join order. */
const sockets = new Map<string, WebSocket[]>();
/** Content updates (sync message, type 2) each room received, by time. */
const updates = new Map<string, number[]>();

beforeAll(async () => {
  server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const room = decodeURIComponent(u.pathname.replace(/^\/ws\//, ''));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const list = sockets.get(room) ?? [];
      list.push(ws);
      sockets.set(room, list);
      ws.on('message', (d: Buffer) => {
        if (d[0] === 0 && d[1] === 2) updates.set(room, [...(updates.get(room) ?? []), Date.now()]);
      });
      getRoom(room).join(ws, devIdentity(u.searchParams));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  (globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;
});
afterAll(() => server.close());

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function client(room: string, backoffMs: number) {
  const ydoc = new Y.Doc();
  const ledger = new Y.Doc();
  const conn = new Connection(ydoc, { wsUrl: url, room, params: { devUser: 'Ana' }, devIdentity: null, rateLimitBackoffMs: backoffMs }, ledger);
  const statuses: string[] = [];
  conn.onStatus((s) => statuses.push(s));
  const notices: string[] = [];
  conn.onNotice((n) => notices.push(n.kind));
  return { conn, doc: new CanvasDoc(ydoc, ledger), statuses, notices };
}

/** What the canvas server does on an empty message bucket: NOTICE rate-limited, then close 4429. */
function rateLimit(room: string, i: number) {
  const ws = sockets.get(room)![i];
  ws.send(encodeNotice({ kind: 'rate-limited' }));
  ws.close(4429, 'rate limited');
}

describe('local edits on the wire', () => {
  it('a burst of edits is merged into a few messages; the room gets the final state', async () => {
    const room = 'batch-1';
    const a = client(room, 300);
    await until(() => a.conn.status === 'synced');
    const id = a.doc.create({ type: 'note', x: 0, y: 0, w: 100, h: 100, text: '' } as never);
    await until(() => getRoom(room).doc.getMap('shapes').has(id));
    const before = updates.get(room)?.length ?? 0;
    // 200 edits, one every 2 ms (a 500 Hz pointer): the tab's document has each at once
    for (let i = 1; i <= 200; i++) {
      a.doc.update(id, { x: i });
      expect(a.doc.get(id)?.x).toBe(i);
      await new Promise((r) => setTimeout(r, 2));
    }
    await until(() => (getRoom(room).doc.getMap('shapes').get(id) as Y.Map<unknown> | undefined)?.get('x') === 200);
    const sent = (updates.get(room)?.length ?? 0) - before;
    // ~0.4 s or more of edits at 30 messages/s, not 200 messages
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(40);
    a.conn.destroy();
  });
});

describe('4429: wait, then join again', () => {
  it('the backoff starts at 2 s and doubles per 4429 in a row, up to 30 s', () => {
    expect(RATE_LIMIT_BACKOFF.firstMs).toBe(2000);
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => rateLimitDelay(n))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('a 4429 leaves the tab editable ("disconnected", never "closed"), rejoins after the backoff and delivers the edits made while waiting', async () => {
    const room = 'rl-1';
    const a = client(room, 300);
    await until(() => a.conn.status === 'synced');
    a.doc.create({ type: 'geo', geo: 'rectangle', id: 'before' } as never);
    await until(() => getRoom(room).doc.getMap('shapes').has('before'));

    const closedAt = Date.now();
    rateLimit(room, 0);
    await until(() => a.conn.closeCode === 4429);
    expect(a.notices).toContain('rate-limited');
    expect(a.conn.status).toBe('disconnected');
    expect(a.conn.rateLimitedCloses).toBe(1);
    expect(a.conn.retryAt).not.toBeNull();
    // an edit while waiting stays in the tab and goes out with the next join
    a.doc.create({ type: 'geo', geo: 'rectangle', id: 'waiting' } as never);
    expect(sockets.get(room)!.length).toBe(1);

    await until(() => a.conn.status === 'synced' && sockets.get(room)!.length === 2);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(300);
    expect(a.conn.retryAt).toBeNull();
    await until(() => getRoom(room).doc.getMap('shapes').has('waiting'));
    expect(a.statuses).not.toContain('closed');

    // a second 4429 in a row waits twice as long
    const second = Date.now();
    rateLimit(room, 1);
    await until(() => a.conn.rateLimitedCloses === 2);
    expect(a.conn.retryAt! - second).toBeGreaterThanOrEqual(2 * 300 - 50);
    await until(() => a.conn.status === 'synced' && sockets.get(room)!.length === 3);
    expect(Date.now() - second).toBeGreaterThanOrEqual(600);
    a.conn.destroy();
  });

  it('every other 44xx close stays final: 4403 leaves the tab closed and never rejoins', async () => {
    const room = 'rl-2';
    const a = client(room, 100);
    await until(() => a.conn.status === 'synced');
    sockets.get(room)![0].close(4403, 'forbidden');
    await until(() => a.conn.status === 'closed');
    expect(a.conn.closeCode).toBe(4403);
    await new Promise((r) => setTimeout(r, 600));
    expect(sockets.get(room)!.length).toBe(1);
    expect(a.conn.status).toBe('closed');
    expect(a.conn.retryAt).toBeNull();
    a.conn.destroy();
  });

  it('destroy() while waiting cancels the rejoin', async () => {
    const room = 'rl-3';
    const a = client(room, 300);
    await until(() => a.conn.status === 'synced');
    rateLimit(room, 0);
    await until(() => a.conn.closeCode === 4429);
    a.conn.destroy();
    await new Promise((r) => setTimeout(r, 900));
    expect(sockets.get(room)!.length).toBe(1);
  });
});
