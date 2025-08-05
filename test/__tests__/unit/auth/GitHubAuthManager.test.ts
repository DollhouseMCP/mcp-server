/**
 * Tests for GitHubAuthManager OAuth device flow implementation
 */

import { GitHubAuthManager } from '../../../../src/auth/GitHubAuthManager.js';
import { APICache } from '../../../../src/cache/APICache.js';
import { TokenManager } from '../../../../src/security/tokenManager.js';
import { logger } from '../../../../src/utils/logger.js';
import { SecurityMonitor } from '../../../../src/security/monitoring/SecurityMonitor.js';

// Mock dependencies
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/security/monitoring/SecurityMonitor.js');
jest.mock('../../../../src/security/tokenManager.js');

// Mock fetch globally
global.fetch = jest.fn();

describe('GitHubAuthManager', () => {
  let authManager: GitHubAuthManager;
  let apiCache: APICache;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;
    apiCache = new APICache(1000, 60000);
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
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue(null);

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

      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue(mockToken);
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
      
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue(mockToken);
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

  describe('initiateDeviceFlow', () => {
    it('should throw error when CLIENT_ID is not set', async () => {
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;

      await expect(authManager.initiateDeviceFlow()).rejects.toThrow(
        'GitHub OAuth is not configured'
      );
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
          type: 'OAUTH_DEVICE_FLOW_INITIATED'
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

      (TokenManager.storeGitHubToken as jest.Mock).mockResolvedValue(undefined);
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
          type: 'OAUTH_AUTHENTICATION_COMPLETED'
        })
      );
    });
  });

  describe('clearAuthentication', () => {
    it('should remove stored token and clear cache', async () => {
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue('ghp_token');
      (TokenManager.removeStoredToken as jest.Mock).mockResolvedValue(undefined);

      await authManager.clearAuthentication();

      expect(TokenManager.removeStoredToken).toHaveBeenCalled();
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GITHUB_AUTH_CLEARED'
        })
      );
    });

    it('should handle errors gracefully', async () => {
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue('ghp_token');
      (TokenManager.removeStoredToken as jest.Mock).mockRejectedValue(new Error('Storage error'));

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
          type: 'GITHUB_AUTH_CLEANUP',
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
        login: 'test\u0301user', // Unicode combining character
        name: 'Test User\u200B' // Zero-width space
      };

      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue(mockToken);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => mockUserInfo
      } as Response);

      const status = await authManager.getAuthStatus();

      // Should have normalized the username
      expect(status.username).not.toContain('\u0301');
    });
  });
});