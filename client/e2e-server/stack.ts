/**
 * End-to-end stack against the REAL server: fake core (dev/fake-core.ts) + in-memory S3
 * (dev/s3-mock.ts) + `node server/dist/index.js` on a free port. The browser talks to the
 * production code path — authz, stamper, persistence, re-checks — nothing is stubbed in
 * the server. Only the PIDs this module spawns are ever killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeUpdate } from 'y-protocols/sync';
import { startFakeCore, type CoreRule, type FakeCore } from '../../dev/fake-core';
import { startS3Mock, type S3Mock } from '../../dev/s3-mock';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SERVER_ENTRY = path.join(repoRoot, 'server', 'dist', 'index.js');
const STATIC_DIR = path.join(repoRoot, 'client', 'dist');

export interface Stack {
  core: FakeCore;
  s3: S3Mock;
  /** http://127.0.0.1:<port> */
  serverUrl: string;
  /** ws://127.0.0.1:<port> */
  wsUrl: string;
  /** Every line the server wrote to stderr (for failure messages). */
  serverLog(): string;
  /** Stop and start the server process again on the SAME port (state lives in the S3 mock). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function startStack(): Promise<Stack> {
  const core = await startFakeCore({ control: true });
  const s3 = await startS3Mock();
  const port = await freePort();
  let child: ChildProcess | null = null;
  let log = '';

  const spawnServer = async (): Promise<void> => {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        GATE_AUTHZ_URL: core.authzUrl,
        ARTIFACT_BASE_URL: core.artifactBaseUrl,
        S3_ENDPOINT: s3.url,
        S3_BUCKET: 'artifacts',
        S3_ACCESS_KEY_ID: 'e2e',
        S3_SECRET_ACCESS_KEY: 'e2e',
        S3_FORCE_PATH_STYLE: 'true',
        STATIC_DIR,
        AUTHZ_RECHECK_SECONDS: '1',
        SAVE_DEBOUNCE_MS: '200',
        SWEEP_INTERVAL_SECONDS: '3600',
        // the browser opens the canvas on the server's own origin
        ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        METRICS_PORT: '0',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (log += d));
    child.stderr?.on('data', (d) => (log += d));
    const exited = new Promise<number>((resolve) => child!.on('exit', (code) => resolve(code ?? -1)));
    try {
      await Promise.race([waitForHealth(`http://127.0.0.1:${port}`, 15_000), exited.then((c) => {
        throw new Error(`server exited early with code ${c}\n${log}`);
      })]);
    } catch (err) {
      if (child && !child.killed) child.kill('SIGKILL');
      throw err;
    }
  };
  await spawnServer();

  const stopChild = (): Promise<void> =>
    new Promise((resolve) => {
      if (!child) return resolve();
      const c = child;
      child = null;
      c.once('exit', () => resolve());
      c.kill('SIGTERM');
      setTimeout(() => {
        if (!c.killed) c.kill('SIGKILL');
      }, 5_000).unref();
    });

  return {
    core,
    s3,
    serverUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    serverLog: () => log,
    async restart() {
      await stopChild();
      await spawnServer();
    },
    async stop() {
      await stopChild();
      await core.close();
      await s3.close();
    },
  };
}

/** Tall enough that the editor's ready gate (pageHeight > 1000) is meaningful. */
export const ARTIFACT_HTML =
  '<!doctype html><html><head><title>E2E</title></head><body style="margin:0">' +
  '<div style="height:1600px;background:linear-gradient(#fff,#eef)">E2E artifact</div></body></html>';

/**
 * Seed an artifact and allow ONE visitor (verified) on it — per-visitor, like the real
 * core answers. Anyone else on this key is denied as `not-shared` (the artifact exists,
 * so "object-missing" would lie).
 */
export function allowUser(core: FakeCore, key: string, user: string, id: string, name: string, extra: Partial<CoreRule> = {}): void {
  core.artifacts.set(key, ARTIFACT_HTML);
  core.rules.set(key, { allowed: false, reason: 'not-shared', user: { id: null, name: 'anonymous', anonymous: true } });
  core.rulesByCookie.set(`canvas_e2e_user=${user}|${key}`, {
    allowed: true, reason: 'owner', user: { id, name, anonymous: false }, ...extra,
  });
}

/** Seed an artifact and open it to anonymous (the `pub/` shape). */
export function allowAnonKey(core: FakeCore, key: string): void {
  core.artifacts.set(key, ARTIFACT_HTML);
  core.rules.set(key, { allowed: true, reason: 'pub', user: { id: null, name: 'anonymous', anonymous: true } });
}

/** The cookie the fake core reads as the visitor identity. */
export const cookieFor = (user: string): string => `canvas_e2e_user=${user}`;

/**
 * Open the wrapper as `user` (cookie identity) in a fresh context, with WebSocket close
 * codes on the canvas route recorded in `window.__wsCloses`. Resolves when the editor is
 * live (synced) against the real server.
 */
