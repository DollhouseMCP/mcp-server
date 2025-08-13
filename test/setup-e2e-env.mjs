/**
 * E2E Test Environment Setup
 * Sets up environment variables and configuration for end-to-end testing
 */

// Simple environment setup without external dependencies

// Set default test environment variables if not provided
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.TEST_MODE = 'e2e';

// GitHub configuration for testing
if (!process.env.GITHUB_TOKEN && !process.env.CI) {
  console.warn('Warning: GITHUB_TOKEN not set - some E2E tests may be skipped');
}

// Test-specific GitHub configuration
process.env.TEST_GITHUB_USERNAME = process.env.TEST_GITHUB_USERNAME || process.env.GITHUB_USERNAME;
process.env.TEST_PORTFOLIO_REPO = process.env.TEST_PORTFOLIO_REPO || 'test-dollhouse-portfolio';

// Collection configuration
process.env.TEST_COLLECTION_URL = process.env.TEST_COLLECTION_URL || 'https://github.com/DollhouseMCP/collection';

// Disable real GitHub operations in CI unless explicitly enabled
if (process.env.CI && !process.env.ENABLE_GITHUB_OPERATIONS) {
  process.env.GITHUB_TOKEN = undefined;
  console.log('GitHub operations disabled in CI environment');
}

// Test timeout settings
process.env.TEST_TIMEOUT = process.env.TEST_TIMEOUT || '60000'; // 60 seconds

// Logging configuration for tests
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // Reduce noise in tests
process.env.DEBUG = process.env.DEBUG || ''; // Only enable debug if explicitly set

console.log('E2E Test Environment Configured:');
console.log(`- NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`- TEST_MODE: ${process.env.TEST_MODE}`);
console.log(`- GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? 'Set' : 'Not Set'}`);
console.log(`- TEST_GITHUB_USERNAME: ${process.env.TEST_GITHUB_USERNAME || 'Not Set'}`);
console.log(`- TEST_PORTFOLIO_REPO: ${process.env.TEST_PORTFOLIO_REPO}`);
console.log(`- TEST_TIMEOUT: ${process.env.TEST_TIMEOUT}ms`);