import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({ level });
}

export type { Logger };
