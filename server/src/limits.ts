import type { IncomingMessage } from 'node:http';

/**
 * Token bucket for per-connection (and per-principal) limits. Clock injectable for tests.
 * `take(cost)` refuses when the bucket holds less than `cost`; `charge(cost)` always spends
 * (the work was already done, e.g. CPU time measured afterwards) and reports whether the
 * bucket is still non-negative.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly refillPerSec: number,
    private readonly capacity: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = clock();
  }

  private refill(): void {
    const now = this.clock();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  /** Consume `cost` tokens (default one); false when the bucket holds less (nothing is taken). */
  take(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Spend `cost` tokens unconditionally; false once the bucket is in debt. */
  charge(cost: number): boolean {
    this.refill();
    this.tokens -= cost;
    return this.tokens >= 0;
  }

  /** Tokens held now (negative while in debt). */
  level(): number {
    this.refill();
    return this.tokens;
  }

  /** Milliseconds until the bucket is out of debt (0 when it is not in debt). */
  msUntilPositive(): number {
    const l = this.level();
    return l >= 0 ? 0 : Math.ceil((-l / this.refillPerSec) * 1000);
  }

  /** Capacity of the bucket (its burst). */
  get burst(): number {
    return this.capacity;
  }

  /** True when the bucket is full again (an idle entry a map of buckets can forget). */
  full(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }
}

/**
 * The client IP when the deployment says where it comes from (CLIENT_IP_HOPS): 0 = the TCP
 * peer, n = the n-th address from the right of X-Forwarded-For (n trusted proxies append to it:
 * 1 behind one Traefik); -1 = unknown (null). With fewer than n entries the TCP peer is used.
 */
export function clientIp(req: IncomingMessage, hops: number): string | null {
  if (hops < 0) return null;
  if (hops === 0) return req.socket?.remoteAddress ?? null;
  const xf = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xf) ? xf.join(',') : xf ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.length >= hops ? list[list.length - hops] : req.socket?.remoteAddress ?? null;
}

/** Token buckets by key (per IP, per principal...), forgetting full ones once there are many. */
export class BucketMap {
  private readonly m = new Map<string, TokenBucket>();
  constructor(
    private readonly refillPerSec: number,
    private readonly capacity: number,
    private readonly max = 10_000,
  ) {}

  get(key: string): TokenBucket {
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.max) for (const [k, v] of this.m) if (v.full()) this.m.delete(k);
      this.m.set(key, (b = new TokenBucket(this.refillPerSec, this.capacity)));
    }
    return b;
  }
}
