import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { writeUpdate } from 'y-protocols/sync';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { canvasObjectKey } from './paths.js';
import type { CanvasObjectStore } from './store.js';
import type { Identity } from './types.js';
import { attachStamper } from '@pocharlies/artifacts-canvas-shared/stamper';
import { ROOT } from '@pocharlies/artifacts-canvas-shared/model';
import { MSG_SYNC } from '@pocharlies/artifacts-canvas-shared/protocol';
import type { TokenBucket } from './limits.js';

/** A live WebSocket connection in a room. Used as the Yjs transaction origin. */
export interface Conn {
  ws: WebSocket;
  artifactKey: string;
  cookie: string;
  /** Raw `Authorization` header (if any), forwarded to the gate on every re-check. */
  authorization: string;
  identity: Identity;
  /** anonymous visitor nonce from the server-signed cookie (anon.ts); undefined if logged in */
  anonVisitor?: string;
  /** awareness clientIds this connection has claimed (protocol §5.4 hardening) */
  clientIds: Set<number>;
  rate: TokenBucket;
  recheckTimer?: ReturnType<typeof setInterval>;
  closing: boolean;
}

export interface RoomDeps {
  cfg: Config;
  store: CanvasObjectStore;
  log: Logger;
  metrics: Metrics;
  /** called after the last connection left and the room was flushed */
  onEmpty: (name: string) => void;
}

/**
 * One room per artifact key (design §6.2). The document lives in memory while anyone is
 * connected and is persisted to object storage with a debounce plus on last-leave
 * (protocol §7). Attribution is stamped server-side (protocol §5) via the shared stamper.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Conn>();
  /** rough doc size estimate; refreshed exactly when it crosses the limit or on save */
  approxBytes = 0;
  ttlTag: string | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    private readonly deps: RoomDeps,
  ) {
    this.awareness.setLocalState(null);

    // Materialise the root types before any update is applied. yjs 13.6 registers a root
    // referenced by an incoming update as a placeholder AbstractType, and `doc.getMap(name)`
    // then returns a *different* object than the one in `transaction.changed` — the stamper's
    // identity checks would silently no-op on the transaction that creates the root.
    this.doc.getMap(ROOT.shapes);
    this.doc.getMap(ROOT.assets);
    this.doc.getMap(ROOT.meta);
    this.doc.getMap(ROOT.attribution);
    this.doc.getMap(ROOT.users);
    this.doc.getArray(ROOT.history);

    // Protocol §5.2: stamp attribution/users/history for every client transaction.
    attachStamper(this.doc, {
      userOf: (origin: unknown) => {
        const c = origin as Conn | undefined;
        if (!c || !c.identity) return null;
        return {
          id: c.identity.id,
          info: {
            name: c.identity.name,
            anonymous: c.identity.anonymous,
            color: c.identity.color,
          },
        };
      },
    });

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      writeUpdate(e, update);
      const msg = encoding.toUint8Array(e);
      // Everyone but the sender. The stamper's follow-up transaction has a string origin,
      // so it goes to everyone including the sender (docs/protocol.md §5.2).
      for (const c of this.conns.values()) if (c !== origin) sendWs(c.ws, msg);
      if (origin !== 'load') this.markDirty();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const c = origin as Conn | undefined;
        if (c?.clientIds) {
          for (const id of added) c.clientIds.add(id);
          for (const id of removed) c.clientIds.delete(id);
        }
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1 /* MSG_AWARENESS */);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        const msg = encoding.toUint8Array(e);
        for (const conn of this.conns.values()) sendWs(conn.ws, msg);
      },
    );
  }

  get objectKey(): string {
    return canvasObjectKey(this.deps.cfg.canvasPrefix, this.name);
  }

  /** Copy the artifact's ttl tag (design §6.3): first valid one wins. The core's gate returns
   *  ttl as an integer number of days (or null). */
  touchTtl(ttl: number | null | undefined): void {
    if (!this.ttlTag && typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 0 && ttl <= 999) {
      this.ttlTag = `ttl=${ttl}`;
    }
  }

  async load(): Promise<void> {
    const { store, metrics } = this.deps;
    try {
      const data = await store.get(this.objectKey);
      if (data && data.byteLength > 0) {
        Y.applyUpdate(this.doc, data, 'load');
        this.approxBytes = data.byteLength;
      }
      metrics.loads.inc({ outcome: 'ok' });
    } catch (err) {
      metrics.loads.inc({ outcome: 'error' });
      throw err;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.save();
      }, this.deps.cfg.saveDebounceMs);
    }
  }

  /** Serialize saves; persist the whole doc as one object with the copied ttl tag. */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      const { store, metrics, log } = this.deps;
      const t0 = performance.now();
      try {
        const bytes = Y.encodeStateAsUpdate(this.doc);
        this.approxBytes = bytes.byteLength;
        await store.put(this.objectKey, bytes, this.ttlTag ?? undefined);
        this.dirty = false;
        metrics.saves.inc({ outcome: 'ok' });
      } catch (err) {
        metrics.saves.inc({ outcome: 'error' });
        log.error({ err: String(err), room: this.name }, 'canvas save failed');
      } finally {
        metrics.saveDuration.observe((performance.now() - t0) / 1000);
      }
    });
    return this.saving;
  }

  /** Cancel the debounce and persist now (last leave / shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }

  /** Live connections of one anonymous visitor (server-issued nonce). */
  countVisitor(nonce: string): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.anonVisitor === nonce) n++;
    return n;
  }

  /** Live anonymous pseudonyms (the NNNN of `anon:NNNN`) -> the visitor holding them. */
  anonHolders(): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of this.conns.values()) {
      if (c.identity.anonymous && c.anonVisitor) m.set(c.identity.id.slice('anon:'.length), c.anonVisitor);
    }
    return m;
  }

  countAnon(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.identity.anonymous) n++;
    return n;
  }

  closeAll(code: number, reason: string): void {
    for (const c of this.conns.values()) {
      try {
        c.ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }
}

export function sendWs(ws: WebSocket, msg: Uint8Array): void {
  if (ws.readyState === ws.OPEN) ws.send(msg);
}
