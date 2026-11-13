import path from 'node:path';
import v8 from 'node:v8';
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
  /**
   * Where to send a visitor WITHOUT a session who opens the wrapper page of an artifact the
   * gate does not open to anonymous visitors (authz reason `unauthenticated`): a URL with an
   * `{rd}` placeholder that is replaced by the URL-encoded original path, e.g. the core's
   * oauth2-proxy `/oauth2/sign_in?rd={rd}`. Empty = answer 403 like any other deny.
   */
  loginUrl: string;

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
  /**
   * Server CPU (ms per second, burst) the debounced saves of all rooms may use together; a save
   * that is due waits while it is used up (fv6 M-A). Flushes (last leave, shutdown) never wait.
   */
  saveCpuMsPerSec: number;
  saveCpuBurstMs: number;
  sweepIntervalSeconds: number;
  readyzCacheMs: number;

  /** Abuse limits. Anonymous visitors get the stricter set. */
  maxConnsPerRoom: number;
  maxConnsPerRoomAnon: number;
  /** Live connections of one anonymous visitor (cookie), over all rooms of the process. */
  maxConnsPerAnonVisitor: number;
  /** Live connections of one logged-in user, over all rooms of the process (fv5 H-1). */
  maxConnsPerUser: number;
  /** Awareness (presence) states one room relays at most; each connection holds one (fv5 M-7). */
  maxAwarenessPerRoom: number;
  msgRatePerSec: number;
  msgBurst: number;
  anonMsgRatePerSec: number;
  anonMsgBurst: number;
  maxDocBytes: number;
  anonMaxDocBytes: number;
  maxMessageBytes: number;
  anonMaxMessageBytes: number;
  /**
   * Outgoing-buffer cap per connection (bytes not yet written to the socket). A peer that
   * stops reading is disconnected once its buffer passes this, instead of the server holding
   * every message for it (fv4 H1).
   */
  wsMaxBufferedBytes: number;
  /**
   * A connection whose outgoing buffer stays over its cap this long is dropped by a timer,
   * not only on its next send (fv5 H-1: a paused socket in a quiet room was kept forever).
   */
  wsSlowConsumerMs: number;
  /**
   * Bytes the server may hold for all connections together (outgoing buffers, the join
   * payloads in flight counted once per room version). A join that would pass it is refused
   * with 1013 (try again), and the slowest connections are dropped while it is passed.
   */
  wsOutgoingBudgetBytes: number;
  /** The join payload (ledger + content) must reach the peer at least this fast (bytes/s), with a 30 s floor. */
  wsJoinMinBytesPerSec: number;
  /**
   * A peer that holds more than 256 KiB and drained less than WS_JOIN_MIN_BYTES_PER_SEC for this
   * long is stalled: under outgoing-budget pressure it is dropped before a join is refused (fv6 L-A).
   */
  wsStallMs: number;
  /** WebSocket ping interval; a peer that answers no ping for two intervals and drains nothing is dropped. */
  wsPingIntervalMs: number;  /**
   * Bytes of sync step-2 answers per connection beyond the first one (which is free: a
   * joining or reconnecting client asks for everything it lacks once). Users / anonymous.
   */
  syncBytesPerSec: number;
  syncBurstBytes: number;
  anonSyncBytesPerSec: number;
  anonSyncBurstBytes: number;
  /**
   * Joins per principal (a user id, an anonymous visitor cookie); per room for anonymous joins
   * that bring no visitor cookie; per client IP for anonymous joins when the IP is known
   * (clientIpHops). A refused join closes with 1013 (the client retries), never 4429 (fv5 M-6).
   */
  joinRatePerMin: number;
  joinBurst: number;
  anonJoinRatePerMin: number;
  anonJoinBurst: number;
  anonRoomJoinRatePerMin: number;
  anonRoomJoinBurst: number;
  anonIpJoinRatePerMin: number;
  anonIpJoinBurst: number;
  /**
   * Where the client IP comes from: -1 = unknown (no per-IP limit), 0 = the TCP peer, n > 0 =
   * the n-th address from the right of X-Forwarded-For (n trusted proxies append to it).
   */
  clientIpHops: number;
  /**
   * Server CPU time (ms) one PRINCIPAL's messages may use per second, and the burst (shared by
   * all its connections: fv5 M-5, 20 connections of one user each had their own budget).
   */
  cpuMsPerSec: number;
  cpuBurstMs: number;
  anonCpuMsPerSec: number;
  anonCpuBurstMs: number;
  /** Server CPU time (ms/s, burst) of all connections together, and of all anonymous ones. */
  cpuTotalMsPerSec: number;
  cpuTotalBurstMs: number;
  anonCpuTotalMsPerSec: number;
  anonCpuTotalBurstMs: number;
  /** While a total CPU budget is used up, messages bigger than this are refused (1013, retry). */
  cpuShedMinBytes: number;
  /**
   * Cuts of items one update may make (fv8 P1/P2: every cut is a struct of its own in the stored
   * room, and Yjs copies the item to make it; an insert between every two points of two strokes,
   * 200 000 cuts in 3.97 MB, held the server for a minute and stored a room past every share).
   * Over it, or over MAX_APPLY_MS, the sender is closed 4413 `too-large` and nothing is applied.
   */
  maxSplitsPerMessage: number;
  /**
   * Estimated Yjs time (ms) the cuts and placement of one update may take (applyEstimateMs()
   * without the bytes term, with the costs measured on x86); over it the update is refused 4413.
   */
  maxApplyMs: number;
  /** Attribution entries of shapes deleted longer ago than this are pruned from the ledger. */
  attributionRetentionDays: number;
  /**
   * Visitor cookies (anonymous principals) the server mints per minute and burst: on the wrapper
   * page and on cookieless WebSocket joins (one global bucket each), and per client IP when the
   * IP is known (clientIpHops). A visitor the limit refuses gets the page without a cookie, and
   * a cookieless join over it is refused with 1013 and no cookie (the client retries) (fv6 M-A).
   */
  anonMintRatePerMin: number;
  anonMintBurst: number;
  anonIpMintRatePerMin: number;
  anonIpMintBurst: number;
  /**
   * Loaded-room memory (fv6 H-1, fv7 F1). A loaded room costs about `roomCostFactor` x its encoded
   * size (content + ledger) plus ROOM_BASE_COST_BYTES. Loads stop at LOAD_FRACTION of
   * `roomMemoryBudgetBytes` (after evicting idle rooms), growth at GROWTH_FRACTION, both with
   * 1013. Default budget: derived from the V8 heap limit (see deriveRoomLimits()).
   */
  roomMemoryBudgetBytes: number;
  /** where the budget came from: `env` (ROOM_MEMORY_BUDGET_BYTES) or `heap` (derived) */
  roomMemoryBudgetSource: 'env' | 'heap';
  roomCostFactor: number;
  /**
   * Fraction of the budget one logged-in principal may be charged for (fv7 F1: the loads it made
   * and every byte it wrote, in full, while those rooms stay loaded). An anonymous visitor gets a
   * quarter of it (ANON_VISITOR_SHARE_RATIO), and all anonymous visitors together
   * `roomMemoryAnonShare`. Their sum is at most GROWTH_FRACTION.
   */
  roomMemoryPrincipalShare: number;
  roomMemoryAnonShare: number;
  /**
   * The size caps as configured, before deriveRoomLimits() lowered them to what the memory
   * budget holds (fv7 F1: a full room must fit one principal's share), and why (startup warnings).
   */
  configuredLimits: { maxDocBytes: number; anonMaxDocBytes: number; maxMessageBytes: number; anonMaxMessageBytes: number; maxImageBytes: number; anonMaxImageBytes: number };
  memoryWarnings: string[];
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

  /**
   * Browser origins allowed to open the canvas WebSocket (exact `scheme://host[:port]`).
   * A missing, `null` or foreign Origin is refused with 4403 (cross-site WebSocket
   * hijacking: the session cookie rides along on any cross-site upgrade). Default: the
   * origin of ARTIFACT_BASE_URL, which in the core chart is the public artifacts host.
   */
  allowedOrigins: Set<string>;
  /** Internal metrics listener (Prometheus `/metrics`); 0 disables it. Never routed publicly. */
  metricsPort: number;
  metricsHost: string;
  /**
   * Key that signs the anonymous-visitor cookie (server-assigned pseudonyms). Empty = a
   * random key per process (pseudonyms then survive reloads but not a server restart).
   */
  anonCookieSecret: string;

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
function int(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be an integer 0..65535, got "${v}"`);
  return n;
}
/** `scheme://host[:port]` only (what browsers send in Origin); throws otherwise. */
export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid origin "${raw}"`);
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin === 'null') throw new Error(`invalid origin "${raw}"`);
  if (raw.replace(/\/+$/, '') !== u.origin && raw.replace(/\/+$/, '').toLowerCase() !== u.origin) {
    throw new Error(`origin "${raw}" must be scheme://host[:port] with no path`);
  }
  return u.origin;
}
/** An integer >= -1 (for "off" switches), or the default. */
function intOrOff(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < -1 || n > 16) throw new Error(`${name} must be an integer -1..16, got "${v}"`);
  return n;
}
/** A fraction in (0, 1], or the default. */
function frac(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`${name} must be a number in (0, 1], got "${v}"`);
  return n;
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
    loginUrl: str(env, 'LOGIN_URL', ''),
    s3Endpoint: env.S3_ENDPOINT || undefined,
    s3Region: str(env, 'S3_REGION', 'us-east-1'),
    s3Bucket,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID || undefined,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    s3ForcePathStyle: bool(env, 'S3_FORCE_PATH_STYLE', true),
    canvasPrefix: str(env, 'CANVAS_PREFIX', '_plugins/canvas').replace(/^\/+|\/+$/g, ''),
    saveDebounceMs: num(env, 'SAVE_DEBOUNCE_MS', 2000),
    saveCpuMsPerSec: num(env, 'SAVE_CPU_MS_PER_SEC', 50),
    saveCpuBurstMs: num(env, 'SAVE_CPU_BURST_MS', 1000),
    sweepIntervalSeconds: num(env, 'SWEEP_INTERVAL_SECONDS', 3600),
    readyzCacheMs: num(env, 'READYZ_CACHE_MS', 5000),
    maxConnsPerRoom: num(env, 'MAX_CONNS_PER_ROOM', 50),
    maxConnsPerRoomAnon: num(env, 'MAX_CONNS_PER_ROOM_ANON', 10),
    maxConnsPerAnonVisitor: num(env, 'MAX_CONNS_PER_ANON_VISITOR', 2),
    maxConnsPerUser: num(env, 'MAX_CONNS_PER_USER', 8),
    maxAwarenessPerRoom: num(env, 'MAX_AWARENESS_PER_ROOM', 50),
    msgRatePerSec: num(env, 'MSG_RATE_PER_SEC', 120),
    msgBurst: num(env, 'MSG_BURST', 240),
    anonMsgRatePerSec: num(env, 'ANON_MSG_RATE_PER_SEC', 30),
    anonMsgBurst: num(env, 'ANON_MSG_BURST', 60),
    maxDocBytes: num(env, 'MAX_DOC_BYTES', 5 * 1024 * 1024),
    anonMaxDocBytes: num(env, 'ANON_MAX_DOC_BYTES', 1280 * 1024),
    maxMessageBytes: num(env, 'MAX_MESSAGE_BYTES', 4 * 1024 * 1024),
    anonMaxMessageBytes: num(env, 'ANON_MAX_MESSAGE_BYTES', 1024 * 1024),
    wsMaxBufferedBytes: num(env, 'WS_MAX_BUFFERED_BYTES', 8 * 1024 * 1024),
    wsSlowConsumerMs: num(env, 'WS_SLOW_CONSUMER_MS', 10_000),
    wsOutgoingBudgetBytes: num(env, 'WS_OUTGOING_BUDGET_BYTES', 256 * 1024 * 1024),
    wsJoinMinBytesPerSec: num(env, 'WS_JOIN_MIN_BYTES_PER_SEC', 32 * 1024),
    wsPingIntervalMs: num(env, 'WS_PING_INTERVAL_MS', 30_000),
    wsStallMs: num(env, 'WS_STALL_MS', 3000),
    syncBytesPerSec: num(env, 'SYNC_BYTES_PER_SEC', 1024 * 1024),
    syncBurstBytes: num(env, 'SYNC_BURST_BYTES', 4 * 1024 * 1024),
    anonSyncBytesPerSec: num(env, 'ANON_SYNC_BYTES_PER_SEC', 256 * 1024),
    anonSyncBurstBytes: num(env, 'ANON_SYNC_BURST_BYTES', 1024 * 1024),
    joinRatePerMin: num(env, 'JOIN_RATE_PER_MIN', 30),
    joinBurst: num(env, 'JOIN_BURST', 20),
    anonJoinRatePerMin: num(env, 'ANON_JOIN_RATE_PER_MIN', 10),
    anonJoinBurst: num(env, 'ANON_JOIN_BURST', 6),
    anonRoomJoinRatePerMin: num(env, 'ANON_ROOM_JOIN_RATE_PER_MIN', 60),
    anonRoomJoinBurst: num(env, 'ANON_ROOM_JOIN_BURST', 30),
    anonIpJoinRatePerMin: num(env, 'ANON_IP_JOIN_RATE_PER_MIN', 30),
    anonIpJoinBurst: num(env, 'ANON_IP_JOIN_BURST', 20),
    clientIpHops: intOrOff(env, 'CLIENT_IP_HOPS', -1),
    cpuMsPerSec: num(env, 'CPU_MS_PER_SEC', 250),
    cpuBurstMs: num(env, 'CPU_BURST_MS', 5000),
    anonCpuMsPerSec: num(env, 'ANON_CPU_MS_PER_SEC', 60),
    anonCpuBurstMs: num(env, 'ANON_CPU_BURST_MS', 1000),
    cpuTotalMsPerSec: num(env, 'CPU_TOTAL_MS_PER_SEC', 600),
    cpuTotalBurstMs: num(env, 'CPU_TOTAL_BURST_MS', 6000),
    anonCpuTotalMsPerSec: num(env, 'ANON_CPU_TOTAL_MS_PER_SEC', 150),
    anonCpuTotalBurstMs: num(env, 'ANON_CPU_TOTAL_BURST_MS', 1500),
    cpuShedMinBytes: num(env, 'CPU_SHED_MIN_BYTES', 16 * 1024),
    maxSplitsPerMessage: num(env, 'MAX_SPLITS_PER_MESSAGE', 5000),
    maxApplyMs: num(env, 'MAX_APPLY_MS', 50),
    attributionRetentionDays: num(env, 'ATTRIBUTION_RETENTION_DAYS', 30),
    anonMintRatePerMin: num(env, 'ANON_MINT_RATE_PER_MIN', 120),
    anonMintBurst: num(env, 'ANON_MINT_BURST', 60),
    anonIpMintRatePerMin: num(env, 'ANON_IP_MINT_RATE_PER_MIN', 10),
    anonIpMintBurst: num(env, 'ANON_IP_MINT_BURST', 10),
    roomMemoryBudgetBytes: 0, // set below (depends on other limits)
    roomMemoryBudgetSource: 'heap',
    roomCostFactor: num(env, 'ROOM_COST_FACTOR', ROOM_COST_FACTOR),
    roomMemoryPrincipalShare: frac(env, 'ROOM_MEMORY_PRINCIPAL_SHARE', 1 / 3),
    roomMemoryAnonShare: frac(env, 'ROOM_MEMORY_ANON_SHARE', 1 / 3),
    configuredLimits: { maxDocBytes: 0, anonMaxDocBytes: 0, maxMessageBytes: 0, anonMaxMessageBytes: 0, maxImageBytes: 0, anonMaxImageBytes: 0 }, // set below
    memoryWarnings: [],
    maxImageBytes: num(env, 'MAX_IMAGE_BYTES', 2 * 1024 * 1024),
    anonMaxImageBytes: num(env, 'ANON_MAX_IMAGE_BYTES', 512 * 1024),
    artifactPrefixes: list(env, 'ARTIFACT_PREFIXES', []),
    anonAllowedPrefixes: list(env, 'ANON_ALLOWED_PREFIXES', ['pub/']),
    // Reason vocabulary of the core gate (gate/gate.py, docs/plugins.md §1): `expired` when the
    // ACL expiry has passed, `object-missing` when the artifact object is gone (HEAD failed).
    expiredReasons: new Set(list(env, 'EXPIRED_REASONS', ['expired'])),
    goneReasons: new Set(list(env, 'GONE_REASONS', ['object-missing'])),
    allowedOrigins: new Set(list(env, 'ALLOWED_ORIGINS', [new URL(artifactBaseUrl).origin]).map(normalizeOrigin)),
    metricsPort: int(env, 'METRICS_PORT', 9091),
    metricsHost: str(env, 'METRICS_HOST', '0.0.0.0'),
    anonCookieSecret: str(env, 'ANON_COOKIE_SECRET', ''),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  };
  if (cfg.metricsPort !== 0 && cfg.metricsPort === cfg.port) {
    throw new Error('METRICS_PORT must differ from PORT (metrics are never served on the public listener)');
  }
  if (cfg.loginUrl && !(/^\/[^/\\]/.test(cfg.loginUrl) || /^https?:\/\/[^/]+/.test(cfg.loginUrl))) {
    throw new Error('LOGIN_URL must be a same-host path (/...) or an http(s) URL');
  }
  if (cfg.loginUrl && !cfg.loginUrl.includes('{rd}')) {
    throw new Error('LOGIN_URL must contain the {rd} placeholder (the original path)');
  }
  if (cfg.maxConnsPerRoomAnon > cfg.maxConnsPerRoom) {
    throw new Error('MAX_CONNS_PER_ROOM_ANON must be <= MAX_CONNS_PER_ROOM');
  }
  if (cfg.anonCpuTotalMsPerSec > cfg.cpuTotalMsPerSec) {
    throw new Error('ANON_CPU_TOTAL_MS_PER_SEC must be <= CPU_TOTAL_MS_PER_SEC');
  }
  if (cfg.anonMaxDocBytes > cfg.maxDocBytes) {
    throw new Error('ANON_MAX_DOC_BYTES must be <= MAX_DOC_BYTES');
  }
  if (cfg.roomMemoryPrincipalShare + cfg.roomMemoryAnonShare > GROWTH_FRACTION + 1e-9) {
    // fv7 F1: one logged-in user and every anonymous visitor together must leave room to load
    throw new Error(`ROOM_MEMORY_PRINCIPAL_SHARE + ROOM_MEMORY_ANON_SHARE must be <= ${GROWTH_FRACTION}`);
  }
  const envBudget = env.ROOM_MEMORY_BUDGET_BYTES !== undefined && env.ROOM_MEMORY_BUDGET_BYTES !== '' ? num(env, 'ROOM_MEMORY_BUDGET_BYTES', 0) : null;
  deriveRoomLimits(cfg, v8.getHeapStatistics().heap_size_limit, envBudget);
  return cfg;
}

