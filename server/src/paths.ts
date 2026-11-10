/**
 * Artifact key validation.
 *
 * The authoritative permission decision is always the core's authz; this module only keeps
 * keys inside a sane shape so a malformed URL can never escape the artifact key space or
 * reach the canvas object prefix:
 *   - no path traversal (`..`, `.`, backslashes, percent-encoded variants — validated
 *     AFTER decoding),
 *   - no control characters,
 *   - no segment starting with `_` or `.` (this excludes `_gate/`, `_plugins/`, `.acl.json`
 *     and the reserved `_/` canvas route space),
 *   - bounded length.
 */

const MAX_KEY_LENGTH = 1024;

// Control characters (C0 range + DEL). Built from escapes to keep this source file ASCII.
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f]');

export interface KeyResult {
  ok: boolean;
  /** Normalized artifact key (no leading/trailing slash) when ok. */
  key: string;
  reason?: string;
}

export function validateArtifactKey(raw: string, prefixes: string[] = []): KeyResult {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return { ok: false, key: '', reason: 'bad_encoding' };
  }
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return { ok: false, key: '', reason: 'bad_length' };
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    return { ok: false, key: '', reason: 'bad_shape' };
  }
  if (CONTROL_RE.test(key) || key.includes('\\')) {
    return { ok: false, key: '', reason: 'bad_chars' };
  }
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, key: '', reason: 'traversal' };
    }
    if (seg.startsWith('_') || seg.startsWith('.')) {
      return { ok: false, key: '', reason: 'reserved' };
    }
  }
  if (prefixes.length > 0 && !prefixes.some((p) => key.startsWith(p))) {
    return { ok: false, key: '', reason: 'outside_key_space' };
  }
  return { ok: true, key };
}

/**
 * The core's discovery links are `<read_base>/_canvas/<bucket>/<key>` (the bucket as first
 * segment, e.g. `/_canvas/artifacts/pub/run/index.html`), while the canvas client protocol uses
 * `/_canvas/<key>`. Both reach this server; the canonical artifact key never contains the
 * bucket. Strip a leading segment when it equals the configured bucket, so both shapes resolve
 * to the same key, authz path (`/artifacts/<key>`) and canvas object (`_plugins/canvas/<key>.ydoc`).
 *
 * Known ambiguity: an artifact key that itself starts with `<bucket>/` cannot be distinguished
 * from a bucket-prefixed link; the bucket-prefixed reading wins (that is what the core emits).
 */
export function stripBucketSegment(raw: string, bucket: string): string {
  if (!bucket) return raw;
  const i = raw.indexOf('/');
  if (i <= 0) return raw;
  const first = raw.slice(0, i);
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    /* undecodable first segment: validateArtifactKey will reject it */
  }
  return decoded === bucket ? raw.slice(i + 1) : raw;
}

/** Map an artifact key to its canvas object key under the plugin prefix. */
export function canvasObjectKey(prefix: string, artifactKey: string): string {
  return `${prefix}/${artifactKey}.ydoc`;
}

/**
 * The ledger object of an artifact's canvas (protocol §8): `<content object>.ledger`, i.e.
 * `<prefix>/<key>.ydoc.ledger`. Not `<key>.ledger.ydoc`: that is also the CONTENT object of
 * an artifact named `<key>.ledger`, so one room's ledger could overwrite another room's
 * content. Content objects always end in `.ydoc` and ledgers in `.ledger`, so the two
 * families never collide.
 */
export const LEDGER_SUFFIX = '.ydoc.ledger';
export function canvasLedgerKey(prefix: string, artifactKey: string): string {
  return `${prefix}/${artifactKey}${LEDGER_SUFFIX}`;
}

/** Inverse of canvasObjectKey / canvasLedgerKey; null when the object key is neither. */
export function artifactKeyFromObject(prefix: string, objectKey: string): string | null {
  const p = `${prefix.replace(/\/+$/, '')}/`;
  if (!objectKey.startsWith(p)) return null;
  const suffix = objectKey.endsWith(LEDGER_SUFFIX) ? LEDGER_SUFFIX : objectKey.endsWith('.ydoc') ? '.ydoc' : null;
  if (!suffix) return null;
  const key = objectKey.slice(p.length, -suffix.length);
  return validateArtifactKey(key).ok ? key : null;
}
