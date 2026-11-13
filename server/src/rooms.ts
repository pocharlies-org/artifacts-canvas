import { ANON_VISITOR_SHARE_RATIO, GROWTH_FRACTION, LOAD_FRACTION, ROOM_BASE_COST_BYTES, roomCost, type Config } from './config.js';
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

export { GROWTH_FRACTION, LOAD_FRACTION };
/**
 * What the stamper adds to the ledger for one update, at most (fv7 F1, server/test/fv7/ledger.ts):
 * per shape the update writes or deletes, one attribution entry (the shape id, its creator's and
 * the writer's ids, two timestamps) and one history line (the shape id, the writer's id, the
 * creator's as owner, the verb and type), each LEDGER_LINE_BYTES plus those ids; history lines
 * are at most HISTORY_LIMIT per update; plus the writer's `users` entry and the update's headers,
 * LEDGER_UPDATE_BYTES. Measured with 768-byte ids: 3.4-3.9 KiB per shape against a bound of
 * 4.3 KiB; with short ids 0.3 KiB per shape. (fv6 counted the ledger as a ratio of the content,
 * 0.3-1.6: one image of 2 MiB in a new room was counted at 2.6 x its size, more than a share.)
 */
export const LEDGER_LINE_BYTES = 192;
export const LEDGER_UPDATE_BYTES = 2048;
const HISTORY_LIMIT = 300;
/** A shape id is at most MAX_KEY_LENGTH (256) characters, 3 UTF-8 bytes each. */
const MAX_KEY_BYTES = 3 * 256;