/**
 * Measured resident cost of a loaded room per encoded byte (content + ledger), V8 heap and
 * buffers together, with its join frames encoded (Node 22 on x86-64, `--expose-gc`, rooms built
 * through the real guard and stamper and loaded through Room.load: server/test/fv7/ratio.ts).
 * fv7 F2: a key overwritten alternately by two client ids 37.7x (`meta-overwrite`,
 * `alt-overwrite`), the same with a new pair of ids every 250 writes 39.5x, geo shapes whose
 * fields alternate ids 25.1x, one client id per shape 24.8x, create/delete 10.1x (fv6: geo shapes
 * with a text label 21.7x, strokes 4.2x). The worst, plus 10%.
 */
export const ROOM_COST_FACTOR = 44;
/**
 * Yjs apply time of an update, per unit (fv8 P2, server/test/fv8/split-cpu-cal.ts, split-growth.ts
 * and scan-probe.ts on x86-64, Node 22): UpdateCheck.splitWork (cuts: worst 4.5 ns per unit, a
 * long points list cut in many places), UpdateCheck.scanWork (placement scans: 189-193 ns per
 * item scanned) and the update's bytes (integrating its structs: 65 ns per byte for 20 000 new
 * shapes). The worst measured plus 30-50%. The server refuses an update whose cuts and placement
 * are estimated over MAX_APPLY_MS, and pre-charges the whole estimate to the CPU budgets before
 * it applies one.
 */
