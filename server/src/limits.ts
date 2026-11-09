/** Token bucket for per-connection message rate limiting. Clock injectable for tests. */
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

  /** Consume one token; false when the bucket is empty (caller should drop the connection). */
  take(): boolean {
    const now = this.clock();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
