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
  wsPingIntervalMs: number;
  /**
   * Incoming deadline (review S8): a connection whose socket delivered part of a message (a frame
   * not complete, or fragments without the last one) and not its end within WS_INCOMING_TIMEOUT_MS
   * + the bytes held / WS_INCOMING_MIN_BYTES_PER_SEC is dropped. What `ws` holds for it (up to
   * maxPayload) is then released; answering pings meanwhile does not keep it.
   */
  wsIncomingTimeoutMs: number;
  wsIncomingMinBytesPerSec: number;
  /**
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
   * Estimated Yjs time (ms) the cuts, placement, merges and deletes of one update may take
   * (applyEstimateMs() without the bytes term, with the costs measured on x86); over it the update
   * is refused 4413. fv9: the update runs in its room's worker, so this no longer bounds a stall of
   * the server but the worker time one message may take (and the apply slot it holds): honest
   * deletes of thousands of shapes cost Yjs 0.4-0.8 s (it splices the writer's struct array once
   * per shape), so the default went from 50 to 1000. The worker's watchdog for the apply is
   * WORKER_MESSAGE_TIMEOUT_MS plus twice the estimate.
   */
  maxApplyMs: number;
  /**
   * Client blocks (Yjs client ids) one update may carry (fv9 E). An honest update carries its
   * sender's id, a resync after a reconnect the few ids the room lacks. Over it: closed 4413.
   */
  maxClientsPerUpdate: number;
  /**
   * Room isolation (fv9): every loaded room runs in a worker thread of its own, and the main
   * thread waits for each answer with a watchdog. A client message (its guard and apply) may take
   * WORKER_MESSAGE_TIMEOUT_MS plus WORKER_TIMEOUT_NS_PER_BYTE per byte of the message; an
   * operation on the whole room (load, join encodings, saves, the replay of a recovery)
   * WORKER_OP_TIMEOUT_MS plus WORKER_OP_NS_PER_BYTE per byte of the room. Past it the worker is
   * terminated, the room rebuilt in a fresh one from its saved state and write-ahead log, and the
   * sender of the message closed (4413) with a strike. 1000 ms by default: the main thread does
   * not wait on it either way, and an honest message must never miss it — under CPU contention
   * (two honest fuzzers on one host) one honest update missed 250 ms, and the first message of a
   * fresh worker runs unoptimised code.
   */
  workerMessageTimeoutMs: number;
  workerTimeoutNsPerByte: number;
  workerOpTimeoutMs: number;
  workerOpNsPerByte: number;
  /**
   * Client messages processed at once over all rooms (their guard and apply): each may use its
   * worker's heap up to the worker's limit, so this bounds the memory of the messages being
   * processed (the budget reserves one, see roomMemoryBudget()); the ones waiting for a slot are
   * bounded by WORKER_INFLIGHT_BYTES.
   */
  workerApplyConcurrency: number;
  /**
   * Bytes of client messages (updates, sync steps) received and not processed yet, over all
   * connections (review M-1: messages wait for their room's queue and the apply slots, and on
   * main the TCP backpressure of the one thread bounded them; nothing did once they queued).
   * Over it a message bigger than CPU_SHED_MIN_BYTES is refused (1013 `busy`: the client resends
   * it after it reconnected); a small one is taken and its connection is no longer read until
   * its own messages are processed. A connection, and a principal over all its connections, is
   * no longer read while it has inflightConnBytes() in flight (TCP backpressure again).
   * Default 64 MiB: Node buffers, outside every V8 heap (chart values.yaml, "Memory").
   */
  workerInflightBytes: number;
  /**
   * Strikes (fv9): a principal whose messages made WORKER_STRIKES worker faults within
   * WORKER_STRIKE_WINDOW_MS is refused joins and writes for WORKER_STRIKE_COOLDOWN_MS; anonymous
   * visitors also per client IP (when known) and, all together, after WORKER_ANON_POOL_STRIKES.
   */
  workerStrikes: number;
  workerStrikeWindowMs: number;
  workerStrikeCooldownMs: number;
  workerAnonPoolStrikes: number;
  /**
   * Test only: a client update carrying `canvas-test-hook:<busy|alloc|throw>` makes the worker
   * misbehave. Never in production: with NODE_ENV=production (the image's) the server refuses to
   * start with it, unless WORKER_TEST_HOOKS_IN_PRODUCTION is set too (the compose test stack).
   */
  workerTestHooks: boolean;
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
  /** where the heap limit of the budget came from: `env` (HEAP_LIMIT_MB) or `v8` (the main thread's) */
  heapLimitSource: 'env' | 'v8';
  roomCostFactor: number;
  /** Resident cost of an empty loaded room, its worker thread included (ROOM_BASE_COST_BYTES). */
  roomBaseCostBytes: number;
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
  /**
   * Anonymous drawing on or off (ANON_ENABLED; the chart renders it from `anon.enabled`, default
   * false). Off: a visitor who brings no credential is refused before the core is asked, and an
   * anonymous answer of the core is refused too, whatever ANON_ALLOWED_PREFIXES holds. Unset, the
   * server's own default is on (what it did before the switch; the compose stack and the tests).
   */
  anonEnabled: boolean;
  /**
   * Defense in depth: anonymous connections are only ever accepted for these key prefixes (with
   * anonEnabled). A list that parses to nothing (`,`) accepts anonymous nowhere.
   */
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
/** Is V8's --max-old-space-size given to this process (it then overrides every worker's heap limit)? */
export function oldSpaceFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const re = /--max[-_]old[-_]space[-_]size/;
  return re.test(env.NODE_OPTIONS ?? '') || process.execArgv.some((a) => re.test(a));
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
    wsIncomingTimeoutMs: num(env, 'WS_INCOMING_TIMEOUT_MS', 30_000),
    wsIncomingMinBytesPerSec: num(env, 'WS_INCOMING_MIN_BYTES_PER_SEC', 32 * 1024),
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
    maxApplyMs: num(env, 'MAX_APPLY_MS', 1000),
    maxClientsPerUpdate: num(env, 'MAX_CLIENTS_PER_UPDATE', 256),
    workerMessageTimeoutMs: num(env, 'WORKER_MESSAGE_TIMEOUT_MS', 1000),
    workerTimeoutNsPerByte: num(env, 'WORKER_TIMEOUT_NS_PER_BYTE', 1000),
    workerOpTimeoutMs: num(env, 'WORKER_OP_TIMEOUT_MS', 10_000),
    workerOpNsPerByte: num(env, 'WORKER_OP_NS_PER_BYTE', 2000),
    workerApplyConcurrency: num(env, 'WORKER_APPLY_CONCURRENCY', 1),
    workerInflightBytes: num(env, 'WORKER_INFLIGHT_BYTES', 64 * 1024 * 1024),
    workerStrikes: num(env, 'WORKER_STRIKES', 3),
    workerStrikeWindowMs: num(env, 'WORKER_STRIKE_WINDOW_MS', 600_000),
    workerStrikeCooldownMs: num(env, 'WORKER_STRIKE_COOLDOWN_MS', 600_000),
    workerAnonPoolStrikes: num(env, 'WORKER_ANON_POOL_STRIKES', 10),
    workerTestHooks: bool(env, 'WORKER_TEST_HOOKS', false),
    attributionRetentionDays: num(env, 'ATTRIBUTION_RETENTION_DAYS', 30),
    anonMintRatePerMin: num(env, 'ANON_MINT_RATE_PER_MIN', 120),
    anonMintBurst: num(env, 'ANON_MINT_BURST', 60),
    anonIpMintRatePerMin: num(env, 'ANON_IP_MINT_RATE_PER_MIN', 10),
    anonIpMintBurst: num(env, 'ANON_IP_MINT_BURST', 10),
    roomMemoryBudgetBytes: 0, // set below (depends on other limits)
    roomMemoryBudgetSource: 'heap',
    heapLimitSource: 'v8',
    roomCostFactor: num(env, 'ROOM_COST_FACTOR', ROOM_COST_FACTOR),
    roomBaseCostBytes: num(env, 'ROOM_BASE_COST_BYTES', ROOM_BASE_COST_BYTES),
    roomMemoryPrincipalShare: frac(env, 'ROOM_MEMORY_PRINCIPAL_SHARE', 1 / 3),
    roomMemoryAnonShare: frac(env, 'ROOM_MEMORY_ANON_SHARE', 1 / 3),
    configuredLimits: { maxDocBytes: 0, anonMaxDocBytes: 0, maxMessageBytes: 0, anonMaxMessageBytes: 0, maxImageBytes: 0, anonMaxImageBytes: 0 }, // set below
    memoryWarnings: [],
    maxImageBytes: num(env, 'MAX_IMAGE_BYTES', 2 * 1024 * 1024),
    anonMaxImageBytes: num(env, 'ANON_MAX_IMAGE_BYTES', 512 * 1024),
    artifactPrefixes: list(env, 'ARTIFACT_PREFIXES', []),
    anonEnabled: bool(env, 'ANON_ENABLED', true),
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
  // fv9: the heap the whole process may use (main thread and room workers) is HEAP_LIMIT_MB, not
  // --max-old-space-size: that V8 flag applies to every thread and overrides the room workers' own
  // heap limits (resourceLimits), so a worker could grow to the whole heap (measured: a worker
  // limited to 47 MiB ran out of memory at 1 728 MiB under --max-old-space-size=1728)
  const heapLimit = env.HEAP_LIMIT_MB !== undefined && env.HEAP_LIMIT_MB !== '' ? num(env, 'HEAP_LIMIT_MB', 0) * 1024 * 1024 : v8.getHeapStatistics().heap_size_limit;
  cfg.heapLimitSource = env.HEAP_LIMIT_MB ? 'env' : 'v8';
  deriveRoomLimits(cfg, heapLimit, envBudget);
  // review F-5: refused, not only warned about (a room worker could grow to the whole heap, and
  // one message that exhausts it would take every room with it)
  if (oldSpaceFlag(env)) {
    throw new Error(
      '--max-old-space-size is set (NODE_OPTIONS or the command line): it applies to every thread and overrides the heap limit of each room worker, so one message could make a worker grow to the whole heap and take the process down; remove it and size the process with HEAP_LIMIT_MB',
    );
  }
  if (cfg.workerTestHooks && env.NODE_ENV === 'production' && !bool(env, 'WORKER_TEST_HOOKS_IN_PRODUCTION', false)) {
    throw new Error('WORKER_TEST_HOOKS is set with NODE_ENV=production: the hooks let any writer make its room\'s worker misbehave; they are for the test stacks only (WORKER_TEST_HOOKS_IN_PRODUCTION=true overrides, deploy/compose)');
  }
  // at least one message of the largest size must fit, else the biggest honest message never would
  if (cfg.workerInflightBytes < cfg.maxMessageBytes) {
    throw new Error(`WORKER_INFLIGHT_BYTES (${cfg.workerInflightBytes}) must be >= MAX_MESSAGE_BYTES (${cfg.maxMessageBytes}, after the memory sizing)`);
  }
  return cfg;
}

