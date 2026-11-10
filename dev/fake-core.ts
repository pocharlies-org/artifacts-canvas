/**
 * Fake artifacts core — the single source of truth for "a core" in this repository.
 *
 * Implements `POST /_gate/plugin/authz` exactly as the real gate does (core repo
 * `gate/gate.py::_handle_plugin_authz`, `docs/plugins.md` §1) and serves artifact HTML
 * under `/artifacts/<key>` for the canvas server's frame route. Used by:
 *   - `npm run dev` (dev/dev.ts): with a login page so two browser windows can open
 *     the canvas as two different verified users;
 *   - the server unit tests (server/test/helpers/fakecore.ts re-exports this module);
 *   - the end-to-end suite against the real server (client/e2e-server), which uses the
 *     control API to flip rules mid-session (revocation, expiry).
 *
 * Identity model: the request cookie `canvas_e2e_user=<name>` marks a logged-in user
 * (id `u-<name>`, name `<name>`); no cookie = anonymous. Rules are per key, with an
 * optional per-visitor override keyed by the raw cookie.
 *
 * Control API (only when the `control` option is on):
 *   POST /_e2e/rule      {"key":"...", "cookie":"..."?, "rule":{...}|null}   set/remove a rule
 *   POST /_e2e/artifact  {"key":"...", "html":"..."}                         set artifact HTML
 *   GET  /_e2e/calls     every authz call received, in order
 *   POST /_e2e/broken    {"status":500,"body":"..."} | {"broken":null}       force gate failures
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CoreRule {
  allowed: boolean;
  reason: string;
  user?: { id: string | null; name: string; anonymous: boolean };
  artifact?: { key?: string; expires?: string | null; ttl?: number | null };
}

export interface FakeCoreOptions {
  /** Enable the /_e2e/* control endpoints (e2e and dev). */
  control?: boolean;
  /** Serve the dev login page (GET /login?as=<name> sets the cookie and redirects). */
  login?: boolean;
  /** Fixed port (0 = ephemeral). */
  port?: number;
  /**
   * Answer when no rule matches the key (used by `npm run dev`: any logged-in visitor is
   * allowed, `pub/` keys are open to anonymous). Return null for the default
   * object-missing denial.
   */
  fallback?: (key: string, cookie: string) => CoreRule | null;
}

export interface FakeCore {
  url: string;
  authzUrl: string;
  artifactBaseUrl: string;
  /** key -> rule. Missing key => deny with reason "object-missing". */
  rules: Map<string, CoreRule>;
  /** `${cookie}|${key}` -> rule, checked before `rules` (per-visitor answers). */
  rulesByCookie: Map<string, CoreRule>;
  /** key -> artifact HTML served by /artifacts/<key>. */
  artifacts: Map<string, string>;
  /** every authz call received, in order (key = decoded artifact key). */
  calls: { artifact: string; key: string; cookie: string; authorization: string }[];
  /** when set, authz answers with this raw status/body instead of consulting rules. */
  broken: { status: number; body: string } | null;
  /** when set, authz never answers (tests the timeout path). */
  hang: boolean;
  close(): Promise<void>;
}

/** The gate's _bad_key: keys it never serves on any route. */
function badKey(key: string): boolean {
  if (!key || key.endsWith('/')) return true;
  if (key === '.acl.json' || key.endsWith('/.acl.json')) return true;
  if (key === '_gate' || key.startsWith('_gate/')) return true;
  if (key === '_plugins' || key.startsWith('_plugins/')) return true;
  if (key.split('/').some((seg) => seg === '.' || seg === '..')) return true;
  return false;
}

/** The visitor identity carried by the cookie (see the module header). */
export function userFromCookie(cookie: string): { id: string; name: string; anonymous: boolean } | null {
  const m = /(?:^|;\s*)canvas_e2e_user=([^;]+)/.exec(cookie);
  if (!m) return null;
  const name = decodeURIComponent(m[1]).slice(0, 64);
  if (!name) return null;
  return { id: `u-${name}`, name, anonymous: false };
}

