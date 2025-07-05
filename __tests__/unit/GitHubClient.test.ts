import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { GitHubClient } from '../../src/marketplace/GitHubClient';
import { APICache } from '../../src/cache/APICache';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SECURITY_LIMITS } from '../../src/security/constants';

// Mock fetch globally with proper typing
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('GitHubClient', () => {
  let githubClient: GitHubClient;
  let mockApiCache: jest.Mocked<APICache>;
  let rateLimitTracker: Map<string, number[]>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();
    
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
        json: jest.fn().mockResolvedValue(mockData)
      };

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
      };

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
      process.env.GITHUB_TOKEN = 'test-token';
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({})
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await githubClient.fetchFromGitHub(testUrl);

      expect(global.fetch).toHaveBeenCalledWith(
        testUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'token test-token'
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
        json: jest.fn().mockResolvedValue({})
      };
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
        json: jest.fn().mockResolvedValue({})
      };
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
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await expect(githubClient.fetchFromGitHub('https://api.github.com/test'))
        .rejects.toThrow('Invalid JSON');
    });

    it('should handle 404 responses', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found'
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      await expect(githubClient.fetchFromGitHub('https://api.github.com/test'))
        .rejects.toThrow('GitHub API error: 404 Not Found');
    });

    it('should handle partial network failures', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockImplementation(() => {
          throw new Error('Connection reset');
        })
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockApiCache.get.mockReturnValue(null);

      try {
        await githubClient.fetchFromGitHub('https://api.github.com/test');
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).message).toContain('Connection reset');
      }
    });

    it('should handle cache eviction scenarios', async () => {
      const testUrl = 'https://api.github.com/test-cache-eviction';
      const mockData = { test: 'data' };
      
      // First call - cache miss
      mockApiCache.get.mockReturnValue(null);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockData)
      });

      const result1 = await githubClient.fetchFromGitHub(testUrl);
      expect(mockApiCache.set).toHaveBeenCalledWith(testUrl, mockData);
      expect(result1).toEqual(mockData);

      // Simulate cache eviction
      mockApiCache.get.mockReturnValue(null);
      
      // Second call should fetch again
      const result2 = await githubClient.fetchFromGitHub(testUrl);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result2).toEqual(mockData);
    });
  });
});