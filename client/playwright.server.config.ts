/**
 * Playwright suite against the REAL canvas server (see e2e-server/stack.ts): the stack is
 * started per spec file (fake core + in-memory S3 + node server/dist/index.js), so this
 * config intentionally has no webServer — the client's own `npm run e2e` (vite dev +
 * in-memory dev room) stays untouched.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-server',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
