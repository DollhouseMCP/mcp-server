const path = require('path');
const {
  hasVMModules,
  ROOT_DIR,
  MODULE_NAME_MAPPER,
  ESM_TRANSFORM_IGNORE,
  applyEsmMode,
  applyCjsFallback
} = require('./transforms/jestShared.cjs');

if (!hasVMModules) {
  console.info('[jest.config] --experimental-vm-modules not detected; using CJS fallback transform');
}

/** @type {import('jest').Config} */
const config = {
  displayName: 'Unit Tests',
  testEnvironment: 'node',
  rootDir: ROOT_DIR,
  moduleNameMapper: { ...MODULE_NAME_MAPPER },
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.spec.ts',
    '<rootDir>/packages/*/tests/**/*.test.ts'  // Include standalone package tests (e.g., @dollhousemcp/safety)
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/integration/',   // Integration tests run via jest.integration.config.cjs
    '/tests/performance/'    // Performance tests run separately to avoid resource contention
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  coverageDirectory: 'tests/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: [path.join(ROOT_DIR, 'tests/jest.setup.mjs')],
  modulePathIgnorePatterns: [path.join(ROOT_DIR, 'dist/')],
  roots: [ROOT_DIR],
  testTimeout: 10000,
  // Force garbage collection between test files to reduce memory pressure
  workerIdleMemoryLimit: '512MB',
  transformIgnorePatterns: ESM_TRANSFORM_IGNORE,
  resolver: 'ts-jest-resolver'
};

if (hasVMModules) {
  applyEsmMode(config, {
    allowJs: true,
    rootDir: '.',
    isolatedModules: true,
    module: 'esnext',
    moduleResolution: 'node'
  });
} else {
  applyCjsFallback(config);
  // Exclude ESM-only tests that crash in CJS mode
  config.testPathIgnorePatterns = [
    ...(config.testPathIgnorePatterns || []),
    'autonomyEvaluator\\.test\\.ts$',  // Uses jest.unstable_mockModule + top-level await
    'AgentManager\\.test\\.ts$',        // Auto-mock of FileLockManager causes stack overflow in CJS
  ];
}

// Limit workers to prevent OOM in CI/Docker (which may report host CPUs but have limited memory).
// Use max 2 workers - Docker containers see all host CPUs but have limited memory allocation.
// Note: setting `maxWorkers: undefined` fails Jest config validation, so only set when defined.
if (process.env.CI) {
  config.maxWorkers = 2;
}

module.exports = config;
