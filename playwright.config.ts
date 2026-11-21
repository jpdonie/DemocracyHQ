import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the browser-test build, served under a sub-path the
 * way GitHub Pages serves a project site. The test build is the production build
 * made in Vite's "e2e" mode (`vite build --mode e2e`): it is identical except that
 * it exposes the map object as window.__dhqMap for the map tests. A production
 * build (`npm run build`, dist/) never exposes it, whatever the page address.
 *
 *   npm run test:e2e           builds dist-e2e/ (npm run build:e2e), then runs the tests
 *   npx playwright test        runs the tests against an existing dist-e2e/
 *
 * E2E_DIST points the run at another test build folder (made with
 * `npx vite build --mode e2e --outDir <folder>`), and E2E_PORT at another port,
 * for example to test a second build while the first is still being served.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const DIST = process.env.E2E_DIST ?? 'dist-e2e';
export const SITE_PREFIX = '/democracyhq-preview/';
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `${ORIGIN}${SITE_PREFIX}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    // The tests cover the watchlist, which lives in localStorage; every test starts with a clean profile.
    storageState: undefined,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /phone\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'phone',
      testMatch: /phone\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: `node scripts/serve-subpath.mjs --port ${PORT} --prefix ${SITE_PREFIX} --dir ${JSON.stringify(DIST)}`,
    url: `${ORIGIN}${SITE_PREFIX}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
