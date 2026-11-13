import { Worker } from 'node:worker_threads';
import type { WorkerInit, WorkerReply, WorkerRequest } from './room-protocol.js';
import type { Emitted } from './room-core.js';

/**
 * Why a room's worker stopped serving: it took longer than the watchdog allowed (`timeout`), ran
 * out of its heap (`oom`, ERR_WORKER_OUT_OF_MEMORY), threw outside the guarded paths or died
 * (`crash`), or answered a request with an error (`error`).
 */
export type FaultKind = 'timeout' | 'oom' | 'crash' | 'error';

export class WorkerFault extends Error {
  constructor(
    readonly kind: FaultKind,
    detail: string,
  ) {
    super(`room worker ${kind}: ${detail}`);
  }
}

/** What a request answered, with the changes it made (see WorkerReply). */
export interface Answer<T> {
  result: T;
  emitted: Emitted[];
  writers: [number, string][];
  maxUserIdBytes: number;
  ms: number;
}

/** The worker script: the compiled one in production, the TypeScript source through tsx in tests and dev. */
function workerScript(): { url: URL; execArgv: string[] } {
  const here = import.meta.url;
  if (here.endsWith('.ts')) return { url: new URL('./room-worker.ts', here), execArgv: ['--import', 'tsx'] };
  return { url: new URL('./room-worker.js', here), execArgv: [] };
}

export interface WorkerLimits {
  /** V8 old generation of the worker (MiB): the room plus one message being processed (Room.heapLimitMb) */
  oldMb: number;
  youngMb: number;
}

/**
 * The main thread's handle on one room's worker thread. Requests are answered in order; each
 * has a hard timeout, and a worker that misses it is terminated (V8 interrupts a busy loop), so
 * nothing a client sends can hold the main thread. A worker that exits or runs out of heap fails
 * every request it holds with a WorkerFault. One host = one worker for its whole life: the room
 * replaces a faulted host with a new one (Room.recover).
 */
export class WorkerHost {
  private readonly worker: Worker;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: Answer<unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** the first fault; every later request fails with it */
  fault: WorkerFault | null = null;
  private exitedFlag = false;
  readonly ready: Promise<void>;
  /** resolves once the thread is down */
  readonly exited: Promise<void>;

  constructor(init: WorkerInit, limits: WorkerLimits) {
    const { url, execArgv } = workerScript();
    this.worker = new Worker(url, {
      workerData: init,
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: limits.oldMb, maxYoungGenerationSizeMb: limits.youngMb },
      stdout: false,
      stderr: false,
    });
    this.worker.unref();
    let readyResolve!: () => void;
    this.ready = new Promise<void>((r) => (readyResolve = r));
    let exitResolve!: () => void;
    this.exited = new Promise<void>((r) => (exitResolve = r));
    this.worker.on('message', (m: WorkerReply | { ready: true }) => {
      if ('ready' in m) {
        readyResolve();
        return;
      }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.resolve({ result: m.result, emitted: m.emitted, writers: m.writers, maxUserIdBytes: m.maxUserIdBytes, ms: m.ms });
      else {
        // an error the worker could not keep inside the guarded paths: its documents may be off
        this.fail(new WorkerFault('error', m.error));
        w.reject(this.fault!);
      }
    });
    this.worker.on('error', (err: Error & { code?: string }) => {
      this.fail(new WorkerFault(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'oom' : 'crash', String(err)));
    });
    this.worker.on('exit', (code) => {
      this.exitedFlag = true;
      readyResolve();
      exitResolve();
      this.fail(new WorkerFault('crash', `exited with code ${code}`));
    });
  }

  /** Send a request; it fails with a WorkerFault (and the worker is terminated) past `timeoutMs`. */
  call<T>(req: WorkerRequest, timeoutMs: number, transfer: ArrayBuffer[] = []): Promise<Answer<T>> {
    if (this.fault) return Promise.reject(this.fault);
    const id = ++this.seq;
    return new Promise<Answer<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new WorkerFault('timeout', `${req.op} took more than ${Math.round(timeoutMs)} ms`));
      }, Math.max(1, timeoutMs));
      this.waiting.set(id, { resolve: resolve as (r: Answer<unknown>) => void, reject, timer });
      try {
        this.worker.postMessage({ id, req }, transfer);
      } catch (err) {
        this.fail(new WorkerFault('crash', String(err)));
      }
    });
  }

  /** The first fault terminates the worker and fails every request waiting on it. */
  private fail(f: WorkerFault): void {
    if (!this.fault) {
      this.fault = f;
      if (!this.exitedFlag) void this.worker.terminate().catch(() => undefined);
    }
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      this.waiting.delete(id);
      w.reject(this.fault);
    }
  }

  /** Stop the worker (the room is gone). Idempotent; resolves once the thread is down. */
  async terminate(): Promise<void> {
    if (!this.fault) this.fault = new WorkerFault('crash', 'terminated');
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      this.waiting.delete(id);
      w.reject(this.fault);
    }
    if (!this.exitedFlag) await this.worker.terminate().catch(() => undefined);
  }

  get threadId(): number {
    return this.worker.threadId;
  }
}

/** Buffers sent to a worker without a copy: only ones that are exactly one whole ArrayBuffer. */
export function owned(u: Uint8Array | null | undefined): Uint8Array | null {
  if (!u) return null;
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength && u.buffer instanceof ArrayBuffer) return u;
  return u.slice();
}

/** A FIFO counting semaphore (the apply slots shared by every room, Config.workerApplyConcurrency). */
export class Semaphore {
  private used = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async acquire(): Promise<() => void> {
    if (this.used < this.size) this.used++;
    else await new Promise<void>((r) => this.queue.push(r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.used--;
    };
  }
  get waiting(): number {
    return this.queue.length;
  }
}
