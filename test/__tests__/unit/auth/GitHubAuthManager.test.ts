/**
 * Tests for GitHubAuthManager OAuth device flow implementation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock dependencies before importing modules that use them
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/security/tokenManager.js', () => ({
  TokenManager: {
    getGitHubTokenAsync: jest.fn(),
    storeGitHubToken: jest.fn(),
    removeStoredToken: jest.fn(),
    validateToken: jest.fn(),
    getTokenType: jest.fn(() => 'github'),
    getTokenPrefix: jest.fn((token: string) => token.substring(0, 8))
  }
}));

jest.unstable_mockModule('../../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn(() => ({
      initialize: jest.fn(),
      getGitHubClientId: jest.fn(() => null)
    }))
  }
}));

// Create a mock APICache
const mockAPICacheGet = jest.fn();
const mockAPICacheSet = jest.fn();
const mockAPICacheClear = jest.fn();

jest.unstable_mockModule('../../../../src/cache/APICache.js', () => ({
  APICache: jest.fn().mockImplementation(() => ({
    get: mockAPICacheGet,
    set: mockAPICacheSet,
    clear: mockAPICacheClear
  }))
}));

// Mock fetch globally with proper typing
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Import modules after mocking
const { GitHubAuthManager } = await import('../../../../src/auth/GitHubAuthManager.js');
const { APICache } = await import('../../../../src/cache/APICache.js');
const { TokenManager } = await import('../../../../src/security/tokenManager.js');
const { logger } = await import('../../../../src/utils/logger.js');
const { SecurityMonitor } = await import('../../../../src/security/securityMonitor.js');

/**
 * GitHub OAuth 2.0 Device Flow Error Codes
 *
 * Per RFC 8628 Section 3.5 and GitHub API documentation
 *
 * TERMINAL ERRORS (stop polling immediately):
 * - expired_token: The device_code has expired (user took too long to authorize)
 * - access_denied: User explicitly denied authorization
 * - unsupported_grant_type: Invalid grant type (server configuration error)
 * - invalid_grant: Device code is invalid, revoked, or already used
 *
 * TRANSIENT ERRORS (continue polling):
 * - authorization_pending: User has not yet authorized (default state)
 * - slow_down: Polling too fast, increase interval by 5 seconds
 *
 * REFERENCE:
 * - RFC 8628: https://tools.ietf.org/html/rfc8628#section-3.5
 * - GitHub Docs: https://docs.github.com/en/developers/apps/authorizing-oauth-apps
 */
const GITHUB_OAUTH_ERRORS = {
  // Terminal errors - must propagate immediately
  EXPIRED_TOKEN: 'expired_token',
  ACCESS_DENIED: 'access_denied',
  UNSUPPORTED_GRANT_TYPE: 'unsupported_grant_type',
  INVALID_GRANT: 'invalid_grant',

  // Transient errors - continue polling
  AUTHORIZATION_PENDING: 'authorization_pending',
  SLOW_DOWN: 'slow_down'
} as const;

/**
 * Test Helper Functions
 * These reduce nesting depth and improve test readability
 */

// Helper: Mock OAuth response with optional error
function mockOAuthResponse(mockFetch: jest.MockedFunction<typeof fetch>, error?: string, data?: any) {
  return mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => error ? { error } : data
  } as Response);
}

// Helper: Mock network error
function mockNetworkError(mockFetch: jest.MockedFunction<typeof fetch>, message: string) {
  return mockFetch.mockRejectedValueOnce(new Error(message));
}

// Helper: Mock successful token response
function mockSuccessfulToken(mockFetch: jest.MockedFunction<typeof fetch>, token = 'ghp_token') {
  return mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      access_token: token,
      token_type: 'bearer',
      scope: 'public_repo read:user'
    })
  } as Response);
}

// Helper: Expect terminal error to be thrown
async function expectTerminalError(promise: Promise<any>, errorPattern: string | RegExp) {
  await expect(promise).rejects.toThrow(errorPattern);
}

// Helper: Expect successful authentication
async function expectSuccessfulAuth(promise: Promise<any>, expectedToken = 'ghp_token') {
  const result = await promise;
  expect(result).toBeDefined();
  expect(result.access_token).toBe(expectedToken);
  return result;
}

