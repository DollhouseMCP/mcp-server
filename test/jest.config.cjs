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
    '<rootDir>/test/__tests__/**/*.test.ts',
    '<rootDir>/test/**/?(*.)+(spec|test).ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/test/__tests__/integration/',
    '/test/__tests__/performance/',  // Performance tests run separately to avoid resource contention
    // Temporarily ignore tests with ES module mocking issues
    'convertToGit\\.test\\.ts$',
    'UpdateManager\\.npm\\.test\\.ts$',
    'BackupManager\\.npm\\.test\\.ts$',
    'InstallationDetector\\.test\\.ts$',
    'GitHubAuthManager\\.test\\.ts$',  // Complex mocking issues - needs complete rewrite
    'CollectionCache\\.test\\.ts$',  // ESM mocking issues with fs/promises
    'EnhancedIndexManager\\.extractActionTriggers\\.test\\.ts$',  // ESM mocking issues with logger
    'EnhancedIndexManager\\.telemetry\\.test\\.ts$',  // ESM mocking issues with ConfigManager
    'EnhancedIndexManager\\.triggerMetrics\\.test\\.ts$',  // ESM compatibility issues with rebuild method
    'memory-enhanced-index\\.test\\.ts$',  // ESM compatibility issues with EnhancedIndexManager
    'skill-enhanced-index\\.test\\.ts$'  // ESM compatibility issues with EnhancedIndexManager (Issue #1121)
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  coverageDirectory: 'test/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.mjs'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  roots: ['<rootDir>'],
  testTimeout: 30000, // Increased to 30s to prevent teardown issues with async file operations
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol|zod)/)'
  ],
  resolver: 'ts-jest-resolver'
};

module.exports = config;