import { parentPort, workerData } from 'node:worker_threads';
import { RoomCore } from './room-core.js';
import type { WorkerInit, WorkerReply, WorkerRequest } from './room-protocol.js';

/**
 * A room's worker thread (fv9 isolation): it holds the room's two documents (RoomCore) and runs
 * everything that decodes or applies client bytes: the guard, the apply, the stamper, the
 * encodings. The main thread sends one request at a time and waits for the answer with a
 * watchdog; a worker that takes too long or runs out of its heap (resourceLimits) is terminated
 * and the room is rebuilt in a fresh one (Room.recover), so whatever an update makes Yjs do, it
 * costs one room's worker, never the process.
 */
const init = workerData as WorkerInit;
const core = new RoomCore(init.core);
const port = parentPort!;

/** Test-only (WORKER_TEST_HOOKS): a marker in a client update makes the worker misbehave on purpose. */
const HOOKS: [string, () => void][] = [
  ['canvas-test-hook:busy', () => {
    for (;;) {
      /* an unknown super-linear path: never returns */
    }
  }],
  ['canvas-test-hook:alloc', () => {
    // 8 MiB of the old generation per step: as fast as the heap fills
    const hold: unknown[] = [];
    for (;;) hold.push(new Array(1 << 20).fill(hold.length + 0.5));
  }],
  ['canvas-test-hook:throw', () => {
    throw new Error('test hook');
  }],
];
const decoder = new TextDecoder('latin1');
function testHook(update: Uint8Array): void {
  if (!init.testHooks) return;
  const text = decoder.decode(update);
  for (const [marker, run] of HOOKS) if (text.includes(marker)) run();
}

function serve(req: WorkerRequest): unknown {
  switch (req.op) {
    case 'load': {
      const r = core.load(req.ledger, req.content, req.recovery);
      return { ...r, writers: core.writers() };
    }
    case 'replay':
      core.replay(req.entries);
      return null;
    case 'check':
      testHook(req.update);
      return { check: core.check(req.update, req.writer, new Set(req.claimed)) };
    case 'apply':
      return core.apply(req.identity);
    case 'drop':
      core.drop();
      return null;
    case 'diff':
      return core.diff(req.sv, req.joinSv, req.refuseEmpty);
    case 'frames':
      return core.frames(req.content, req.ledger, req.sv);
    case 'save':
      return core.save();
    case 'inspect': {
      const f = core.frames(true, true, false);
      return { content: f.content, ledger: f.ledger, pending: core.hasPending() };
    }
  }
}

/** Buffers that are the worker's own (sent without a copy). */
function transferList(v: unknown, out: ArrayBuffer[] = [], depth = 0): ArrayBuffer[] {
  if (depth > 4 || v === null || typeof v !== 'object') return out;
  if (v instanceof Uint8Array) {
    if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer && !out.includes(v.buffer)) out.push(v.buffer);
    return out;
  }
  for (const x of Array.isArray(v) ? v : Object.values(v)) transferList(x, out, depth + 1);
  return out;
}

port.on('message', (msg: { id: number; req: WorkerRequest }) => {
  const t0 = performance.now();
  let reply: WorkerReply;
  try {
    const result = serve(msg.req);
    const { emitted, writers } = core.take();
    reply = { id: msg.id, ok: true, result, emitted, writers, maxUserIdBytes: core.maxUserIdBytes, ms: performance.now() - t0 };
  } catch (err) {
    core.take();
    reply = { id: msg.id, ok: false, error: String(err), ms: performance.now() - t0 };
  }
  port.postMessage(reply, transferList(reply));
});
port.postMessage({ ready: true });
