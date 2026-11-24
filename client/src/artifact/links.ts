import { RESERVED, encodePath, sanitizePath } from '../config';

/**
 * Links clicked in the artifact (docs/protocol.md §3 "Links"). The reporter, inside the
 * sandboxed frame, stops the frame's own navigation and posts the resolved URL; the wrapper
 * decides here what the click does. Nothing is fetched: the outcome is a navigation of this
 * tab to another canvas page, a new tab, or nothing.
 *
 *   - another file of the artifact host (a relative link resolves to the frame route
 *     `/_canvas/_/frame/<key>`; an absolute link to the plain artifact URL or to a canvas URL
 *     works too): this tab opens the canvas of that file, so its annotations follow per page;
 *   - a non-HTML file of the artifact (the last path segment has an extension other than
 *     `html` or `htm`; a path ending in `/` is a page): the file is saved and this tab stays on
 *     its page (`download`, see `downloadUrl`);
 *   - another page, http or https only: a new tab, `noopener,noreferrer`;
 *   - anything else (`javascript:`, `data:`, `blob:`, `file:`, `mailto:`, user:password URLs,
 *     an unparsable or over-long URL): blocked.
 * Same-document anchors never reach the wrapper as links: the reporter scrolls to them.
 */

/** Longest URL the wrapper accepts from the frame. */
export const MAX_LINK_LENGTH = 4096;

export interface LinkContext {
  /** Origin of the wrapper page (location.origin). */
  origin: string;
  /** The canvas prefix, e.g. `/_canvas/`. */
  prefix: string;
  /** The path the current wrapper puts before the artifact key: `/_canvas/` or `/_canvas/<bucket>/`. */
  canvasBase: string;
  /** Path of the plain artifact URLs on this host (`/<bucket>/`), or null when it is not known. */
  artifactBase: string | null;
}

export type LinkAction =
  | { kind: 'canvas'; key: string }
  | { kind: 'download'; key: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked'; reason: 'invalid' | 'scheme' | 'credentials' | 'reserved' };

/**
 * Where the wrapper of `artifactKey` sits: from `/_canvas/artifacts/u/run/a.html` and the key
 * `u/run/a.html`, the canvas base `/_canvas/artifacts/` and the artifact base `/artifacts/`.
 */
export function linkContext(origin: string, pathname: string, prefix: string, artifactKey: string): LinkContext {
  let canvasBase = prefix;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep the raw path */
  }
  if (artifactKey && decoded.endsWith('/' + artifactKey) && decoded.startsWith(prefix)) {
    const base = decoded.slice(0, decoded.length - artifactKey.length);
    if (base.startsWith(prefix) && !base.startsWith(prefix + RESERVED)) canvasBase = encodePath(base.slice(0, -1)) + '/';
  }
  const bucket = canvasBase.slice(prefix.length);
  return { origin, prefix, canvasBase, artifactBase: bucket ? '/' + bucket : null };
}

/** What a click on `href` (absolute, as the frame resolved it) does. */
export function classifyLink(href: unknown, ctx: LinkContext): LinkAction {
  if (typeof href !== 'string' || !href || href.length > MAX_LINK_LENGTH) return { kind: 'blocked', reason: 'invalid' };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'blocked', reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'scheme' };
  if (url.username || url.password) return { kind: 'blocked', reason: 'credentials' };
  if (url.origin !== ctx.origin) return { kind: 'external', url: url.href };
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return { kind: 'blocked', reason: 'invalid' };
  }
  // the keys of the first three branches are relative to the artifact base (no base: no download)
  const relative = ctx.artifactBase !== null;
  const frame = ctx.prefix + RESERVED + 'frame/';
  if (path.startsWith(frame)) return canvasKey(path.slice(frame.length), relative);
  // the canvas's own routes other than the frame (bundle, socket): nothing to open
  if (path.startsWith(ctx.prefix + RESERVED) || path + '/' === ctx.prefix + RESERVED) return { kind: 'blocked', reason: 'reserved' };
  if (path.startsWith(ctx.canvasBase)) return canvasKey(path.slice(ctx.canvasBase.length), relative);
  // a canvas URL of another bucket: its key is not relative to this artifact base
  if (path.startsWith(ctx.prefix)) return canvasKey(path.slice(ctx.prefix.length), false);
  if (ctx.artifactBase && path.startsWith(ctx.artifactBase)) return canvasKey(path.slice(ctx.artifactBase.length), true);
  // another page of this host that is not an artifact: as the plain artifact link would, a new tab
  return { kind: 'external', url: url.href };
}

/**
 * The action for a key under a base. `relative`: the key is relative to the artifact base, so a
 * non-HTML file of it is a download. A path ending in `/` is a page, never a file.
 */
function canvasKey(rest: string, relative: boolean): LinkAction {
  const key = sanitizePath(rest);
  if (!key) return { kind: 'blocked', reason: 'invalid' };
  if (relative && !rest.endsWith('/') && isDownloadKey(key)) return { kind: 'download', key };
  return { kind: 'canvas', key };
}

/**
 * Is `key` a non-HTML file? Its last path segment has an extension: a `.` that is neither the
 * first nor the last character, and an extension other than `html` or `htm` (any case). Keys
 * without one (`README`), dot files (`.hidden`) and pages (`Report.HTML`) stay canvas pages.
 */
export function isDownloadKey(key: string): boolean {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return ext !== 'html' && ext !== 'htm';
}

/**
 * The plain URL of a `download` key: the artifact base plus the sanitised, encoded key, with no
 * query and no fragment. Null when the context has no artifact base (classifyLink makes no
 * download then).
 */
export function downloadUrl(key: string, ctx: LinkContext): string | null {
  if (ctx.artifactBase === null) return null;
  return ctx.artifactBase + encodePath(sanitizePath(key));
}

/** Query parameters a canvas page hands to the next one (`canvas`: a forced shown/hidden stays forced). */
const KEEP = ['lang', 'canvas'];
const KEEP_DEV = ['as', 'room', 'csp'];

/**
 * The canvas URL (path and query, same origin) of `key`: `lang`, `canvas` (and the development
 * parameters) are kept, `present=1` is added while presenting.
 */
export function canvasUrl(key: string, ctx: LinkContext, current: URLSearchParams, opts: { presenting: boolean; dev: boolean }): string {
  const q = new URLSearchParams();
  for (const k of opts.dev ? [...KEEP, ...KEEP_DEV] : KEEP) {
    const v = current.get(k);
    if (v !== null) q.set(k, v);
  }
  if (opts.presenting) q.set('present', '1');
  const qs = q.toString();
  return ctx.canvasBase + encodePath(sanitizePath(key)) + (qs ? `?${qs}` : '');
}
