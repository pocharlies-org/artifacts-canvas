/** Shared types for the canvas server. */

// Identity and the NOTICE vocabulary are defined once, in
// @pocharlies/artifacts-canvas-shared (docs/protocol.md §4); re-exported here so the
// server modules keep their historical import paths.
import type { Identity } from '@pocharlies/artifacts-canvas-shared';

export type { Identity, Notice, NoticeKind } from '@pocharlies/artifacts-canvas-shared';

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
