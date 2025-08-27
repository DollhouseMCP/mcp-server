import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TokenManager } from '../../../src/security/tokenManager.js';

describe('TokenManager - GitHub Token Security', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear environment
    delete process.env.GITHUB_TOKEN;
    // Reset rate limiter before each test to prevent interference
    TokenManager.resetTokenValidationLimiter();
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clean up rate limiter after each test
    TokenManager.resetTokenValidationLimiter();
  });

  describe('validateTokenFormat', () => {
    test('should validate GitHub Personal Access Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghp_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should validate GitHub Installation Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghs_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should validate GitHub User Access Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghu_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should validate GitHub Refresh Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghr_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should reject invalid token formats', () => {
      // These should be rejected as they don't match GitHub patterns
      expect(TokenManager.validateTokenFormat('invalid_token')).toBe(false);
      expect(TokenManager.validateTokenFormat('')).toBe(false);
      expect(TokenManager.validateTokenFormat('abc_1234567890123456789012345678901234567890')).toBe(false);
      expect(TokenManager.validateTokenFormat('gh_missing_letter')).toBe(false);
      expect(TokenManager.validateTokenFormat('ghp')).toBe(false);  // Missing underscore and content
      expect(TokenManager.validateTokenFormat('ghp_')).toBe(false); // Missing content after underscore
      
      // These should now pass with our flexible validation
      expect(TokenManager.validateTokenFormat('ghp_test')).toBe(true);  // Any content after ghp_ is valid
      expect(TokenManager.validateTokenFormat('gho_test123')).toBe(true); // Short OAuth token
      expect(TokenManager.validateTokenFormat('ghx_test_token')).toBe(true); // Future token types
      expect(TokenManager.validateTokenFormat('github_pat_test')).toBe(true); // Fine-grained PAT
    });

    test('should reject null or undefined tokens', () => {
      expect(TokenManager.validateTokenFormat(null as any)).toBe(false);
      expect(TokenManager.validateTokenFormat(undefined as any)).toBe(false);
    });
  });

  describe('redactToken', () => {
    test('should safely redact tokens for logging', () => {
      const token = 'ghp_1234567890123456789012345678901234567890';
      const redacted = TokenManager.redactToken(token);
      expect(redacted).toBe('ghp_...7890');
      expect(redacted).not.toContain('1234567890123456789012345678901234');
    });

    test('should handle short tokens', () => {
      expect(TokenManager.redactToken('short')).toBe('[REDACTED]');
      expect(TokenManager.redactToken('')).toBe('[REDACTED]');
    });

    test('should handle null/undefined tokens', () => {
      expect(TokenManager.redactToken(null as any)).toBe('[REDACTED]');
      expect(TokenManager.redactToken(undefined as any)).toBe('[REDACTED]');
    });
  });

  describe('getGitHubToken', () => {
    test('should return null when no token is set', () => {
      expect(TokenManager.getGitHubToken()).toBe(null);
    });

    test('should return valid token when format is correct', () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      expect(TokenManager.getGitHubToken()).toBe('ghp_1234567890123456789012345678901234567890');
    });

    test('should return null for invalid token format', () => {
      process.env.GITHUB_TOKEN = 'invalid_token';
      expect(TokenManager.getGitHubToken()).toBe(null);
    });

    test('should handle empty token', () => {
      process.env.GITHUB_TOKEN = '';
      expect(TokenManager.getGitHubToken()).toBe(null);
    });
  });

  describe('getTokenType', () => {
    test('should identify Personal Access Token', () => {
      expect(TokenManager.getTokenType('ghp_1234567890123456789012345678901234567890')).toBe('Personal Access Token');
    });

    test('should identify Installation Token', () => {
      expect(TokenManager.getTokenType('ghs_1234567890123456789012345678901234567890')).toBe('Installation Token');
    });

    test('should identify User Access Token', () => {
      expect(TokenManager.getTokenType('ghu_1234567890123456789012345678901234567890')).toBe('User Access Token');
    });

    test('should identify Refresh Token', () => {
      expect(TokenManager.getTokenType('ghr_1234567890123456789012345678901234567890')).toBe('Refresh Token');
    });

    test('should return Unknown for invalid tokens', () => {
      expect(TokenManager.getTokenType('invalid_token')).toBe('Unknown');
    });
  });

  describe('getTokenPrefix', () => {
    test('should return safe prefix for valid tokens', () => {
      expect(TokenManager.getTokenPrefix('ghp_1234567890123456789012345678901234567890')).toBe('ghp_...');
    });

    test('should handle short tokens', () => {
      expect(TokenManager.getTokenPrefix('abc')).toBe('[INVALID]');
      expect(TokenManager.getTokenPrefix('')).toBe('[INVALID]');
    });
  });

  describe('createSafeErrorMessage', () => {
    test('should remove tokens from error messages', () => {
      const errorWithToken = 'API failed with token ghp_1234567890123456789012345678901234567890';
      const safeMessage = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeMessage).toContain('[REDACTED_PAT]');
      expect(safeMessage).not.toContain('ghp_1234567890123456789012345678901234567890');
    });

    test('should remove Installation tokens', () => {
      const errorWithToken = 'Error: ghs_1234567890123456789012345678901234567890 is invalid';
      const safeMessage = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeMessage).toContain('[REDACTED_INSTALL]');
      expect(safeMessage).not.toContain('ghs_1234567890123456789012345678901234567890');
    });

    test('should remove User tokens', () => {
      const errorWithToken = 'Failed with ghu_1234567890123456789012345678901234567890';
      const safeMessage = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeMessage).toContain('[REDACTED_USER]');
    });

    test('should remove Refresh tokens', () => {
      const errorWithToken = 'Token ghr_1234567890123456789012345678901234567890 expired';
      const safeMessage = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeMessage).toContain('[REDACTED_REFRESH]');
    });

    test('should append token prefix when provided', () => {
      const error = 'Some error occurred';
      const token = 'ghp_1234567890123456789012345678901234567890';
      const safeMessage = TokenManager.createSafeErrorMessage(error, token);
      expect(safeMessage).toContain('(Token: ghp_...)');
    });
  });

  describe('getRequiredScopes', () => {
    test('should return read scopes', () => {
      const scopes = TokenManager.getRequiredScopes('read');
      expect(scopes.required).toContain('public_repo');
      expect(scopes.optional).toContain('user:email');
    });

    test('should return write scopes', () => {
      const scopes = TokenManager.getRequiredScopes('write');
      expect(scopes.required).toContain('public_repo');
    });

    test('should return collection scopes', () => {
      const scopes = TokenManager.getRequiredScopes('collection');
      expect(scopes.required).toContain('public_repo');
    });

    test('should return gist scopes', () => {
      const scopes = TokenManager.getRequiredScopes('gist');
      expect(scopes.required).toContain('gist');
    });

    test('should return default scopes for unknown operation', () => {
      const scopes = TokenManager.getRequiredScopes('unknown' as any);
      expect(scopes.required).toContain('public_repo');
    });
  });

  describe('ensureTokenPermissions', () => {
    test('should return error when no token available', async () => {
      const result = await TokenManager.ensureTokenPermissions('read');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('No GitHub token available');
    });

    test('should validate token with GitHub API when token is available', async () => {
      // Set a valid token format
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock fetch to simulate GitHub API response
      const mockGet = jest.fn((header: string) => {
        switch (header) {
          case 'x-oauth-scopes': return 'public_repo,user:email';
          case 'x-ratelimit-remaining': return '100';
          case 'x-ratelimit-reset': return '1640995200';
          default: return null;
        }
      });
      
      const mockFetch = jest.fn((_url: string, _options?: any) => Promise.resolve({
        ok: true,
        headers: {
          get: mockGet
        }
      } as unknown as Response));
      
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.ensureTokenPermissions('read');
      expect(result.isValid).toBe(true);
      expect(result.scopes).toContain('repo');
      expect(mockFetch).toHaveBeenCalledWith('https://api.github.com/user', expect.any(Object));
    });

    test('should handle GitHub API errors gracefully', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock fetch to simulate GitHub API error
      const mockFetch = jest.fn(() => Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          get: jest.fn().mockReturnValue(null)
        }
      } as unknown as Response));
      
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.ensureTokenPermissions('read');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('GitHub API error: 401 Unauthorized');
    });

    test('should detect missing required scopes', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock fetch to return token with insufficient scopes
      const mockGet = jest.fn((header: string) => {
          switch (header) {
            case 'x-oauth-scopes': return 'user:email'; // missing 'gist'
            case 'x-ratelimit-remaining': return '100';
            case 'x-ratelimit-reset': return '1640995200';
            default: return null;
          }
        });
      
      const mockFetch = jest.fn(() => Promise.resolve({
        ok: true,
        headers: {
          get: mockGet
        }
      } as unknown as Response));
      
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.ensureTokenPermissions('gist');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing required scopes: gist');
      expect(result.scopes).toEqual(['user:email']);
    });

    test('should handle network errors', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock fetch to simulate network error
      const mockFetch = jest.fn(() => Promise.reject(new Error('Network error')));
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.ensureTokenPermissions('read');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Validation error: Network error');
    });
  });

  describe('validateTokenScopes', () => {
    test('should validate token with sufficient scopes', async () => {
      const token = 'ghp_1234567890123456789012345678901234567890';
      const requiredScopes = { required: ['public_repo'], optional: ['user:email'] };
      
      const mockGet = jest.fn((header: string) => {
          switch (header) {
            case 'x-oauth-scopes': return 'public_repo,user:email,gist';
            case 'x-ratelimit-remaining': return '95';
            case 'x-ratelimit-reset': return '1640995200';
            default: return null;
          }
        });
      
      const mockFetch = jest.fn(() => Promise.resolve({
        ok: true,
        headers: {
          get: mockGet
        }
      } as unknown as Response));
      
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.validateTokenScopes(token, requiredScopes);
      expect(result.isValid).toBe(true);
      expect(result.scopes).toEqual(['public_repo', 'user:email', 'gist']);
      expect(result.rateLimit?.remaining).toBe(95);
    });

    test('should handle empty scopes header', async () => {
      const token = 'ghp_1234567890123456789012345678901234567890';
      const requiredScopes = { required: ['public_repo'] };
      
      const mockGet = jest.fn((header: string) => {
          switch (header) {
            case 'x-oauth-scopes': return '';
            case 'x-ratelimit-remaining': return '100';
            case 'x-ratelimit-reset': return '1640995200';
            default: return null;
          }
        });
      
      const mockFetch = jest.fn(() => Promise.resolve({
        ok: true,
        headers: {
          get: mockGet
        }
      } as unknown as Response));
      
      global.fetch = mockFetch as any;
      
      const result = await TokenManager.validateTokenScopes(token, requiredScopes);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing required scopes: repo');
    });
  });

  describe('Security Integration Tests', () => {
    test('should prevent token exposure in logs across all methods', () => {
      const sensitiveToken = 'ghp_1234567890123456789012345678901234567890';
      
      // Test redaction
      const redacted = TokenManager.redactToken(sensitiveToken);
      expect(redacted).not.toContain('1234567890123456789012345678901234');
      
      // Test safe error messages
      const errorWithToken = `Authentication failed for token ${sensitiveToken}`;
      const safeError = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeError).not.toContain(sensitiveToken);
      expect(safeError).toContain('[REDACTED_PAT]');
      
      // Test prefix logging
      const prefix = TokenManager.getTokenPrefix(sensitiveToken);
      expect(prefix).toBe('ghp_...');
      expect(prefix).not.toContain('1234567890123456789012345678901234');
    });

    test('should handle multiple tokens in error messages', () => {
      const error = 'Failed with ghp_1111111111111111111111111111111111111111 and ghs_2222222222222222222222222222222222222222';
      const safeMessage = TokenManager.createSafeErrorMessage(error);
      
      expect(safeMessage).toContain('[REDACTED_PAT]');
      expect(safeMessage).toContain('[REDACTED_INSTALL]');
      expect(safeMessage).not.toContain('1111111111111111111111111111111111111111');
      expect(safeMessage).not.toContain('2222222222222222222222222222222222222222');
    });

    test('should validate all supported token formats', () => {
      const validTokens = [
        'ghp_1234567890123456789012345678901234567890', // PAT
        'ghs_1234567890123456789012345678901234567890', // Installation
        'ghu_1234567890123456789012345678901234567890', // User Access
        'ghr_1234567890123456789012345678901234567890'  // Refresh
      ];

      validTokens.forEach(token => {
        expect(TokenManager.validateTokenFormat(token)).toBe(true);
        expect(TokenManager.getTokenType(token)).not.toBe('Unknown');
        expect(TokenManager.redactToken(token)).toContain('...');
      });
    });
  });
});