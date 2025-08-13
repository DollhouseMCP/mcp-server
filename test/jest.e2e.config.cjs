/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '..',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { 
      useESM: true,
      tsconfig: {
        allowJs: true,
        rootDir: '.',
        isolatedModules: true
      }
    }]
  },
  testMatch: [
    '<rootDir>/test/e2e/**/*.test.ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  coverageDirectory: 'test/coverage-e2e',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.mjs'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  roots: ['<rootDir>'],
  testTimeout: 60000, // 60 seconds for E2E tests
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol|zod)/)'
  ],
  resolver: 'ts-jest-resolver',
  // E2E specific settings
  maxWorkers: 1, // Run E2E tests serially to avoid conflicts
  forceExit: true, // Force exit after tests complete
  detectOpenHandles: true, // Help identify resource leaks
  verbose: true, // Detailed output for E2E tests
  // Environment variables for E2E tests
  setupFiles: ['<rootDir>/test/setup-e2e-env.mjs']
};

module.exports = config;