import { ROOM_BASE_COST_BYTES, type Config } from './config.js';
import { encodeNotice } from '@pocharlies/artifacts-canvas-shared/protocol';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import { BusyError, Room, sendWs } from './room.js';
import { TokenBucket } from './limits.js';
import type { CanvasObjectStore } from './store.js';
import { artifactKeyFromObject, canvasLedgerKey, canvasObjectKey } from './paths.js';
import type { AuthzClient } from './authz.js';
import type { NoticeKind } from './types.js';

/** Who is loading a room (the memory budget's per-principal share, fv6 H-1). */
export interface Loader {
  principal: string;
  anonymous: boolean;
}

/** Loads (rooms brought into memory) stop at this fraction of the budget; growth may use the rest. */
export const LOAD_FRACTION = 0.9;
/**
 * Ledger bytes the stamper writes per content byte, at most (measured, fv6 H-1: tiny shapes one
 * attribution entry each 1.53, geo shapes 0.21-0.28): an update's growth counts the room's own
 * ratio more, between 0.3 and this.
 */
export const LEDGER_PER_CONTENT = 1.6;
/** Rooms fetched from storage and decoded at once (each fetch holds up to MAX_DOC_BYTES). */
export const MAX_CONCURRENT_LOADS = 4;

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
  /** memory of loads admitted whose documents are not in yet (fv6 H-1) */
  private reserved = 0;
  private loading = 0;
  private readonly loadQueue: (() => void)[] = [];
  /** evictions under way, by room (awaited, never started twice) */
  private readonly evicting = new Map<Room, Promise<void>>();

  /** server CPU for debounced saves, shared by every room (see RoomDeps.saveBudget) */
  private readonly saveBudget: TokenBucket;

  constructor(private readonly deps: ManagerDeps) {
    deps.metrics.roomMemoryBudget.set(deps.cfg.roomMemoryBudgetBytes);
    this.saveBudget = new TokenBucket(deps.cfg.saveCpuMsPerSec, deps.cfg.saveCpuBurstMs);
  }

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
   *
   * The returned room counts the caller in `pendingJoins` (it is never evicted meanwhile): the
   * caller attaches its connection, or calls abandon(). A load the memory budget refuses
   * throws BusyError (fv6 H-1).
   */
  async getOrCreate(name: string, ttl: number | null | undefined, loader?: Loader): Promise<Room> {
    if (this.closing) throw new Error('shutting down');
    let room = this.rooms.get(name);
    if (!room) {
      const fresh = new Room(name, {
        cfg: this.deps.cfg,
        store: this.deps.store,
        log: this.deps.log,
        metrics: this.deps.metrics,
        onEmpty: (n) => this.rooms.delete(n),
        saveBudget: this.saveBudget,
      });
      room = fresh;
      this.rooms.set(name, fresh);
      this.deps.metrics.rooms.set(this.rooms.size);
      this.loads.set(
        fresh,
        this.withLoadSlot(() => fresh.load((bytes) => this.admitLoad(fresh, bytes, loader))).catch((err) => {
          if (this.rooms.get(name) === fresh) {
            this.rooms.delete(name);
            fresh.dispose();
            this.deps.metrics.rooms.set(this.rooms.size);
          }
          throw err;
        }),
      );
    }
    room.pendingJoins++;
    try {
      await this.loads.get(room);
      if (this.closing) throw new Error('shutting down');
    } catch (err) {
      room.pendingJoins--;
      throw err;
    }
    room.touchTtl(ttl);
    return room;
  }

  /** A caller of getOrCreate() that will not attach a connection (its socket went away). */
  abandon(name: string, room: Room): void {
    room.pendingJoins = Math.max(0, room.pendingJoins - 1);
    if (room.idle) void this.leave(name, room);
  }

  /** At most MAX_CONCURRENT_LOADS rooms are fetched and decoded at once (a freed slot is handed over). */
  private async withLoadSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.loading >= MAX_CONCURRENT_LOADS) await new Promise<void>((r) => this.loadQueue.push(r));
    else this.loading++;
    try {
      return await fn();
    } finally {
      const next = this.loadQueue.shift();
      if (next) next();
      else this.loading--;
    }
  }

  // ---------- loaded-room memory budget (fv6 H-1) ----------

  /** Estimated resident cost of a room of `bytes` encoded bytes (content + ledger). */
  cost(bytes: number): number {
    return ROOM_BASE_COST_BYTES + this.deps.cfg.roomCostFactor * bytes;
  }

  /**
   * Estimated memory of the loaded rooms: in total, of the idle ones (evicted first under
   * pressure), and of the rooms only anonymous visitors hold.
   */
  memory(): { total: number; idle: number; anon: number } {
    let total = this.reserved;
    let idle = 0;
    let anon = 0;
    for (const r of this.rooms.values()) {
      const c = this.cost(r.bytes);
      total += c;
      if (r.idle && !r.disposed) idle += c;
      if (r.anonOnly()) anon += c;
    }
    return { total, idle, anon };
  }

  /** What `principal` keeps loaded: every room it is connected to, split between its principals. */
  held(principal: string): number {
    let h = 0;
    for (const r of this.rooms.values()) if (r.principals.has(principal)) h += this.cost(r.bytes) / r.principals.size;
    return h;
  }

  /**
   * The share of the budget one principal may keep loaded: never less than one room at its cap
   * (with a quarter more, for the estimate of the last update that reaches the cap).
   */
  share(anonymous: boolean): number {
    const { cfg } = this.deps;
    const s = cfg.roomMemoryBudgetBytes * cfg.roomMemoryPrincipalShare * (anonymous ? 0.25 : 1);
    return Math.max(s, this.cost(1.25 * (anonymous ? cfg.anonMaxDocBytes : cfg.maxDocBytes)));
  }

  /**
   * Why a load of `extra` bytes of resident memory by `loader` is refused, or null. Idle rooms
   * count as free: they are evicted before a refusal.
   */
  private loadRefusal(extra: number, loader: Loader | undefined, m = this.memory()): string | null {
    const { cfg } = this.deps;
    if (m.total - m.idle + extra > cfg.roomMemoryBudgetBytes * LOAD_FRACTION) return 'room_memory';
    if (loader && this.held(loader.principal) + extra > this.share(loader.anonymous)) return 'room_memory_principal';
    if (loader?.anonymous && m.anon + extra > cfg.roomMemoryBudgetBytes * cfg.roomMemoryAnonShare) return 'room_memory_anon';
    return null;
  }

  /**
   * Quick check before a join that would load a room (nothing fetched yet): refused when not
   * even an empty room fits.
   */
  mayLoad(loader: Loader): string | null {
    return this.loadRefusal(ROOM_BASE_COST_BYTES, loader);
  }

  /**
   * Admission of a load once its encoded size is known, before anything is decoded: evicts idle
   * rooms when they are in the way, reserves the room's cost until its documents are in, or
   * throws BusyError.
   */
  private async admitLoad(room: Room, bytes: number, loader: Loader | undefined): Promise<() => void> {
    const { cfg, log } = this.deps;
    const extra = this.cost(bytes) - this.cost(0);
    for (let attempt = 0; ; attempt++) {
      const m = this.memory();
      const why = this.loadRefusal(extra, loader, m) ?? (attempt > 0 && m.total + extra > cfg.roomMemoryBudgetBytes * LOAD_FRACTION ? 'room_memory' : null);
      if (why) {
        log.warn({ room: room.name, bytes, estimate: Math.round(extra), loaded: Math.round(m.total), budget: cfg.roomMemoryBudgetBytes, why }, 'room load refused: memory budget');
        throw new BusyError(why);
      }
      if (m.total + extra <= cfg.roomMemoryBudgetBytes * LOAD_FRACTION) {
        this.reserved += extra;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.reserved -= extra;
          this.deps.metrics.roomMemory.set(this.memory().total);
        };
      }
      // only idle rooms are in the way: evict them, then decide again
      await this.evictIdle();
    }
  }

  /**
   * Why an update that grows `room` by `growthBytes` (encoded) is refused, or null (fv6 H-1):
   * the loaded rooms may not grow past the budget, a principal past its share, the rooms only
   * anonymous visitors hold past theirs. Idle rooms count as free and are evicted.
   */
  growthRefusal(room: Room, principal: string, anonymous: boolean, growthBytes: number): string | null {
    const { cfg } = this.deps;
    // the ledger grows with the content (the stamper writes it after the apply): counted ahead,
    // at this room's ledger/content ratio (at least 0.3, at most LEDGER_PER_CONTENT)
    const ratio = room.approxBytes > 64 * 1024 ? room.ledgerApproxBytes / room.approxBytes : LEDGER_PER_CONTENT;
    const extra = cfg.roomCostFactor * growthBytes * (1 + Math.min(LEDGER_PER_CONTENT, Math.max(0.3, ratio)));
    const m = this.memory();
    if (m.idle > 0 && m.total + extra > cfg.roomMemoryBudgetBytes) void this.evictIdle();
    if (m.total - m.idle + extra > cfg.roomMemoryBudgetBytes) return 'room_memory';
    if (this.held(principal) + extra / Math.max(1, room.principals.size) > this.share(anonymous)) return 'room_memory_principal';
    if (room.anonOnly() && m.anon + extra > cfg.roomMemoryBudgetBytes * cfg.roomMemoryAnonShare) return 'room_memory_anon';
    return null;
  }

  /** Flush and evict every idle room (no connection, no join waiting for it). */
  async evictIdle(): Promise<void> {
    const all: Promise<void>[] = [];
    for (const [name, room] of this.rooms) if (room.idle && !room.disposed) all.push(this.leave(name, room));
    await Promise.all(all);
  }

  /** Last connection left: flush and evict (once: concurrent callers await the same eviction). */
  leave(name: string, room: Room): Promise<void> {
    if (!room.idle) return Promise.resolve();
    let p = this.evicting.get(room);
    if (!p) {
      p = (async () => {
        await room.flush();
        if (room.idle && this.rooms.get(name) === room) {
          this.rooms.delete(name);
          room.dispose();
          this.deps.metrics.rooms.set(this.rooms.size);
          this.deps.metrics.roomMemory.set(this.memory().total);
        }
      })().finally(() => this.evicting.delete(room));
      this.evicting.set(room, p);
    }
    return p;
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
      room.dispose();
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
    for (const r of all) r.dispose();
    this.rooms.clear();
    this.deps.metrics.rooms.set(0);
  }
}

function isPast(expires: string | null | undefined): boolean {
  if (!expires) return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t <= Date.now();
}