export const SPLIT_WORK_NS = 6;
export const SCAN_WORK_NS = 250;
export const APPLY_NS_PER_BYTE = 100;

/** Estimated Yjs apply time (ms) of an update of `bytes` with these cut and placement counts. */
export function applyEstimateMs(bytes: number, splitWork: number, scanWork: number): number {
  return (bytes * APPLY_NS_PER_BYTE + splitWork * SPLIT_WORK_NS + scanWork * SCAN_WORK_NS) / 1e6;
}

/** Resident cost of an empty loaded room (two documents, awareness, caches): measured 11-12 KiB. */
export const ROOM_BASE_COST_BYTES = 32 * 1024;

/** Estimated resident cost of a loaded room of `bytes` encoded bytes (content + ledger). */
export function roomCost(cfg: Pick<Config, 'roomCostFactor'>, bytes: number): number {
  return ROOM_BASE_COST_BYTES + cfg.roomCostFactor * bytes;
}

/** What the process needs besides rooms: runtime, libraries, the HTTP side (heap). */
export const RUNTIME_RESERVE_BYTES = 192 * 1024 * 1024;
/**
 * Heap needed to guard and apply one message, per byte (fv7 F2, server/test/fv7/guardcost.ts):
 * the guard of a 7.98 MiB update of alternating overwrites needs a heap limit of 423-438 MiB (13
 * MiB of it the runtime), 51-53x; geo shapes need less. Rounded up to 60.
 */
