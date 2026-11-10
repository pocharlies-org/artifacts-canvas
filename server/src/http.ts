import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import type { AuthzClient } from './authz.js';
import { artifactState } from './expiry.js';
import type { RoomManager } from './rooms.js';
import type { AuthzResult } from './types.js';
import { stripBucketSegment, validateArtifactKey } from './paths.js';
import type { CanvasObjectStore } from './store.js';

export interface HttpDeps {
  cfg: Config;
  authz: AuthzClient;
  manager: RoomManager;
  store: CanvasObjectStore;
  log: Logger;
  metrics: Metrics;
  fetchImpl: typeof fetch;
}

/** The plugin prefix. The ingress may forward the full path or strip it; both work. */
export const CANVAS_PREFIX_PATH = '/_canvas';

const WRAPPER_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const FRAME_HEADERS: Record<string, string> = {
  'content-security-policy': 'sandbox allow-scripts',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Cap for artifact HTML fetched for the frame route. */
const MAX_FRAME_BYTES = 20 * 1024 * 1024;

/** Insert the reporter as an inline script (docs/protocol.md §3; same algorithm as client/dev/plugin.ts). */
export function injectReporter(html: string, reporter: string): string {
  const tag = `<script>${reporter.replace(/<\/script/gi, '<\\/script')}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tag);
  const d = html.match(/<!doctype[^>]*>/i);
  if (d) return html.replace(d[0], d[0] + tag);
  return tag + html;
}

/** Inject the inline wrapper config (docs/protocol.md §2). `<` escaped so it can never close the tag. */
export function injectConfig(html: string, config: Record<string, unknown>): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="artifacts-canvas-config">${json}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tag);
  const d = html.match(/<!doctype[^>]*>/i);
  if (d) return html.replace(d[0], d[0] + tag);
  return tag + html;
}

/** Resolve `rel` inside `base` without traversal (same semantics as the client dev plugin). */
export function safeJoin(base: string, rel: string): string | null {
  const clean = rel.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const p = path.resolve(base, clean);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export class HttpApp {
  private readyzCache: { ok: boolean; at: number } | null = null;

  constructor(private readonly deps: HttpDeps) {}

  handler = (req: IncomingMessage, res: ServerResponse): void => {
    void this.route(req, res).catch((err) => {
      this.deps.log.error({ err: String(err) }, 'http handler error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  };

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { cfg } = this.deps;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.end('method not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    let p = decodeURIComponent(url.pathname);
    if (p.startsWith(CANVAS_PREFIX_PATH + '/')) p = p.slice(CANVAS_PREFIX_PATH.length);
    else if (p === CANVAS_PREFIX_PATH) p = '/';

    // --- operational endpoints (no artifact data, no authz) ---
    if (p === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end('{"ok":true}');
      return;
    }
    if (p === '/readyz') {
      const ok = await this.ready();
      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(ok ? '{"ready":true}' : '{"ready":false}');
      return;
    }
    if (p === '/metrics') {
      res.statusCode = 200;
      res.setHeader('content-type', this.deps.metrics.registry.contentType);
      res.end(await this.deps.metrics.registry.metrics());
      return;
    }

    const cookie = req.headers.cookie ?? '';
    const authorization = req.headers.authorization ?? '';
    const reserved = p.startsWith('/_/');

    // --- frame route (artifact HTML + reporter, artifact data: authz required) ---
    if (reserved && p.startsWith('/_/frame/')) {
      const checked = validateArtifactKey(
        stripBucketSegment(p.slice('/_/frame/'.length), cfg.s3Bucket),
        cfg.artifactPrefixes,
      );
      if (!checked.ok) {
        this.generic(res, 400);
        return;
      }
      const key = checked.key;
      const gate = await this.gate(cookie, key, authorization);
      if (!gate.ok) {
        this.generic(res, gate.status);
        return;
      }
      await this.serveFrame(req, res, key, cookie, authorization);
      return;
    }

    // --- static bundle (no artifact data: no authz) ---
    if (reserved) {
      // `/_/` is the reserved marker, not a directory: the bundle root is staticDir.
      const file = safeJoin(cfg.staticDir, p.slice('/_/'.length));
      if (!file) {
        this.generic(res, 400);
        return;
      }
      let data: Buffer;
      try {
        data = fs.readFileSync(file);
      } catch {
        this.generic(res, 404);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.statusCode = 200;
      res.setHeader('content-type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
      res.setHeader('x-content-type-options', 'nosniff');
      // Vite hashes asset filenames; everything else stays revalidatable.
      res.setHeader(
        'cache-control',
        p.startsWith('/_/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      );
      res.end(req.method === 'HEAD' ? undefined : data);
      return;
    }

    // --- wrapper page (artifact data only via later authz'd routes, but it names the
    // artifact, so the gate must allow it: docs/protocol.md §1) ---
    if (p === '/' || p === '') {
      this.generic(res, 404);
      return;
    }
    // Wrapper page: accept the core link shape `/_canvas/<bucket>/<key>` and the client
    // shape `/_canvas/<key>`; the canonical key (without bucket) is what authz and the
    // injected config use.
    const checked = validateArtifactKey(stripBucketSegment(p.replace(/^\//, ''), cfg.s3Bucket), cfg.artifactPrefixes);
    if (!checked.ok) {
      this.generic(res, 400);
      return;
    }
    const key = checked.key;
    const gate = await this.gate(cookie, key, authorization);
    if (!gate.ok) {
      if (gate.login && cfg.loginUrl) {
        // No session at all on an artifact that needs one: send the visitor through the
        // core's login and back here (the gate does the same for artifact reads). Says
        // nothing about the artifact: every unauthenticated non-pub key answers this way.
        res.statusCode = 302;
        res.setHeader('location', cfg.loginUrl.replace('{rd}', encodeURIComponent(req.url ?? '/')));
        res.setHeader('cache-control', 'no-store');
        res.end();
        return;
      }
      this.generic(res, gate.status);
      return;
    }
    let html: string;
    try {
      html = fs.readFileSync(path.join(cfg.staticDir, 'index.html'), 'utf8');
    } catch {
      this.deps.log.error('client bundle missing: build client/dist');
      res.statusCode = 503;
      res.end('canvas client bundle not installed');
      return;
    }
    if (cfg.injectConfig) {
      const anon = gate.res.identity?.anonymous ?? false;
      html = injectConfig(html, {
        artifactPath: key,
        dev: false,
        maxImageBytes: anon ? cfg.anonMaxImageBytes : cfg.maxImageBytes,
      });
    }
    res.statusCode = 200;
    for (const [k, v] of Object.entries(WRAPPER_HEADERS)) res.setHeader(k, v);
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  /**
   * Gate a route that reveals an artifact. Answers exactly like the gate would, with no
   * existence leak: deny → 403, gone → 404 (canvas object deleted), expired → 410 (canvas
   * object deleted).
   */
  private async gate(
    cookie: string,
    key: string,
    authorization = '',
  ): Promise<{ ok: true; res: AuthzResult } | { ok: false; status: number; login?: boolean }> {
    const { cfg, authz, manager } = this.deps;
    const res = await authz.authorize(cookie, key, authorization);
    const state = artifactState(res, cfg);
    if (state === 'gone') {
      void manager.expireRoom(key, 'gone');
      return { ok: false, status: 404 };
    }
    if (state === 'expired') {
      void manager.expireRoom(key, 'expired');
      return { ok: false, status: 410 };
    }
    // `unauthenticated` is the gate's answer for a visitor with no session (docs/plugins.md §1).
    if (!res.allowed) return { ok: false, status: 403, login: res.reason === 'unauthenticated' && !isBearer(authorization) };
    return { ok: true, res };
  }

  private generic(res: ServerResponse, status: number): void {
    res.statusCode = status;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(status === 404 ? 'not found' : status === 410 ? 'gone' : status === 403 ? 'forbidden' : 'bad request');
  }

  private async ready(): Promise<boolean> {
    const { cfg } = this.deps;
    const now = Date.now();
    if (this.readyzCache && now - this.readyzCache.at < cfg.readyzCacheMs) return this.readyzCache.ok;
    let ok = false;
    try {
      ok = await this.deps.store.ready();
    } catch {
      ok = false;
    }
    this.readyzCache = { ok, at: now };
    return ok;
  }

  private async serveFrame(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    cookie: string,
    authorization = '',
  ): Promise<void> {
    const { cfg, fetchImpl, log } = this.deps;
    const target = `${cfg.artifactBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.frameFetchTimeoutMs);
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        // The core's gate accepts the visitor cookie or a forwarded bearer token.
        headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (err) {
      log.warn({ err: String(err), key }, 'frame fetch failed');
      this.generic(res, upstream_status_for_fetch_error(err));
      return;
    } finally {
      clearTimeout(timer);
    }
    if (upstream.status === 404) {
      void this.deps.manager.expireRoom(key, 'gone');
      this.generic(res, 404);
      return;
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      // The core must serve artifacts directly; following redirects could leak the
      // visitor cookie to another origin.
      this.generic(res, 403);
      return;
    }
    if (!upstream.ok) {
      this.generic(res, upstream.status === 403 ? 403 : 502);
      return;
    }
    const ctype = upstream.headers.get('content-type') ?? '';
    for (const [k, v] of Object.entries(FRAME_HEADERS)) res.setHeader(k, v);
    if (!ctype.includes('text/html')) {
      // Non-HTML artifacts are out of scope for v1 (docs/protocol.md §3); pass the bytes
      // through into the sandboxed frame unchanged.
      res.statusCode = 200;
      res.setHeader('content-type', ctype || 'application/octet-stream');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('content-length', len);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
      res.end(body);
      return;
    }
    let html = await upstream.text();
    if (Buffer.byteLength(html) > MAX_FRAME_BYTES) {
      this.generic(res, 413);
      return;
    }
    let reporter: string;
    try {
      reporter = fs.readFileSync(path.join(cfg.staticDir, 'reporter.js'), 'utf8');
    } catch {
      log.error('reporter.js missing from client bundle');
      this.generic(res, 503);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : injectReporter(html, reporter));
  }
}

/** Scripted callers (bearer token) must get the 403, never a login redirect. */
function isBearer(authorization: string): boolean {
  return /^bearer\s/i.test(authorization);
}

function upstream_status_for_fetch_error(err: unknown): number {
  const msg = String(err);
  if (msg.includes('abort') || msg.includes('timeout')) return 504;
  if (msg.includes('404')) return 404;
  return 502;
}
