import type { Config } from './config.js';
import type { AuthzResult } from './types.js';

export type ArtifactState = 'alive' | 'expired' | 'gone';

/**
 * Decide what an authz answer says about the artifact's life, so the canvas can die with it
 * (design §2 G7 / §8.4): the authz `reason` (expired/gone sets) or a past `artifact.expires`.
 */
export function artifactState(res: AuthzResult, cfg: Config, now: number = Date.now()): ArtifactState {
  if (cfg.goneReasons.has(res.reason)) return 'gone';
  if (cfg.expiredReasons.has(res.reason)) return 'expired';
  // No existence/expiry leak: the artifact's own expiry date only counts for a visitor the
  // core allowed. A denied visitor is just denied (the core reports `expired` and
  // `object-missing` only to visitors who would otherwise be allowed).
  if (!res.allowed) return 'alive';
  const exp = res.artifact?.expires;
  if (exp) {
    const t = Date.parse(exp);
    if (!Number.isNaN(t) && t <= now) return 'expired';
  }
  return 'alive';
}
