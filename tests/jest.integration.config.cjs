const {
  hasVMModules,
  MODULE_NAME_MAPPER,
  ESM_TRANSFORM_IGNORE,
  applyEsmMode,
  applyCjsFallback
} = require('./transforms/jestShared.cjs');

if (!hasVMModules) {
  console.info('[jest.integration.config] --experimental-vm-modules not detected; using CJS fallback transform');
}

/** @type {import('jest').Config} */
const config = {
  displayName: 'Integration Tests',
  rootDir: '../',
  testEnvironment: 'node',
  transformIgnorePatterns: ESM_TRANSFORM_IGNORE,
  resolver: 'ts-jest-resolver',

  // Module name mapper to handle .js imports to .ts files (ES modules)
  moduleNameMapper: { ...MODULE_NAME_MAPPER },

  // Integration test specific settings
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  moduleDirectories: ['node_modules', '<rootDir>'],

  // Longer timeout for integration tests
  testTimeout: 30000,

  // Run tests sequentially to avoid conflicts
  maxWorkers: 1,

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Coverage settings for integration tests
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**'
  ],

  // Different coverage directory
  coverageDirectory: 'tests/coverage-integration',

  // Setup and teardown
  globalSetup: '<rootDir>/tests/setup.ts',
  globalTeardown: '<rootDir>/tests/teardown.ts'
};

if (hasVMModules) {
  applyEsmMode(config, '<rootDir>/tests/tsconfig.test.json');
} else {
  applyCjsFallback(config);
}

module.exports = config;
