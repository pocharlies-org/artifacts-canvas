/**
 * Honest-edit fuzzer (fifth verification, fv5 M-1/M-2): 2-3 tabs of real clients edit one
 * room through the REAL server code, and no honest update may ever be refused.
 *
 * Every tab is a client `CanvasDoc` (client/src/model/doc.ts, with its UndoManager) synced by
 * a REAL y-websocket provider — either the canvas client's `Connection` (client/src/collab/
 * connection.ts, which holds local sends until it answered the server's step 1) or a stock
 * `WebsocketProvider` (y-websocket's own send order: local updates go out as soon as the
 * socket is open) — over an in-memory socket. The server side is the real `WsServer.join` /
 * message handler of server/src/ws.ts on a real `RoomManager` (guard, applyGuarded, writer
 * bindings, the stamper, broadcasts, persistence to an in-memory store, eviction and reload).
 *
 * Tabs make random valid edits (every shape type, moves, resizes, typing, big pastes,
 * select-all-and-type, strokes, arrows bound to shapes, images, groups, z-order, styles,
 * locks, deletes, undo/redo), go offline (in-flight messages lost both ways) and reconnect,
 * and messages are delivered in random interleavings (FIFO per direction, like TCP). Several
 * tabs may grow the same text concurrently only up to MAX_TEXT_LENGTH together — typing,
 * pastes and undo/redo alike (a merge over the cap is a real conflict the server refuses by
 * design: see docs/protocol.md §11).
 *
 * Oracle: the server closes no tab (no 4403/4413/4429/1003/1011), and once everything is
 * delivered every tab equals the room. `updates` counts the client sync messages that carried
 * document changes (update / step 2) the server processed.
 *
 *   npx tsx server/test/fuzz/honest-fuzz.ts [runs=200] [seed=1] [steps=400] [mode=both|client|ywebsocket]
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import { loadConfig } from '../../src/config.js';
import { WsServer } from '../../src/ws.js';
import { RoomManager } from '../../src/rooms.js';
import { MemoryCanvasObjectStore } from '../../src/store.js';
import { createLogger } from '../../src/logging.js';
import { Metrics } from '../../src/metrics.js';
import type { AuthzClient } from '../../src/authz.js';
import { MAX_TEXT_LENGTH, GEO_KINDS } from '@pocharlies/artifacts-canvas-shared/model';
import { CanvasDoc } from '../../../client/src/model/doc';
import { Connection } from '../../../client/src/collab/connection';

export type HonestMode = 'client' | 'ywebsocket';

export interface HonestResult {
  seed: number;
  mode: HonestMode;
  runs: number;
  steps: number;
  /** client sync messages with document changes the server processed */
  updates: number;
  reconnects: number;
  /** server closes of a tab (anything but our own disconnects) */
  refused: number;
  diverged: number;
  /** server step-1 requests answering a pending update (server-side resync, fv5 M-2) */
  resyncs: number;
  refusals: Record<string, { n: number; example: string }>;
  ops: Record<string, number>;
  ms: number;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const COLORS = ['black', 'red', 'blue', 'green'];
const KEY = 'u/honest/index.html';

/** Server end of an in-memory socket: the API of `ws` that ws.ts uses. */
class ServerSock extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  constructor(private readonly link: Link) {
    super();
  }
  send(msg: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.link.s2c.push(msg.slice());
  }
  ping(): void {
    queueMicrotask(() => this.emit('pong'));
  }
  pause(): void {}
  resume(): void {}
  close(code = 1005, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.link.serverClose = { code, reason };
    this.emit('close', code);
  }
  terminate(): void {
    this.close(1006, 'terminated');
  }
}

/** Client end: the browser WebSocket API y-websocket uses (passed as WebSocketPolyfill). */
class ClientSock {
  static connecting: Link | null = null;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly link: Link;
  constructor() {
    // a socket y-websocket opens by itself (its reconnect timer) goes nowhere
    this.link = ClientSock.connecting ?? { client: null, server: null, c2s: [], s2c: [], serverClose: null, dead: true };
    this.link.client = this;
  }
  send(buf: Uint8Array | ArrayBuffer): void {
    if (this.readyState !== 1) return;
    this.link.c2s.push(new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.slice()));
  }
  close(): void {
    this.readyState = 3;
  }
}

