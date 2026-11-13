import { detectLang, type Lang } from './i18n';

/**
 * Runtime configuration of the wrapper page. Resolution order (later wins):
 *   1. defaults derived from the URL:  <prefix><artifact path>   e.g. /_canvas/runs/x/report.html
 *   2. inline JSON rendered by the server: <script type="application/json" id="artifacts-canvas-config">
 *   3. development query parameters (only when `dev` is true): ?artifact=…&as=…&lang=…
 * See docs/protocol.md for the routes.
 */
export interface CanvasConfig {
  /** Artifact key (path inside the bucket). */
  artifactPath: string;
  /** Room name on the websocket server (the artifact key; tests may use a separate room in dev). */
  room: string;
  /** iframe src of the artifact (served with the reporter injected and CSP sandbox). */
  frameUrl: string;
  /** y-websocket server URL; the room name is appended as /<artifactPath>. */
  wsUrl: string;
  /** URL of html-to-image, loaded into the artifact frame only when exporting. */
  vendorUrl: string;
  /** Link to share (the wrapper URL). */
  shareUrl: string;
  /** Layout width of the artifact page (world units). Stored in the document on first use. */
  pageWidth: number;
  title: string;
  lang: Lang;
  /** Development: allow a local identity when the server sends none. */
  dev: boolean;
  /** Development: name to ask the dev server for (?as=). */
  devUser: string;
  maxImageBytes: number;
  /** The room's size cap for this visitor (MAX_DOC_BYTES / ANON_MAX_DOC_BYTES): the editor says the canvas is full before it (fv8 U1). */
  maxDocBytes: number;
}

export const DEFAULT_PREFIX = '/_canvas/';
/** Static assets, frame, websocket and vendor files live under this reserved segment. */
export const RESERVED = '_/';

export function resolveConfig(loc: Location, doc: Document, isDev: boolean): CanvasConfig {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/_canvas/_/';
  const prefix = base.endsWith(RESERVED) ? base.slice(0, -RESERVED.length) : DEFAULT_PREFIX;
  const q = new URLSearchParams(loc.search);
  let inline: Partial<CanvasConfig> = {};
  const el = doc.getElementById('artifacts-canvas-config');
  if (el?.textContent) {
    try {
      inline = JSON.parse(el.textContent);
    } catch {
      inline = {};
    }
  }
  const dev = inline.dev ?? isDev;
  let path = '';
  if (loc.pathname.startsWith(prefix) && !loc.pathname.startsWith(prefix + RESERVED)) {
    path = decodeURIComponent(loc.pathname.slice(prefix.length));
  }
  if (dev && q.get('artifact')) path = q.get('artifact')!;
  path = sanitizePath(inline.artifactPath ?? path);
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const cfg: CanvasConfig = {
    artifactPath: path,
    room: path,
    frameUrl: `${prefix}${RESERVED}frame/${encodePath(path)}`,
    wsUrl: `${wsProto}//${loc.host}${prefix}${RESERVED}ws`,
    vendorUrl: `${loc.origin}${prefix}${RESERVED}vendor/html-to-image.js`,
    shareUrl: `${loc.origin}${prefix}${encodePath(path)}`,
    pageWidth: 980,
    title: '',
    lang: detectLang(q.get('lang')),
    dev,
    devUser: dev ? (q.get('as') ?? '') : '',
    maxImageBytes: 2 * 1024 * 1024,
    maxDocBytes: 5 * 1024 * 1024,
    ...inline,
  };
  if (!inline.room) cfg.room = cfg.artifactPath;
  if (dev && q.get('room')) cfg.room = `${cfg.artifactPath}~${sanitizePath(q.get('room')!)}`;
  if (dev && q.get('pageWidth')) cfg.pageWidth = Math.max(320, Math.min(4000, Number(q.get('pageWidth')) || cfg.pageWidth));
  return cfg;
}

/** Reject traversal and odd characters; keeps "a/b/c.html". */
export function sanitizePath(p: string): string {
  return p
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
    .slice(0, 1024);
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