export async function openAs(
  stack: Stack,
  browser: import('@playwright/test').Browser,
  user: string | null,
  key: string,
): Promise<{ page: import('@playwright/test').Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (user) {
    await ctx.addCookies([{ name: 'canvas_e2e_user', value: user, url: stack.serverUrl }]);
  }
  await ctx.addInitScript(() => {
    const closes: number[] = [];
    (window as unknown as Record<string, unknown>).__wsCloses = closes;
    const Orig = window.WebSocket;
    class Tracked extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/_canvas/_/ws/')) {
          this.addEventListener('close', (e) => closes.push((e as CloseEvent).code));
        }
      }
    }
    (window as unknown as Record<string, unknown>).WebSocket = Tracked;
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[e2e-server] pageerror`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[e2e-server] console.${m.type()}`, m.text());
  });
  const res = await page.goto(`${stack.serverUrl}/_canvas/${key.split('/').map(encodeURIComponent).join('/')}`);
  if (!res?.ok()) throw new Error(`wrapper ${res?.status()} for ${key}: ${await res?.text().catch(() => '')}`);
  await page.waitForFunction(() => {
    const c = (window as any).__canvas;
    return c?.editor?.me && c.editor.status === 'synced' && c.editor.pageHeight > 1000;
  });
  return { page, close: () => ctx.close() };
}

/** Raw y-websocket client (the "attacker" / probe): identity first, then whatever you send. */
export async function rawConnect(stack: Stack, key: string, user: string | null): Promise<WebSocket> {
  const ws = new WebSocket(
    `${stack.wsUrl}/_canvas/_/ws/${key.split('/').map(encodeURIComponent).join('/')}`,
    // a browser on the canvas page sends this Origin; the server refuses any other
    { headers: { origin: stack.serverUrl, ...(user ? { cookie: cookieFor(user) } : {}) } },
  );
  // The client never sends IDENTITY (protocol §4: it is server → client and MUST be the
  // first message). Wait for the server's IDENTITY: it proves the authz join finished and
  // the message handler is attached, so anything we send next is processed for real.
  // A socket that is refused closes with its protocol code instead — recorded for
  // expectClose, which also handles an already-closed socket.
  // The listeners are attached BEFORE `open`: the server sends IDENTITY the moment it
  // accepts the upgrade, and a message emitted while we were still awaiting `open` would
  // be lost (flaky "unexpected first server message", seen 2026-11-10).
  (ws as WebSocket & { __closeCode?: number }).__closeCode = undefined;
  ws.on('close', (code) => {
    (ws as WebSocket & { __closeCode?: number }).__closeCode = code;
  });
  const first = await new Promise<number | 'closed'>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no first message from server')), 5_000);
    ws.once('message', (data) => {
      clearTimeout(t);
      resolve(new Uint8Array(data as ArrayBuffer)[0] ?? -1);
    });
    ws.once('close', () => {
      clearTimeout(t);
      resolve('closed'); // refused connection: expectClose on the caller will check the code
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
  if (first === 100 || first === 'closed') return ws;
  throw new Error(`unexpected first server message (type ${first})`);
}

/** Send an update that writes `root.set(entryKey, value)` — a forged attribution write. */
export function sendForgedRootWrite(ws: WebSocket, root: 'attribution' | 'users' | 'history', entryKey: string, value: unknown): void {
  const forge = new Y.Doc();
  forge.getMap(root).set(entryKey, value);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // messageSync
  writeUpdate(enc, Y.encodeStateAsUpdate(forge)); // exactly what y-websocket sends for a client update
  ws.send(encoding.toUint8Array(enc));
}

/**
 * Same forged write, smuggled inside a SyncStep2 — the answer a client gives to the server's
 * step 1 on join (y-protocols: messageYjsSyncStep2 + varUint8Array(update), no state vector).
 */
export function sendForgedRootWriteAsStep2(ws: WebSocket, root: 'attribution' | 'users' | 'history', entryKey: string, value: unknown): void {
  const forge = new Y.Doc();
  forge.getMap(root).set(entryKey, value);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // messageSync
  encoding.writeVarUint(enc, 1); // messageYjsSyncStep2
  encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(forge));
  ws.send(encoding.toUint8Array(enc));
}

export function expectClose(ws: WebSocket, code: number, timeoutMs = 8_000): Promise<void> {
  const already = (ws as WebSocket & { __closeCode?: number }).__closeCode;
  if (already !== undefined) {
    return already === code
      ? Promise.resolve()
      : Promise.reject(new Error(`closed with ${already}, expected ${code}`));
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`expected close ${code}, socket still open`)), timeoutMs);
    ws.once('close', (c) => {
      clearTimeout(t);
      if (c === code) resolve();
      else reject(new Error(`closed with ${c}, expected ${code}`));
    });
  });
}

/** Poll the S3 mock for the canvas object of `key` (returns its bytes when present). */
export async function s3CanvasObject(stack: Stack, key: string, timeoutMs = 10_000): Promise<Uint8Array | null> {
  const objectKey = `_plugins/canvas/${key}.ydoc`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${stack.s3.url}/_e2e/object?key=${encodeURIComponent(objectKey)}`);
    if (r.ok) {
      const j = (await r.json()) as { base64: string };
      return new Uint8Array(Buffer.from(j.base64, 'base64'));
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 8_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
