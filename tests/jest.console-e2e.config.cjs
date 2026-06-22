const {
  hasVMModules,
  MODULE_NAME_MAPPER,
  ESM_TRANSFORM_IGNORE,
  applyEsmMode,
  applyCjsFallback,
} = require('./transforms/jestShared.cjs');

/** @type {import('jest').Config} */
const config = {
  displayName: 'Web Console E2E',
  rootDir: '../',
  testEnvironment: 'node',
  transformIgnorePatterns: ESM_TRANSFORM_IGNORE,
  resolver: 'ts-jest-resolver',
  moduleNameMapper: { ...MODULE_NAME_MAPPER },

  // Distinct suffix so the shared integration config (**/*.test.ts) never runs
  // these — they require a booted app + provisioned database.
  testMatch: ['<rootDir>/tests/integration/web-console-e2e/specs/**/*.e2e-spec.ts'],
  moduleDirectories: ['node_modules', '<rootDir>'],

  // Booting the app + DB round-trips are slow; one shared instance, serial.
  testTimeout: 60000,
  maxWorkers: 1,

  globalSetup: '<rootDir>/tests/integration/web-console-e2e/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/integration/web-console-e2e/setup/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/tests/integration/web-console-e2e/setup/afterEnv.ts'],
};

if (hasVMModules) {
  applyEsmMode(config, '<rootDir>/tests/tsconfig.test.json');
} else {
  applyCjsFallback(config);
}

module.exports = config;
