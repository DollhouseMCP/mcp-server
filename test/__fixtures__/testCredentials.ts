/**
 * Test credentials for unit tests
 *
 * IMPORTANT: These are MOCK credentials for testing only.
 * They are intentionally obvious fakes and should NEVER be real values.
 * All values are clearly marked as test/mock/fake to avoid confusion.
 */

// NOSONAR - These are intentional mock credentials for testing
export const TEST_CREDENTIALS = {
  // Mock GitHub tokens - clearly fake patterns
  MOCK_GITHUB_PAT: 'ghp_FAKE1234567890TESTTOKEN1234567890TEST',
  MOCK_GITHUB_OAUTH: 'gho_FAKE1234567890TESTTOKEN1234567890TEST',
  MOCK_GITHUB_INVALID: 'invalid_token_format_for_testing',

  // Mock API keys - obviously fake
  MOCK_API_KEY: 'sk-FAKE-TEST-KEY-DO-NOT-USE-1234567890',
  MOCK_SECRET_KEY: 'secret_FAKE_TEST_KEY_NOT_REAL_123456',

  // Mock passwords - clearly for testing
  MOCK_PASSWORD: 'test_password_NOT_REAL_123',
  MOCK_ADMIN_PASSWORD: 'admin_test_FAKE_password_456',

  // Mock secrets - obviously fake patterns
  MOCK_SECRET: 'test-secret-value-NOT-REAL',
  MOCK_TOKEN: 'test-token-FAKE-1234567890',

  // Redacted patterns for testing redaction
  REDACTED_TOKEN: '***REDACTED***',
  PARTIAL_REDACT: 'ghp_...TEST',
} as const;

/**
 * Test patterns for security scanning tests
 * These are patterns that SHOULD be detected as vulnerabilities
 */
// NOSONAR - These patterns are for security testing
export const VULNERABLE_PATTERNS = {
  // Patterns that look real but are fake - for testing detection
  REALISTIC_API_KEY: 'sk-1234567890abcdef1234567890abcdef', // NOSONAR - Test pattern
  REALISTIC_PASSWORD: 'super_secret_password_123', // NOSONAR - Test pattern
  HARDCODED_SECRET: 'hardcoded_password_123', // NOSONAR - Test pattern
} as const;

/**
 * Get test credential from environment or use mock
 * This allows CI to use different values if needed
 */
export function getTestCredential(key: keyof typeof TEST_CREDENTIALS): string {
  // In CI, we might want to use different mock values
  const envKey = `TEST_${key}`;
  return process.env[envKey] || TEST_CREDENTIALS[key];
}

/**
 * Generate a unique test token for isolation
 * Ensures each test has its own unique fake token
 */
export function generateTestToken(prefix = 'test'): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  return `${prefix}_FAKE_${timestamp}_${random}_NOT_REAL`;
}