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
  }
}