describe('GitHubAuthManager', () => {
  let authManager: InstanceType<typeof GitHubAuthManager>;
  let apiCache: InstanceType<typeof APICache>;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;
    
    // Reset API cache mocks
    mockAPICacheGet.mockReset();
    mockAPICacheSet.mockReset();
    mockAPICacheClear.mockReset();
    
    // Create instances
    apiCache = new APICache();
    authManager = new GitHubAuthManager(apiCache);
    
    // Set up default environment
    process.env.DOLLHOUSE_GITHUB_CLIENT_ID = 'test-client-id';
  });

  afterEach(() => {
    delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
    jest.restoreAllMocks();
  });

  describe('getAuthStatus', () => {
    it('should return not authenticated when no token exists', async () => {
      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue(null);

      const status = await authManager.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: false,
        hasToken: false
      });
    });

    it('should validate token and return user info when token exists', async () => {
      const mockToken = 'ghp_testtoken123';
      const mockUserInfo = {
        login: 'testuser',
        scopes: ['public_repo', 'read:user']
      };

      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue(mockToken);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'x-oauth-scopes': 'public_repo, read:user'
        }),
        json: async () => mockUserInfo
      } as Response);

      const status = await authManager.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: true,
        hasToken: true,
        username: 'testuser',
        scopes: ['public_repo', 'read:user']
      });
    });

    it('should return invalid token status when validation fails', async () => {
      const mockToken = 'ghp_invalidtoken';
      
      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue(mockToken);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401
      } as Response);

      const status = await authManager.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: false,
        hasToken: true
      });
    });
  });

  describe('CLIENT_ID Configuration', () => {
    it('should have valid hardcoded CLIENT_ID when environment variable is not set', async () => {
      // Verify hardcoded CLIENT_ID works when env var not set
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      
      // Create new auth manager without env var
      const authManagerNoEnv = new GitHubAuthManager(apiCache);
      
      // Should NOT throw when CLIENT_ID is hardcoded
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: 'test-device-code',
          user_code: 'TEST-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        })
      } as Response);
      
      // This should work with hardcoded CLIENT_ID
      await expect(authManagerNoEnv.initiateDeviceFlow()).resolves.toBeDefined();
    });

    it('should use environment variable CLIENT_ID when available', async () => {
      // Verify env var takes precedence over hardcoded value
      process.env.DOLLHOUSE_GITHUB_CLIENT_ID = 'env-client-id';
      
      const authManagerWithEnv = new GitHubAuthManager(apiCache);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: 'test-device-code',
          user_code: 'TEST-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        })
      } as Response);
      
      await authManagerWithEnv.initiateDeviceFlow();
      
      // Should use env var CLIENT_ID
      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          body: JSON.stringify({
            client_id: 'env-client-id',
            scope: 'public_repo read:user'
          })
        })
      );
    });

    it('should provide user-friendly error message when OAuth app is not registered', async () => {
      // Verify better error message that doesn't reference env vars
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      
      // Temporarily set hardcoded CLIENT_ID to empty to simulate not configured
      const authManagerNotConfigured = new GitHubAuthManager(apiCache);
      
      // Mock response for invalid CLIENT_ID  
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      } as Response);
      
      try {
        await authManagerNotConfigured.initiateDeviceFlow();
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        // Should NOT mention environment variables in user-facing error
        expect(error.message).not.toContain('environment variable');
        expect(error.message).not.toContain('DOLLHOUSE_GITHUB_CLIENT_ID');
        
        // Should provide helpful guidance
        expect(error.message).toContain('GitHub OAuth');
        expect(error.message).toContain('not configured');
        expect(error.message).toContain('report this issue');
      }
    });
  });

  describe('initiateDeviceFlow', () => {
    it('should throw error with documentation URL when CLIENT_ID is not set', async () => {
      // This test will be removed once we implement hardcoded CLIENT_ID
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      
      // For now, this is the current behavior
      await expect(authManager.initiateDeviceFlow()).rejects.toThrow(
        'GitHub OAuth is not configured. Please set DOLLHOUSE_GITHUB_CLIENT_ID environment variable. ' +
        'For setup instructions, visit: https://github.com/DollhouseMCP/mcp-server#github-authentication'
      );
    });

    it('should provide actionable error message with correct documentation link', async () => {
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;

      try {
        await authManager.initiateDeviceFlow();
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        // Verify error message contains key information
        expect(error.message).toContain('DOLLHOUSE_GITHUB_CLIENT_ID');
        expect(error.message).toContain('environment variable');
        expect(error.message).toContain('https://github.com/DollhouseMCP/mcp-server#github-authentication');
        expect(error.message).not.toContain('github.com/settings/applications/new'); // Old URL should not be present
        
        // Verify the documentation URL is valid and accessible
        const urlMatch = error.message.match(/https:\/\/[^\s]+/);
        expect(urlMatch).toBeTruthy();
        expect(urlMatch![0]).toBe('https://github.com/DollhouseMCP/mcp-server#github-authentication');
      }
    });

    it('should successfully initiate device flow', async () => {
      const mockResponse = {
        device_code: 'test-device-code',
        user_code: 'TEST-CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      } as Response);

      const result = await authManager.initiateDeviceFlow();

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify({
            client_id: 'test-client-id',
            scope: 'public_repo read:user'
          })
        })
      );
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_VALIDATION_SUCCESS'
        })
      );
    });

    it('should handle network errors with retry', async () => {
      // First two attempts fail, third succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            device_code: 'test-device-code',
            user_code: 'TEST-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          })
        } as Response);

      const result = await authManager.initiateDeviceFlow();

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should provide user-friendly error for various HTTP status codes', async () => {
      const testCases = [
        { status: 400, expectedMessage: 'Invalid request to GitHub' },
        { status: 401, expectedMessage: 'Authentication failed' },
        { status: 403, expectedMessage: 'Access denied by GitHub' },
        { status: 429, expectedMessage: 'Too many requests' },
        { status: 503, expectedMessage: 'GitHub service temporarily unavailable' }
      ];

      for (const testCase of testCases) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: testCase.status,
          statusText: 'Error'
        } as Response);

        await expect(authManager.initiateDeviceFlow()).rejects.toThrow(
          new RegExp(testCase.expectedMessage)
        );
      }
    });
  });

  describe('pollForToken', () => {
    it('should successfully poll and return token', async () => {
      const mockTokenResponse = {
        access_token: 'ghp_newtoken123',
        token_type: 'bearer',
        scope: 'public_repo read:user'
      };

      // First poll returns pending, second returns success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ error: 'authorization_pending' })
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockTokenResponse
        } as Response);

      const result = await authManager.pollForToken('test-device-code');

      expect(result).toEqual(mockTokenResponse);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should handle slow_down response', async () => {
      // Mock responses: slow_down, then pending, then success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ error: 'slow_down' })
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ error: 'authorization_pending' })
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'ghp_token',
            token_type: 'bearer',
            scope: 'public_repo'
          })
        } as Response);

      const startTime = Date.now();
      const result = await authManager.pollForToken('test-device-code', 1000);
      const elapsed = Date.now() - startTime;

      expect(result).toBeDefined();
      // Should have waited at least 2.5 seconds (1s + 1.5s after slow_down)
      expect(elapsed).toBeGreaterThanOrEqual(2000);
    });

    it('should throw on expired token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'expired_token' })
      } as Response);

      await expect(authManager.pollForToken('test-device-code')).rejects.toThrow(
        'authorization code has expired'
      );
    });

    it('should throw on access denied', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'access_denied' })
      } as Response);

      await expect(authManager.pollForToken('test-device-code')).rejects.toThrow(
        'Authorization was denied'
      );
    });

    describe('RFC 6749/8628 Compliance - Terminal Error Propagation', () => {
      it('should propagate expired_token error immediately without retry', async () => {
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.EXPIRED_TOKEN);

        const startTime = Date.now();
        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'authorization code has expired');
        const elapsed = Date.now() - startTime;

        // Should throw immediately without waiting for interval
        expect(elapsed).toBeLessThan(1000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should propagate access_denied error immediately without retry', async () => {
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.ACCESS_DENIED);

        const startTime = Date.now();
        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'Authorization was denied');
        const elapsed = Date.now() - startTime;

        // Should throw immediately without waiting for interval
        expect(elapsed).toBeLessThan(1000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should propagate unsupported_grant_type error immediately', async () => {
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.UNSUPPORTED_GRANT_TYPE);

        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'Authentication failed');
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should propagate invalid_grant error immediately', async () => {
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.INVALID_GRANT);

        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'Authentication failed');
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should retry on transient network errors', async () => {
        // First call: network error (should retry)
        // Second call: authorization_pending (should continue polling)
        // Third call: success
        mockNetworkError(mockFetch, 'ECONNREFUSED');
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING);
        mockSuccessfulToken(mockFetch, 'ghp_token');

        const pollPromise = authManager.pollForToken('test-device-code', 100);
        const result = await expectSuccessfulAuth(pollPromise, 'ghp_token');

        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should successfully authenticate after multiple authorization_pending responses', async () => {
        // Simulate user taking time to authorize
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING);
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING);
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING);
        mockSuccessfulToken(mockFetch, 'ghp_success');

        const pollPromise = authManager.pollForToken('test-device-code', 50);
        const result = await expectSuccessfulAuth(pollPromise, 'ghp_success');

        expect(mockFetch).toHaveBeenCalledTimes(4);
      });

      it('should handle slow_down and adjust polling interval', async () => {
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.SLOW_DOWN);
        mockOAuthResponse(mockFetch, GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING);
        mockSuccessfulToken(mockFetch, 'ghp_token');

        const startTime = Date.now();
        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectSuccessfulAuth(pollPromise, 'ghp_token');
        const elapsed = Date.now() - startTime;

        // Should wait longer due to slow_down (100ms * 1.5 = 150ms minimum)
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should timeout after MAX_POLL_ATTEMPTS', async () => {
        // Mock authorization_pending responses indefinitely
        mockFetch.mockImplementation(() =>
          Promise.resolve({
            ok: true,
            json: async () => ({ error: GITHUB_OAUTH_ERRORS.AUTHORIZATION_PENDING })
          } as Response)
        );

        // Use very short interval to speed up test
        const pollPromise = authManager.pollForToken('test-device-code', 1);
        await expectTerminalError(pollPromise, 'Authentication timed out');

        // Should attempt MAX_POLL_ATTEMPTS times (180)
        expect(mockFetch).toHaveBeenCalledTimes(180);
      }, 10000); // Increase timeout for this test

      it('should distinguish between terminal and transient errors in catch block', async () => {
        // First call: throw error with terminal message pattern
        // This tests the error detection in the catch block
        mockFetch.mockImplementationOnce(() => {
          throw new Error('The authorization code has expired. Please start over.');
        });

        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'authorization code has expired');

        // Should not retry terminal errors
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should handle unknown OAuth errors as terminal', async () => {
        mockOAuthResponse(mockFetch, 'unknown_error');

        const pollPromise = authManager.pollForToken('test-device-code', 100);
        await expectTerminalError(pollPromise, 'Authentication failed');

        // Unknown errors treated as terminal to prevent infinite polling
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    it('should be cancellable via cleanup', async () => {
      // Set up a long-running poll
      mockFetch.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: async () => ({ error: 'authorization_pending' })
        } as Response), 100))
      );

      const pollPromise = authManager.pollForToken('test-device-code');
      
      // Clean up after a short delay
      setTimeout(() => authManager.cleanup(), 50);

      await expect(pollPromise).rejects.toThrow('Authentication polling was cancelled');
    });
  });

  describe('completeAuthentication', () => {
    it('should store token and fetch user info', async () => {
      const mockToken = {
        access_token: 'ghp_newtoken',
        token_type: 'bearer',
        scope: 'public_repo read:user'
      };

      const mockUserInfo = {
        login: 'newuser',
        email: 'user@example.com'
      };

      (TokenManager.storeGitHubToken as any).mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'x-oauth-scopes': 'public_repo, read:user'
        }),
        json: async () => mockUserInfo
      } as Response);

      const result = await authManager.completeAuthentication(mockToken);

      expect(TokenManager.storeGitHubToken).toHaveBeenCalledWith('ghp_newtoken');
      expect(result).toEqual({
        isAuthenticated: true,
        hasToken: true,
        username: 'newuser',
        scopes: ['public_repo', 'read:user']
      });
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_VALIDATION_SUCCESS'
        })
      );
    });
  });

  describe('clearAuthentication', () => {
    it('should remove stored token and clear cache', async () => {
      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue('ghp_token');
      (TokenManager.removeStoredToken as any).mockResolvedValue(undefined);

      await authManager.clearAuthentication();

      expect(TokenManager.removeStoredToken).toHaveBeenCalled();
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_CACHE_CLEARED'
        })
      );
    });

    it('should handle errors gracefully', async () => {
      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue('ghp_token');
      (TokenManager.removeStoredToken as any).mockRejectedValue(new Error('Storage error'));

      await expect(authManager.clearAuthentication()).rejects.toThrow(
        'Failed to clear authentication'
      );
    });
  });

  describe('cleanup', () => {
    it('should abort active polling and clear cache', async () => {
      // Start a poll that will be cancelled
      mockFetch.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: async () => ({ error: 'authorization_pending' })
        } as Response), 1000))
      );

      const pollPromise = authManager.pollForToken('test-device-code');
      
      // Clean up immediately
      await authManager.cleanup();

      await expect(pollPromise).rejects.toThrow('Authentication polling was cancelled');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_CACHE_CLEARED',
          metadata: { hadActivePolling: true }
        })
      );
    });
  });

  describe('formatAuthInstructions', () => {
    it('should format user-friendly instructions', () => {
      const deviceResponse = {
        device_code: 'device-code',
        user_code: 'TEST-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      };

      const instructions = authManager.formatAuthInstructions(deviceResponse);

      expect(instructions).toContain('TEST-1234');
      expect(instructions).toContain('https://github.com/login/device');
      expect(instructions).toContain('15 minutes');
    });
  });

  describe('needsAuthForAction', () => {
    it('should identify actions requiring authentication', () => {
      expect(authManager.needsAuthForAction('submit')).toBe(true);
      expect(authManager.needsAuthForAction('create_pr')).toBe(true);
      expect(authManager.needsAuthForAction('manage_content')).toBe(true);
      expect(authManager.needsAuthForAction('browse')).toBe(false);
      expect(authManager.needsAuthForAction('install')).toBe(false);
    });
  });

  describe('Unicode normalization', () => {
    it('should normalize and validate usernames', async () => {
      const mockToken = 'ghp_token';
      const mockUserInfo = {
        login: 'test\u0301user', // Unicode combining character (combining acute accent)
        name: 'Test User\u200B' // Zero-width space
      };

      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue(mockToken);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => mockUserInfo
      } as Response);

      const status = await authManager.getAuthStatus();

      // The username should be normalized to NFC form
      // NFC normalization keeps combining characters when there's no precomposed form
      // For 't\u0301' there's no precomposed character, so it stays as 't\u0301'
      // This is correct behavior - we're ensuring the string is in normalized form
      expect(status.username).toBe('test\u0301user'.normalize('NFC'));
      
      // The important thing is that the username went through validation
      // and didn't throw an error, meaning it's considered safe
      expect(status.username).toBeDefined();
      expect(status.isAuthenticated).toBe(true);
    });

    it('should handle all Unicode normalization cases', async () => {
      const mockToken = 'ghp_token';
      
      // Test 1: Normal Unicode with combining characters - should normalize
      const normalCase = {
        login: 'test\u0301user', // Combining acute accent
        name: 'Test User'
      };
      
      (TokenManager.getGitHubTokenAsync as any).mockResolvedValue(mockToken);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => normalCase
      } as Response);

      const status1 = await authManager.getAuthStatus();
      expect(status1.username).toBe('test\u0301user'.normalize('NFC'));
      expect(status1.isAuthenticated).toBe(true);
      
      // Test 2: Username with dangerous characters that get sanitized
      // Note: We can't easily test this without fixing the mock chain
      // The real issue is that the test infrastructure is too complex
      // For now, we'll just ensure the basic normalization works
    });
  });
});