/** Bound of the ledger the stamper writes for an update (see LEDGER_LINE_BYTES). */
export function ledgerBound(shapes: number, shapeKeyBytes: number, userIdBytes: number): number {
  if (shapes <= 0) return 0;
  const line = LEDGER_LINE_BYTES + 2 * userIdBytes;
  const lines = Math.min(shapes, HISTORY_LIMIT);
  // the history keeps the update's LAST lines: their ids may be the longest ones
  return LEDGER_UPDATE_BYTES + shapes * line + shapeKeyBytes + lines * line + Math.min(shapeKeyBytes, lines * MAX_KEY_BYTES);
}
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
    deps.metrics.roomMemoryShare.set({ who: 'user' }, this.share(false));
    deps.metrics.roomMemoryShare.set({ who: 'anon_visitor' }, this.share(true));
    deps.metrics.roomMemoryShare.set({ who: 'anon_total' }, this.anonShare());
    deps.metrics.heldProbe = () => this.heldStats();
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
        shareOf: (anonymous) => this.share(anonymous),
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

  // ---------- loaded-room memory budget (fv6 H-1, fv7 F1) ----------
  //
  // Every loaded room has an estimated cost (cost(), ROOM_COST_FACTOR x content + ledger), and
  // that cost is charged to principals (Room.charges):
  //   load     the room's cost when it was loaded, to the principal whose join loaded it;
  //   growth   what each accepted update added to the room's estimate, in full, to the principal
  //            that sent it (never split with the others connected, who pay nothing for reading);
  //   settle   every save measures the room, and the principals that wrote since the previous
  //            save share what it really changed by since then (in proportion to their own
  //            estimates): an over-estimate or a delete is given back to the writers, nobody
  //            else's charge moves.
  // A charge stays while the room stays loaded, whoever keeps it loaded (a charged principal
  // that leaves still pays) and goes with the room when it is evicted. So the charges of a room
  // always add up to (at least) its cost, and the loaded rooms cost at most what the principals
  // are charged together. The bounds, both refused with 1013 busy:
  //   total     loads stop at LOAD_FRACTION (85%) of the budget, growth at GROWTH_FRACTION (80%):
  //             the 5% between them is always left for loads;
  //   share     a load or a growing update may not take its principal past its share (a third
  //             of the budget; an anonymous visitor a quarter of that, 1/12) nor all anonymous
  //             visitors together past theirs (a third).
  // One logged-in principal plus every anonymous visitor are then charged at most 2/3 of the
  // budget: everybody else can always load (fv7 F1: a user who grew rooms while other principals
  // sat in them was charged a fraction of each, kept them loaded alone once they left, and held
  // the whole budget: every load, for everybody, was refused 1013).

  /** Estimated resident cost of a room of `bytes` encoded bytes (content + ledger). */
  cost(bytes: number): number {
    return roomCost(this.deps.cfg, bytes);
  }

  /** Estimated memory of the loaded rooms: in total, and of the idle ones (evicted first under pressure). */
  memory(): { total: number; idle: number } {
    let total = this.reserved;
    let idle = 0;
    for (const r of this.rooms.values()) {
      const c = r.cost;
      total += c;
      if (r.idle && !r.disposed) idle += c;
    }
    return { total, idle };
  }

  /**
   * What `principal` is charged for: what it loaded and wrote, in every loaded room (idle rooms,
   * evicted before any refusal, count as free).
   */
  held(principal: string): number {
    let h = 0;
    for (const r of this.rooms.values()) if (!r.idle) h += r.chargeOf(principal);
    return h;
  }

  /** What the anonymous visitors together are charged for (idle rooms count as free). */
  anonHeld(): number {
    let h = 0;
    for (const r of this.rooms.values()) if (!r.idle) h += r.anonCharged();
    return h;
  }

  /**
   * The largest charge of one logged-in principal and of one anonymous visitor, and what the
   * anonymous visitors hold together (metrics, tests).
   */
  heldStats(): { user: number; anonVisitor: number; anon: number } {
    const by = new Map<string, { anonymous: boolean; bytes: number }>();
    for (const r of this.rooms.values()) {
      if (r.idle) continue;
      for (const [p, c] of r.chargeEntries()) {
        const e = by.get(p);
        if (e) e.bytes += c.bytes;
        else by.set(p, { anonymous: c.anonymous, bytes: c.bytes });
      }
    }
    let user = 0;
    let anonVisitor = 0;
    let anon = 0;
    for (const e of by.values()) {
      if (e.anonymous) {
        anon += e.bytes;
        anonVisitor = Math.max(anonVisitor, e.bytes);
      } else user = Math.max(user, e.bytes);
    }
    return { user, anonVisitor, anon };
  }

  /** The most one principal may be charged for: a fixed fraction of the budget, never more. */
  share(anonymous: boolean): number {
    const { cfg } = this.deps;
    return cfg.roomMemoryBudgetBytes * cfg.roomMemoryPrincipalShare * (anonymous ? ANON_VISITOR_SHARE_RATIO : 1);
  }

  /** The most the anonymous visitors together may be charged for. */
  anonShare(): number {
    return this.deps.cfg.roomMemoryBudgetBytes * this.deps.cfg.roomMemoryAnonShare;
  }

  /**
   * Why a load that adds `extra` bytes to the loaded rooms and charges `charge` to `loader` is
   * refused, or null. Idle rooms count as free: they are evicted before a refusal.
   */
  private loadRefusal(extra: number, charge: number, loader: Loader | undefined, m = this.memory()): string | null {
    const { cfg } = this.deps;
    // fv8 P1: a room the server stored is never refused for good because a share cannot hold it
    // (one update grew a room past every share and it was refused 4413 to everyone, for good): it
    // loads, its loader charged one share at most (loadCharge). Only a room the whole load budget
    // cannot hold (stored by a deployment with more memory) never loads here: 4413, no retry.
    if (charge > cfg.roomMemoryBudgetBytes * LOAD_FRACTION) return 'room_too_large';
    const own = loader ? this.loadCharge(charge, loader) : 0;
    if (m.total - m.idle + extra > cfg.roomMemoryBudgetBytes * LOAD_FRACTION) return 'room_memory';
    if (loader && this.held(loader.principal) + own > this.share(loader.anonymous)) return 'room_memory_principal';
    if (loader?.anonymous && this.anonHeld() + own > this.anonShare()) return 'room_memory_anon';
    return null;
  }

  /** What a load of a room costing `cost` charges its loader: the cost, one share at most (fv8 P1). */
  loadCharge(cost: number, loader: Loader): number {
    return Math.min(cost, this.share(loader.anonymous));
  }

  /**
   * Quick check before a join that would load a room (nothing fetched yet): refused when not
   * even an empty room fits.
   */
  mayLoad(loader: Loader): string | null {
    return this.loadRefusal(ROOM_BASE_COST_BYTES, ROOM_BASE_COST_BYTES, loader);
  }

  /**
   * Admission of a load once its encoded size is known, before anything is decoded: evicts idle
   * rooms when they are in the way, charges the room's cost to the loader and reserves it until
   * the documents are in (then the charge follows what was really loaded), or throws BusyError.
   */
  private async admitLoad(room: Room, bytes: number, loader: Loader | undefined): Promise<() => void> {
    const { cfg, log } = this.deps;
    // rooms nobody is connected to anymore are on their way out (flushed, then evicted) and count
    // as free: when the loader is still charged for one, it goes first, so that what the loader
    // is charged for is exact when its share is checked below
    if (loader && [...this.rooms.values()].some((r) => r.idle && !r.disposed && r.chargeOf(loader.principal) > 0)) await this.evictIdle();
    // the room's base is counted already (it is in `rooms`, empty, while it loads)
    const extra = this.cost(bytes) - this.cost(0);
    const charge = this.cost(bytes);
    for (let attempt = 0; ; attempt++) {
      const m = this.memory();
      const why = this.loadRefusal(extra, charge, loader, m) ?? (attempt > 0 && m.total + extra > cfg.roomMemoryBudgetBytes * LOAD_FRACTION ? 'room_memory' : null);
      if (why) {
        log.warn({ room: room.name, bytes, estimate: Math.round(extra), loaded: Math.round(m.total), budget: cfg.roomMemoryBudgetBytes, why }, 'room load refused: memory budget');
        throw new BusyError(why);
      }
      if (m.total + extra <= cfg.roomMemoryBudgetBytes * LOAD_FRACTION) {
        this.reserved += extra;
        if (loader && charge > this.share(loader.anonymous)) {
          log.warn(
            { room: room.name, bytes, cost: Math.round(charge), share: Math.round(this.share(loader.anonymous)), anonymous: loader.anonymous },
            'stored room costs more than a share: loaded, its loader charged one share; the size cap refuses it any growth',
          );
        }
        if (loader) room.charge(loader.principal, loader.anonymous, this.loadCharge(charge, loader), false);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.reserved -= extra;
          // the documents are in (a stored room repaired or migrated at load may differ)
          room.settleCharges(loader);
          this.deps.metrics.roomMemory.set(this.memory().total);
        };
      }
      // only idle rooms are in the way: evict them, then decide again
      await this.evictIdle();
    }
  }

  /**
   * Why an update that grows `room` by `growthBytes` (encoded) and adds at most `ledgerBytes` to
   * its ledger (ledgerBound()), sent by `principal`, is refused, or null (fv6 H-1, fv7 F1): the
   * loaded rooms may not grow past GROWTH_FRACTION of the budget, the principal past its share,
   * the anonymous visitors past theirs. Idle rooms count as free and are evicted. An update that
   * is let through is charged with chargeUpdate() once applied.
   */
  growthRefusal(room: Room, principal: string, anonymous: boolean, growthBytes: number, ledgerBytes: number): string | null {
    const extra = this.deps.cfg.roomCostFactor * (growthBytes + ledgerBytes);
    const { cfg } = this.deps;
    const m = this.memory();
    const limit = cfg.roomMemoryBudgetBytes * GROWTH_FRACTION;
    if (m.idle > 0 && m.total + extra > limit) void this.evictIdle();
    if (m.total - m.idle + extra > limit) return 'room_memory';
    if (this.held(principal) + extra > this.share(anonymous)) return 'room_memory_principal';
    if (anonymous && this.anonHeld() + extra > this.anonShare()) return 'room_memory_anon';
    return null;
  }

  /**
   * An update of `principal` was applied to `room`, whose cost was `costBefore`: what it added
   * (content and the ledger the stamper wrote for it) is charged to that principal, in full.
   */
  chargeUpdate(room: Room, principal: string, anonymous: boolean, costBefore: number): void {
    room.charge(principal, anonymous, room.cost - costBefore);
  }

  /**
   * fv8 U2: a principal's last connection left `room` while others keep it loaded. The load
   * charges of the principals no longer connected (what the room cost when they loaded it, or
   * what was handed over to them) move to the principals still connected, split evenly, each at
   * most what its share still holds (an anonymous visitor's also within the anonymous share);
   * what nobody can take stays where it was, and moves at a later leave. Before, a user who
   * opened a big room and left it to colleagues kept paying for it, and could not open a second
   * one (refused 1013 for as long as they kept it open). What a principal WROTE stays charged to
   * it (fv7 F1: a writer pays for its growth while the room is loaded, whoever keeps it loaded).
   */
  handOver(room: Room): void {
    if (room.idle || room.disposed) return;
    const takers = new Map<string, boolean>();
    for (const c of room.conns.values()) takers.set(c.principal, c.identity.anonymous);
    if (!takers.size) return;
    for (const [from, charge] of [...room.chargeEntries()]) {
      if (takers.has(from) || !(charge.load > 0)) continue;
      let left = charge.load;
      const head = new Map<string, number>();
      for (const [p, anon] of takers) head.set(p, Math.max(0, this.share(anon) - this.held(p)));
      let anonRoom = Math.max(0, this.anonShare() - this.anonHeld());
      let open = [...takers.keys()].filter((p) => head.get(p)! > 0);
      while (left > 1 && open.length) {
        const part = left / open.length;
        const next: string[] = [];
        let round = 0;
        for (const p of open) {
          const anon = takers.get(p)!;
          const give = Math.min(part, head.get(p)!, anon ? anonRoom : Infinity);
          const moved = give > 0 ? room.handOverLoad(from, p, anon, give) : 0;
          round += moved;
          left -= moved;
          head.set(p, head.get(p)! - moved);
          if (anon) anonRoom -= moved;
          if (head.get(p)! > 1 && (!anon || anonRoom > 1)) next.push(p);
        }
        if (round < 1) break;
        open = next;
      }
    }
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
