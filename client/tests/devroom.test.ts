import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import WebSocket, { WebSocketServer } from 'ws';
import { devIdentity, getRoom } from '../dev/yroom';
import { Connection } from '../src/collab/connection';
import { CanvasDoc } from '../src/model/doc';
import { MSG_IDENTITY } from '../src/collab/protocol';

let server: http.Server;
let url = '';

beforeAll(async () => {
  server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const room = decodeURIComponent(u.pathname.replace(/^\/ws\//, ''));
    wss.handleUpgrade(req, socket, head, (ws) => getRoom(room).join(ws, devIdentity(u.searchParams)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  (globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;
});
afterAll(() => server.close());

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function client(room: string, devUser: string) {
  const ydoc = new Y.Doc();
  const conn = new Connection(ydoc, { wsUrl: url, room, params: { devUser }, devIdentity: null });
  return { ydoc, conn, doc: new CanvasDoc(ydoc) };
}

describe('reference dev room (docs/protocol.md)', () => {
  it('sends IDENTITY first, then syncs', async () => {
    const first = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/r0?devUser=Ana`);
      ws.binaryType = 'arraybuffer';
      ws.once('message', (d: ArrayBuffer) => {
        resolve(decoding.readVarUint(decoding.createDecoder(new Uint8Array(d))));
        ws.close();
      });
    });
    expect(first).toBe(MSG_IDENTITY);
  });

  it('stamps attribution server-side with the connection identity', async () => {
    const a = client('r1', 'Ana López');
    const b = client('r1', 'Bea Gil');
    await until(() => a.conn.status === 'synced' && b.conn.status === 'synced' && !!a.conn.identity && !!b.conn.identity);
    expect(a.conn.identity).toMatchObject({ id: 'dev:Ana López', name: 'Ana López', attribution: 'server' });
    const id = a.doc.create({ type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 } as never);
    await until(() => !!b.doc.attributionOf(id));
    expect(b.doc.attributionOf(id)?.createdBy).toBe('dev:Ana López');
    expect(b.doc.user('dev:Ana López')?.name).toBe('Ana López');
    b.doc.update(id, { x: 50 });
    await until(() => a.doc.attributionOf(id)?.updatedBy === 'dev:Bea Gil');
    a.conn.destroy();
    b.conn.destroy();
  });

  it('closes a connection that forges attribution (4403) and leaves the room intact', async () => {
    const a = client('r2', 'Mallory');
    await until(() => a.conn.status === 'synced');
    a.ydoc.getMap('attribution').set('x', { createdBy: 'dev:Someone Else', createdAt: 0, updatedBy: '', updatedAt: 0 });
    await until(() => a.conn.status === 'closed');
    expect(a.conn.closeCode).toBe(4403);
    expect(getRoom('r2').doc.getMap('attribution').has('x')).toBe(false);
    a.conn.destroy();
  });

  it('forces the awareness user to the verified identity', async () => {
    const a = client('r3', 'Ana López');
    const b = client('r3', 'Bea Gil');
    await until(() => a.conn.status === 'synced' && b.conn.status === 'synced');
    a.conn.awareness.setLocalState({ user: { id: 'dev:CEO', name: 'The CEO', color: '#000000', anonymous: false }, cursor: { x: 1, y: 2 } });
    await until(() => [...b.conn.awareness.getStates().values()].some((s) => (s as { cursor?: unknown }).cursor));
    const st = [...b.conn.awareness.getStates().values()].find((s) => (s as { cursor?: unknown }).cursor) as { user: { id: string; name: string } };
    expect(st.user).toMatchObject({ id: 'dev:Ana López', name: 'Ana López' });
    a.conn.destroy();
    b.conn.destroy();
  });

  it('anonymous visitors get the pseudonym they keep in their browser', () => {
    expect(devIdentity(new URLSearchParams('anon=4821'))).toMatchObject({ id: 'anon:4821', name: 'Anónimo 4821', anonymous: true });
    expect(devIdentity(new URLSearchParams('anon=../../x')).id).toMatch(/^anon:\d{4}$/);
  });
});
