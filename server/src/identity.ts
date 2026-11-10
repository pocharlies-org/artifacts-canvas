import type { AuthzResult, Identity } from './types.js';

/**
 * Identity composition (protocol §4). The identity is ONLY ever derived from the authz
 * answer; the client's `?anon=NNNN` pseudonym is accepted (validated `^\d{4}$`) for
 * anonymous pub/ visitors and ignored for logged-in ones.
 */
export function composeIdentity(authz: AuthzResult, anonParam: string | null): Identity {
  const authIdentity = authz.identity;
  if (authIdentity && !authIdentity.anonymous) {
    return authIdentity; // logged-in: the core's verified id/name, anon param ignored
  }
  const p = anonParam && /^\d{4}$/.test(anonParam) ? anonParam : String(1000 + Math.floor(Math.random() * 9000));
  return { id: `anon:${p}`, name: `Anónimo ${p}`, anonymous: true, attribution: 'server' };
}

// Awareness hardening (the `user` field forced to the verified identity, foreign
// clientIds dropped) lives in @pocharlies/artifacts-canvas-shared/awareness — the same
// implementation the development room in client/dev/yroom.ts applies.
export { awarenessUser, sanitizeAwarenessUpdate } from '@pocharlies/artifacts-canvas-shared/awareness';