export async function startFakeCore(opts: FakeCoreOptions = {}): Promise<FakeCore> {
  const rules = new Map<string, CoreRule>();
  const rulesByCookie = new Map<string, CoreRule>();
  const artifacts = new Map<string, string>();
  const calls: FakeCore['calls'] = [];
  const state: { broken: FakeCore['broken']; hang: boolean } = { broken: null, hang: false };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://core');
    const send = (status: number, obj: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };

    // --- control API (e2e/dev only) ---
    if (opts.control && url.pathname.startsWith('/_e2e/')) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          /* GET endpoints need no body */
        }
        if (url.pathname === '/_e2e/rule') {
          const key = String(body.key ?? '');
          const cookie = body.cookie === undefined ? null : String(body.cookie);
          const rule = (body.rule ?? null) as CoreRule | null;
          const map = cookie === null ? rules : rulesByCookie;
          const mk = cookie === null ? key : `${cookie}|${key}`;
          if (rule === null) map.delete(mk);
          else map.set(mk, rule);
          return send(200, { ok: true });
        }
        if (url.pathname === '/_e2e/artifact') {
          artifacts.set(String(body.key ?? ''), String(body.html ?? ''));
          return send(200, { ok: true });
        }
        if (url.pathname === '/_e2e/calls') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify(calls));
        }
        if (url.pathname === '/_e2e/broken') {
          state.broken = body.broken === null || body.broken === undefined
            ? (body.status === undefined ? null : { status: Number(body.status), body: String(body.body ?? '') })
            : null;
          state.hang = body.hang === true;
          return send(200, { ok: true });
        }
        res.statusCode = 404;
        res.end('not found');
      });
      return;
    }

    // --- dev login (sets the identity cookie and redirects back) ---
    if (opts.login && url.pathname === '/login') {
      const as = url.searchParams.get('as') ?? '';
      const next = url.searchParams.get('next') ?? '/';
      res.statusCode = 302;
      res.setHeader(
        'set-cookie',
        `canvas_e2e_user=${encodeURIComponent(as)}; Path=/; SameSite=Lax; Max-Age=86400`,
      );
      res.setHeader('location', next);
      res.end();
      return;
    }

    if (url.pathname === '/_gate/plugin/authz') {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'POST required' }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // Parse like the gate: JSON {artifact} (or form artifact=), urlsplit().path.
        const ctype = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        let artifact: unknown;
        if (ctype === 'application/json') {
          try {
            const obj: unknown = JSON.parse(body);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) artifact = (obj as Record<string, unknown>).artifact;
          } catch {
            artifact = undefined;
          }
          if (typeof artifact !== 'string') {
            send(400, { error: 'artifact required' });
            return;
          }
        } else {
          artifact = new URLSearchParams(body).get('artifact') ?? '';
        }
        const path = new URL(String(artifact), 'http://x').pathname;
        if (!path.startsWith('/artifacts/')) {
          send(400, { error: 'artifact must be an /artifacts/ path' });
          return;
        }
        const key = decodeURIComponent(path.slice('/artifacts/'.length));
        if (badKey(key)) {
          send(400, { error: 'artifact path not allowed' });
          return;
        }
        const cookie = req.headers.cookie ?? '';
        const authorization = req.headers.authorization ?? '';
        calls.push({ artifact: String(artifact), key, cookie, authorization });
        if (state.hang) return; // never answer: the client must time out and fail closed
        if (state.broken) {
          res.statusCode = state.broken.status;
          res.end(state.broken.body);
          return;
        }
        const rule =
          rulesByCookie.get(`${cookie}|${key}`) ?? rules.get(key) ?? opts.fallback?.(key, cookie) ?? null;
        if (!rule) {
          // Gate semantics: an artifact whose object is not there answers as denied with
          // reason object-missing (no existence leak, and plugins delete their data).
          send(200, {
            allowed: false,
            reason: 'object-missing',
            user: { id: null, name: 'anonymous', anonymous: true },
            artifact: { key, expires: null, ttl: null },
          });
          return;
        }
        send(200, {
          allowed: rule.allowed,
          reason: rule.reason,
          user: rule.user ?? { id: null, name: 'anonymous', anonymous: true },
          artifact: { key, expires: null, ttl: null, ...rule.artifact },
        });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
      const key = decodeURIComponent(url.pathname.slice('/artifacts/'.length));
      const html = artifacts.get(key);
      if (html === undefined) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    authzUrl: `${url}/_gate/plugin/authz`,
    artifactBaseUrl: `${url}/artifacts`,
    rules,
    rulesByCookie,
    artifacts,
    calls,
    get broken() {
      return state.broken;
    },
    set broken(v) {
      state.broken = v;
    },
    get hang() {
      return state.hang;
    },
    set hang(v) {
      state.hang = v;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export const allowUser = (id: string, name: string, extra: Partial<CoreRule> = {}): CoreRule => ({
  allowed: true,
  reason: 'owner',
  user: { id, name, anonymous: false },
  ...extra,
});

export const allowAnon = (extra: Partial<CoreRule> = {}): CoreRule => ({
  allowed: true,
  reason: 'pub: anonymous (anonymous-pub enabled)',
  user: { id: null, name: 'anonymous', anonymous: true },
  ...extra,
});

/**
 * The cookie-driven policy used by `npm run dev`: any `canvas_e2e_user` cookie is a
 * verified user; `pub/` keys are open to anonymous; everything else is denied as if not
 * shared with the visitor (the seeded artifacts do exist, so "object-missing" would lie).
 */
export const devFallback = (key: string, cookie: string): CoreRule | null => {
  const user = userFromCookie(cookie);
  if (user) return { allowed: true, reason: 'dev: any logged-in user', user };
  if (key.startsWith('pub/')) return allowAnon();
  return { allowed: false, reason: 'not-shared', user: { id: null, name: 'anonymous', anonymous: true } };
};
