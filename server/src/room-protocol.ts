import type { UpdateCheck } from '@pocharlies/artifacts-canvas-shared/stamper';
import type { CoreOptions, Emitted } from './room-core.js';
import type { Identity } from './types.js';

/**
 * Messages between the main thread and a room's worker (room-worker.ts). The main thread sends
 * one request at a time per room (Room's job queue) and waits for the answer with a watchdog;
 * every answer carries the changes the documents emitted while serving it, in order.
 */
export interface WorkerInit {
  name: string;
  core: CoreOptions;
  /** test-only hooks (WORKER_TEST_HOOKS): a client update carrying a marker string makes the worker misbehave */
  testHooks: boolean;
}

export type StampIdentity = Pick<Identity, 'id' | 'name' | 'anonymous' | 'color'>;

export type WorkerRequest =
  | { op: 'load'; ledger: Uint8Array | null; content: Uint8Array | null; recovery: boolean }
  | { op: 'replay'; entries: Emitted[] }
  | { op: 'check'; update: Uint8Array; writer: string; claimed: number[] }
  | { op: 'apply'; identity: StampIdentity }
  | { op: 'drop' }
  | { op: 'diff'; sv: Uint8Array; joinSv: Uint8Array; refuseEmpty: boolean }
  | { op: 'frames'; content: boolean; ledger: boolean; sv: boolean }
  | { op: 'save' }
  | { op: 'inspect' };

export interface LoadResult {
  dirty: boolean;
  droppedPending: boolean;
  migrated: boolean;
  pruned: number;
  writers: [number, string][];
}
export interface CheckResult {
  check: UpdateCheck;
}
export interface ApplyResult {
  threw: string | null;
  droppedPending: boolean;
}
export interface DiffResult {
  empty: boolean;
  diff: Uint8Array | null;
  /** the state vector does not decode */
  malformed?: boolean;
}
export interface FramesResult {
  content?: Uint8Array;
  ledger?: Uint8Array;
  sv?: Uint8Array;
}
export interface SaveResult {
  content: Uint8Array;
  ledger: Uint8Array;
  droppedPending: boolean;
  pruned: number;
}
export interface InspectResult {
  content: Uint8Array;
  ledger: Uint8Array;
  pending: boolean;
}

export type WorkerReply =
  | {
      id: number;
      ok: true;
      result: unknown;
      emitted: Emitted[];
      /** writer bindings added (client id -> writer) */
      writers: [number, string][];
      maxUserIdBytes: number;
      /** time the worker spent on the request (ms) */
      ms: number;
    }
  | { id: number; ok: false; error: string; ms: number };
