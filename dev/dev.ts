/**
 * `npm run dev` — the whole product on your laptop, through the production code path.
 *
 *   fake core (:9401)   gate authz + artifact HTML, with a /login page so two browser
 *                       windows can be two different verified users;
 *   S3 mock   (:9402)   in-memory object store (dev/s3-mock.ts);
 *   canvas server       the REAL server (server/dist/index.js) on :8080, serving the
 *                       client bundle from client/dist while `vite build --watch`
 *                       rebuilds it;
 *
 * Collaboration, attribution, revocation and persistence all run through the same code
 * that ships — not the client's in-memory dev room (which stays for unit/e2e tests via
 * `npm run dev -w client`).
 *
 * Ctrl-C stops only the processes this script started.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCore, devFallback } from './fake-core.js';
import { startS3Mock } from './s3-mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const clientDir = path.join(root, 'client');
const bin = (name: string): string =>
  path.join(root, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));

const num = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const CORE_PORT = num('DEV_CORE_PORT', 9401);
const S3_PORT = num('DEV_S3_PORT', 9402);
const SERVER_PORT = num('PORT', 8080);

const children: ChildProcess[] = [];
function spawnChild(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && !shuttingDown) {
      console.error(`[dev] ${path.basename(cmd)} exited with code ${code}; stopping`);
      void shutdown(code);
    }
  });
  children.push(child);
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

/** Seed the fake core with the sample artifacts (also under `pub/`, so the anonymous
 *  path is demoable without touching the rules). */
function seedArtifacts(core: { artifacts: Map<string, string> }): void {
  const dir = path.join(clientDir, 'dev', 'artifacts');
  const walk = (d: string, prefix: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.name.endsWith('.html')) {
        const html = fs.readFileSync(full, 'utf8');
        core.artifacts.set(rel, html);
        core.artifacts.set(`pub/${rel}`, html);
      }
    }
  };
  walk(dir, '');
}

async function main(): Promise<void> {
  const core = await startFakeCore({ control: true, login: true, port: CORE_PORT, fallback: devFallback });
  seedArtifacts(core);
  const s3 = await startS3Mock(S3_PORT);

  // Rebuild the client bundle on change; the server serves it from client/dist.
  spawnChild(bin('vite'), ['build', '--watch'], {
    cwd: clientDir,
    env: { VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  });

  // The real server, pointed at the fake core and the S3 mock.
  spawnChild(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], {
    cwd: root,
    env: {
      HOST: '127.0.0.1',
      PORT: String(SERVER_PORT),
      GATE_AUTHZ_URL: `${core.authzUrl}`,
      ARTIFACT_BASE_URL: core.artifactBaseUrl,
      S3_ENDPOINT: s3.url,
      S3_BUCKET: 'artifacts',
      S3_ACCESS_KEY_ID: 'dev',
      S3_SECRET_ACCESS_KEY: 'dev',
      S3_FORCE_PATH_STYLE: 'true',
      STATIC_DIR: path.join(clientDir, 'dist'),
      AUTHZ_RECHECK_SECONDS: '5',
      SAVE_DEBOUNCE_MS: '500',
      // the browser opens the canvas on the server's own origin
      ALLOWED_ORIGINS: `http://127.0.0.1:${SERVER_PORT},http://localhost:${SERVER_PORT}`,
      METRICS_PORT: String(num('DEV_METRICS_PORT', 9403)),
      METRICS_HOST: '127.0.0.1',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    },
  });

  const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;
  const demo = (as: string): string =>
    `${core.url}/login?as=${as}&next=${encodeURIComponent(`${serverUrl}/_canvas/pub/sample-report.html`)}`;
  console.log(`
artifacts-canvas dev stack (real server, fake core, in-memory S3)

  Open in two windows to collaborate as two verified users:
    window A (alice): ${demo('alice')}
    window B (bob):   ${demo('bob')}

  Anonymous (allowed on pub/ keys only):
    ${serverUrl}/_canvas/pub/sample-report.html

  Private key (needs one of the logins above):
    ${serverUrl}/_canvas/sample-report.html

  Canvas objects land in the S3 mock as _plugins/canvas/<key>.ydoc (in memory only).
  Ctrl-C stops everything.`);
}

void main().catch((err) => {
  console.error('[dev] failed to start:', err);
  process.exit(1);
});
