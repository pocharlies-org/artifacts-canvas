import type { Config } from './config.js';
import { encodeNotice } from '@pocharlies/artifacts-canvas-shared/protocol';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { Room, sendWs } from './room.js';
import type { CanvasObjectStore } from './store.js';
import { artifactKeyFromObject, canvasLedgerKey, canvasObjectKey } from './paths.js';
import type { AuthzClient } from './authz.js';
import type { NoticeKind } from './types.js';

export interface ManagerDeps {
  cfg: Config;
  store: CanvasObjectStore;
  authz: AuthzClient;
  log: Logger;
  metrics: Metrics;
}

/**
 * Holds the live rooms and the periodic orphan sweep. A room exists while it has
 * connections; its document is flushed to storage before eviction (protocol §7).
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** load of each room, awaited by EVERY joiner (not only the first one) */
  private readonly loads = new WeakMap<Room, Promise<void>>();
  /** set by shutdown(): no room is joined or created any more */
  closing = false;

  constructor(private readonly deps: ManagerDeps) {}

  get(name: string): Room | undefined {
    return this.rooms.get(name);
  }

  /**
   * Get or create a room, loading its documents from storage on first use. A second joiner
   * arriving while the first load is still running waits for the same load: a connection
   * must never reach a room before its stored state is in (its step-2 answer would be
   * applied to an empty room and stamped into an empty ledger, which the stored ledger then
   * merges into — duplicated history). A failed load leaves no room behind (the next join
   * retries instead of finding an empty room that would overwrite the stored one).
   */
  async getOrCreate(name: string, ttl: number | null | undefined): Promise<Room> {
    if (this.closing) throw new Error('shutting down');
    let room = this.rooms.get(name);
    if (!room) {
      const fresh = new Room(name, {
        cfg: this.deps.cfg,
        store: this.deps.store,
        log: this.deps.log,
        metrics: this.deps.metrics,
        onEmpty: (n) => this.rooms.delete(n),
      });
      room = fresh;
      this.rooms.set(name, fresh);
      this.deps.metrics.rooms.set(this.rooms.size);
      this.loads.set(
        fresh,
        fresh.load().catch((err) => {
          if (this.rooms.get(name) === fresh) {
            this.rooms.delete(name);
            this.deps.metrics.rooms.set(this.rooms.size);
          }
          throw err;
        }),
      );
    }
    await this.loads.get(room);
    if (this.closing) throw new Error('shutting down');
    room.touchTtl(ttl);
    return room;
  }

  /** Last connection left: flush and evict. */
  async leave(name: string, room: Room): Promise<void> {
    if (room.conns.size !== 0) return;
    await room.flush();
    if (room.conns.size === 0 && this.rooms.get(name) === room) {
      this.rooms.delete(name);
      this.deps.metrics.rooms.set(this.rooms.size);
    }
  }

  /**
   * The artifact is expired or gone: refuse/drop the room and delete the canvas object
   * (design §2 G7, §8.4). Idempotent; safe to call from connect, re-check or sweep.
   */
  async expireRoom(name: string, kind: 'expired' | 'gone'): Promise<void> {
    const room = this.rooms.get(name);
    if (room) {
      if (kind === 'expired') {
        for (const c of room.conns.values()) sendWs(c.ws, encodeNotice({ kind: 'expired' }));
        room.closeAll(4410, 'artifact expired');
      } else {
        room.closeAll(4404, 'artifact gone');
      }
      this.rooms.delete(name);
      this.deps.metrics.rooms.set(this.rooms.size);
    }
    try {
      // both objects of the room (content + ledger, protocol §8)
      await this.deps.store.delete(canvasObjectKey(this.deps.cfg.canvasPrefix, name));
      await this.deps.store.delete(canvasLedgerKey(this.deps.cfg.canvasPrefix, name));
      this.deps.metrics.deletes.inc({ reason: kind });
      this.deps.log.info({ room: name, kind }, 'canvas object deleted with artifact');
    } catch (err) {
      this.deps.log.error({ err: String(err), room: name }, 'canvas delete failed');
    }
  }

  /**
   * Periodic sweep of orphans (canvas objects whose artifact is gone or expired).
   * Runs authz with an empty cookie — conservative: only reasons in the gone/expired
   * sets delete; "needs login" answers keep the object (the core's ILM catch-all covers
   * the rest, design §8.4).
   */
  async sweep(): Promise<{ scanned: number; deleted: number }> {
    const { cfg, store, authz, log } = this.deps;
    let scanned = 0;
    let deleted = 0;
    const prefix = `${cfg.canvasPrefix}/`;
    let keys: string[];
    try {
      keys = await store.list(prefix);
    } catch (err) {
      log.error({ err: String(err) }, 'sweep list failed');
      return { scanned, deleted };
    }
    // content (`.ydoc`) and ledger (`.ydoc.ledger`) objects: one authz per artifact
    const artifactKeys = new Set<string>();
    for (const key of keys) {
      const artifactKey = artifactKeyFromObject(cfg.canvasPrefix, key);
      if (artifactKey) artifactKeys.add(artifactKey);
    }
    for (const artifactKey of artifactKeys) {
      scanned++;
      const res = await authz.authorize('', artifactKey);
      const gone = cfg.goneReasons.has(res.reason);
      const expired = cfg.expiredReasons.has(res.reason) || isPast(res.artifact?.expires);
      if (gone || expired) {
        await this.expireRoom(artifactKey, gone ? 'gone' : 'expired');
        deleted++;
      }
    }
    if (deleted > 0) log.info({ scanned, deleted }, 'canvas sweep deleted orphans');
    return { scanned, deleted };
  }

  /**
   * Shutdown: refuse new joins (a client reconnecting into this process while it flushes
   * would push its state into a room that is about to vanish), tell everyone to reconnect
   * elsewhere, flush every room.
   */
  async shutdown(notice: NoticeKind): Promise<void> {
    this.closing = true;
    const all = [...this.rooms.values()];
    for (const room of all) {
      for (const c of room.conns.values()) {
        try {
          sendWs(c.ws, encodeNotice({ kind: notice }));
          c.ws.close(4503, 'server restart');
        } catch {
          /* ignore */
        }
      }
    }
    await Promise.all(all.map((r) => r.flush()));
    this.rooms.clear();
    this.deps.metrics.rooms.set(0);
  }
}

function isPast(expires: string | null | undefined): boolean {
  if (!expires) return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t <= Date.now();
}
