/**
 * Wire protocol additions on top of y-websocket (see docs/protocol.md).
 * The single source of truth is `@pocharlies/artifacts-canvas-shared/protocol`
 * (shared/src/protocol.ts), used identically by the server. This module re-exports
 * it so the client keeps its historical import paths.
 */
export * from '@pocharlies/artifacts-canvas-shared/protocol';
