import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);
const app = createApp({ config: cfg, logger: log });

// Orphan sweep: canvas objects whose artifact is gone or expired are deleted with it
// (design §2 G7 / §8.4). Conservative — see RoomManager.sweep().
const sweepTimer = setInterval(() => {
  void app.manager.sweep().catch((err) => log.error({ err: String(err) }, 'sweep failed'));
}, cfg.sweepIntervalSeconds * 1000);
sweepTimer.unref();
void app.manager.sweep().catch((err) => log.error({ err: String(err) }, 'initial sweep failed'));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down');
  clearInterval(sweepTimer);
  const force = setTimeout(() => {
    log.error('graceful shutdown timed out');
    process.exit(1);
  }, 15_000);
  force.unref();
  try {
    await app.close();
    log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error({ err: String(err) }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void app.listen().catch((err) => {
  log.error({ err: String(err) }, 'failed to listen');
  process.exit(1);
});
