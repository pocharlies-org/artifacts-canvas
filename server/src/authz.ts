import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';
import type { AuthzArtifact, AuthzResult, Identity } from './types.js';

/**
 * Client for the core's plugin authorization API — the real contract of
 * `gate/gate.py::_handle_plugin_authz` (core repo `docs/plugins.md` §1):
 *
 *   POST {GATE_AUTHZ_URL}                    # e.g. http://artifacts-core:8081/_gate/plugin/authz
 *   Content-Type: application/json
 *   Cookie: <visitor cookie, verbatim>       # and Authorization: <bearer, verbatim> when present
 *   {"artifact": "/artifacts/<key>"}         # key percent-encoded per segment
 *
 *   200 {allowed, reason, user:{id,name,anonymous}, artifact:{key,expires,ttl}}  # decision,
 *       including denials (anonymous deny is a 200 with allowed:false)
 *   400 malformed body / path outside /artifacts/ / key the gate refuses
 *   405 non-POST, 500 identity-backend error
 *
 * `user.id` is null for anonymous (name 'anonymous'); `artifact.ttl` is an integer number of
 * days or null; `artifact.expires` an ISO datetime or null. Only `allowed` is the decision —
 * `reason` is informational (except for our gone/expired classification).
 *
 * FAIL CLOSED: anything other than a well-formed `allowed: true` answer is a deny — network
 * errors, timeouts, 400/405/500, malformed JSON, missing user fields. The only identity the
 * server ever uses is the one in this answer (protocol §4/§5).
 */
export class AuthzClient {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Ask the core whether this visitor may access `artifactKey` (a validated key, without the
   * `/artifacts/` prefix). `cookie` and `authorization` are the raw header values ('' if absent).
   */
  async authorize(cookie: string, artifactKey: string, authorization = ''): Promise<AuthzResult> {
    const started = performance.now();
    const done = (r: AuthzResult): AuthzResult => {
      this.metrics.authzDuration.observe((performance.now() - started) / 1000);
      this.metrics.authz.inc({ result: r.allowed ? 'allow' : r.reason === 'core_error' || r.reason === 'malformed' ? 'error' : 'deny' });
      if (!r.allowed) this.metrics.authzDeny.inc({ reason: r.reason });
      return r;
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.authzTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.gateAuthzUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ artifact: gateArtifactPath(artifactKey) }),
        signal: ac.signal,
      });
    } catch (err) {
      this.log.warn({ err: String(err), artifactKey }, 'authz request failed (fail closed)');
      return done(deny('core_error'));
    } finally {
      clearTimeout(timer);
    }

    // 200 carries the decision (denials included). 400 = the gate refused the path/key (our
    // validation diverged from the gate's — deny, and log loudly). 405/500/anything else =
    // core-side problem → fail closed.
    if (res.status === 400) {
      this.log.error({ artifactKey }, 'gate rejected the authz path (400) — key validation divergence, denying');
      return done(deny('bad_path'));
    }
    if (res.status !== 200) {
      this.log.warn({ status: res.status, artifactKey }, 'authz non-200 (fail closed)');
      return done(deny('core_error'));
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return done(deny('malformed'));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return done(deny('malformed'));
    }
    const o = body as Record<string, unknown>;
    const artifact = parseArtifact(o.artifact);

    if (o.allowed !== true) {
      return done({ allowed: false, reason: str(o.reason) ?? 'denied', artifact });
    }

    const u = o.user;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return done(deny('malformed'));
    const user = u as Record<string, unknown>;
    if (typeof user.anonymous !== 'boolean') return done(deny('malformed'));

    if (user.anonymous) {
      // Defense in depth: the core only allows anonymous inside pub/ while its anonymous-pub
      // flag is on; a misconfigured core must not open every artifact.
      if (!anonAllowed(artifactKey, this.cfg.anonAllowedPrefixes)) {
        this.log.error({ artifactKey }, 'core allowed anonymous outside pub/ (refusing)');
        return done(deny('anon_outside_pub'));
      }
      // user.id is null for anonymous; the server composes its own anon:<NNNN> identity.
      return done({ allowed: true, reason: str(o.reason) ?? 'ok', artifact });
    }

    // Identified visitor: the core must supply a real id and name.
    if (typeof user.id !== 'string' || user.id === '' || user.id.length > 256) return done(deny('malformed'));
    if (typeof user.name !== 'string' || user.name === '' || user.name.length > 128) return done(deny('malformed'));
    const identity: Identity = {
      id: user.id,
      name: user.name,
      anonymous: false,
      attribution: 'server',
    };
    return done({ allowed: true, reason: str(o.reason) ?? 'ok', identity, artifact });
  }
}

/** The path the gate demands: `/artifacts/<key>`, percent-encoded per segment (gate urlsplit+unquote). */
export function gateArtifactPath(artifactKey: string): string {
  return `/artifacts/${artifactKey.split('/').map(encodeURIComponent).join('/')}`;
}

function deny(reason: string): AuthzResult {
  return { allowed: false, reason };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function parseArtifact(v: unknown): AuthzArtifact | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const key = typeof o.key === 'string' ? o.key : undefined;
  const expires = typeof o.expires === 'string' && o.expires !== '' ? o.expires : null;
  // The gate returns ttl as an integer number of days (or null); bounded to keep the S3 tag sane.
  const ttl =
    typeof o.ttl === 'number' && Number.isInteger(o.ttl) && o.ttl >= 0 && o.ttl <= 999 ? o.ttl : null;
  return { key, expires, ttl };
}

export function anonAllowed(artifactKey: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((p) => artifactKey.startsWith(p));
}
