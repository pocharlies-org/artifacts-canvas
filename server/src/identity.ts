import type { AuthzResult, Identity } from './types.js';

/**
 * Identity composition (protocol §4). The identity is ONLY ever derived from the authz
 * answer. Logged-in visitors get the core's verified id/name; anonymous pub/ visitors get
 * `anon:<visitorId>` — bound to the server-signed visitor cookie (anon.ts), never to a
 * client-chosen value — and the display name `Anónimo <num>`, where `num` is the pseudonym
 * the SERVER assigned.
 */
export function composeIdentity(authz: AuthzResult, anonNum: string, visitorId = ''): Identity {
  const authIdentity = authz.identity;
  if (authIdentity && !authIdentity.anonymous) {
    return authIdentity; // logged-in: the core's verified id/name
  }
  return { id: `anon:${visitorId || anonNum}`, name: `Anónimo ${anonNum}`, anonymous: true, attribution: 'server' };
}

// Awareness hardening (the `user` field forced to the verified identity, foreign
// clientIds dropped) lives in @pocharlies/artifacts-canvas-shared/awareness — the same
// implementation the development room in client/dev/yroom.ts applies.
export { awarenessUser, sanitizeAwarenessUpdate } from '@pocharlies/artifacts-canvas-shared/awareness';
