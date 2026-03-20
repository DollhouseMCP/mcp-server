/**
 * Test Environment Configuration
 *
 * This module provides test-specific environment variable access.
 * Test code should ONLY use these functions to access GitHub credentials,
 * NEVER the production credentials from env.ts
 *
 * Safety Rules:
 * - Tests ONLY use GITHUB_TEST_* variables
 * - Tests NEVER fall back to production GITHUB_* variables
 * - Tests skip gracefully if test credentials are not configured
 *
 * Usage:
 * ```typescript
 * import { getTestGitHubToken, hasTestCredentials } from './config/test-env';
 *
 * if (!hasTestCredentials()) {
 *   console.log('⏭️ Skipping test - GITHUB_TEST_TOKEN not set');
 *   return;
 * }
 *
 * const token = getTestGitHubToken();
 * ```
 */

import { env } from './env.js';

/**
 * Get GitHub token for tests
 *
 * IMPORTANT: This function ONLY returns GITHUB_TEST_TOKEN and NEVER falls
 * back to the production GITHUB_TOKEN. This prevents tests from accidentally
 * using production credentials.
 *
 * @returns {string} Test GitHub token
 * @throws {Error} If GITHUB_TEST_TOKEN is not set
 */
export function getTestGitHubToken(): string {
  const token = env.GITHUB_TEST_TOKEN;

  if (!token) {
    throw new Error(
      '❌ GITHUB_TEST_TOKEN not set. Tests require dedicated test credentials.\n\n' +
      'To enable GitHub integration tests:\n' +
      '1. Create a SEPARATE GitHub account for testing (NOT your production account!)\n' +
      '2. Generate a token at: https://github.com/settings/tokens\n' +
      '3. Add to .env.local:\n' +
      '   GITHUB_TEST_TOKEN=ghp_your_test_token_here\n' +
      '   GITHUB_TEST_USERNAME=test-username\n' +
      '   GITHUB_TEST_REPOSITORY=test-username/dollhouse-test-sandbox\n\n' +
      '⚠️  NEVER use your production GITHUB_TOKEN for tests!'
    );
  }

  return token;
}

/**
 * Get GitHub username for tests
 *
 * @returns {string | undefined} Test GitHub username
 */
export function getTestGitHubUsername(): string | undefined {
  return env.GITHUB_TEST_USERNAME;
}

/**
 * Get GitHub repository for tests
 *
 * @returns {string | undefined} Test GitHub repository (format: username/repo)
 */
export function getTestGitHubRepository(): string | undefined {
  return env.GITHUB_TEST_REPOSITORY;
}

/**
 * Check if test credentials are configured
 *
 * Use this to conditionally run tests that require GitHub access:
 *
 * ```typescript
 * if (!hasTestCredentials()) {
 *   console.log('⏭️ Skipping GitHub test - credentials not configured');
 *   return;
 * }
 * ```
 *
 * @returns {boolean} True if GITHUB_TEST_TOKEN is set
 */
export function hasTestCredentials(): boolean {
  return !!env.GITHUB_TEST_TOKEN;
}

/**
 * Get skip message for tests
 *
 * Returns a consistent message for tests that are skipped due to missing credentials.
 *
 * @returns {string} Skip message with setup instructions
 */
export function getTestSkipMessage(): string {
  return (
    '⏭️  Skipping E2E tests - GITHUB_TEST_TOKEN not available\n\n' +
    'To run these tests:\n' +
    '1. Copy .env.example to .env.local\n' +
    '2. Set GITHUB_TEST_TOKEN with a token from a SEPARATE test GitHub account\n' +
    '3. Run tests again: npm run test:e2e\n\n' +
    'See docs/guides/environment-variables.md for detailed setup instructions.'
  );
}

/**
 * Assert test credentials are configured (for use in test setup)
 *
 * Call this in beforeAll() to ensure tests have required credentials.
 * Tests will fail with clear error message if credentials are missing.
 *
 * @throws {Error} If test credentials are not configured
 */
export function assertTestCredentials(): void {
  if (!hasTestCredentials()) {
    throw new Error(getTestSkipMessage());
  }
}
