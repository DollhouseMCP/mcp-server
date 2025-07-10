import { jest } from '@jest/globals';
import { SecureTokenManager, TokenScope } from '../../src/security/tokenManager.js';
import { SecurityError } from '../../src/errors/SecurityError.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('SecureTokenManager', () => {
  const originalEnv = process.env;
  const validToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const validOAuthToken = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
  const validFineGrainedToken = 'github_pat_' + 'a'.repeat(82);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    SecureTokenManager.clearCache();
    
    // Mock SecurityMonitor
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Token Format Validation', () => {
    it('should accept valid personal access token format', async () => {
      process.env.GITHUB_TOKEN = validToken;
      
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(token).toBe(validToken);
    });

    it('should accept valid OAuth token format', async () => {
      process.env.GITHUB_TOKEN = validOAuthToken;
      
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(token).toBe(validOAuthToken);
    });

    it('should accept valid fine-grained token format', async () => {
      process.env.GITHUB_TOKEN = validFineGrainedToken;
      
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(token).toBe(validFineGrainedToken);
    });

    it('should reject invalid token formats', async () => {
      const invalidTokens = [
        'invalid_token',
        'ghp_short',
        'ghp_' + 'x'.repeat(35), // Too short
        'ghp_' + 'x'.repeat(37), // Too long
        'GHP_' + 'x'.repeat(36), // Wrong case
        'ghp_with spaces inside',
        'ghp_with\nnewline',
        'ghp_with\ttab',
        ''
      ];

      for (const invalidToken of invalidTokens) {
        process.env.GITHUB_TOKEN = invalidToken;
        
        await expect(SecureTokenManager.getSecureGitHubToken(TokenScope.READ))
          .rejects.toThrow();
      }
    });
  });

  describe('Token Permission Validation', () => {
    beforeEach(() => {
      process.env.GITHUB_TOKEN = validToken;
    });

    it('should validate READ scope permissions', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'public_repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(token).toBe(validToken);
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'SecureTokenManager',
        details: 'GitHub token validated successfully',
        additionalData: { scope: TokenScope.READ }
      });
    });

    it('should validate WRITE scope permissions', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.WRITE);
      expect(token).toBe(validToken);
    });

    it('should validate ADMIN scope permissions', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo, admin:org'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      const token = await SecureTokenManager.getSecureGitHubToken(TokenScope.ADMIN);
      expect(token).toBe(validToken);
    });

    it('should reject tokens with insufficient permissions', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'read:user'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      await expect(SecureTokenManager.getSecureGitHubToken(TokenScope.WRITE))
        .rejects.toThrow('Token lacks required write permissions');
    });

    it('should handle invalid tokens (401)', async () => {
      const mockResponse = new Response('Unauthorized', {
        status: 401,
        headers: {}
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      await expect(SecureTokenManager.getSecureGitHubToken(TokenScope.READ))
        .rejects.toThrow('GitHub token is invalid or expired');
    });

    it('should handle rate limited tokens (403)', async () => {
      const mockResponse = new Response('Forbidden', {
        status: 403,
        headers: {}
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      await expect(SecureTokenManager.getSecureGitHubToken(TokenScope.READ))
        .rejects.toThrow('GitHub token lacks required permissions');
    });

    it('should warn about low rate limits', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '50',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'RATE_LIMIT_WARNING',
        severity: 'MEDIUM',
        source: 'SecureTokenManager',
        details: 'GitHub API rate limit low',
        additionalData: { remaining: '50' }
      });
    });
  });

  describe('Error Sanitization', () => {
    it('should sanitize token patterns from error messages', async () => {
      // Test with an invalid format token that contains the pattern
      const tokenInError = 'ghp_short'; // Too short, will fail format validation
      process.env.GITHUB_TOKEN = tokenInError;

      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        // The error message should not contain the actual token pattern
        expect(error.message).toBe('Invalid GitHub token format');
        expect(error.message).not.toContain(tokenInError);
        // Verify sanitization is working by checking the logs
        expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOKEN_VALIDATION_FAILURE',
            additionalData: expect.objectContaining({
              error: expect.stringContaining('Invalid GitHub token format')
            })
          })
        );
      }
    });

    it('should sanitize Bearer tokens from errors', async () => {
      process.env.GITHUB_TOKEN = validToken;
      
      const bearerToken = 'Bearer secret-token-12345';
      const mockError = new Error(`Authentication failed: ${bearerToken}`);
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(mockError);

      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        // SecurityError sanitizes the original error
        expect(error.message).toBe('Failed to validate token permissions');
        expect(error.message).not.toContain('secret-token-12345');
        expect(error.message).not.toContain('Bearer');
      }
    });

    it('should sanitize environment variable values', async () => {
      process.env.GITHUB_TOKEN = validToken;
      
      const mockError = new Error(`Config error: GITHUB_TOKEN=${validToken}`);
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(mockError);

      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        // SecurityError sanitizes the original error internally
        expect(error.message).toBe('Failed to validate token permissions');
        expect(error.message).not.toContain(validToken);
        expect(error.message).not.toContain('GITHUB_TOKEN=');
      }
    });

    it('should log security events for failures', async () => {
      delete process.env.GITHUB_TOKEN;

      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
        throw new Error('Should have thrown error');
      } catch (error) {
        // Expected
      }

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'HIGH',
        source: 'SecureTokenManager',
        details: 'Token validation failed',
        additionalData: {
          scope: TokenScope.READ,
          error: 'GitHub token not found in environment variables'
        }
      });
    });
  });

  describe('Token Caching', () => {
    beforeEach(() => {
      process.env.GITHUB_TOKEN = validToken;
    });

    it('should cache valid tokens', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce(mockResponse)
        .mockResolvedValueOnce(mockResponse); // Second response for cache validation

      // First call - should hit API
      const token1 = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Second call - should use cache but still validate permissions
      const token2 = await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(token1).toBe(token2);
      expect(global.fetch).toHaveBeenCalledTimes(2); // One more call for permission validation
    });

    it('should validate permissions even for cached tokens', async () => {
      // First response - token with READ permissions only
      const mockResponseRead = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'read:user'  // Only read permissions
        }
      });
      
      // Second response - same token, still only read permissions
      const mockResponseStillRead = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'read:user'  // Still only read permissions
        }
      });

      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce(mockResponseRead)
        .mockResolvedValueOnce(mockResponseStillRead);

      // First call with READ scope - should succeed
      await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Second call with WRITE scope - should re-validate and fail
      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.WRITE);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        if (error.message === 'Should have thrown error') {
          throw error;
        }
        expect(error.message).toBe('Token lacks required write permissions');
        expect(global.fetch).toHaveBeenCalledTimes(2);
      }
    });

    it('should clear cache on demand', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>)
        .mockResolvedValueOnce(mockResponse)
        .mockResolvedValueOnce(mockResponse);

      // First call
      await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Clear cache
      SecureTokenManager.clearCache();
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'TOKEN_CACHE_CLEARED',
        severity: 'LOW',
        source: 'SecureTokenManager',
        details: 'Token cache cleared'
      });

      // Next call should hit API again
      await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should provide cache statistics', async () => {
      const mockResponse = new Response(JSON.stringify({ login: 'testuser' }), {
        status: 200,
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-oauth-scopes': 'repo'
        }
      });
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse);

      let stats = SecureTokenManager.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.tokens).toEqual([]);

      await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);

      stats = SecureTokenManager.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.tokens).toEqual(['github']);
    });
  });

  describe('Network Error Handling', () => {
    beforeEach(() => {
      process.env.GITHUB_TOKEN = validToken;
    });

    it('should handle network timeouts gracefully', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(
        new Error('Network timeout')
      );

      await expect(SecureTokenManager.getSecureGitHubToken(TokenScope.READ))
        .rejects.toThrow('Failed to validate token permissions');
    });

    it('should not expose token in network errors', async () => {
      const errorWithToken = new Error(`Failed to connect to https://api.github.com with token ${validToken}`);
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValueOnce(errorWithToken);

      try {
        await SecureTokenManager.getSecureGitHubToken(TokenScope.READ);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Failed to validate token permissions');
        // Original error should be sanitized in logs
      }
    });
  });
});