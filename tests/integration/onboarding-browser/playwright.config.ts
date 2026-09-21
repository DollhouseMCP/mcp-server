import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs', testMatch: '**/*.pw-spec.ts',
  globalSetup: './setup/globalSetup.ts', globalTeardown: './setup/globalTeardown.ts',
  timeout: 60_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, reporter: [['list']],
  use: { channel: 'chrome', headless: true, ignoreHTTPSErrors: true },
});
