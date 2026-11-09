import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake artifacts core: implements `POST /_gate/plugin/authz` exactly as the real gate does
 * (core repo `gate/gate.py::_handle_plugin_authz`, `docs/plugins.md` §1) and serves artifact
 * HTML under `/artifacts/<key>` for the frame route. The policy is mutable so tests can
 * revoke, expire or delete artifacts mid-session.
 *
 * Contract mirrored here:
 *   - body JSON {"artifact": "/artifacts/<key>"} (or form `artifact=`); path outside
 *     /artifacts/ or a key the gate refuses => 400 JSON error
 *   - 405 for non-POST; 200 carries the decision, denials included
 *   - answer {allowed, reason, user:{id,name,anonymous}, artifact:{key,expires,ttl}} with
 *     user.id null for anonymous and ttl an integer number of days (or null)
 *   - unknown key => deny with reason "object-missing" (gate: allowed-but-HEAD-404)
 */
export interface CoreRule {
  allowed: boolean;
  reason: string;
  user?: { id: string | null; name: string; anonymous: boolean };
  artifact?: { key?: string; expires?: string | null; ttl?: number | null };
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

export async function startFakeCore(): Promise<FakeCore> {
  const rules = new Map<string, CoreRule>();
  const rulesByCookie = new Map<string, CoreRule>();
  const artifacts = new Map<string, string>();
  const calls: FakeCore['calls'] = [];
  const state: { broken: FakeCore['broken']; hang: boolean } = { broken: null, hang: false };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://core');
    if (url.pathname === '/_gate/plugin/authz') {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'POST required' }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, obj: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(obj));
        };
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
        const rule = rulesByCookie.get(`${cookie}|${key}`) ?? rules.get(key);
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