/** One connection attempt of a tab: both ends and the two FIFO queues between them. */
interface Link {
  client: ClientSock | null;
  server: ServerSock | null;
  c2s: Uint8Array[];
  s2c: Uint8Array[];
  serverClose: { code: number; reason: string } | null;
  dead: boolean;
  /** the last client message the server processed (dumped with HONEST_DUMP=<dir>) */
  last?: Uint8Array;
}

interface Tab {
  name: string;
  principal: string;
  cd: CanvasDoc;
  provider: WebsocketProvider;
  conn: Connection | null;
  link: Link | null;
  online: boolean;
}

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const view = (d: Y.Doc) => JSON.stringify(canon({ shapes: d.getMap('shapes').toJSON(), assets: d.getMap('assets').toJSON(), meta: d.getMap('meta').toJSON() }));
const tick = () => new Promise<void>((r) => setImmediate(r));

export async function runHonestFuzz(runs: number, seed: number, steps = 400, mode: HonestMode = 'client'): Promise<HonestResult> {
  const rnd = lcg(seed * 2654435761 + (mode === 'client' ? 1 : 2));
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const res: HonestResult = { seed, mode, runs: 0, steps: 0, updates: 0, reconnects: 0, refused: 0, diverged: 0, resyncs: 0, refusals: {}, ops: {}, ms: 0 };
  const t0 = Date.now();
  const cfg = loadConfig({
    GATE_AUTHZ_URL: 'http://core.invalid/authz', ARTIFACT_BASE_URL: 'http://core.invalid/a', S3_BUCKET: 'canvas-fuzz',
    LOG_LEVEL: 'silent', METRICS_PORT: '0', AUTHZ_RECHECK_SECONDS: '1000000', SAVE_DEBOUNCE_MS: '1000000',
    // honest-edit semantics only: no rate or CPU limit may close a tab driven this fast
    MSG_RATE_PER_SEC: '1000000000', MSG_BURST: '1000000000', CPU_MS_PER_SEC: '1000000000', CPU_BURST_MS: '1000000000',
    CPU_TOTAL_MS_PER_SEC: '1000000000', CPU_TOTAL_BURST_MS: '1000000000', SYNC_BYTES_PER_SEC: '1000000000', SYNC_BURST_BYTES: '1000000000',
    JOIN_RATE_PER_MIN: '1000000000', JOIN_BURST: '1000000000', WS_PING_INTERVAL_MS: '1000000',
  });
  const log = createLogger('silent');
  const metrics = new Metrics();
  const authz = { authorize: async () => ({ allowed: true, reason: 'ok' }) } as unknown as AuthzClient;

  for (let r = 0; r < runs; r++) {
    const store = new MemoryCanvasObjectStore();
    const manager = new RoomManager({ cfg, store, authz, log, metrics });
    const server = new WsServer({ cfg, authz, manager, log, metrics });
    const srv = server as unknown as {
      join(ws: unknown, key: string, cookie: string, auth: string, id: unknown, anon: null, ttl: null, principal: string): Promise<void>;
    };
    const resyncs0 = (await metrics.pendingResync.get()).values[0]?.value ?? 0;
    const trace: string[] = [];
    /** with HONEST_DUMP: every update each document integrated, in order (divergence analysis) */
    const logs = new Map<string, Uint8Array[]>();
    const logDoc = (name: string, d: Y.Doc, initial?: Uint8Array) => {
      if (!process.env.HONEST_DUMP) return;
      const l = logs.get(name) ?? [];
      logs.set(name, l);
      if (initial) l.push(initial);
      d.on('update', (u: Uint8Array) => l.push(u));
    };
    let loggedRoom: unknown = null;
    const watchRoom = () => {
      const room = manager.get(KEY);
      if (room && room !== loggedRoom) {
        loggedRoom = room;
        logDoc(`room${logs.size}`, room.doc, Y.encodeStateAsUpdate(room.doc));
      }
    };
    let runRefused = false;
    const nTabs = 2 + Math.floor(rnd() * 2);
    const principals = ['ana@corp', 'bob@corp', 'ana@corp']; // the third tab is Ana's second tab
    const tabs: Tab[] = [];

    const connect = async (t: Tab) => {
      const link: Link = { client: null, server: null, c2s: [], s2c: [], serverClose: null, dead: false };
      t.link = link;
      ClientSock.connecting = link;
      t.provider.connect(); // y-websocket creates the socket (ClientSock) now
      ClientSock.connecting = null;
      if (!link.client) throw new Error('provider did not open a socket');
      const sock = new ServerSock(link);
      link.server = sock;
      sock.once('close', () => {
        const c = link.serverClose;
        if (!link.dead && c) {
          // the server closed an honest tab
          res.refused++;
          runRefused = true;
          const k = `${c.code} ${c.reason}`;
          res.refusals[k] ??= { n: 0, example: `seed ${seed} mode ${mode} run ${r}: ${trace.slice(-14).join(' | ')}` };
          res.refusals[k].n++;
          const dir = process.env.HONEST_DUMP;
          if (dir && link.last) {
            // the update the server refused, the room before it, the trace
            const room = manager.get(KEY);
            fs.mkdirSync(dir, { recursive: true });
            const tag = `${mode}-${seed}-${r}`;
            fs.writeFileSync(path.join(dir, `${tag}.msg`), link.last);
            if (room) fs.writeFileSync(path.join(dir, `${tag}.room`), Y.encodeStateAsUpdate(room.doc));
            fs.writeFileSync(path.join(dir, `${tag}.trace`), trace.join('\n'));
          }
        }
      });
      const identity = { id: t.principal, name: t.principal, anonymous: false, attribution: 'server' };
      void srv.join(sock, KEY, '', '', identity, null, null, `u:${t.principal}`);
      // the TCP handshake completed: the client side is open (y-websocket sends its step 1)
      link.client.readyState = 1;
      link.client.onopen?.();
      t.online = true;
      res.reconnects++;
      await tick();
    };
    const disconnect = (t: Tab) => {
      const link = t.link;
      if (!link) return;
      link.dead = true; // in-flight messages are lost both ways
      link.c2s.length = 0;
      link.s2c.length = 0;
      link.server?.close(1006, 'network');
      if (link.client) link.client.readyState = 3;
      t.provider.disconnect();
      t.online = false;
      t.link = null;
    };
    /** one client -> server message (only once join() listens: ws.ts pauses the socket until then) */
    const toServer = (t: Tab): boolean => {
      const link = t.link;
      if (!link || !link.server || link.server.readyState !== 1 || !link.c2s.length) return false;
      if (link.server.listenerCount('message') === 0) return false;
      const m = link.c2s.shift()!;
      const d = decoding.createDecoder(m);
      if (decoding.readVarUint(d) === 0 && decoding.readVarUint(d) !== 0) res.updates++;
      link.last = m;
      watchRoom();
      link.server.emit('message', Buffer.from(m));
      return true;
    };
    /** one server -> client message */
    const toClient = (t: Tab): boolean => {
      const link = t.link;
      if (!link || !link.client || link.client.readyState !== 1 || !link.s2c.length) return false;
      const m = link.s2c.shift()!;
      watchRoom();
      link.client.onmessage?.({ data: m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer });
      return true;
    };
    /** the server closed this tab: deliver the close to the client */
    const serverClosed = (t: Tab): boolean => {
      const link = t.link;
      if (!link || link.dead || !link.serverClose || link.s2c.length) return false;
      link.dead = true;
      if (link.client) {
        link.client.readyState = 3;
        link.client.onclose?.({ code: link.serverClose.code, reason: link.serverClose.reason });
      }
      t.provider.disconnect(); // reconnects are driven by the fuzzer
      t.online = false;
      t.link = null;
      return true;
    };

    for (let i = 0; i < nTabs; i++) {
      const doc = new Y.Doc();
      const cd = new CanvasDoc(doc, new Y.Doc());
      const t = { name: `t${i}`, principal: principals[i], cd, online: false, link: null } as unknown as Tab;
      ClientSock.connecting = { client: null, server: null, c2s: [], s2c: [], serverClose: null, dead: true };
      if (mode === 'client') {
        t.conn = new Connection(doc, { wsUrl: 'ws://fuzz', room: 'r', params: {}, devIdentity: null, WebSocketPolyfill: ClientSock as unknown as typeof WebSocket });
        t.provider = t.conn.provider;
      } else {
        t.conn = null;
        t.provider = new WebsocketProvider('ws://fuzz', 'r', doc, { disableBc: true, WebSocketPolyfill: ClientSock as unknown as typeof WebSocket });
        // the canvas messages (identity, notice, ledger) are not y-websocket's: ignore them quietly
        for (const k of [100, 101, 102]) t.provider.messageHandlers[k] = () => undefined;
      }
      ClientSock.connecting = null;
      t.provider.disconnect(); // the constructor connected to the placeholder link: start offline
      logDoc(t.name, doc);
      tabs.push(t);
    }
    for (const t of tabs) await connect(t);

    /**
     * Characters a tab may add to a text so that the room's text never passes the cap: a
     * character alive in the room, or in any tab, is counted (the room can hold characters a
     * tab already deleted offline), so room + every tab's own text bounds every state the room
     * can reach. The room is the live one, or the last one loaded (evicted rooms keep their doc).
     */
    let roomDoc: Y.Doc | null = null;
    const roomText = (id: string) => {
      roomDoc = manager.get(KEY)?.doc ?? roomDoc;
      return (((roomDoc?.getMap('shapes').get(id) as Y.Map<unknown> | undefined)?.get('text') as Y.Text | undefined)?.length ?? 0);
    };
    const textBudget = (_t: Tab, id: string) => {
      let sum = roomText(id);
      for (const o of tabs) sum += ((o.cd.get(id) as { text?: string } | undefined)?.text ?? '').length;
      return MAX_TEXT_LENGTH - sum;
    };
    /** some text is longer, summed over the room and the tabs, than the cap (an undo/redo brought it back) */
    const overBudget = () => {
      const sum = new Map<string, number>();
      for (const o of tabs) {
        for (const id of o.cd.ids()) {
          const n = ((o.cd.get(id) as { text?: string } | undefined)?.text ?? '').length;
          if (n) sum.set(id, (sum.get(id) ?? roomText(id)) + n);
        }
      }
      for (const n of sum.values()) if (n > MAX_TEXT_LENGTH) return true;
      return false;
    };
    const ids = (t: Tab) => t.cd.ids().filter((id) => t.cd.get(id));
    const texty = (t: Tab) => ids(t).filter((id) => ['note', 'text', 'geo'].includes(t.cd.get(id)!.type));
    const ops: [string, number, (t: Tab) => void][] = [
      ['create-geo', 8, (t) => t.cd.create({ type: 'geo', geo: pick(GEO_KINDS), x: rnd() * 800, y: rnd() * 600, w: 20 + rnd() * 200, h: 20 + rnd() * 200, text: rnd() < 0.3 ? 'g' : '' } as never)],
      ['create-note', 5, (t) => t.cd.create({ type: 'note', x: rnd() * 800, y: rnd() * 600, w: 200, h: 200, text: '' } as never)],
      ['create-text', 4, (t) => t.cd.create({ type: 'text', x: rnd() * 800, y: rnd() * 600, w: 50, h: 30, text: 'hi' } as never)],
      ['create-frame', 2, (t) => t.cd.create({ type: 'frame', x: rnd() * 800, y: rnd() * 600, w: 300, h: 200, name: 'F' } as never)],
      ['stroke', 6, (t) => {
        const id = t.cd.create({ type: 'draw', x: rnd() * 800, y: rnd() * 600, w: 1, h: 1, points: [0, 0, 0.5] } as never);
        const n = 1 + Math.floor(rnd() * 8);
        for (let i = 0; i < n; i++) t.cd.appendPoints(id, [i, i * 2, 0.5, i + 1, i * 2 + 1, 0.5]);
        t.cd.update(id, { w: 10 + n, h: 10 + n } as never);
        t.cd.endGesture();
      }],
      ['arrow', 4, (t) => {
        const live = ids(t).filter((id) => !['arrow', 'line'].includes(t.cd.get(id)!.type));
        const a = live.length ? pick(live) : null;
        const b = live.length ? pick(live) : null;
        t.cd.create({ type: pick(['arrow', 'line']), x: 0, y: 0, w: 0, h: 0, start: a ? { x: 1, y: 1, bind: { shapeId: a, nx: 0.5, ny: 0.5 } } : { x: 1, y: 1 }, end: b ? { x: 99, y: 99, bind: { shapeId: b, nx: 0.2, ny: 0.8 } } : { x: 99, y: 99 } } as never);
      }],
      ['image', 2, (t) => {
        const aid = `a${Math.floor(rnd() * 1e9)}`;
        t.cd.setAsset(aid, PNG);
        t.cd.create({ type: 'image', assetId: aid, x: rnd() * 800, y: rnd() * 600, w: 40, h: 40 } as never);
      }],
      ['move', 14, (t) => {
        const l = ids(t);
        if (!l.length) return;
        const p = new Map<string, Record<string, unknown>>();
        for (let i = 0; i < 1 + Math.floor(rnd() * Math.min(4, l.length)); i++) {
          const id = pick(l);
          const sh = t.cd.get(id)! as unknown as Record<string, { x: number; y: number }> & { type: string; x: number; y: number };
          if (sh.type === 'arrow' || sh.type === 'line') p.set(id, { start: { x: sh.start.x + 5, y: sh.start.y }, end: { x: sh.end.x + 5, y: sh.end.y } });
          else p.set(id, { x: sh.x + rnd() * 20 - 10, y: sh.y + rnd() * 20 - 10 });
        }
        t.cd.updateMany(p);
      }],
      ['resize', 6, (t) => {
        const l = ids(t);
        if (l.length) t.cd.update(pick(l), { w: 10 + rnd() * 300, h: 10 + rnd() * 300, rotation: rnd() < 0.2 ? rnd() * 3 : 0 } as never);
      }],
      ['type', 14, (t) => {
        const l = texty(t);
        if (!l.length) return;
        const id = pick(l);
        const cur = (t.cd.get(id) as unknown as { text: string }).text;
        const pos = Math.floor(rnd() * (cur.length + 1));
        const x = rnd();
        const add = x < 0.5 ? pick(['a', 'b ', 'ñ', '😀', '\n', 'hello ']) : x < 0.8 ? '' : 'replaced';
        if (add.length > textBudget(t, id)) return;
        const next = x < 0.5 ? cur.slice(0, pos) + add + cur.slice(pos) : x < 0.8 ? cur.slice(0, pos) + cur.slice(pos + 1 + Math.floor(rnd() * 5)) : cur.slice(0, pos) + add + cur.slice(Math.min(cur.length, pos + 10));
        t.cd.update(id, { text: next } as never);
      }],
      ['paste-big', 2, (t) => {
        const l = texty(t);
        if (!l.length) return;
        const id = pick(l);
        const cur = (t.cd.get(id) as unknown as { text: string }).text;
        const n = Math.floor(rnd() * Math.min(textBudget(t, id), 6000));
        if (n <= 0) return;
        t.cd.update(id, { text: cur + 'p'.repeat(n) } as never);
        t.cd.endGesture();
      }],
      ['select-all-text', 2, (t) => {
        const l = texty(t);
        if (!l.length) return;
        const id = pick(l);
        const next = rnd() < 0.5 ? '' : 'new text';
        if (next.length <= textBudget(t, id)) t.cd.update(id, { text: next } as never);
      }],
      ['style', 4, (t) => {
        const l = ids(t);
        if (l.length) t.cd.setStyle([pick(l)], { color: pick(COLORS) } as never);
      }],
      ['zorder', 3, (t) => {
        const l = ids(t);
        if (!l.length) return;
        if (rnd() < 0.5) t.cd.bringToFront([pick(l)]);
        else t.cd.sendToBack([pick(l)]);
      }],
      ['group', 2, (t) => {
        const l = ids(t);
        if (l.length < 2) return;
        if (rnd() < 0.6) t.cd.group([pick(l), pick(l)]);
        else t.cd.ungroup([pick(l)]);
      }],
      ['lock', 1, (t) => {
        const l = ids(t);
        if (l.length) t.cd.setLocked([pick(l)], rnd() < 0.5);
      }],
      ['delete', 7, (t) => {
        const l = ids(t);
        if (l.length) t.cd.delete(t.cd.expandGroups([pick(l)]));
      }],
      ['gesture-end', 8, (t) => t.cd.endGesture()],
      ['undo', 9, (t) => {
        t.cd.endGesture();
        t.cd.undo();
        // an undo can bring back text another tab has meanwhile filled up: take it back
        // (redo) when the texts of all tabs together would pass the cap (see textBudget)
        if (overBudget()) t.cd.redo();
      }],
      ['redo', 5, (t) => {
        t.cd.endGesture();
        t.cd.redo();
        if (overBudget()) t.cd.undo();
      }],
      ['page-width', 1, (t) => t.cd.ensurePageWidth(1200)],
    ];
    const total = ops.reduce((a, o) => a + o[1], 0);
    const doOp = (t: Tab) => {
      let x = rnd() * total;
      for (const [name, w, f] of ops) {
        if ((x -= w) < 0) {
          res.ops[name] = (res.ops[name] ?? 0) + 1;
          trace.push(`${t.name}:${name}${t.online ? '' : '(offline)'}`);
          f(t);
          return;
        }
      }
    };

    for (let step = 0; step < steps && !runRefused; step++) {
      res.steps++;
      const t = pick(tabs);
      const x = rnd();
      if (x < 0.36) doOp(t);
      else if (x < 0.6) toServer(t);
      else if (x < 0.86) {
        if (!toClient(t)) serverClosed(t);
      } else if (x < 0.93) {
        if (t.online) {
          trace.push(`${t.name}:offline`);
          disconnect(t);
        }
      } else if (!t.online) {
        trace.push(`${t.name}:reconnect`);
        await connect(t);
      }
      if (step % 16 === 0) await tick();
    }
    // drain: everyone online, deliver everything
    for (const t of tabs) {
      t.cd.endGesture();
      if (!t.online && !runRefused) await connect(t);
    }
    for (let round = 0; round < 100_000 && !runRefused; round++) {
      let moved = false;
      for (const t of tabs) {
        while (toClient(t)) moved = true;
        if (serverClosed(t)) moved = true;
        while (toServer(t)) moved = true;
      }
      await tick();
      // done when every tab is online, its server connection finished joining (join() awaits
      // the room load: on a busy host that takes more than one tick), and nothing is in flight
      const settled = () => {
        const conns = [...(manager.get(KEY)?.conns.values() ?? [])];
        return tabs.every((t) => t.link && t.link.server && conns.some((c) => c.ws === (t.link!.server as unknown) && !c.joining) && t.provider.synced && !t.link.c2s.length && !t.link.s2c.length);
      };
      if (!moved && settled()) {
        await new Promise((r) => setTimeout(r, 2));
        if (settled()) break;
      }
      if (!moved) await new Promise((r) => setTimeout(r, 1));
    }
    if (!runRefused) {
      const room = manager.get(KEY);
      const want = room ? view(room.doc) : '';
      if (process.env.HONEST_DEBUG) {
        const shapes = [...(room?.doc.getMap('shapes').values() ?? [])] as Y.Map<unknown>[];
        const chars = shapes.reduce((a, m) => a + ((m.get('text') as Y.Text | undefined)?.length ?? 0), 0);
        console.error(`run ${r}: room shapes ${shapes.length}, text chars ${chars}`);
      }
      for (const t of tabs) {
        if (view(t.cd.doc) !== want) {
          if (process.env.HONEST_DEBUG) {
            const conns = [...(room?.conns.values() ?? [])].map((c) => ({ p: c.principal, joining: c.joining, closing: c.closing }));
            const rs = room?.doc.getMap('shapes');
            const ts = t.cd.doc.getMap('shapes');
            const onlyRoom = [...(rs?.keys() ?? [])].filter((k) => !ts.has(k));
            const onlyTab = [...ts.keys()].filter((k) => !rs?.has(k));
            const differ = [...ts.keys()].filter((k) => rs?.has(k) && JSON.stringify(canon((rs.get(k) as Y.Map<unknown>).toJSON())) !== JSON.stringify(canon((ts.get(k) as Y.Map<unknown>).toJSON())));
            console.error(`DIVERGED run ${r} tab ${t.name} online=${t.online} synced=${t.provider.synced} link=${!!t.link} c2s=${t.link?.c2s.length} s2c=${t.link?.s2c.length} conns=${JSON.stringify(conns)} onlyRoom=${onlyRoom} onlyTab=${onlyTab} differ=${differ.slice(0, 3)}`);
            for (const k of differ.slice(0, 1)) console.error(' room:', JSON.stringify(canon((rs!.get(k) as Y.Map<unknown>).toJSON())).slice(0, 400), '\n tab: ', JSON.stringify(canon((ts.get(k) as Y.Map<unknown>).toJSON())).slice(0, 400));
            console.error(' sv room', JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(room!.doc))]), 'sv tab', JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(t.cd.doc))]), 'pending tab', !!t.cd.doc.store.pendingStructs, !!t.cd.doc.store.pendingDs);
          }
          if (process.env.HONEST_DUMP && !res.refusals.diverged) {
            const dir = path.join(process.env.HONEST_DUMP, `diverged-${mode}-${seed}-${r}`);
            fs.mkdirSync(dir, { recursive: true });
            for (const [name, l] of logs) l.forEach((u, i) => fs.writeFileSync(path.join(dir, `${name}.${String(i).padStart(6, '0')}`), u));
            fs.writeFileSync(path.join(dir, 'room.final'), Y.encodeStateAsUpdate(room!.doc));
            for (const o of tabs) fs.writeFileSync(path.join(dir, `${o.name}.final`), Y.encodeStateAsUpdate(o.cd.doc));
            fs.writeFileSync(path.join(dir, 'trace'), trace.join('\n'));
          }
          res.diverged++;
          const k = 'diverged';
          res.refusals[k] ??= { n: 0, example: `seed ${seed} mode ${mode} run ${r} tab ${t.name}: ${trace.slice(-14).join(' | ')}` };
          res.refusals[k].n++;
        }
      }
    }
    res.resyncs += ((await metrics.pendingResync.get()).values[0]?.value ?? 0) - resyncs0;
    for (const t of tabs) {
      if (t.link) disconnect(t);
      t.conn?.destroy();
      t.provider.destroy();
      t.provider.awareness.destroy();
    }
    server.close();
    await manager.shutdown('shutdown');
    res.runs++;
  }
  res.ms = Date.now() - t0;
  return res;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const runs = Number(process.argv[2] ?? 200);
  const seed = Number(process.argv[3] ?? 1);
  const steps = Number(process.argv[4] ?? 400);
  const which = (process.argv[5] ?? 'both') as HonestMode | 'both';
  const modes: HonestMode[] = which === 'both' ? ['client', 'ywebsocket'] : [which];
  let bad = 0;
  for (const m of modes) {
    const r = await runHonestFuzz(runs, seed, steps, m);
    console.log(JSON.stringify(r, null, 1));
    bad += r.refused + r.diverged;
  }
  process.exit(bad ? 1 : 0);
}
