import v8 from 'node:v8';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/** Prometheus metrics. Labels are low-cardinality by construction (reasons are a fixed enum). */
export class Metrics {
  readonly registry = new Registry();

  readonly rooms = new Gauge({
    name: 'canvas_rooms_active',
    help: 'Rooms currently loaded in memory',
    registers: [this.registry],
  });
  readonly connections = new Gauge({
    name: 'canvas_connections_active',
    help: 'Live WebSocket connections',
    labelNames: ['anonymous'],
    registers: [this.registry],
  });
  readonly wsAccepted = new Counter({
    name: 'canvas_ws_connections_total',
    help: 'WebSocket connections accepted',
    labelNames: ['anonymous'],
    registers: [this.registry],
  });
  readonly wsRejected = new Counter({
    name: 'canvas_ws_rejected_total',
    help: 'WebSocket connections refused or dropped',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly authz = new Counter({
    name: 'canvas_authz_total',
    help: 'Calls to the core authz endpoint',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly authzDeny = new Counter({
    name: 'canvas_authz_deny_total',
    help: 'Authz denials by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly saves = new Counter({
    name: 'canvas_saves_total',
    help: 'Canvas document saves to object storage',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly loads = new Counter({
    name: 'canvas_loads_total',
    help: 'Canvas document loads from object storage',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly pendingDropped = new Counter({
    name: 'canvas_pending_dropped_total',
    help: 'Pending (unintegrated) Yjs state dropped from a room: on load, at save, or after an apply the guard let through',
    labelNames: ['where'],
    registers: [this.registry],
  });
  readonly pendingResync = new Counter({
    name: 'canvas_pending_resync_total',
    help: 'Client updates that would have left the room pending: dropped and answered with a sync step 1 (the client resends what the room lacks)',
    registers: [this.registry],
  });
  readonly outgoingBytes = new Gauge({
    name: 'canvas_ws_outgoing_bytes',
    help: 'Bytes held for all WebSocket peers (outgoing buffers; join payloads in flight counted once per room version)',
    registers: [this.registry],
  });
  readonly roomMemory = new Gauge({
    name: 'canvas_room_memory_bytes',
    help: 'Estimated resident memory of the loaded rooms (ROOM_COST_FACTOR x content + ledger, plus a base per room)',
    registers: [this.registry],
  });
  readonly roomMemoryBudget = new Gauge({
    name: 'canvas_room_memory_budget_bytes',
    help: 'Loaded-room memory budget (ROOM_MEMORY_BUDGET_BYTES, or derived from the V8 heap limit)',
    registers: [this.registry],
  });
  /** Set by the RoomManager: what the principals are charged for (read at every scrape). */
  heldProbe: (() => { user: number; anonVisitor: number; anon: number }) | null = null;
  readonly roomMemoryHeld = new Gauge({
    name: 'canvas_room_memory_charged_bytes',
    help: 'Loaded-room memory charged to principals (fv7 F1): the most one logged-in user is charged for (who="user_max"), the most one anonymous visitor (who="anon_visitor_max"), all anonymous visitors together (who="anon_total")',
    labelNames: ['who'],
    registers: [this.registry],
    collect: () => {
      const h = this.heldProbe?.();
      if (!h) return;
      this.roomMemoryHeld.set({ who: 'user_max' }, h.user);
      this.roomMemoryHeld.set({ who: 'anon_visitor_max' }, h.anonVisitor);
      this.roomMemoryHeld.set({ who: 'anon_total' }, h.anon);
    },
  });
  readonly roomMemoryShare = new Gauge({
    name: 'canvas_room_memory_share_bytes',
    help: 'The most one logged-in user (who="user"), one anonymous visitor (who="anon_visitor") and all anonymous visitors together (who="anon_total") may be charged for',
    labelNames: ['who'],
    registers: [this.registry],
  });
  readonly heapUsedPeak = new Gauge({
    name: 'canvas_heap_used_peak_bytes',
    help: 'Highest V8 used heap seen since start (sampled every 500 ms and after every message over 256 KiB)',
    registers: [this.registry],
  });
  readonly heapLimit = new Gauge({
    name: 'canvas_heap_size_limit_bytes',
    help: 'V8 heap size limit (follows --max-old-space-size)',
    registers: [this.registry],
  });
  private heapPeak = 0;
  /** Sample the used heap into canvas_heap_used_peak_bytes. */
  sampleHeap(): void {
    const used = v8.getHeapStatistics().used_heap_size;
    if (used > this.heapPeak) {
      this.heapPeak = used;
      this.heapUsedPeak.set(used);
    }
  }
  readonly joinEncodes = new Counter({
    name: 'canvas_join_encodes_total',
    help: 'Full encodings of a room document for joins (each one is shared by every join until the updates since outgrow it)',
    labelNames: ['doc'],
    registers: [this.registry],
  });
  readonly anonMinted = new Counter({
    name: 'canvas_anon_visitors_minted_total',
    help: 'Anonymous visitor cookies issued, and refused by the mint rate limit',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly migrations = new Counter({
    name: 'canvas_legacy_migrations_total',
    help: 'Stored single-document canvases split into content + ledger on load',
    registers: [this.registry],
  });
  readonly deletes = new Counter({
    name: 'canvas_deletes_total',
    help: 'Canvas objects deleted (expiry / sweep)',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly saveDuration = new Histogram({
    name: 'canvas_save_duration_seconds',
    help: 'Object storage save duration',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [this.registry],
  });
  readonly authzDuration = new Histogram({
    name: 'canvas_authz_duration_seconds',
    help: 'Core authz call duration',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 3],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.heapLimit.set(v8.getHeapStatistics().heap_size_limit);
  }
}
