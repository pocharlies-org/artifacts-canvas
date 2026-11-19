/**
 * Awareness on the wire (collab/connection.ts sendOwnAwarenessOnly), against the reference dev room
 * (dev/yroom.ts) through a real WebSocket server: a tab sends its own state and nothing else.
 * y-websocket 3.1.0 sends every awareness update event, the ones a remote state fires included, so
 * every tab used to send every other tab's states back: wire traffic grew with the square of the
 * room, and a presentation of 10 tabs closed every tab 4429. Plus the y-websocket pin the wrapper
 * depends on, and the presence patch that changes nothing (collab/presence.ts setPresence).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocket, { WebSocketServer } from 'ws';
import { devIdentity, getRoom } from '../dev/yroom';
import { Connection } from '../src/collab/connection';
import { setPresence } from '../src/collab/presence';

let server: http.Server;
let url = '';
/** Server-side sockets per room, in join order. */
const sockets = new Map<string, WebSocket[]>();

beforeAll(async () => {
  server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const room = decodeURIComponent(u.pathname.replace(/^\/ws\//, ''));
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(room, [...(sockets.get(room) ?? []), ws]);
      getRoom(room).join(ws, devIdentity(u.searchParams));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
afterAll(() => server.close());

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry {
  id: number;
  clock: number;
  state: unknown;
}
function entries(update: Uint8Array): Entry[] {
  const dec = decoding.createDecoder(update);
  const out: Entry[] = [];
  for (let n = decoding.readVarUint(dec); n > 0; n--) {
    const id = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    out.push({ id, clock, state: JSON.parse(decoding.readVarString(dec)) });
  }
  return out;
}

/** A tab: the canvas Connection over a WebSocket that records every awareness message it sends. */
function tab(room: string, user: string) {
  const sent: Entry[][] = [];
  class Recording extends WebSocket {
    override send(data: unknown, ...rest: unknown[]) {
      const b = new Uint8Array(data as ArrayBuffer);
      if (b[0] === 1) {
        const dec = decoding.createDecoder(b);
        decoding.readVarUint(dec);
        sent.push(entries(decoding.readVarUint8Array(dec)));
      }
      return (super.send as (...a: unknown[]) => void)(data, ...rest);
    }
  }
  const conn = new Connection(new Y.Doc(), { wsUrl: url, room, params: { devUser: user }, devIdentity: null, WebSocketPolyfill: Recording as unknown as typeof globalThis.WebSocket }, new Y.Doc());
  return { conn, aw: conn.awareness, sent, foreign: () => sent.filter((m) => m.some((e) => e.id !== conn.awareness.clientID)) };
}

describe('a tab sends its own awareness state, never the others\'', () => {
  it('three tabs, one moving its cursor: the others send nothing of it back', async () => {
    const room = 'aw-own-1';
    const [a, b, c] = [tab(room, 'Ana'), tab(room, 'Bob'), tab(room, 'Eve')];
    await until(() => [a, b, c].every((t) => t.conn.status === 'synced'));
    for (const t of [a, b, c]) setPresence(t.aw, { user: { id: t.aw.clientID.toString(), name: 'x', color: '#000000', anonymous: false } });
    await until(() => [b, c].every((t) => t.aw.getStates().size === 3) && a.aw.getStates().size === 3);
    const before = [a, b, c].map((t) => t.sent.length);
    for (let i = 1; i <= 20; i++) {
      setPresence(a.aw, { cursor: { x: i, y: i } });
      await sleep(5);
    }
    const last = (t: ReturnType<typeof tab>) => (t.aw.getStates().get(a.aw.clientID) as { cursor?: { x: number } } | undefined)?.cursor?.x === 20;
    await until(() => last(b) && last(c));
    await sleep(200);
    expect(a.sent.length - before[0]).toBe(20);
    // before: b and c each sent the 20 updates of a back (y-websocket's own awareness handler)
    expect(b.sent.length - before[1]).toBe(0);
    expect(c.sent.length - before[2]).toBe(0);
    expect([a, b, c].flatMap((t) => t.foreign())).toEqual([]);
    for (const t of [a, b, c]) t.conn.destroy();
  });

  it('a remote removal of this tab\'s state is answered with its state at a higher clock (it stays visible)', async () => {
    const room = 'aw-own-2';
    const a = tab(room, 'Ana');
    const b = tab(room, 'Bob');
    await until(() => a.conn.status === 'synced' && b.conn.status === 'synced');
    setPresence(a.aw, { cursor: { x: 1, y: 1 } });
    await until(() => b.aw.getStates().has(a.aw.clientID));
    const clock = a.aw.meta.get(a.aw.clientID)!.clock;
    const n = a.sent.length;
    // what a server that timed the tab out sends: its state removed, at the clock it last saw
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    const u = encoding.createEncoder();
    encoding.writeVarUint(u, 1);
    encoding.writeVarUint(u, a.aw.clientID);
    encoding.writeVarUint(u, clock);
    encoding.writeVarString(u, 'null');
    encoding.writeVarUint8Array(e, encoding.toUint8Array(u));
    sockets.get(room)![0].send(encoding.toUint8Array(e));
    await until(() => a.sent.length > n);
    expect(a.sent[n]).toEqual([{ id: a.aw.clientID, clock: clock + 1, state: a.aw.getLocalState() }]);
    expect(a.foreign()).toEqual([]);
    for (const t of [a, b]) t.conn.destroy();
  });

  it('QUERY_AWARENESS is answered with this tab\'s state only', async () => {
    const room = 'aw-own-3';
    const a = tab(room, 'Ana');
    const b = tab(room, 'Bob');
    await until(() => a.conn.status === 'synced' && b.conn.status === 'synced');
    setPresence(a.aw, { cursor: { x: 1, y: 1 } });
    setPresence(b.aw, { cursor: { x: 2, y: 2 } });
    await until(() => b.aw.getStates().has(a.aw.clientID) && a.aw.getStates().has(b.aw.clientID));
    const n = b.sent.length;
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, 3);
    sockets.get(room)![1].send(encoding.toUint8Array(q));
    await until(() => b.sent.length > n);
    expect(b.sent[n].map((x) => x.id)).toEqual([b.aw.clientID]);
    expect(b.foreign()).toEqual([]);
    for (const t of [a, b]) t.conn.destroy();
  });
});

describe('the y-websocket pin of sendOwnAwarenessOnly', () => {
  it('y-websocket is 3.1.0 and its provider still has _awarenessUpdateHandler (re-check connection.ts on a bump)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lock = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    const versions = Object.entries(lock.packages).filter(([k]) => k.endsWith('node_modules/y-websocket')).map(([, v]) => v.version);
    expect(new Set(versions)).toEqual(new Set(['3.1.0']));
    const p = new WebsocketProvider('ws://127.0.0.1:1', 'pin', new Y.Doc(), { connect: false, WebSocketPolyfill: WebSocket as never, disableBc: true });
    expect(typeof (p as unknown as { _awarenessUpdateHandler: unknown })._awarenessUpdateHandler).toBe('function');
    p.destroy();
  });
});

describe('setPresence', () => {
  it('a patch that changes nothing is not set (no clock raised, nothing sent); a change is', () => {
    const aw = new awarenessProtocol.Awareness(new Y.Doc());
    const updates: number[] = [];
    aw.on('update', () => updates.push(aw.meta.get(aw.clientID)!.clock));
    expect(setPresence(aw, { viewport: { x: 0, y: 0, w: 10, h: 10 }, cursor: null })).toBe(true);
    expect(setPresence(aw, { viewport: { x: 0, y: 0, w: 10, h: 10 } })).toBe(false);
    expect(setPresence(aw, { cursor: null })).toBe(false);
    expect(setPresence(aw, { viewport: { x: 0, y: 1, w: 10, h: 10 } })).toBe(true);
    expect(setPresence(aw, { laser: null })).toBe(true); // a field it did not have yet
    expect(updates).toEqual([1, 2, 3]);
    aw.destroy();
  });
});
