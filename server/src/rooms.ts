import type { Config } from './config.js';
import { encodeNotice } from './vendor/protocol.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { Room, sendWs } from './room.js';
import type { CanvasObjectStore } from './store.js';
import { canvasObjectKey } from './paths.js';
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

  constructor(private readonly deps: ManagerDeps) {}

  get(name: string): Room | undefined {
    return this.rooms.get(name);
  }

  /** Get or create a room, loading its document from storage on first use. */
  async getOrCreate(name: string, ttl: number | null | undefined): Promise<Room> {
    let room = this.rooms.get(name);
    if (!room) {
      room = new Room(name, {
        cfg: this.deps.cfg,
        store: this.deps.store,
        log: this.deps.log,
        metrics: this.deps.metrics,
        onEmpty: (n) => this.rooms.delete(n),
      });
      this.rooms.set(name, room);
      this.deps.metrics.rooms.set(this.rooms.size);
      await room.load();
    }
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
      await this.deps.store.delete(canvasObjectKey(this.deps.cfg.canvasPrefix, name));
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
    for (const key of keys) {
      if (!key.endsWith('.ydoc')) continue;
      const artifactKey = key.slice(prefix.length, -'.ydoc'.length);
      if (!artifactKey) continue;
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

  /** Shutdown: tell everyone to reconnect elsewhere, flush every room. */
  async shutdown(notice: NoticeKind): Promise<void> {
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
