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

describe('CollectionIndexCache', () => {
  let indexCache: InstanceType<typeof CollectionIndexCache>;
  let mockGithubClient: InstanceType<typeof GitHubClient>;
  let mockApiCache: InstanceType<typeof APICache>;
  let container: InstanceType<typeof DollhouseContainer>;

  beforeEach(() => {
    container = new DollhouseContainer();

    container.register('APICache', () => new APICache());
    mockApiCache = container.resolve('APICache');

    container.register('GitHubClient', () => new GitHubClient(mockApiCache, new Map()));
    mockGithubClient = container.resolve('GitHubClient');

    const fileOperationsService = createTestFileOperationsService();
    container.register('FileOperationsService', () => fileOperationsService);
    container.register('PerformanceMonitor', () => new PerformanceMonitor());

    const baseDir = os.homedir();
    container.register('CollectionIndexCache', () => new CollectionIndexCache(
      mockGithubClient,
      baseDir,
      container.resolve('PerformanceMonitor'),
      container.resolve('FileOperationsService')
    ));
    indexCache = container.resolve('CollectionIndexCache');
  });

  afterEach(async () => {
    await container.dispose();
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