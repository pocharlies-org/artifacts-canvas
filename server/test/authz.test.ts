import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AuthzClient, gateArtifactPath } from '../src/authz.js';
import { Metrics } from '../src/metrics.js';
import { createLogger } from '../src/logging.js';

const cfg = loadConfig({
  GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz',
  ARTIFACT_BASE_URL: 'http://core',
  S3_BUCKET: 'b',
  AUTHZ_TIMEOUT_MS: '50',
});
const log = createLogger('silent');

function client(fetchImpl: typeof fetch): AuthzClient {
  return new AuthzClient(cfg, log, new Metrics(), fetchImpl as unknown as typeof fetch);
}

const json = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

/** Gate-shaped allow for an identified user. */
const allow = (id = 'u', name = 'U') => ({
  allowed: true,
  reason: 'owner',
  user: { id, name, anonymous: false },
  artifact: { key: 'x', expires: null, ttl: null },
});

describe('AuthzClient (gate contract: POST /_gate/plugin/authz)', () => {
  it('accepts an identified user and builds the server identity', async () => {
    const c = client(json({ ...allow('ana@corp', 'Ana López') }));
    const r = await c.authorize('sid=1', 'runs/x.html');
    expect(r.allowed).toBe(true);
    expect(r.identity).toMatchObject({ id: 'ana@corp', name: 'Ana López', anonymous: false, attribution: 'server' });
  });

  it('sends {"artifact": "/artifacts/<key>"} with the visitor cookie forwarded verbatim', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const c = client((async (url: string, init: RequestInit) => {
      seen = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return new Response(JSON.stringify(allow()));
    }) as unknown as typeof fetch);
    await c.authorize('sid=42', 'pub/doc.html');
    expect(seen).toEqual({
      url: 'http://core/_gate/plugin/authz',
      headers: { 'content-type': 'application/json', cookie: 'sid=42' },
      body: JSON.stringify({ artifact: '/artifacts/pub/doc.html' }),
    });
  });

  it('forwards an Authorization bearer besides the cookie (gate accepts both)', async () => {
    let seen: Record<string, string> | null = null;
    const c = client((async (_u: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response(JSON.stringify(allow()));
    }) as unknown as typeof fetch);
    await c.authorize('sid=42', 'runs/x.html', 'Bearer tok');
    expect(seen).toMatchObject({ cookie: 'sid=42', authorization: 'Bearer tok' });
  });

  it('percent-encodes the key per segment (gate does urlsplit + unquote)', () => {
    expect(gateArtifactPath('runs/a b.html')).toBe('/artifacts/runs/a%20b.html');
    expect(gateArtifactPath('pub/100%.png')).toBe('/artifacts/pub/100%25.png');
  });

  it('accepts anonymous (user.id null, name anonymous) only inside pub/', async () => {
    const anon = json({
      allowed: true,
      reason: 'pub: anonymous (anonymous-pub enabled)',
      user: { id: null, name: 'anonymous', anonymous: true },
      artifact: { key: 'pub/doc.html', expires: null, ttl: null },
    });
    const r = await client(anon).authorize('', 'pub/doc.html');
    expect(r.allowed).toBe(true);
    expect(r.identity).toBeUndefined(); // the server composes the anon:<NNNN> identity itself
    const r2 = await client(anon).authorize('', 'runs/private.html');
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('anon_outside_pub');
  });

  it('passes through a core deny (200 with allowed:false) with its reason', async () => {
    const r = await client(
      json({
        allowed: false,
        reason: 'unauthenticated',
        user: { id: null, name: 'anonymous', anonymous: true },
        artifact: { key: 'x', expires: null, ttl: null },
      }),
    ).authorize('c', 'x');
    expect(r).toMatchObject({ allowed: false, reason: 'unauthenticated' });
  });

  it('FAILS CLOSED on network error', async () => {
    const r = await client((async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch).authorize('c', 'x');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('core_error');
  });

  it('FAILS CLOSED on timeout', async () => {
    const r = await client(((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch).authorize(
      'c',
      'x',
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('core_error');
  });

  it('FAILS CLOSED on gate 400 (path refused), 405 and 500', async () => {
    expect((await client(json({ error: 'artifact path not allowed' }, 400)).authorize('c', 'x')).reason).toBe('bad_path');
    expect((await client(json({ error: 'POST required' }, 405)).authorize('c', 'x')).reason).toBe('core_error');
    expect((await client(json({ error: 'identity backend error' }, 500)).authorize('c', 'x')).reason).toBe('core_error');
  });

  it('FAILS CLOSED on malformed bodies', async () => {
    expect((await client((async () => new Response('not json')) as unknown as typeof fetch).authorize('c', 'x')).reason).toBe(
      'malformed',
    );
    expect((await client(json({ allowed: true, reason: 'ok' })).authorize('c', 'x')).reason).toBe('malformed'); // no user
    expect(
      (await client(json({ allowed: true, reason: 'ok', user: { id: 'u', name: 'U' } })).authorize('c', 'x')).reason,
    ).toBe('malformed'); // no anonymous flag
    expect(
      (await client(json({ allowed: true, reason: 'ok', user: { id: null, name: 'x', anonymous: false } })).authorize('c', 'x'))
        .reason,
    ).toBe('malformed'); // identified user must carry a real id
  });

  it('parses the gate artifact block: integer ttl days, ISO expires', async () => {
    const r = await client(
      json({
        ...allow(),
        artifact: { key: 'x', ttl: 7, expires: '2030-01-01T00:00:00+00:00' },
      }),
    ).authorize('c', 'x');
    expect(r.artifact).toMatchObject({ key: 'x', ttl: 7, expires: '2030-01-01T00:00:00+00:00' });
  });

  it('drops non-integer / out-of-range ttl values (S3 tag stays sane)', async () => {
    for (const ttl of ['7', 1.5, -1, 1000, null, undefined]) {
      const r = await client(json({ ...allow(), artifact: { ttl } })).authorize('c', 'x');
      expect(r.artifact?.ttl).toBeNull();
    }
  });
});
