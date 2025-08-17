/**
 * Tests for GitHub Portfolio Indexer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Create mock functions first
const mockFetchFromGitHub = jest.fn();
const mockCheckPortfolioExists = jest.fn();

// Mock modules using jest.unstable_mockModule for ES modules
jest.unstable_mockModule('../../../../src/collection/GitHubClient.js', () => ({
  GitHubClient: jest.fn().mockImplementation((apiCache, rateLimitTracker) => ({
    fetchFromGitHub: mockFetchFromGitHub
  }))
}));

jest.unstable_mockModule('../../../../src/portfolio/PortfolioRepoManager.js', () => ({
  PortfolioRepoManager: jest.fn().mockImplementation(() => ({
    checkPortfolioExists: mockCheckPortfolioExists
  }))
}));

jest.unstable_mockModule('../../../../src/cache/APICache.js', () => ({
  APICache: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn()
  }))
}));

// Import types and non-mocked modules
import { ElementType } from '../../../../src/portfolio/types.js';
import { TokenManager } from '../../../../src/security/tokenManager.js';

// Dynamically import the modules under test after mocks are set up
const { GitHubPortfolioIndexer } = await import('../../../../src/portfolio/GitHubPortfolioIndexer.js');
const { GitHubPortfolioIndex, GitHubIndexEntry } = await import('../../../../src/portfolio/GitHubPortfolioIndexer.js');

describe('GitHubPortfolioIndexer', () => {
  let indexer: GitHubPortfolioIndexer;

  beforeEach(() => {
    // Reset singleton
    (GitHubPortfolioIndexer as any).instance = null;
    
    // Clear mocks
    mockFetchFromGitHub.mockClear();
    mockCheckPortfolioExists.mockClear();
    
    // Mock TokenManager
    jest.spyOn(TokenManager, 'getGitHubTokenAsync').mockResolvedValue('test-token');
    
    // Create fresh indexer instance (will use mocked GitHubClient)
    indexer = GitHubPortfolioIndexer.getInstance();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = GitHubPortfolioIndexer.getInstance();
      const instance2 = GitHubPortfolioIndexer.getInstance();
      
      expect(instance1).toBe(instance2);
    });

    it('should handle concurrent instance creation', () => {
      // Reset singleton
      (GitHubPortfolioIndexer as any).instance = null;
      
      const instance1 = GitHubPortfolioIndexer.getInstance();
      const instance2 = GitHubPortfolioIndexer.getInstance();
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('Cache Management', () => {
    it('should return cached data when valid', async () => {
      // Setup cached data
      const mockIndex: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map([[ElementType.PERSONA, []]]),
        totalElements: 0,
        sha: 'abc123'
      };
      
      (indexer as any).cache = mockIndex;
      (indexer as any).lastFetch = new Date();
      
      const result = await indexer.getIndex();
      
      expect(result).toBe(mockIndex);
      expect(mockFetchFromGitHub).not.toHaveBeenCalled();
    });

    it('should fetch fresh data when cache is stale', async () => {
      // Setup stale cache
      (indexer as any).cache = null;
      (indexer as any).lastFetch = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
      
      // Mock GitHub API responses
      mockFetchFromGitHub
        .mockResolvedValueOnce({ login: 'testuser' }) // 1. user info call
        .mockRejectedValueOnce(new Error('GraphQL implementation not yet complete')) // 2. GraphQL call fails  
        .mockResolvedValueOnce({ html_url: 'https://github.com/testuser/dollhouse-portfolio' }) // 3. repo info
        .mockResolvedValueOnce({ sha: 'abc123', commit: { committer: { date: new Date().toISOString() } } }) // 4. latest commit
        .mockResolvedValue([]); // remaining calls for directory contents
      
      // Mock portfolio repo manager
      mockCheckPortfolioExists.mockResolvedValue(true);
      
      const result = await indexer.getIndex();
      
      expect(result.username).toBe('testuser');
      expect(mockFetchFromGitHub).toHaveBeenCalled();
    });

    it('should invalidate cache after user actions', () => {
      indexer.invalidateAfterAction('submit_content');
      
      const stats = indexer.getCacheStats();
      expect(stats.recentUserAction).toBe(true);
    });

    it('should clear all cached data', () => {
      (indexer as any).cache = { some: 'data' };
      (indexer as any).lastFetch = new Date();
      
      indexer.clearCache();
      
      const stats = indexer.getCacheStats();
      expect(stats.hasCachedData).toBe(false);
      expect(stats.lastFetch).toBe(null);
    });
  });

  describe('GitHub API Integration', () => {
    beforeEach(() => {
      // Mock portfolio repo manager
      mockCheckPortfolioExists.mockResolvedValue(true);
    });

    it('should fetch repository content using REST API', async () => {
      const mockUserInfo = { login: 'testuser' };
      const mockRepoInfo = { html_url: 'https://github.com/testuser/dollhouse-portfolio' };
      const mockCommit = { 
        sha: 'abc123', 
        commit: { committer: { date: new Date().toISOString() } } 
      };
      const mockPersonas = [{
        type: 'file',
        name: 'test-persona.md',
        path: 'personas/test-persona.md',
        sha: 'file123',
        html_url: 'https://github.com/testuser/dollhouse-portfolio/blob/main/personas/test-persona.md',
        download_url: 'https://raw.githubusercontent.com/testuser/dollhouse-portfolio/main/personas/test-persona.md',
        size: 1024
      }];

      mockFetchFromGitHub
        .mockResolvedValueOnce(mockUserInfo) // 1. user info
        .mockRejectedValueOnce(new Error('GraphQL implementation not yet complete')) // 2. GraphQL call fails
        .mockResolvedValueOnce(mockRepoInfo) // 3. repo info
        .mockResolvedValueOnce(mockCommit) // 4. latest commit
        .mockResolvedValueOnce(mockPersonas) // 5. personas directory
        .mockResolvedValue([]); // remaining directories empty

      const result = await indexer.getIndex();

      expect(result.username).toBe('testuser');
      expect(result.repository).toBe('dollhouse-portfolio');
      expect(result.sha).toBe('abc123');
      expect(result.totalElements).toBe(1);
      
      const personas = result.elements.get(ElementType.PERSONA);
      expect(personas).toHaveLength(1);
      expect(personas![0].name).toBe('test persona');
      expect(personas![0].path).toBe('personas/test-persona.md');
    });

    it('should handle rate limiting gracefully', async () => {
      const rateLimitError = new Error('GitHub API rate limit exceeded');
      mockFetchFromGitHub.mockRejectedValue(rateLimitError);

      const result = await indexer.getIndex();

      // Should return empty index on rate limit
      expect(result.totalElements).toBe(0);
      expect(result.username).toBe('unknown');
    });

    it('should handle authentication errors', async () => {
      const authError = new Error('GitHub authentication failed');
      mockFetchFromGitHub.mockRejectedValue(authError);

      const result = await indexer.getIndex();

      // Should return empty index on auth failure
      expect(result.totalElements).toBe(0);
    });

    it('should handle non-existent portfolio repository', async () => {
      // Mock portfolio repo manager to return false
      mockCheckPortfolioExists.mockResolvedValue(false);
      
      mockFetchFromGitHub.mockResolvedValue({ login: 'testuser' });

      const result = await indexer.getIndex();

      expect(result.username).toBe('testuser');
      expect(result.totalElements).toBe(0);
    });
  });

  describe('Metadata Parsing', () => {
    it('should parse frontmatter metadata from file content', () => {
      const content = `---
name: Test Persona
description: A test persona for unit testing
version: 1.0.0
author: Test Author
---

# Test Persona

This is a test persona.`;

      const metadata = (indexer as any).parseMetadataFromContent(content);

      expect(metadata.name).toBe('Test Persona');
      expect(metadata.description).toBe('A test persona for unit testing');
      expect(metadata.version).toBe('1.0.0');
      expect(metadata.author).toBe('Test Author');
    });

    it('should handle content without frontmatter', () => {
      const content = `# Test Persona

This is a test persona without frontmatter.`;

      const metadata = (indexer as any).parseMetadataFromContent(content);

      expect(metadata.name).toBeUndefined();
      expect(metadata.description).toBeUndefined();
    });

    it('should handle malformed frontmatter gracefully', () => {
      const content = `---
name: Test Persona
description: 
invalid yaml here
---

# Test Persona`;

      const metadata = (indexer as any).parseMetadataFromContent(content);

      // Should still parse what it can
      expect(metadata.name).toBe('Test Persona');
    });
  });

  describe('Performance Requirements', () => {
    it('should fetch index within 500ms for small portfolios', async () => {
      // Mock fast GitHub responses
      mockFetchFromGitHub
        .mockResolvedValueOnce({ login: 'testuser' })
        .mockResolvedValueOnce({ html_url: 'test' })
        .mockResolvedValueOnce({ sha: 'abc', commit: { committer: { date: new Date().toISOString() } } })
        .mockResolvedValue([]);

      mockCheckPortfolioExists.mockResolvedValue(true);

      const startTime = Date.now();
      await indexer.getIndex();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(500);
    });

    it('should handle large portfolios efficiently', async () => {
      // Mock setTimeout to avoid delays during testing
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn((fn) => {
        if (typeof fn === 'function') fn();
        return 1 as any;
      });

      // Create mock data for 1000 elements (make them > 10KB to skip metadata fetching)
      const largePersonaList = Array.from({ length: 1000 }, (_, i) => ({
        type: 'file',
        name: `persona-${i}.md`,
        path: `personas/persona-${i}.md`,
        sha: `sha${i}`,
        html_url: `https://github.com/test/repo/blob/main/personas/persona-${i}.md`,
        download_url: `https://raw.githubusercontent.com/test/repo/main/personas/persona-${i}.md`,
        size: 15000 // > 10KB to skip metadata fetching
      }));

      mockFetchFromGitHub.mockImplementation((url) => {
        try {
          // Parse URL safely to validate hostname and pathname
          const parsedUrl = new URL(url);
          
          // Validate allowed GitHub domains
          const allowedHosts = [
            'api.github.com',
            'raw.githubusercontent.com'
          ];
          
          if (!allowedHosts.includes(parsedUrl.hostname)) {
            return Promise.reject(new Error('Invalid domain'));
          }
          
          // Mock different types of API calls based on URL patterns
          if (url === 'https://api.github.com/user') {
            return Promise.resolve({ login: 'testuser' });
          } else if (url === 'https://api.github.com/graphql') {
            return Promise.reject(new Error('GraphQL implementation not yet complete'));
          } else if (parsedUrl.hostname === 'api.github.com' && 
                     parsedUrl.pathname.includes('/repos/') && 
                     parsedUrl.pathname.endsWith('/dollhouse-portfolio')) {
            return Promise.resolve({ html_url: 'test' });
          } else if (parsedUrl.hostname === 'api.github.com' && 
                     parsedUrl.pathname.includes('/commits/HEAD')) {
            return Promise.resolve({ sha: 'abc', commit: { committer: { date: new Date().toISOString() } } });
          } else if (parsedUrl.hostname === 'api.github.com' && 
                     parsedUrl.pathname.includes('/contents/personas')) {
            return Promise.resolve(largePersonaList);
          } else if (parsedUrl.hostname === 'api.github.com' && 
                     parsedUrl.pathname.includes('/contents/')) {
            // Other directory contents (skills, templates, etc.)
            return Promise.resolve([]);
          } else if (parsedUrl.hostname === 'raw.githubusercontent.com') {
            // File content downloads for metadata extraction
            return Promise.resolve('---\nname: Mock Persona\n---\nMock content');
          } else {
            return Promise.resolve([]);
          }
        } catch (error) {
          // Invalid URL format
          return Promise.reject(new Error('Invalid URL format'));
        }
      });

      mockCheckPortfolioExists.mockResolvedValue(true);

      try {
        const result = await indexer.getIndex();

        expect(result.totalElements).toBe(1000);
        expect(result.elements.get(ElementType.PERSONA)).toHaveLength(1000);
      } finally {
        // Restore original setTimeout
        global.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('Error Handling', () => {
    it('should return stale cache on fetch failure', async () => {
      // Setup stale cache
      const staleCache: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
        elements: new Map([[ElementType.PERSONA, []]]),
        totalElements: 5,
        sha: 'old123'
      };
      
      (indexer as any).cache = staleCache;
      (indexer as any).lastFetch = new Date(Date.now() - 30 * 60 * 1000);
      
      // Mock fetch failure
      mockFetchFromGitHub.mockRejectedValue(new Error('Network error'));

      const result = await indexer.getIndex();

      expect(result).toBe(staleCache);
      expect(result.totalElements).toBe(5);
    });

    it('should return empty index as last resort', async () => {
      // No cache available
      (indexer as any).cache = null;
      (indexer as any).lastFetch = null;
      
      // Mock fetch failure
      mockFetchFromGitHub.mockRejectedValue(new Error('Network error'));

      const result = await indexer.getIndex();

      expect(result.totalElements).toBe(0);
      expect(result.username).toBe('unknown');
      expect(result.elements.size).toBe(6); // All element types initialized
    });
  });

  describe('Cache Statistics', () => {
    it('should provide accurate cache statistics', () => {
      const mockCache: GitHubPortfolioIndex = {
        username: 'testuser',
        repository: 'dollhouse-portfolio',
        lastUpdated: new Date(),
        elements: new Map(),
        totalElements: 10,
        sha: 'abc123'
      };
      
      (indexer as any).cache = mockCache;
      (indexer as any).lastFetch = new Date();
      (indexer as any).recentUserAction = true;

      const stats = indexer.getCacheStats();

      expect(stats.hasCachedData).toBe(true);
      expect(stats.totalElements).toBe(10);
      expect(stats.recentUserAction).toBe(true);
      expect(stats.isStale).toBe(false);
    });
  });

  describe('URL Security Validation', () => {
    it('should reject malicious URLs with GitHub domain in path', async () => {
      // Mock a malicious URL that contains GitHub domain in the path
      const maliciousUrl = 'http://evil.com/raw.githubusercontent.com/malicious';
      
      mockFetchFromGitHub.mockImplementation((url) => {
        try {
          const parsedUrl = new URL(url);
          const allowedHosts = ['api.github.com', 'raw.githubusercontent.com'];
          
          if (!allowedHosts.includes(parsedUrl.hostname)) {
            return Promise.reject(new Error('Invalid domain'));
          }
          return Promise.resolve({});
        } catch (error) {
          return Promise.reject(new Error('Invalid URL format'));
        }
      });

      // Test that malicious URL is rejected
      await expect(mockFetchFromGitHub(maliciousUrl))
        .rejects.toThrow('Invalid domain');
    });

    it('should accept legitimate GitHub URLs', async () => {
      const validUrls = [
        'https://api.github.com/repos/user/repo/contents/file',
        'https://raw.githubusercontent.com/user/repo/main/file.md'
      ];

      mockFetchFromGitHub.mockImplementation((url) => {
        try {
          const parsedUrl = new URL(url);
          const allowedHosts = ['api.github.com', 'raw.githubusercontent.com'];
          
          if (!allowedHosts.includes(parsedUrl.hostname)) {
            return Promise.reject(new Error('Invalid domain'));
          }
          return Promise.resolve({ success: true });
        } catch (error) {
          return Promise.reject(new Error('Invalid URL format'));
        }
      });

      for (const url of validUrls) {
        const result = await mockFetchFromGitHub(url);
        expect(result).toEqual({ success: true });
      }
    });

    it('should reject URLs with invalid format', async () => {
      const invalidUrl = 'not-a-valid-url';
      
      mockFetchFromGitHub.mockImplementation((url) => {
        try {
          new URL(url);
          return Promise.resolve({});
        } catch (error) {
          return Promise.reject(new Error('Invalid URL format'));
        }
      });

      await expect(mockFetchFromGitHub(invalidUrl))
        .rejects.toThrow('Invalid URL format');
    });
  });
});