/**
 * Bytes of messages one connection, and one principal over all its connections, may have in
 * flight before the server stops reading it (review M-1): two messages of the largest size, 1 MiB
 * at least. An honest tab has one small update in flight, a reconnecting one its step 2 (at most a
 * room) and an edit or two.
 */
export function inflightConnBytes(maxMessageBytes: number): number {
  return Math.max(2 * maxMessageBytes, 1024 * 1024);
}

/**
 * What `ws` reads of one message before it closes the connection 1009 (maxPayload), over the largest
 * message cap (review S8): the y-protocols framing of a message (types and length, a few bytes) and
 * room for a message a little over the cap to be read and refused with the `too-large` notice
 * (4413) instead of a bare 1009.
 */
export const WS_PAYLOAD_SLACK = 64 * 1024;

/**
 * maxPayload of the WebSocket server (review S8): the message cap plus WS_PAYLOAD_SLACK, after the
 * memory sizing lowered the caps (it was a fixed 8 MiB, twice the chart's 4 MiB cap). Also the most
 * an unfinished frame or fragmented message can make `ws` hold for one connection, until its
 * incoming deadline drops it.
 */
export function wsMaxPayload(cfg: Pick<Config, 'maxMessageBytes' | 'anonMaxMessageBytes'>): number {
  return Math.max(cfg.maxMessageBytes, cfg.anonMaxMessageBytes) + WS_PAYLOAD_SLACK;
}

