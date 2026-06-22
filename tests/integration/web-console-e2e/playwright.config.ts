import { defineConfig } from '@playwright/test';

import { BASE_URL } from './setup/provision.js';

/**
 * Real-auth lifecycle config: boots an isolated app (own port/DB) via globalSetup
 * and drives the actual browser login / TOTP / step-up flow. Uses the system
 * Google Chrome (`channel: 'chrome'`) — the prebuilt Playwright chromium is
 * unsupported on this OS, and `npx playwright install` must NOT be run here.
 */
export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.pw-spec.ts',
  globalSetup: './setup/playwrightGlobalSetup.ts',
  globalTeardown: './setup/playwrightGlobalTeardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: true,
    ignoreHTTPSErrors: true,
  },
});