export const MESSAGE_COST_FACTOR = 60;
/** The budget never goes below this (a heap too small for the limits gets a warning at start). */
export const MIN_ROOM_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Loads (rooms brought into memory) stop at this fraction of the budget (fv7 F1). */
export const LOAD_FRACTION = 0.85;
/**
 * Growth (updates that make loaded rooms bigger) stops at this fraction: the gap to LOAD_FRACTION
 * (5% of the budget, 43 MiB with the chart's defaults) is always left for loads, so a room of
 * typical size still opens when the loaded rooms have grown as far as they may (fv7 F1).
 */
export const GROWTH_FRACTION = 0.8;
/** An anonymous visitor's share is this fraction of a logged-in principal's (1/12 of the budget by default). */
export const ANON_VISITOR_SHARE_RATIO = 0.25;
/**
 * A room at the size cap must fit its principal's share with this margin (the last update that
 * reaches the cap is estimated with the ledger it will add): cost(1.25 x cap) <= share.
 */
export const FULL_ROOM_MARGIN = 1.25;
/** A data-URL image (4/3 of its bytes) plus its shape must fit one message: image cap <= 0.7 x message cap. */
const IMAGE_PER_MESSAGE = 0.7;

/**
 * Loaded-room budget derived from the heap: what the V8 heap can hold besides the runtime, the
 * outgoing budget and one message of `maxMessageBytes` being processed:
 *
 *   heap_size_limit - RUNTIME_RESERVE_BYTES - WS_OUTGOING_BUDGET_BYTES - 60 x MAX_MESSAGE_BYTES
 *
 * heap_size_limit follows --max-old-space-size (the chart's nodeMaxOldSpaceMb), so the budget is
 * right for any memory setting. The outgoing buffers live outside the heap: counting them here
 * leaves the container limit the room it needs for them (chart values.yaml, "Memory").
 */
