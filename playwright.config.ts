/**
 * Playwright configuration for DollhouseMCP web console browser tests.
 *
 * Starts the web server in standalone --web mode on a test-only port,
 * then runs browser tests against it.
 *
 * Usage:
 *   npx playwright test                    # run all browser tests
 *   npx playwright test --headed           # run with visible browser
 *   npx playwright test --ui               # interactive UI mode
 */

import { defineConfig, devices } from '@playwright/test';

const TEST_PORT = 41716;

export default defineConfig({
  testDir: './tests/playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,

  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `node dist/index.js --web --port=${TEST_PORT} --no-open`,
    url: `http://127.0.0.1:${TEST_PORT}/api/setup/version`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
