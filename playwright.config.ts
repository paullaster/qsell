import { defineConfig } from '@playwright/test';
import { AUTH_FILE, E2E_PORT, E2E_URL } from './e2e/support/constants';
import { e2eEnvironment } from './e2e/support/env';

/**
 * End-to-end tests, run in the Chrome already installed on the machine against their own
 * database, their own port and their own build folder, so the development server and its
 * database are never touched:
 *
 *   E2E_DATABASE_URL=postgres://user:pass@127.0.0.1:5434/qsell_e2e pnpm test:e2e
 *
 * Every test runs at a desktop width and at a phone width.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  // One retry: the development server compiles routes on first use, which can stall a first attempt.
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  use: {
    baseURL: E2E_URL,
    channel: 'chrome',
    storageState: AUTH_FILE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    {
      name: 'phone',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    // Migrate first, so the server never starts against an empty database.
    command: `pnpm exec drizzle-kit migrate && exec pnpm exec next dev -p ${String(E2E_PORT)}`,
    url: `${E2E_URL}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: e2eEnvironment(),
  },
});
