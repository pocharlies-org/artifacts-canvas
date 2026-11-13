import crypto from 'node:crypto';
import { BucketMap, TokenBucket } from './limits.js';

/**
 * Server-assigned anonymous pseudonyms (protocol §4).
 *
 * The server, not the client, decides who "Anónimo NNNN" is. Each anonymous browser gets
 * an HttpOnly cookie signed by this server: `<visitor nonce>.<NNNN>.<hmac>`. The nonce
 * identifies the visitor (per-visitor connection caps, two tabs of the same visitor share
 * one pseudonym); NNNN is the pseudonym the server last assigned to it. The client's
 * `?anon=NNNN` is only a hint, used for a visitor without a cookie, and never wins over
 * another live connection: a number held by a different visitor in the room is replaced
 * by a free one.
 *
 * Attribution is bound to the visitor, not to the number: the identity id is
 * `anon:<visitorId>`, an HMAC of the cookie nonce, so a later visitor who hints (or is given)
 * the same free number shows the same "Anónimo NNNN" label but can never write as, or be
 * credited with, the earlier visitor's shapes and history lines.
 */
export const ANON_COOKIE = 'canvas_anon';
const MAX_AGE_SECONDS = 30 * 24 * 3600;

export interface AnonVisitor {
  /** opaque visitor id (random, server-issued) */
  nonce: string;
  /** preferred pseudonym, 4 digits */
  num: string;
  /** true when the visitor had no valid cookie: a Set-Cookie must be sent */
  fresh: boolean;
}

export type MintRoute = 'http' | 'ws';

/** Visitor cookies minted per minute and burst, per route and per client IP (fv6 M-A). */
export interface MintLimits {
  anonMintRatePerMin: number;
  anonMintBurst: number;
  anonIpMintRatePerMin: number;
  anonIpMintBurst: number;
}

export class AnonIssuer {
  private readonly key: Buffer;
  /** global mint buckets: the wrapper page, and the WebSocket (a cookieless join) */
  private readonly mintAll: Record<MintRoute, TokenBucket> | null;
  private readonly mintIp: BucketMap | null;

  constructor(secret: string, limits?: MintLimits) {
    this.key = secret ? crypto.createHash('sha256').update(`artifacts-canvas anon v1\n${secret}`).digest() : crypto.randomBytes(32);
    this.mintAll = limits
      ? { http: new TokenBucket(limits.anonMintRatePerMin / 60, limits.anonMintBurst), ws: new TokenBucket(limits.anonMintRatePerMin / 60, limits.anonMintBurst) }
      : null;
    this.mintIp = limits ? new BucketMap(limits.anonIpMintRatePerMin / 60, limits.anonIpMintBurst) : null;
  }

  /**
   * May a new visitor (a new anonymous principal, with budgets of its own) be minted now? fv6
   * M-A: one client minted hundreds of visitors with HEAD requests, each with its own join and
   * CPU buckets. Takes one token from the route's global bucket and from the client IP's bucket
   * (when the IP is known; shared by both routes). The wrapper page and the WebSocket have a
   * global bucket each, so a flood of cookieless joins cannot stop the wrapper page from giving
   * honest visitors their cookie (fv5 M-6), nor the other way round.
   */
  mint(ip: string | null, route: MintRoute): boolean {
    if (!this.mintAll || !this.mintIp) return true;
    const all = this.mintAll[route];
    const perIp = ip !== null ? this.mintIp.get(ip) : null;
    if (all.level() < 1 || (perIp && perIp.level() < 1)) return false;
    all.take();
    perIp?.take();
    return true;
  }

  private sign(nonce: string, num: string): string {
    return crypto.createHmac('sha256', this.key).update(`${nonce}.${num}`).digest('base64url').slice(0, 27);
  }

  /** The verified visitor from the Cookie header, or null. */
  parse(cookieHeader: string): { nonce: string; num: string } | null {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== ANON_COOKIE) continue;
      const m = /^([A-Za-z0-9_-]{22})\.(\d{4})\.([A-Za-z0-9_-]{27})$/.exec(part.slice(eq + 1).trim());
      if (!m) continue;
      const want = Buffer.from(this.sign(m[1], m[2]));
      const got = Buffer.from(m[3]);
      if (want.length === got.length && crypto.timingSafeEqual(want, got)) return { nonce: m[1], num: m[2] };
    }
    return null;
  }

  /** Visitor from the cookie, else a new one (preferring a valid `hint`). */
  visitor(cookieHeader: string, hint: string | null): AnonVisitor {
    const v = this.parse(cookieHeader);
    if (v) return { ...v, fresh: false };
    return { nonce: crypto.randomBytes(16).toString('base64url'), num: validNum(hint) ?? randomNum(), fresh: true };
  }

  /** Stable, non-reversible attribution id of a visitor (16 base64url chars from its nonce). */
  visitorId(nonce: string): string {
    return crypto.createHmac('sha256', this.key).update(`visitor-id\n${nonce}`).digest('base64url').slice(0, 16);
  }

  /** `Set-Cookie` value for this visitor and pseudonym. */
  setCookie(nonce: string, num: string, secure: boolean): string {
    return `${ANON_COOKIE}=${nonce}.${num}.${this.sign(nonce, num)}; Path=/_canvas/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }
}

/**
 * Does a request carry anything the core could identify a visitor by? The core decides only on
 * the Cookie and Authorization headers it is sent (authz.ts), and the canvas's own visitor cookie
 * means nothing to it: without an Authorization header and without any other cookie, the core's
 * answer can only be anonymous (or a deny). Used to refuse anonymous visitors without asking the
 * core while anonymous drawing is off (ANON_ENABLED=false). Any other cookie counts, whatever its
 * name: the session cookie's name is the core's business.
 */
export function bringsCredentials(cookieHeader: string, authorization: string): boolean {
  if (authorization.trim() !== '') return true;
  for (const part of cookieHeader.split(';')) {
    const p = part.trim();
    if (p === '') continue;
    const eq = p.indexOf('=');
    if ((eq < 0 ? p : p.slice(0, eq).trim()) !== ANON_COOKIE) return true;
  }
  return false;
}

export function validNum(v: string | null | undefined): string | null {
  return v && /^\d{4}$/.test(v) && Number(v) >= 1000 ? v : null;
}

export function randomNum(): string {
  return String(1000 + crypto.randomInt(9000));
}

/**
 * The pseudonym for `visitor` in a room: its preferred number unless another visitor holds
 * it on a live connection there, else a random free one. `held` maps live anonymous
 * pseudonyms to the visitor holding them.
 */
export function assignNum(preferred: string, nonce: string, held: Map<string, string>): string {
  const owner = held.get(preferred);
  if (owner === undefined || owner === nonce) return preferred;
  for (let i = 0; i < 64; i++) {
    const n = randomNum();
    if (!held.has(n)) return n;
  }
  for (let n = 1000; n <= 9999; n++) if (!held.has(String(n))) return String(n);
  return preferred; // 9000 live anonymous pseudonyms in one room: capacity limits make this unreachable
}
