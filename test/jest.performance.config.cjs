/** @type {import('jest').Config} */
const baseConfig = require('./jest.config.cjs');

const config = {
  ...baseConfig,
  testMatch: [
    '<rootDir>/test/__tests__/performance/**/*.test.ts'
  ],
  // Override to only ignore base paths, not performance tests
  testPathIgnorePatterns: [
    '/node_modules/',
    '/test/__tests__/integration/',
    // Temporarily ignore tests with ES module mocking issues
    'convertToGit\\.test\\.ts$',
    'UpdateManager\\.npm\\.test\\.ts$',
    'BackupManager\\.npm\\.test\\.ts$',
    'InstallationDetector\\.test\\.ts$',
    'GitHubAuthManager\\.test\\.ts$',
    'CollectionCache\\.test\\.ts$',
    'EnhancedIndexManager\\.extractActionTriggers\\.test\\.ts$',
    'EnhancedIndexManager\\.telemetry\\.test\\.ts$',
    'EnhancedIndexManager\\.triggerMetrics\\.test\\.ts$',
    'memory-enhanced-index\\.test\\.ts$',
    'skill-enhanced-index\\.test\\.ts$'
  ],
  // Run in band (single worker) to avoid resource contention
  maxWorkers: 1,
  // Increase timeout for performance tests
  testTimeout: 30000,
  // Display individual test results
  verbose: true,
  // Don't collect coverage for performance tests
  collectCoverage: false
};

module.exports = config;
