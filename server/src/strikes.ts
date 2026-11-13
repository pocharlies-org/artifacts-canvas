import type { Config } from './config.js';
import type { Logger } from './logging.js';
import type { Metrics } from './metrics.js';

/** Who a strike counts against: the principal, its client IP when known, and the anonymous pool. */
export interface Striker {
  principal: string;
  anonymous: boolean;
  ip?: string | null;
}

/**
 * Strikes (fv9 isolation). A client message that makes its room's worker fault (over the
 * watchdog, out of heap, crashed), or that the guard refuses for the work it would cost (cuts,
 * merges, deletes or placement over MAX_APPLY_MS / MAX_SPLITS_PER_MESSAGE, client blocks over
 * MAX_CLIENTS_PER_UPDATE), closes its sender 4413 and gives a strike to its principal;
 * WORKER_STRIKES of them within WORKER_STRIKE_WINDOW_MS refuse that principal's joins and writes
 * for WORKER_STRIKE_COOLDOWN_MS (1013: an honest client retries later). An anonymous visitor
 * without a cookie is a new principal on every connection, so anonymous strikes also count per
 * client IP (when CLIENT_IP_HOPS says where it is) and for all anonymous visitors together:
 * WORKER_ANON_POOL_STRIKES of them refuse every anonymous join and write for the cooldown.
 */
export class StrikeBook {
  private readonly book = new Map<string, { at: number[]; until: number }>();

  constructor(
    private readonly cfg: Config,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
  ) {}

  private keys(s: Striker): [string, number][] {
    const out: [string, number][] = [[`p:${s.principal}`, this.cfg.workerStrikes]];
    if (s.anonymous) {
      if (s.ip) out.push([`i:${s.ip}`, this.cfg.workerStrikes]);
      out.push(['anon', this.cfg.workerAnonPoolStrikes]);
    }
    return out;
  }

  /** A worker fault caused by a message of `s`. */
  strike(s: Striker, kind: string): void {
    const now = this.clock();
    this.metrics.strikes.inc({ outcome: 'strike' });
    if (this.book.size > 10_000) {
      for (const [k, e] of this.book) if (e.until <= now && (e.at[e.at.length - 1] ?? 0) < now - this.cfg.workerStrikeWindowMs) this.book.delete(k);
    }
    for (const [key, max] of this.keys(s)) {
      let e = this.book.get(key);
      if (!e) this.book.set(key, (e = { at: [], until: 0 }));
      e.at = e.at.filter((t) => t > now - this.cfg.workerStrikeWindowMs);
      e.at.push(now);
      if (e.at.length >= max && e.until <= now) {
        e.until = now + this.cfg.workerStrikeCooldownMs;
        e.at = [];
        this.metrics.strikes.inc({ outcome: 'cooldown' });
        this.log.warn({ who: key.startsWith('p:') ? s.principal : key === 'anon' ? 'anonymous visitors' : 'anonymous ip', kind, cooldownMs: this.cfg.workerStrikeCooldownMs }, 'strikes: refused joins and writes for a cooldown');
      }
    }
  }

  /** Why `s` may not join or write now (a cooldown of its own, its IP's or the anonymous pool's), or null. */
  coolingDown(s: Striker): string | null {
    const now = this.clock();
    for (const [key] of this.keys(s)) {
      const e = this.book.get(key);
      if (e && e.until > now) return key === 'anon' ? 'cooldown_anon' : 'cooldown';
    }
    return null;
  }
}
