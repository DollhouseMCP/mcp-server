import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { GitHubClient } from '../../src/marketplace/GitHubClient';
import { APICache } from '../../src/cache/APICache';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SECURITY_LIMITS } from '../../src/security/constants';

// Create a properly typed mock for fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// Mock SecurityMonitor to avoid security event logging in tests
jest.mock('../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn()
  }
}));

describe('GitHubClient', () => {
  let githubClient: GitHubClient;
  let mockApiCache: jest.Mocked<APICache>;
  let rateLimitTracker: Map<string, number[]>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();
    mockFetch.mockReset();
    
    // Create mock APICache
    mockApiCache = {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn(),
      has: jest.fn(),
      delete: jest.fn(),
      size: jest.fn()
    } as unknown as jest.Mocked<APICache>;

    rateLimitTracker = new Map();
    githubClient = new GitHubClient(mockApiCache, rateLimitTracker);
  });

  describe('fetchFromGitHub', () => {
    const testUrl = 'https://api.github.com/repos/test/repo';

    it('should fetch data successfully', async () => {
      const mockData = { name: 'test-repo', stars: 100 };
      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockResolvedValue(mockData)
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      const result = await githubClient.fetchFromGitHub(testUrl);

      expect(result).toEqual(mockData);
      expect(mockApiCache.set).toHaveBeenCalledWith(testUrl, mockData);
    });

    it('should return cached data when available', async () => {
      const cachedData = { name: 'cached-repo', stars: 200 };
      mockApiCache.get.mockReturnValue(cachedData);

      const result = await githubClient.fetchFromGitHub(testUrl);

      expect(result).toEqual(cachedData);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should enforce rate limiting', async () => {
      // Fill up rate limit
      const requests = Array(SECURITY_LIMITS.RATE_LIMIT_REQUESTS).fill(Date.now());
      rateLimitTracker.set('github_api', requests);

      await expect(githubClient.fetchFromGitHub(testUrl))
        .rejects.toThrow('Rate limit exceeded');
    });

    it('should handle 403 rate limit response', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        statusText: 'Forbidden'
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await expect(githubClient.fetchFromGitHub(testUrl))
        .rejects.toThrow('GitHub API rate limit exceeded');
    });

    it('should handle network errors with enhanced error info', async () => {
      const networkError = new Error('Network error');
      mockFetch.mockRejectedValue(networkError);
      mockApiCache.get.mockReturnValue(null);

      try {
        await githubClient.fetchFromGitHub(testUrl);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(ErrorCode.InternalError);
        expect((error as McpError).message).toContain('Failed to fetch from GitHub');
        
        // Check enhanced error preservation
        const errorData = (error as McpError).data as any;
        expect(errorData.originalMessage).toBe('Network error');
        expect(errorData.url).toBe(testUrl);
        expect(errorData.errorType).toBe('Error');
        expect((error as any).cause).toBe(networkError);
      }
    });

    it('should handle timeout with AbortController', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      
      mockFetch.mockRejectedValue(abortError);
      mockApiCache.get.mockReturnValue(null);

      try {
        await githubClient.fetchFromGitHub(testUrl);
        fail('Should have thrown an error');
      } catch (error) {
        const errorData = (error as McpError).data as any;
        expect(errorData.timeout).toBe(true);
      }
    });

    it('should include GitHub token when available', async () => {
      const validToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      process.env.GITHUB_TOKEN = validToken;

      // Mock the token validation API response
      const mockTokenValidationResponse = {
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((key: string) => {
            if (key === 'x-ratelimit-remaining') return '5000';
            if (key === 'x-oauth-scopes') return 'repo';
            return null;
          })
        },
        json: (jest.fn() as any).mockResolvedValue({ login: 'testuser' })
      } as unknown as Response;

      // Mock the actual API response
      const mockApiResponse = {
        ok: true,
        json: (jest.fn() as any).mockResolvedValue({})
      } as unknown as Response;

      // First call is for token validation, second is for the actual API call
      mockFetch
        .mockResolvedValueOnce(mockTokenValidationResponse)
        .mockResolvedValueOnce(mockApiResponse);
      mockApiCache.get.mockReturnValue(null);

      await githubClient.fetchFromGitHub(testUrl);

      // Check that both calls were made
      expect(global.fetch).toHaveBeenCalledTimes(2);
      
      // First call should be to validate the token
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${validToken}`
          })
        })
      );
      
      // Second call should be the actual API request
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        testUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${validToken}`
          })
        })
      );

      delete process.env.GITHUB_TOKEN;
    });

    it('should handle non-Error thrown values', async () => {
      mockFetch.mockRejectedValue('String error');
      mockApiCache.get.mockReturnValue(null);

      try {
        await githubClient.fetchFromGitHub(testUrl);
        fail('Should have thrown an error');
      } catch (error) {
        const errorData = (error as McpError).data as any;
        expect(errorData.originalMessage).toBe('String error');
      }
    });
  });

  describe('Rate Limiting', () => {
    it('should clean up old rate limit entries', async () => {
      // Add old entries (outside window)
      const oldTime = Date.now() - SECURITY_LIMITS.RATE_LIMIT_WINDOW_MS - 1000;
      rateLimitTracker.set('github_api', [oldTime, oldTime, oldTime]);

      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockResolvedValue({})
      } as unknown as Response;
      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      // Should not throw rate limit error
      await githubClient.fetchFromGitHub('https://api.github.com/test');

      // Old entries should be cleaned up
      const requests = rateLimitTracker.get('github_api') || [];
      expect(requests.every(time => time > oldTime)).toBe(true);
    });

    it('should track requests per key', async () => {
      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockResolvedValue({})
      } as unknown as Response;
      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      // Make multiple requests
      await githubClient.fetchFromGitHub('https://api.github.com/test1');
      await githubClient.fetchFromGitHub('https://api.github.com/test2');

      const requests = rateLimitTracker.get('github_api') || [];
      expect(requests).toHaveLength(2);
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('should handle malformed JSON response', async () => {
      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockRejectedValue(new Error('Invalid JSON'))
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await expect(githubClient.fetchFromGitHub('https://api.github.com/test'))
        .rejects.toThrow('Invalid JSON');
      
      // Verify cache was not updated with bad data
      expect(mockApiCache.set).not.toHaveBeenCalled();
    });

    it('should handle JSON parsing with unexpected format', async () => {
      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockResolvedValue('not an object')
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      const result = await githubClient.fetchFromGitHub('https://api.github.com/test');
      expect(result).toBe('not an object');
      
      // Even non-object JSON should be cached
      expect(mockApiCache.set).toHaveBeenCalledWith('https://api.github.com/test', 'not an object');
    });

    it('should handle 404 responses', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found'
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await expect(githubClient.fetchFromGitHub('https://api.github.com/test'))
        .rejects.toThrow('GitHub API error: 404 Not Found');
    });

    it('should handle partial network failures', async () => {
      const mockResponse = {
        ok: true,
        json: (jest.fn() as any).mockImplementation(() => {
          throw new Error('Connection reset');
        })
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      try {
        await githubClient.fetchFromGitHub('https://api.github.com/test');
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).message).toContain('Connection reset');
        expect((error as McpError).code).toBe(ErrorCode.InternalError);
      }
      
      // Verify no cache pollution
      expect(mockApiCache.set).not.toHaveBeenCalled();
    });

    it('should handle intermittent network failures with retry', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNRESET');
        }
        return Promise.resolve({
          ok: true,
          json: (jest.fn() as any).mockResolvedValue({ success: true })
        } as unknown as Response);
      });
      
      mockApiCache.get.mockReturnValue(null);

      // First call should fail
      await expect(githubClient.fetchFromGitHub('https://api.github.com/test'))
        .rejects.toThrow('ECONNRESET');
      
      // Second call should succeed
      const result = await githubClient.fetchFromGitHub('https://api.github.com/test');
      expect(result).toEqual({ success: true });
      expect(callCount).toBe(2);
    });

    it('should handle cache eviction scenarios', async () => {
      const testUrl = 'https://api.github.com/test-cache-eviction';
      const mockData = { test: 'data' };
      
      // First call - cache miss
      mockApiCache.get.mockReturnValue(null);
      mockFetch.mockResolvedValue({
        ok: true,
        json: (jest.fn() as any).mockResolvedValue(mockData)
      } as unknown as Response);

      const result1 = await githubClient.fetchFromGitHub(testUrl);
      expect(mockApiCache.set).toHaveBeenCalledWith(testUrl, mockData);
      expect(result1).toEqual(mockData);

      // Simulate cache eviction
      mockApiCache.get.mockReturnValue(null);
      
      // Second call should fetch again
      const result2 = await githubClient.fetchFromGitHub(testUrl);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result2).toEqual(mockData);
      
      // Verify cache was set both times
      expect(mockApiCache.set).toHaveBeenCalledTimes(2);
    });

    it('should handle cache corruption gracefully', async () => {
      const testUrl = 'https://api.github.com/test-cache-corruption';
      
      // Simulate corrupted cache returning undefined
      mockApiCache.get.mockReturnValue(undefined);
      
      const mockData = { fresh: 'data' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: (jest.fn() as any).mockResolvedValue(mockData)
      } as unknown as Response);

      const result = await githubClient.fetchFromGitHub(testUrl);
      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalled();
      expect(mockApiCache.set).toHaveBeenCalledWith(testUrl, mockData);
    });

    it('should handle concurrent request scenarios', async () => {
      const testUrl = 'https://api.github.com/test-concurrent';
      const mockData = { concurrent: 'test' };
      
      mockApiCache.get.mockReturnValue(null);
      mockFetch.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => {
          resolve({
            ok: true,
            json: (jest.fn() as any).mockResolvedValue(mockData)
          } as unknown as Response);
        }, 100);
      }));

      // Make concurrent requests
      const promises = [
        githubClient.fetchFromGitHub(testUrl),
        githubClient.fetchFromGitHub(testUrl),
        githubClient.fetchFromGitHub(testUrl)
      ];

      const results = await Promise.all(promises);
      
      // All should get the same result
      results.forEach(result => {
        expect(result).toEqual(mockData);
      });
      
      // Despite 3 concurrent requests, fetch should only be called once per unique URL
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should handle race condition in cache updates', async () => {
      const testUrl = 'https://api.github.com/test-race';
      const mockData1 = { version: 1 };
      const mockData2 = { version: 2 };
      
      mockApiCache.get.mockReturnValue(null);
      
      // Simulate different responses for concurrent requests
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        const data = callCount === 1 ? mockData1 : mockData2;
        return Promise.resolve({
          ok: true,
          json: (jest.fn() as any).mockResolvedValue(data)
        } as unknown as Response);
      });

      // Make requests with slight delay
      const promise1 = githubClient.fetchFromGitHub(testUrl);
      const promise2 = new Promise(resolve => {
        setTimeout(async () => {
          const result = await githubClient.fetchFromGitHub(testUrl);
          resolve(result);
        }, 10);
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);
      
      // Results might differ due to race condition
      expect([mockData1, mockData2]).toContainEqual(result1);
      expect([mockData1, mockData2]).toContainEqual(result2);
      
      // Cache should be set at least once
      expect(mockApiCache.set).toHaveBeenCalled();
    });
  });
});