export function roomMemoryBudget(heapLimit: number, cfg: Pick<Config, 'wsOutgoingBudgetBytes' | 'maxMessageBytes'>): number {
  const b = heapLimit - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - MESSAGE_COST_FACTOR * cfg.maxMessageBytes;
  return Math.max(MIN_ROOM_MEMORY_BUDGET_BYTES, Math.floor(b));
}

/** The biggest room (encoded bytes) whose cost, with FULL_ROOM_MARGIN, fits `share` bytes of memory. */
export function roomCapFor(share: number, costFactor: number): number {
  return Math.max(0, Math.floor((share - ROOM_BASE_COST_BYTES) / (FULL_ROOM_MARGIN * costFactor)));
}

/**
 * fv7 F1: the budget and the size caps that go with it. A principal is never charged more than
 * its share, so a room at MAX_DOC_BYTES must fit that share (with FULL_ROOM_MARGIN); when it does
 * not, the cap of this deployment is lowered to what fits and a warning is logged at start (the
 * 1 GiB case: a full 20 MiB room cost more than the whole budget). A message can never add more
 * than a room holds, so the message caps follow the room caps, and the heap budget is derived
 * with the message cap that results (the largest m <= MAX_MESSAGE_BYTES with m <= the room cap
 * of the budget left after reserving 60 x m). Image caps follow the message caps.
 */
