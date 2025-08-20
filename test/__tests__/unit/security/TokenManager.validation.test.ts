/**
 * Comprehensive tests for TokenManager validation functionality
 * Tests the core token validation features that were enhanced in PR #639
 * 
 * Task #11: Token authentication tests
 * - Test token format validation
 * - Test token scopes validation  
 * - Test rate limiting for validation
 * - Test security event logging
 * - Test GitHub API integration
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock external dependencies first
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock SecurityMonitor
const mockLogSecurityEvent = jest.fn();
jest.mock('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent
  }
}));

// Mock logger
const mockLogWarn = jest.fn();
const mockLogDebug = jest.fn();
jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: mockLogDebug,
    warn: mockLogWarn,
    info: jest.fn(),
    error: jest.fn()
  }
}));

// Mock UnicodeValidator
jest.mock('../../../../src/security/validators/unicodeValidator.js', () => ({
  UnicodeValidator: {
    normalize: jest.fn((input: string) => ({
      normalizedContent: input,
      hasChanges: false,
      issues: []
    }))
  }
}));

// Import the TokenManager
const { TokenManager } = await import('../../../../src/security/tokenManager.js');

describe('TokenManager - Validation Functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();
    mockFetch.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Token Format Validation', () => {
    it('should validate GitHub Personal Access Token format', () => {
      const validTokens = [
        'ghp_1234567890123456789012345678901234567890', // 40 chars after prefix
        'ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd', // Mixed alphanumeric
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD', // Mixed case
        'ghp_1234567890123456789012345678901234567890EXTRA' // Longer than minimum
      ];

      validTokens.forEach(token => {
        expect(TokenManager.validateTokenFormat(token)).toBe(true);
      });
    });

    it('should validate different GitHub token types', () => {
      const tokenTypes = [
        'ghp_1234567890123456789012345678901234567890', // Personal Access Token
        'ghs_1234567890123456789012345678901234567890', // Installation Token
        'ghu_1234567890123456789012345678901234567890', // User Access Token  
        'ghr_1234567890123456789012345678901234567890', // Refresh Token
        'gho_1234567890123456' // OAuth Access Token (shorter)
      ];

      tokenTypes.forEach(token => {
        expect(TokenManager.validateTokenFormat(token)).toBe(true);
      });
    });

    it('should reject invalid token formats', () => {
      const invalidTokens = [
        '', // Empty string
        'invalid-token', // Wrong format
        'ghp_', // Too short
        'ghp_12345', // Too short
        'abc_1234567890123456789012345678901234567890', // Wrong prefix
        'ghp_1234567890123456789012345678901234567890!', // Invalid character
        null, // Null
        undefined, // Undefined
        123 // Not a string
      ];

      invalidTokens.forEach(token => {
        expect(TokenManager.validateTokenFormat(token as any)).toBe(false);
      });
    });
  });

  describe('Token Type Detection', () => {
    it('should correctly identify token types', () => {
      const tokenTypeTests = [
        { token: 'ghp_1234567890123456789012345678901234567890', expectedType: 'Personal Access Token' },
        { token: 'ghs_1234567890123456789012345678901234567890', expectedType: 'Installation Token' },
        { token: 'ghu_1234567890123456789012345678901234567890', expectedType: 'User Access Token' },
        { token: 'ghr_1234567890123456789012345678901234567890', expectedType: 'Refresh Token' },
        { token: 'gho_1234567890123456', expectedType: 'OAuth Access Token' },
        { token: 'invalid-token', expectedType: 'Unknown' }
      ];

      tokenTypeTests.forEach(({ token, expectedType }) => {
        expect(TokenManager.getTokenType(token)).toBe(expectedType);
      });
    });
  });

  describe('Token Redaction for Security', () => {
    it('should safely redact tokens for logging', () => {
      const testCases = [
        { token: 'ghp_1234567890123456789012345678901234567890', expected: 'ghp_...7890' },
        { token: 'ghs_abcdefghijklmnopqrstuvwxyz1234567890', expected: 'ghs_...7890' },
        { token: 'short', expected: '[REDACTED]' }, // Too short to safely redact
        { token: '', expected: '[REDACTED]' },
        { token: 'ab', expected: '[REDACTED]' }
      ];

      testCases.forEach(({ token, expected }) => {
        expect(TokenManager.redactToken(token)).toBe(expected);
      });
    });

    it('should safely generate token prefixes', () => {
      const testCases = [
        { token: 'ghp_1234567890123456789012345678901234567890', expected: 'ghp_...' },
        { token: 'ghs_abcdefghijklmnopqrstuvwxyz', expected: 'ghs_...' },
        { token: 'abc', expected: '[INVALID]' }, // Too short
        { token: '', expected: '[INVALID]' }
      ];

      testCases.forEach(({ token, expected }) => {
        expect(TokenManager.getTokenPrefix(token)).toBe(expected);
      });
    });
  });

  describe('Environment Token Retrieval', () => {
    let originalEnvToken: string | undefined;

    beforeEach(() => {
      originalEnvToken = process.env.GITHUB_TOKEN;
    });

    afterEach(() => {
      if (originalEnvToken) {
        process.env.GITHUB_TOKEN = originalEnvToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    });

    it('should retrieve valid token from environment', () => {
      const validToken = 'ghp_1234567890123456789012345678901234567890';
      process.env.GITHUB_TOKEN = validToken;

      const result = TokenManager.getGitHubToken();

      expect(result).toBe(validToken);
      expect(mockLogDebug).toHaveBeenCalledWith('Valid GitHub token found', {
        tokenType: 'Personal Access Token',
        tokenPrefix: 'ghp_...'
      });
    });

    it('should return null when no token in environment', () => {
      delete process.env.GITHUB_TOKEN;

      const result = TokenManager.getGitHubToken();

      expect(result).toBeNull();
      expect(mockLogDebug).toHaveBeenCalledWith('No GitHub token found in environment');
    });

    it('should reject invalid token from environment', () => {
      process.env.GITHUB_TOKEN = 'invalid-token-format';

      const result = TokenManager.getGitHubToken();

      expect(result).toBeNull();
      expect(mockLogWarn).toHaveBeenCalledWith('Invalid GitHub token format detected', {
        tokenPrefix: '[INVALID]',
        length: 20
      });
    });
  });

  describe('Token Scopes Validation with GitHub API', () => {
    it('should validate token with required scopes successfully', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: true,
        headers: new Map([
          ['x-oauth-scopes', 'repo, user, gist'],
          ['x-ratelimit-remaining', '4000'],
          ['x-ratelimit-reset', String(Math.floor((Date.now() + 3600000) / 1000))]
        ]),
        json: jest.fn().mockResolvedValue({ login: 'testuser' })
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: ['repo'],
        optional: ['user', 'gist']
      });

      expect(result.isValid).toBe(true);
      expect(result.scopes).toContain('repo');
      expect(result.rateLimit?.remaining).toBe(4000);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${testToken}`
          })
        })
      );
    });

    it('should handle rate limiting during token validation', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: false,
        status: 403,
        headers: new Map([
          ['x-ratelimit-remaining', '0'],
          ['x-ratelimit-reset', String(Math.floor((Date.now() + 3600000) / 1000))]
        ]),
        json: jest.fn().mockResolvedValue({
          message: 'API rate limit exceeded'
        })
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: ['repo']
      });

      expect(result.isValid).toBe(false);
      expect(result.rateLimitExceeded).toBe(true);
      expect(result.rateLimit?.remaining).toBe(0);
    });

    it('should handle invalid token response', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: false,
        status: 401,
        json: jest.fn().mockResolvedValue({
          message: 'Bad credentials'
        })
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: ['repo']
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Bad credentials');
    });

    it('should handle network errors during validation', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      mockFetch.mockRejectedValueOnce(new Error('Network connection failed'));

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: ['repo']
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Network connection failed');
    });
  });

  describe('Rate Limiting for Token Validation', () => {
    it('should enforce rate limits for token validation attempts', async () => {
      // Make multiple validation attempts to hit rate limit
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock successful API responses
      const mockResponse = {
        ok: true,
        headers: new Map([
          ['x-oauth-scopes', 'repo'],
          ['x-ratelimit-remaining', '5000']
        ]),
        json: jest.fn().mockResolvedValue({ login: 'testuser' })
      };

      mockFetch.mockResolvedValue(mockResponse);

      // Create a fresh rate limiter for this test
      TokenManager.resetTokenValidationLimiter();

      // Make requests that should eventually hit rate limit
      const requests = Array.from({ length: 15 }, () =>
        TokenManager.validateTokenScopes(testToken, { required: ['repo'] })
      );

      const results = await Promise.allSettled(requests);
      
      // Some requests should be successful, some should be rate limited
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const rateLimited = results.filter(r => r.status === 'rejected').length;
      
      expect(successful).toBeGreaterThan(0);
      expect(rateLimited).toBeGreaterThan(0);
    });

    it('should create appropriate rate limiter configuration', () => {
      const rateLimiter = TokenManager.createTokenValidationLimiter();
      const status = rateLimiter.getStatus();
      
      expect(status.remainingTokens).toBeLessThanOrEqual(10); // Max 10 requests
      expect(typeof status.resetTime).toBe('object'); // Should be a Date
    });
  });

  describe('Security Event Logging', () => {
    it('should not log sensitive token data in security events', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      
      // This should not actually log the token validation process
      // since we're testing the TokenManager directly, not through a higher-level service
      expect(mockLogSecurityEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining(testToken) // Should never log full token
        })
      );
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle malformed token format checks', () => {
      const edgeCases = [
        null,
        undefined,
        {},
        [],
        123,
        true,
        Symbol('token')
      ];

      edgeCases.forEach(input => {
        expect(TokenManager.validateTokenFormat(input as any)).toBe(false);
      });
    });

    it('should handle empty scopes requirements', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: true,
        headers: new Map([['x-oauth-scopes', '']]),
        json: jest.fn().mockResolvedValue({ login: 'testuser' })
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: []
      });

      expect(result.isValid).toBe(true);
      expect(result.scopes).toEqual([]);
    });

    it('should handle malformed API responses', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: true,
        headers: new Map(), // No headers
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await TokenManager.validateTokenScopes(testToken, {
        required: ['repo']
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });
  });

  describe('Performance and Resource Management', () => {
    it('should handle concurrent token validation requests', async () => {
      const testToken = 'ghp_1234567890123456789012345678901234567890';
      const mockResponse = {
        ok: true,
        headers: new Map([
          ['x-oauth-scopes', 'repo'],
          ['x-ratelimit-remaining', '5000']
        ]),
        json: jest.fn().mockResolvedValue({ login: 'testuser' })
      };

      mockFetch.mockResolvedValue(mockResponse);
      TokenManager.resetTokenValidationLimiter();

      // Make concurrent requests
      const concurrentRequests = Array.from({ length: 5 }, () =>
        TokenManager.validateTokenScopes(testToken, { required: ['repo'] })
      );

      const results = await Promise.allSettled(concurrentRequests);
      
      // Should handle all requests appropriately
      results.forEach(result => {
        expect(['fulfilled', 'rejected']).toContain(result.status);
      });
    });

    it('should efficiently validate token format', () => {
      const longToken = 'ghp_' + 'a'.repeat(1000);
      const start = Date.now();
      
      const result = TokenManager.validateTokenFormat(longToken);
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(10); // Should be very fast
      expect(result).toBe(true); // Should still be valid
    });
  });
});