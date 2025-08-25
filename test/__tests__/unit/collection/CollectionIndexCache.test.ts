/**
 * Tests for CollectionIndexCache functionality
 */

import { CollectionIndexCache } from '../../../../src/cache/CollectionIndexCache.js';
import { GitHubClient } from '../../../../src/collection/GitHubClient.js';
import { APICache } from '../../../../src/cache/APICache.js';

describe('CollectionIndexCache', () => {
  let indexCache: CollectionIndexCache;
  let mockGithubClient: GitHubClient;
  let mockApiCache: APICache;

  beforeEach(() => {
    mockApiCache = new APICache();
    mockGithubClient = new GitHubClient(mockApiCache, new Map());
    indexCache = new CollectionIndexCache(mockGithubClient);
  });

  describe('getCacheStats', () => {
    it('should return initial cache stats', () => {
      const stats = indexCache.getCacheStats();
      
      expect(stats).toHaveProperty('isValid');
      expect(stats).toHaveProperty('age');
      expect(stats).toHaveProperty('hasCache');
      expect(stats).toHaveProperty('elements');
      
      // Initially no cache
      expect(stats.hasCache).toBe(false);
      expect(stats.elements).toBe(0);
      expect(stats.isValid).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear cache without throwing', async () => {
      await expect(indexCache.clearCache()).resolves.not.toThrow();
    });
  });
});