/** The incoming deadline of a connection holding `bytes` of an unfinished message (review S8). */
export function incomingDeadlineMs(bytes: number, cfg: Pick<Config, 'wsIncomingTimeoutMs' | 'wsIncomingMinBytesPerSec'>): number {
  return cfg.wsIncomingTimeoutMs + (bytes / cfg.wsIncomingMinBytesPerSec) * 1000;
}

/**
 * What a client message counts in flight at least (review S6): a tiny update is a few payload
 * bytes but holds far more while it waits (the copy of its frame, its views, the job, its async
 * state and promises), so counted by its bytes alone many of them from many principals never
 * reached a cap and queued without a bound. Measured (review S8; Node 22, x86-64, the main thread's
 * heap and buffers after a GC, 11 520 queued 4-byte updates: `fv9-review.test.ts`, "calibration"):
 * 1.65-1.7 KiB each, so the floor is 2 KiB (it was 1 KiB, an estimate). With it,
 * WORKER_INFLIGHT_BYTES (64 MiB) bounds the queue to ~32 000 messages, plus one or two per
 * connection (protocol §12), and a connection's cap (8 MiB) to ~4 000; an honest tab has a handful
 * in flight.
 */
export const INFLIGHT_MIN_COST = 2048;

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

/**
 * The versions of Yjs and its libraries every cost constant here and in the guard
 * (shared/src/stamper.ts: SPLIT_COST_BYTES, SPLIT_BASE_WORK, SPLIT_MOVE_DIVISOR, the merge and scan
 * counts) was measured against: they mirror Yjs internals. A bump of any of them invalidates the
 * calibration: re-run the fv8/fv9 adversarial suites (server/test/fv8.test.ts, fv9.test.ts,
 * e2e-system/adversarial-fv8/fv9.spec.ts, the guard fuzzer) and only then update this list. A unit
 * test (server/test/fv9-review.test.ts) fails while the lockfile and this list differ.
 */
