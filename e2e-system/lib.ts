/**
 * Helpers for the full-system suite: the canvas running as a plugin of the REAL artifacts
 * core (deploy/compose/compose.yml). Nothing here is faked — publishing goes through the
 * core's CLI, logins through oauth2-proxy and Dex in the browser, authz through the gate,
 * storage through MinIO. Docker access is only used for what an operator would do by hand:
 * the admin `mc` alias inside the MinIO container and restarting the canvas container.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const CORE_DIR = path.resolve(process.env.ARTIFACTS_CORE_DIR ?? path.join(REPO, '..', 'artifacts'));
export const BASE = (process.env.SYSTEM_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
export const S3_WRITE = process.env.SYSTEM_S3_URL ?? 'http://127.0.0.1:9000';
export const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'artifacts';
/** Must match the stack (deploy/compose/compose.yml + canvas.env). */
export const RECHECK_SECONDS = Number(process.env.SYSTEM_RECHECK_SECONDS ?? 3);
export const ACL_CACHE_SECONDS = Number(process.env.SYSTEM_ACL_CACHE_SECONDS ?? 2);

/** The core's Dex users; `name` is the display name (id_token `name` claim, via the gate). */
export const USERS = {
  user1: { email: 'test@example.com', password: 'test-password', name: 'Test One' },
  user2: { email: 'test2@example.com', password: 'test2-password', name: 'Test Two' },
  user3: { email: 'test3@example.com', password: 'test3-password', name: 'Test Three' },
} as const;
export type UserName = keyof typeof USERS;

/**
 * The id of the running container of a compose service of the stack. Compose labels the image it
 * builds with the project and service too, so a `docker run` of that image (or a `docker compose
 * run` one-off) also matches those two labels: only the service's own container carries
 * `com.docker.compose.oneoff=False`. More than one match is an error, never a guess (review T-1: a
 * throwaway container of the image was picked and the suite read and restarted the wrong one).
 */
export function container(service: string): string {
  const ids = execFileSync('docker', [
    'ps', '-q',
    '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', 'label=com.docker.compose.oneoff=False',
  ], { encoding: 'utf8' }).trim().split('\n').filter((s) => s !== '');
  if (ids.length === 0) throw new Error(`service ${service} of compose project ${PROJECT} is not running`);
  if (ids.length > 1) throw new Error(`service ${service} of compose project ${PROJECT}: ${ids.length} running containers (${ids.join(', ')}), expected one`);
  return ids[0];
}

