import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All configuration comes from environment variables (the Helm chart renders a ConfigMap).
 * Nothing here contains hostnames or credentials by default: this server is a public
 * open-source component and every deployment-specific value is supplied at install time.
 */
export interface Config {
  host: string;
  port: number;

  /** Core's internal authorization endpoint, e.g. http://artifacts-core:8081/_gate/plugin/authz */
  gateAuthzUrl: string;
  authzTimeoutMs: number;
  /** Re-check authz for every live connection every N seconds. */
  recheckSeconds: number;

  /** Internal base URL used to fetch artifact HTML for the frame route. */
  artifactBaseUrl: string;
  frameFetchTimeoutMs: number;

  /** Directory with the built client bundle (index.html, assets/, reporter.js, vendor/). */
  staticDir: string;
  /** Inject the `artifacts-canvas-config` element into the wrapper page. */
  injectConfig: boolean;

  /** S3/MinIO persistence. */
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
  /** Prefix of the canvas objects, per the core plugin contract. */
  canvasPrefix: string;
  saveDebounceMs: number;
  sweepIntervalSeconds: number;
  readyzCacheMs: number;

  /** Abuse limits. Anonymous visitors get the stricter set. */
  maxConnsPerRoom: number;
  maxConnsPerRoomAnon: number;
  maxConnsPerAnonVisitor: number;
  msgRatePerSec: number;
  msgBurst: number;
  anonMsgRatePerSec: number;
  anonMsgBurst: number;
  maxDocBytes: number;
  anonMaxDocBytes: number;
  maxMessageBytes: number;
  anonMaxMessageBytes: number;
  /** Advertised to the client in the wrapper config (client-side cap for pasted images). */
  maxImageBytes: number;
  anonMaxImageBytes: number;

  /**
   * Artifact key space. Empty list = any structurally valid key (the core's authz is the
   * authority). When set, the key must start with one of these prefixes.
   */
  artifactPrefixes: string[];
  /** Defense in depth: anonymous connections are only ever accepted for these key prefixes. */
  anonAllowedPrefixes: string[];
  /** authz `reason` values that mean the artifact is expired. */
  expiredReasons: Set<string>;
  /** authz `reason` values that mean the artifact is gone (deleted / never existed). */
  goneReasons: Set<string>;

  logLevel: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function str(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const v = env[name];
  return v === undefined || v === '' ? def : v;
}
function num(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`);
  return n;
}
function bool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}
function list(env: NodeJS.ProcessEnv, name: string, def: string[]): string[] {
  const v = env[name];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gateAuthzUrl = env.GATE_AUTHZ_URL ?? '';
  if (!/^https?:\/\/.+/.test(gateAuthzUrl)) {
    throw new Error('GATE_AUTHZ_URL is required (core internal authz endpoint, http(s) URL)');
  }
  const artifactBaseUrl = env.ARTIFACT_BASE_URL ?? '';
  if (!/^https?:\/\/.+/.test(artifactBaseUrl)) {
    throw new Error('ARTIFACT_BASE_URL is required (core internal base URL used to fetch artifact HTML)');
  }
  const s3Bucket = env.S3_BUCKET ?? '';
  if (!s3Bucket) throw new Error('S3_BUCKET is required');

  const cfg: Config = {
    host: str(env, 'HOST', '0.0.0.0'),
    port: num(env, 'PORT', 8080),
    gateAuthzUrl,
    authzTimeoutMs: num(env, 'AUTHZ_TIMEOUT_MS', 3000),
    recheckSeconds: num(env, 'AUTHZ_RECHECK_SECONDS', 300),
    artifactBaseUrl,
    frameFetchTimeoutMs: num(env, 'FRAME_FETCH_TIMEOUT_MS', 10000),
    staticDir: str(env, 'STATIC_DIR', path.resolve(here, '..', '..', 'client', 'dist')),
    injectConfig: bool(env, 'CANVAS_INJECT_CONFIG', true),
    s3Endpoint: env.S3_ENDPOINT || undefined,
    s3Region: str(env, 'S3_REGION', 'us-east-1'),
    s3Bucket,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID || undefined,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    s3ForcePathStyle: bool(env, 'S3_FORCE_PATH_STYLE', true),
    canvasPrefix: str(env, 'CANVAS_PREFIX', '_plugins/canvas').replace(/^\/+|\/+$/g, ''),
    saveDebounceMs: num(env, 'SAVE_DEBOUNCE_MS', 2000),
    sweepIntervalSeconds: num(env, 'SWEEP_INTERVAL_SECONDS', 3600),
    readyzCacheMs: num(env, 'READYZ_CACHE_MS', 5000),
    maxConnsPerRoom: num(env, 'MAX_CONNS_PER_ROOM', 50),
    maxConnsPerRoomAnon: num(env, 'MAX_CONNS_PER_ROOM_ANON', 10),
    maxConnsPerAnonVisitor: num(env, 'MAX_CONNS_PER_ANON_VISITOR', 2),
    msgRatePerSec: num(env, 'MSG_RATE_PER_SEC', 120),
    msgBurst: num(env, 'MSG_BURST', 240),
    anonMsgRatePerSec: num(env, 'ANON_MSG_RATE_PER_SEC', 30),
    anonMsgBurst: num(env, 'ANON_MSG_BURST', 60),
    maxDocBytes: num(env, 'MAX_DOC_BYTES', 20 * 1024 * 1024),
    anonMaxDocBytes: num(env, 'ANON_MAX_DOC_BYTES', 5 * 1024 * 1024),
    maxMessageBytes: num(env, 'MAX_MESSAGE_BYTES', 8 * 1024 * 1024),
    anonMaxMessageBytes: num(env, 'ANON_MAX_MESSAGE_BYTES', 2 * 1024 * 1024),
    maxImageBytes: num(env, 'MAX_IMAGE_BYTES', 2 * 1024 * 1024),
    anonMaxImageBytes: num(env, 'ANON_MAX_IMAGE_BYTES', 1 * 1024 * 1024),
    artifactPrefixes: list(env, 'ARTIFACT_PREFIXES', []),
    anonAllowedPrefixes: list(env, 'ANON_ALLOWED_PREFIXES', ['pub/']),
    // Reason vocabulary of the core gate (gate/gate.py, docs/plugins.md §1): `expired` when the
    // ACL expiry has passed, `object-missing` when the artifact object is gone (HEAD failed).
    expiredReasons: new Set(list(env, 'EXPIRED_REASONS', ['expired'])),
    goneReasons: new Set(list(env, 'GONE_REASONS', ['object-missing'])),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  };
  if (cfg.maxConnsPerRoomAnon > cfg.maxConnsPerRoom) {
    throw new Error('MAX_CONNS_PER_ROOM_ANON must be <= MAX_CONNS_PER_ROOM');
  }
  if (cfg.anonMaxDocBytes > cfg.maxDocBytes) {
    throw new Error('ANON_MAX_DOC_BYTES must be <= MAX_DOC_BYTES');
  }
  return cfg;
}