export function deriveRoomLimits(cfg: Config, heapLimit: number, envBudget: number | null): void {
  const MiB = (b: number) => `${(b / 1048576).toFixed(2)} MiB`;
  const conf = {
    maxDocBytes: cfg.maxDocBytes,
    anonMaxDocBytes: cfg.anonMaxDocBytes,
    maxMessageBytes: cfg.maxMessageBytes,
    anonMaxMessageBytes: cfg.anonMaxMessageBytes,
    maxImageBytes: cfg.maxImageBytes,
    anonMaxImageBytes: cfg.anonMaxImageBytes,
  };
  cfg.configuredLimits = conf;
  const warnings: string[] = [];
  const f = cfg.roomCostFactor;
  const userCap = (budget: number) => roomCapFor(budget * cfg.roomMemoryPrincipalShare, f);
  let budget: number;
  // the message size the budget leaves room for (the message caps never go above it)
  let reserved = conf.maxMessageBytes;
  if (envBudget !== null) {
    budget = envBudget;
    cfg.roomMemoryBudgetSource = 'env';
  } else {
    cfg.roomMemoryBudgetSource = 'heap';
    const budgetFor = (m: number) => roomMemoryBudget(heapLimit, { wsOutgoingBudgetBytes: cfg.wsOutgoingBudgetBytes, maxMessageBytes: m });
    const top = Math.min(conf.maxMessageBytes, conf.maxDocBytes);
    let m = top;
    if (userCap(budgetFor(top)) < top) {
      // userCap(budgetFor(m)) - m decreases with m: the largest m that fits, by bisection
      let lo = 0;
      let hi = top;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (userCap(budgetFor(mid)) >= mid) lo = mid;
        else hi = mid;
      }
      m = lo;
    }
    budget = budgetFor(m);
    reserved = m;
    if (heapLimit - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - MESSAGE_COST_FACTOR * m < MIN_ROOM_MEMORY_BUDGET_BYTES) {
      warnings.push(
        `the V8 heap (${MiB(heapLimit)}) is too small for the runtime (${MiB(RUNTIME_RESERVE_BYTES)}), WS_OUTGOING_BUDGET_BYTES (${MiB(cfg.wsOutgoingBudgetBytes)}) and one message: the room budget is at its floor (${MiB(MIN_ROOM_MEMORY_BUDGET_BYTES)}); raise --max-old-space-size or lower WS_OUTGOING_BUDGET_BYTES`,
      );
    }
  }
  cfg.roomMemoryBudgetBytes = budget;
  const fullRoom = ROOM_BASE_COST_BYTES + f * conf.maxDocBytes;
  if (budget < fullRoom) {
    warnings.push(`the room memory budget (${MiB(budget)}) is smaller than one full room at MAX_DOC_BYTES (${MiB(conf.maxDocBytes)} x ${f} = ${MiB(fullRoom)})`);
  }
  const lower = (name: string, key: keyof typeof conf, to: number, why: string) => {
    const v = Math.max(0, Math.min(conf[key], to));
    (cfg as unknown as Record<string, number>)[key] = v;
    if (v < conf[key]) warnings.push(`${name} lowered from ${MiB(conf[key])} to ${MiB(v)}: ${why}`);
  };
  const share = budget * cfg.roomMemoryPrincipalShare;
  const anonShare = share * ANON_VISITOR_SHARE_RATIO;
  lower('MAX_DOC_BYTES', 'maxDocBytes', roomCapFor(share, f), `a full room (x ${f}, +25%) must fit one user's share of the room memory budget (${MiB(share)} of ${MiB(budget)})`);
  lower('ANON_MAX_DOC_BYTES', 'anonMaxDocBytes', Math.min(cfg.maxDocBytes, roomCapFor(anonShare, f)), `a full anonymous room must fit one anonymous visitor's share (${MiB(anonShare)})`);
  lower('MAX_MESSAGE_BYTES', 'maxMessageBytes', Math.min(cfg.maxDocBytes, reserved), 'a message cannot add more than a room holds (MAX_DOC_BYTES)');
  lower('ANON_MAX_MESSAGE_BYTES', 'anonMaxMessageBytes', Math.min(cfg.maxMessageBytes, cfg.anonMaxDocBytes), 'a message cannot add more than a room holds (ANON_MAX_DOC_BYTES)');
  lower('MAX_IMAGE_BYTES', 'maxImageBytes', Math.floor(IMAGE_PER_MESSAGE * cfg.maxMessageBytes), 'an image (as a data URL) must fit one message');
  lower('ANON_MAX_IMAGE_BYTES', 'anonMaxImageBytes', Math.floor(IMAGE_PER_MESSAGE * cfg.anonMaxMessageBytes), 'an image (as a data URL) must fit one message');
  cfg.memoryWarnings = warnings;
}
