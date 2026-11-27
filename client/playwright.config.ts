import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5180);
const CROSS_BROWSER = !!process.env.CI || process.env.E2E_CROSS_BROWSER === '1';
const CROSS_BROWSER_SPECS = /(viewport-units|native-scroll-engines)\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // What the reporter does inside the artifact's page (viewport units, IntersectionObserver, the
    // document's native scroll) depends on each engine: those specs also run in Firefox and WebKit, in CI and with
    // E2E_CROSS_BROWSER=1 (`npx playwright install firefox webkit` first).
    ...(CROSS_BROWSER
      ? [
          { name: 'firefox', testMatch: CROSS_BROWSER_SPECS, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
          { name: 'webkit', testMatch: CROSS_BROWSER_SPECS, use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
        ]
      : []),
  ],
  webServer: {
    command: `PORT=${PORT} npm run dev`,
    url: `http://127.0.0.1:${PORT}/_canvas/sample-report.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