/** Run `mc` inside the MinIO container with the admin alias `local` (MinIO root). */
export function mc(script: string, input?: string | Buffer): { code: number; out: string; err: string } {
  const r = spawnSync('docker', ['exec', '-i', container('minio'), 'sh', '-ec',
    `export PATH=/opt/bitnami/minio-client/bin:$PATH
mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null
${script}`], { input: typeof input === 'string' ? Buffer.from(input) : input, encoding: 'buffer' });
  return { code: r.status ?? -1, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') };
}

export function mcBytes(objectPath: string): Buffer | null {
  const r = spawnSync('docker', ['exec', container('minio'), 'sh', '-ec',
    `export PATH=/opt/bitnami/minio-client/bin:$PATH
mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null
mc cat "local/${objectPath}"`], { encoding: 'buffer' });
  return r.status === 0 ? r.stdout : null;
}

/** Tall artifact so the canvas has room; the CLI wraps runs in an index.html. */
export const ARTIFACT_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>System e2e report</title></head>' +
  '<body style="margin:0;font-family:sans-serif"><h1 style="margin:24px">System e2e report</h1>' +
  '<div style="height:1600px;background:linear-gradient(#fff,#eef)">content</div></body></html>';

export interface Published { run: string; index: string; canvas: string; key: string; out: string }

/** Publish with the core's real CLI and return the links it printed. */
export function publish(audience: { users: string[] } | 'pub', run: string): Published {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sys-'));
  const file = path.join(dir, 'report.html');
  fs.writeFileSync(file, ARTIFACT_HTML);
  const args = [path.join(CORE_DIR, 'cli', 'publish.sh'),
    ...(audience === 'pub' ? ['-g', 'pub'] : ['-u', audience.users.join(',')]),
    '-r', run, '-t', '7', '-a', 'system-e2e', '-s', 'canvas', file];
  let out: string;
  try {
    out = execFileSync('bash', args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARTIFACTS_ACCESS_KEY: 'minioadmin', ARTIFACTS_SECRET_KEY: 'minioadmin',
        ARTIFACTS_WRITE_BASE: S3_WRITE, ARTIFACTS_READ_BASE: BASE,
        ARTIFACTS_PLUGINS: 'canvas=/_canvas/',
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const index = /INDEX \(deliver this link\): (\S+)/.exec(out)?.[1];
  const canvas = /open with canvas: (\S+)/.exec(out)?.[1];
  if (!index || !canvas) throw new Error(`CLI did not print the links:\n${out}`);
  const key = index.slice(`${BASE}/artifacts/`.length);
  return { run, index, canvas, key, out };
}

/** Fresh browser context that records the canvas WebSocket close codes in window.__wsCloses. */
export async function newContext(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
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
  return ctx;
}

/**
 * Open `url` and go through the real login chain if it asks for one: the canvas (or the
 * artifact) redirects to oauth2-proxy, which redirects to Dex; we fill Dex's password form
 * (and its approval screen, when shown) and follow the redirects back to `url`.
 * Returns the status of the final document response.
 */
export async function openWithLogin(page: Page, url: string, user: UserName): Promise<number> {
  const first = await gotoRetrying(page, url);
  if (!/\/dex\//.test(page.url())) return first?.status() ?? 0;
  const { email, password } = USERS[user];
  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const back = page.waitForResponse((r) => r.request().isNavigationRequest() && r.url().split('?')[0] === url.split('?')[0], { timeout: 20_000 });
  await page.locator('button[type="submit"]').click();
  // Dex shows an approval screen unless skipApprovalScreen is set: grant it.
  const grant = page.locator('button[type="submit"][value="approve"], button:has-text("Grant Access")');
  const res = await Promise.race([
    back,
    grant.first().waitFor({ timeout: 20_000 }).then(
      async () => {
        await grant.first().click();
        return back;
      },
      () => back,
    ),
  ]);
  await page.waitForURL((u) => u.href.split('?')[0] === url.split('?')[0], { timeout: 20_000 });
  await page.waitForLoadState('load');
  return res.status();
}

/**
 * `page.goto` that retries a navigation the network dropped: right after `docker restart` the
 * Docker bridge can briefly change under Chromium (net::ERR_NETWORK_CHANGED, seen once in
 * three fv4 runs of test d) or the port can refuse for a moment. Anything else is rethrown.
 */
export async function gotoRetrying(page: Page, url: string, attempts = 5): Promise<Awaited<ReturnType<Page['goto']>>> {
  for (let i = 1; ; i++) {
    try {
      return await page.goto(url);
    } catch (err) {
      const transient = /ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|NS_ERROR_NET_RESET/.test(String(err));
      if (!transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

/** Wait until the canvas editor is live against the real server. */
export async function editorReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const c = (window as any).__canvas;
    return c?.editor?.me && c.editor.status === 'synced';
  }, undefined, { timeout: 20_000 });
}

export const shapes = (page: Page): Promise<{ id: string; type: string; points?: number[] }[]> =>
  page.evaluate(() => (window as any).__canvas.editor.doc.all());

export const me = (page: Page): Promise<{ id: string; name: string; anonymous: boolean }> =>
  page.evaluate(() => {
    const m = (window as any).__canvas.editor.me;
    return { id: m.id, name: m.name, anonymous: m.anonymous };
  });

export const wsCloses = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...((window as any).__wsCloses as number[])]);

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Raw WebSocket probe from Node (no browser): resolves with the close code. Sends the
 * browser's Origin (BASE) unless `headers` overrides it (`origin: ''` = send none).
 */
export async function wsCloseCode(pathAndQuery: string, headers: Record<string, string> = {}): Promise<number> {
  const { WebSocket } = await import('ws');
  const h: Record<string, string> = { origin: BASE, ...headers };
  if (h.origin === '') delete h.origin;
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}${pathAndQuery}`, { headers: h });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket neither closed nor refused')), 15_000);
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); resolve(res.statusCode ?? -1); });
    ws.on('error', () => undefined);
  });
}
