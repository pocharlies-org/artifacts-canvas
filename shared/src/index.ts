/**
 * @pocharlies/artifacts-canvas-shared — the single source of truth shared by the
 * artifacts-canvas client and server:
 *   ./model      document schema (ROOT) and data types (Shape, Identity, ...)
 *   ./protocol   wire message types (100 IDENTITY, 101 NOTICE), close codes, codecs
 *   ./stamper    server-side attribution stamper + content-document write guard
 *   ./ledger     the two documents of a room (content / ledger), legacy migration, writers
 *   ./awareness  awareness sanitization (verified identity forced into `user`)
 */
export * from './model.js';
export * from './protocol.js';
export * from './stamper.js';
export * from './awareness.js';
export * from './ledger.js';
