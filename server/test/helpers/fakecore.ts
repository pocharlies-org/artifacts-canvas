/**
 * The server tests use the same fake core as `npm run dev` and the end-to-end suite.
 * The implementation lives in dev/fake-core.ts (single source); this module re-exports it
 * so the tests keep their historical import path.
 */
export * from '../../../dev/fake-core.js';
