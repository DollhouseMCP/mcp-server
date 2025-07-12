import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { TokenManager } from '../../src/security/tokenManager.js';

describe('TokenManager - GitHub Token Security', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear environment
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
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
      expect(TokenManager.validateTokenFormat('invalid_token')).toBe(false);
      expect(TokenManager.validateTokenFormat('ghp_short')).toBe(false);
      expect(TokenManager.validateTokenFormat('')).toBe(false);
      expect(TokenManager.validateTokenFormat('abc_1234567890123456789012345678901234567890')).toBe(false);
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
      expect(scopes.required).toContain('repo');
      expect(scopes.optional).toContain('user:email');
    });

    test('should return write scopes', () => {
      const scopes = TokenManager.getRequiredScopes('write');
      expect(scopes.required).toContain('repo');
    });

    test('should return marketplace scopes', () => {
      const scopes = TokenManager.getRequiredScopes('marketplace');
      expect(scopes.required).toContain('repo');
    });

    test('should return gist scopes', () => {
      const scopes = TokenManager.getRequiredScopes('gist');
      expect(scopes.required).toContain('gist');
    });

    test('should return default scopes for unknown operation', () => {
      const scopes = TokenManager.getRequiredScopes('unknown' as any);
      expect(scopes.required).toContain('repo');
    });
  });

  describe('ensureTokenPermissions', () => {
    test('should return error when no token available', async () => {
      const result = await TokenManager.ensureTokenPermissions('read');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('No GitHub token available');
    });
  });
});