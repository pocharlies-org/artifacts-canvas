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
  const exp = res.artifact?.expires;
  if (exp) {
    const t = Date.parse(exp);
    if (!Number.isNaN(t) && t <= now) return 'expired';
  }
  return 'alive';
}
