/**
 * Tests for CollectionIndexCache functionality
 */

import { CollectionIndexCache } from '../../../src/cache/CollectionIndexCache.js';
import { GitHubClient } from '../../../src/collection/GitHubClient.js';
import { APICache } from '../../../src/cache/APICache.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import * as os from 'os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';

describe('CollectionIndexCache', () => {
  let indexCache: InstanceType<typeof CollectionIndexCache>;
  let mockGithubClient: InstanceType<typeof GitHubClient>;
  let mockApiCache: InstanceType<typeof APICache>;
  let container: InstanceType<typeof DollhouseContainer>;

  beforeEach(() => {
    container = new DollhouseContainer();

    container.replace('APICache', () => new APICache());
    mockApiCache = container.resolve('APICache');

    container.replace('GitHubClient', () => new GitHubClient(mockApiCache, new Map()));
    mockGithubClient = container.resolve('GitHubClient');

    const fileOperationsService = createTestFileOperationsService();
    container.replace('FileOperationsService', () => fileOperationsService);
    container.replace('PerformanceMonitor', () => new PerformanceMonitor());

    const baseDir = os.homedir();
    container.replace('CollectionIndexCache', () => new CollectionIndexCache(
      mockGithubClient,
      baseDir,
      container.resolve('PerformanceMonitor'),
      container.resolve('FileOperationsService')
    ));
    indexCache = container.resolve('CollectionIndexCache');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await container.dispose();
  });

  describe('getCacheStats', () => {
    it.each([false, true])('reports real failed refresh without marking stale data fresh (cached=%s)', async cached => {
      const data = { version: '1.0', total_elements: 0, index: {}, generated: '2026-01-01', metadata: {} } as any;
      const fetchedAt = new Date(0);
      indexCache['cache'] = cached ? { data, fetchedAt } : null;
      jest.spyOn(indexCache as any, 'loadFromDisk').mockResolvedValue(null);
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Private network diagnostic'));
      if (cached) {
        const report = await indexCache.getIndexReport();
        expect(report).toMatchObject({ complete: false, items: [data],
          failures: [expect.objectContaining({ reference: 'collection' })] });
        expect(indexCache['cache']?.fetchedAt).toBe(fetchedAt);
        expect(indexCache.getCacheStats().isValid).toBe(false);
      }
      await expect(indexCache.getIndex()).rejects.toBeInstanceOf(ElementReadError);
    });
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

  describe('cache path resolution', () => {
    it('uses an exact canonical cache directory without nesting it again', () => {
      const canonicalCacheDir = path.resolve('canonical', 'cache');
      const canonicalCache = new CollectionIndexCache({
        githubClient: mockGithubClient,
        cacheDir: canonicalCacheDir,
        performanceMonitor: container.resolve('PerformanceMonitor'),
        fileOperations: container.resolve('FileOperationsService'),
      });

      const cacheFile = (canonicalCache as unknown as { cacheFile: string }).cacheFile;
      expect(cacheFile).toBe(path.join(canonicalCacheDir, 'collection-index-cache.json'));
    });
  });

  describe('clearCache', () => {
    it('should clear cache without throwing', async () => {
      await expect(indexCache.clearCache()).resolves.not.toThrow();
    });
  });
});
