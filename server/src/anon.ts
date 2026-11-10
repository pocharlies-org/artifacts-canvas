import crypto from 'node:crypto';

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

export class AnonIssuer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = secret ? crypto.createHash('sha256').update(`artifacts-canvas anon v1\n${secret}`).digest() : crypto.randomBytes(32);
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

  /** `Set-Cookie` value for this visitor and pseudonym. */
  setCookie(nonce: string, num: string, secure: boolean): string {
    return `${ANON_COOKIE}=${nonce}.${num}.${this.sign(nonce, num)}; Path=/_canvas/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }
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
