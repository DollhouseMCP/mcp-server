/**
 * Test credentials for unit tests
 *
 * IMPORTANT: These are MOCK credentials for testing only.
 * They are intentionally obvious fakes and should NEVER be real values.
 * All values are clearly marked as test/mock/fake to avoid confusion.
 *
 * @security-audit-suppress OWASP-A01-001 - Intentional test credentials
 * @sonarcloud-suppress typescript:S2068 - Hardcoded credentials for testing
 * @sonarcloud-suppress typescript:S6418 - Hardcoded secrets for testing
 */

import { randomInt } from 'node:crypto';

// NOSONAR - These are intentional mock credentials for testing
// security:audit:suppress - All credentials in this file are fake test values
export const TEST_CREDENTIALS = {
  // Mock GitHub tokens - clearly fake patterns
  MOCK_GITHUB_PAT: 'ghp_FAKE1234567890TESTTOKEN1234567890TEST', // NOSONAR - Fake test token
  MOCK_GITHUB_OAUTH: 'gho_FAKE1234567890TESTTOKEN1234567890TEST', // NOSONAR - Fake test token
  MOCK_GITHUB_INVALID: 'invalid_token_format_for_testing', // NOSONAR - Intentionally invalid

  // Mock API keys - obviously fake
  MOCK_API_KEY: 'sk-FAKE-TEST-KEY-DO-NOT-USE-1234567890', // NOSONAR - Fake API key for testing
  MOCK_SECRET_KEY: 'secret_FAKE_TEST_KEY_NOT_REAL_123456', // NOSONAR - Fake secret for testing

  // Mock passwords - clearly for testing
  MOCK_PASSWORD: 'test_password_NOT_REAL_123', // NOSONAR - Fake password for testing
  MOCK_ADMIN_PASSWORD: 'admin_test_FAKE_password_456', // NOSONAR - Fake admin password

  // Mock secrets - obviously fake patterns
  MOCK_SECRET: 'test-secret-value-NOT-REAL', // NOSONAR - Fake secret value
  MOCK_TOKEN: 'test-token-FAKE-1234567890', // NOSONAR - Fake token for testing

  // Redacted patterns for testing redaction
  REDACTED_TOKEN: '***REDACTED***',
  PARTIAL_REDACT: 'ghp_...TEST',
} as const;

/**
 * Test patterns for security scanning tests
 * These are patterns that SHOULD be detected as vulnerabilities
 *
 * @security-audit-suppress OWASP-A01-001 - Intentional vulnerable patterns for testing
 */
// NOSONAR - These patterns are for security testing
// security:audit:suppress - Intentional vulnerable patterns to test detection
export const VULNERABLE_PATTERNS = {
  // Patterns that look real but are fake - for testing detection
  REALISTIC_API_KEY: 'sk-1234567890abcdef1234567890abcdef', // NOSONAR - Test pattern for security scanner
  REALISTIC_PASSWORD: 'super_secret_password_123', // NOSONAR - Test pattern for security scanner
  HARDCODED_SECRET: 'hardcoded_password_123', // NOSONAR - Test pattern for security scanner
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
 *
 * FIX: Use crypto.randomInt() instead of Math.random() for security compliance
 * Previously: Used Math.random() which is predictable
 * Now: Uses crypto.randomInt() for cryptographically secure randomness
 * SonarCloud: Resolves "Make sure using this pseudorandom number generator is safe" hotspot
 */
export function generateTestToken(prefix = 'test'): string {
  const timestamp = Date.now();
  // Use crypto.randomInt() for secure random generation (0-9999)
  // This provides cryptographically secure randomness even for test tokens
  const random = randomInt(0, 10000);
  return `${prefix}_FAKE_${timestamp}_${random}_NOT_REAL`;
}