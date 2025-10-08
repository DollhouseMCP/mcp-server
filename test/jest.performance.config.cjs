/** @type {import('jest').Config} */
const baseConfig = require('./jest.config.cjs');

const config = {
  ...baseConfig,
  testMatch: [
    '<rootDir>/test/__tests__/performance/**/*.test.ts'
  ],
  // Remove performance test exclusion from base config's ignore patterns
  testPathIgnorePatterns: baseConfig.testPathIgnorePatterns.filter(
    pattern => pattern !== '/test/__tests__/performance/'
  ),
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
