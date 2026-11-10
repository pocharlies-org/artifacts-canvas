/**
 * Attribution stamper (protocol §5).
 * The single source of truth is `@pocharlies/artifacts-canvas-shared/stamper`
 * (shared/src/stamper.ts): the production server, the development room and the
 * client-side fallback all run this exact implementation. This module re-exports it.
 */
export * from '@pocharlies/artifacts-canvas-shared/stamper';
