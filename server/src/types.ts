/** Shared types for the canvas server. */

export interface Identity {
  id: string;
  name: string;
  anonymous: boolean;
  color?: string;
  attribution: 'server' | 'client';
  readOnly?: boolean;
}

export type NoticeKind = 'revoked' | 'expired' | 'readonly' | 'rate-limited' | 'too-large' | 'shutdown';

export interface Notice {
  kind: NoticeKind;
  message?: string;
}

export interface AuthzArtifact {
  /** Artifact key as the core sees it (no `/artifacts/` prefix). */
  key?: string;
  /** ISO 8601 datetime when the artifact dies (ACL `expires`, else lastModified + ttl), or null. */
  expires?: string | null;
  /** Artifact `ttl` tag in whole days (the core returns an integer), or null. */
  ttl?: number | null;
}

/** Result of the core's POST /_gate/plugin/authz, normalised. */
export interface AuthzResult {
  allowed: boolean;
  /** Machine-readable reason. On failure: the core's reason, or `core_error` / `malformed`. */
  reason: string;
  identity?: Identity;
  artifact?: AuthzArtifact;
}