export const CALIBRATED_WITH: Readonly<Record<'yjs' | 'lib0' | 'y-protocols', string>> = { yjs: '13.6.33', lib0: '0.2.120', 'y-protocols': '1.0.7' };

/** Estimated Yjs apply time (ms) of an update of `bytes` with these cut and placement counts. */
export function applyEstimateMs(bytes: number, splitWork: number, scanWork: number): number {
  return (bytes * APPLY_NS_PER_BYTE + splitWork * SPLIT_WORK_NS + scanWork * SCAN_WORK_NS) / 1e6;
}

/**
 * Resident cost of an empty loaded room (fv9: ROOM_BASE_COST_BYTES): its worker thread with the
 * empty room loaded and its join frames encoded — the V8 isolate, the Node environment and the
 * modules it loads (Yjs, lib0, the stamper) — plus the room's state on the main thread (awareness,
 * caches: 11-12 KiB). Measured with server/test/fv9/worker-cost.mjs (40 workers, RSS per worker):
 * 15.7 MiB in the image (node:22-alpine, x86-64), 17.3 MiB on Ubuntu (glibc) Node 22. Before the
 * rooms had workers it was 32 KiB.
 */
export const ROOM_BASE_COST_BYTES = 16 * 1024 * 1024;

/** Estimated resident cost of a loaded room of `bytes` encoded bytes (content + ledger). */
export function roomCost(cfg: Pick<Config, 'roomCostFactor'> & { roomBaseCostBytes?: number }, bytes: number): number {
  return (cfg.roomBaseCostBytes ?? ROOM_BASE_COST_BYTES) + cfg.roomCostFactor * bytes;
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
 * The heap limit is HEAP_LIMIT_MB (the chart's heapLimitMb) or, without it, the main thread's
 * heap_size_limit (V8 sizes it from the container's memory), so the budget is right for any memory
 * setting. fv9: not --max-old-space-size, which would override every room worker's own limit. The outgoing buffers live outside the heap: counting them here
 * leaves the container limit the room it needs for them (chart values.yaml, "Memory").
 */
export function roomMemoryBudget(heapLimit: number, cfg: Pick<Config, 'wsOutgoingBudgetBytes' | 'maxMessageBytes'> & { workerApplyConcurrency?: number }): number {
  const b = heapLimit - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - (cfg.workerApplyConcurrency ?? 1) * MESSAGE_COST_FACTOR * cfg.maxMessageBytes;
  return Math.max(MIN_ROOM_MEMORY_BUDGET_BYTES, Math.floor(b));
}

/** The biggest room (encoded bytes) whose cost, with FULL_ROOM_MARGIN, fits `share` bytes of memory. */
export function roomCapFor(share: number, costFactor: number, base = ROOM_BASE_COST_BYTES): number {
  return Math.max(0, Math.floor((share - base) / (FULL_ROOM_MARGIN * costFactor)));
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
  const base = cfg.roomBaseCostBytes;
  const userCap = (budget: number) => roomCapFor(budget * cfg.roomMemoryPrincipalShare, f, base);
  let budget: number;
  // the message size the budget leaves room for (the message caps never go above it)
  let reserved = conf.maxMessageBytes;
  if (envBudget !== null) {
    budget = envBudget;
    cfg.roomMemoryBudgetSource = 'env';
  } else {
    cfg.roomMemoryBudgetSource = 'heap';
    const budgetFor = (m: number) => roomMemoryBudget(heapLimit, { wsOutgoingBudgetBytes: cfg.wsOutgoingBudgetBytes, maxMessageBytes: m, workerApplyConcurrency: cfg.workerApplyConcurrency });
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
    if (heapLimit - RUNTIME_RESERVE_BYTES - cfg.wsOutgoingBudgetBytes - cfg.workerApplyConcurrency * MESSAGE_COST_FACTOR * m < MIN_ROOM_MEMORY_BUDGET_BYTES) {
      warnings.push(
        `the V8 heap (${MiB(heapLimit)}) is too small for the runtime (${MiB(RUNTIME_RESERVE_BYTES)}), WS_OUTGOING_BUDGET_BYTES (${MiB(cfg.wsOutgoingBudgetBytes)}) and one message: the room budget is at its floor (${MiB(MIN_ROOM_MEMORY_BUDGET_BYTES)}); raise HEAP_LIMIT_MB or lower WS_OUTGOING_BUDGET_BYTES`,
      );
    }
  }
  cfg.roomMemoryBudgetBytes = budget;
  const fullRoom = base + f * conf.maxDocBytes;
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
  lower('MAX_DOC_BYTES', 'maxDocBytes', roomCapFor(share, f, base), `a full room (x ${f}, +25%) must fit one user's share of the room memory budget (${MiB(share)} of ${MiB(budget)})`);
  lower('ANON_MAX_DOC_BYTES', 'anonMaxDocBytes', Math.min(cfg.maxDocBytes, roomCapFor(anonShare, f, base)), `a full anonymous room must fit one anonymous visitor's share (${MiB(anonShare)})`);
  lower('MAX_MESSAGE_BYTES', 'maxMessageBytes', Math.min(cfg.maxDocBytes, reserved), 'a message cannot add more than a room holds (MAX_DOC_BYTES)');
  lower('ANON_MAX_MESSAGE_BYTES', 'anonMaxMessageBytes', Math.min(cfg.maxMessageBytes, cfg.anonMaxDocBytes), 'a message cannot add more than a room holds (ANON_MAX_DOC_BYTES)');
  lower('MAX_IMAGE_BYTES', 'maxImageBytes', Math.floor(IMAGE_PER_MESSAGE * cfg.maxMessageBytes), 'an image (as a data URL) must fit one message');
  lower('ANON_MAX_IMAGE_BYTES', 'anonMaxImageBytes', Math.floor(IMAGE_PER_MESSAGE * cfg.anonMaxMessageBytes), 'an image (as a data URL) must fit one message');
  cfg.memoryWarnings = warnings;
}
