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
