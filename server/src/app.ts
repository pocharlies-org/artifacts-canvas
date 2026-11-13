import http from 'node:http';
import v8 from 'node:v8';
import { GROWTH_FRACTION, LOAD_FRACTION, type Config } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { Metrics } from './metrics.js';
import { AuthzClient } from './authz.js';
import { RoomManager } from './rooms.js';
import { HttpApp, metricsHandler } from './http.js';
import { AnonIssuer } from './anon.js';
import { WsServer } from './ws.js';
import { S3CanvasObjectStore, type CanvasObjectStore } from './store.js';

export interface AppDeps {
  config: Config;
  /** Override the object store (tests use the in-memory one). */
  store?: CanvasObjectStore;
  logger?: Logger;
  metrics?: Metrics;
  fetchImpl?: typeof fetch;
}

export interface App {
  server: http.Server;
  /** internal metrics listener (null when METRICS_PORT=0) */
  metricsServer: http.Server | null;
  manager: RoomManager;
  metrics: Metrics;
  log: Logger;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Compose the whole server. Everything is injectable so integration tests can run it
 * against a fake core and an in-memory store on an ephemeral port. */
export function createApp(deps: AppDeps): App {
  const cfg = deps.config;
  const log = deps.logger ?? createLogger(cfg.logLevel);
  const metrics = deps.metrics ?? new Metrics();
  const store = deps.store ?? new S3CanvasObjectStore(cfg);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authz = new AuthzClient(cfg, log, metrics, fetchImpl);
  const manager = new RoomManager({ cfg, store, authz, log, metrics });
  const anon = new AnonIssuer(cfg.anonCookieSecret, cfg);
  const httpApp = new HttpApp({ cfg, authz, manager, store, log, metrics, fetchImpl, anon });
  const wsApp = new WsServer({ cfg, authz, manager, log, metrics, anon });
  const metricsServer = cfg.metricsPort ? http.createServer(metricsHandler(metrics)) : null;

  const heapTimer = setInterval(() => metrics.sampleHeap(), 500);
  heapTimer.unref();

  const server = http.createServer(httpApp.handler);
  server.on('upgrade', (req, socket, head) => wsApp.handleUpgrade(req, socket, head));

  return {
    server,
    metricsServer,
    manager,
    metrics,
    log,
    listen(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          server.removeListener('error', reject);
          log.info({ port: cfg.port }, 'artifacts-canvas server listening');
          const mib = (b: number) => Math.round((b / 1048576) * 100) / 100;
          log.info(
            {
              budgetMiB: mib(cfg.roomMemoryBudgetBytes),
              source: cfg.roomMemoryBudgetSource,
              heapLimitMiB: mib(v8.getHeapStatistics().heap_size_limit),
              heapLimitSource: cfg.heapLimitSource,
              costFactor: cfg.roomCostFactor,
              loadsUpToMiB: mib(cfg.roomMemoryBudgetBytes * LOAD_FRACTION),
              growthUpToMiB: mib(cfg.roomMemoryBudgetBytes * GROWTH_FRACTION),
              userShareMiB: mib(manager.share(false)),
              anonVisitorShareMiB: mib(manager.share(true)),
              anonTotalShareMiB: mib(manager.anonShare()),
              maxDocMiB: mib(cfg.maxDocBytes),
              anonMaxDocMiB: mib(cfg.anonMaxDocBytes),
              maxMessageMiB: mib(cfg.maxMessageBytes),
              anonMaxMessageMiB: mib(cfg.anonMaxMessageBytes),
            },
            'loaded-room memory budget',
          );
          // fv7 F1: the limits this deployment's memory cannot hold were lowered; say so loudly
          for (const w of cfg.memoryWarnings) log.warn({ budgetMiB: mib(cfg.roomMemoryBudgetBytes) }, `memory sizing: ${w}`);
          resolve();
        });
      }).then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!metricsServer) return resolve();
            metricsServer.once('error', reject);
            metricsServer.listen(cfg.metricsPort, cfg.metricsHost, () => {
              metricsServer.removeListener('error', reject);
              log.info({ port: cfg.metricsPort }, 'metrics listener (internal)');
              resolve();
            });
          }),
      );
    },
    async close(): Promise<void> {
      clearInterval(heapTimer);
      wsApp.close();
      await manager.shutdown('shutdown');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (metricsServer) await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    },
  };
}
