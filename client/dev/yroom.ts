/*
 * Reference room server for development and tests (NOT the production service).
 * It implements docs/protocol.md exactly, so the client can be developed and tested
 * against it, and the production service (server/) can compare behaviour:
 *   - IDENTITY (100) as the first message,
 *   - attribution stamped server-side (model/stamper.ts) per connection,
 *   - client writes to attribution/users/history rejected (connection closed 4403),
 *   - awareness `user` field forced to the connection identity.
 * Rooms live in memory for the lifetime of the process.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { WebSocket } from 'ws';
import { attachStamper, dropPending, forbiddenRootWrite } from '../src/model/stamper';
import { CLOSE, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC, encodeIdentity } from '../src/collab/protocol';
import { sanitizeAwarenessUpdate } from '@pocharlies/artifacts-canvas-shared/awareness';
import { personColor } from '../src/model/colors';
import type { Identity } from '../src/model/types';

interface Conn {
  ws: WebSocket;
  identity: Identity;
  clientIds: Set<number>;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Conn>();

  constructor(readonly name: string) {
    this.awareness.setLocalState(null);
    attachStamper(this.doc, {
      userOf: (origin) => {
        const c = origin as Conn | undefined;
        if (!c || !c.identity) return null;
        return { id: c.identity.id, info: { name: c.identity.name, anonymous: c.identity.anonymous, color: c.identity.color } };
      },
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      const msg = encoding.toUint8Array(e);
      // everyone but the sender; the stamper's follow-up transaction goes to everyone
      for (const c of this.conns.values()) if (c !== origin) send(c.ws, msg);
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const c = origin as Conn | undefined;
      if (c?.clientIds) {
        for (const id of added) c.clientIds.add(id);
        for (const id of removed) c.clientIds.delete(id);
      }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(e);
      for (const conn of this.conns.values()) send(conn.ws, msg);
    });
  }

  join(ws: WebSocket, identity: Identity) {
    const conn: Conn = { ws, identity, clientIds: new Set() };
    this.conns.set(ws, conn);
    send(ws, encodeIdentity(identity));
    // sync step 1 from the server
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    send(ws, encoding.toUint8Array(e));
    const states = this.awareness.getStates();
    if (states.size) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())));
      send(ws, encoding.toUint8Array(a));
    }
    ws.on('message', (data: ArrayBuffer | Buffer) => this.onMessage(conn, new Uint8Array(data as ArrayBuffer)));
    ws.on('close', () => {
      this.conns.delete(ws);
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(conn.clientIds), null);
    });
  }

  private onMessage(conn: Conn, buf: Uint8Array) {
    try {
      const dec = decoding.createDecoder(buf);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const syncType = decoding.readVarUint(dec);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, MSG_SYNC);
          syncProtocol.writeSyncStep2(e, this.doc, decoding.readVarUint8Array(dec));
          send(conn.ws, encoding.toUint8Array(e));
          return;
        }
        const update = decoding.readVarUint8Array(dec);
        if (conn.identity.readOnly) return;
        const bad = forbiddenRootWrite(this.doc, update);
        if (bad) {
          conn.ws.close(CLOSE.forbidden, `write to ${bad} not allowed`);
          return;
        }
        Y.applyUpdate(this.doc, update, conn);
        // same invariant as the production server: the room never keeps pending state
        if (dropPending(this.doc)) conn.ws.close(CLOSE.forbidden, 'write not allowed');
        return;
      }
      if (type === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        // never trust the client's idea of who it is: the exact same hardening the
        // production server applies (shared/awareness: foreign clientIds dropped, the
        // `user` field forced to the connection identity).
        const fixed = sanitizeAwarenessUpdate(update, conn.clientIds, this.awareness, conn.identity);
        if (fixed) awarenessProtocol.applyAwarenessUpdate(this.awareness, fixed, conn);
        return;
      }
      if (type === MSG_QUERY_AWARENESS) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())));
        send(conn.ws, encoding.toUint8Array(e));
      }
    } catch (err) {
      console.error('[dev-room] bad message', err);
      conn.ws.close(1003, 'bad message');
    }
  }
}

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState === 1) ws.send(msg);
}

const rooms = new Map<string, Room>();
export function getRoom(name: string): Room {
  let r = rooms.get(name);
  if (!r) rooms.set(name, (r = new Room(name)));
  return r;
}

/** Development identity: ?devUser=<name> (dev only!) or the anonymous pseudonym ?anon=NNNN. */
export function devIdentity(params: URLSearchParams): Identity {
  const dev = (params.get('devUser') ?? '').trim().slice(0, 64);
  if (dev) {
    const id = `dev:${dev}`;
    return { id, name: dev, anonymous: false, color: personColor(id, false), attribution: 'server' };
  }
  const anon = /^\d{4}$/.test(params.get('anon') ?? '') ? params.get('anon')! : String(1000 + Math.floor(Math.random() * 9000));
  const id = `anon:${anon}`;
  return { id, name: `Anónimo ${anon}`, anonymous: true, color: personColor(id, true), attribution: 'server' };
}
