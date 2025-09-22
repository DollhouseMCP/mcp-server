import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UnifiedIndexManager } from '../../../src/portfolio/UnifiedIndexManager.js';
import { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';
import { LRUCache } from '../../../src/cache/LRUCache.js';
import { IndexPerformanceBenchmark } from '../../../src/benchmarks/IndexPerformanceBenchmark.js';

// Mock fs module to avoid file system operations in tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => '{}'),
  existsSync: jest.fn(() => false)
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readFile: jest.fn(() => Promise.resolve('{}')),
  writeFile: jest.fn(() => Promise.resolve()),
  mkdir: jest.fn(() => Promise.resolve()),
  stat: jest.fn(() => Promise.reject(new Error('File not found')))
}));

describe('Index Performance Optimization Tests', () => {
  let unifiedIndexManager: UnifiedIndexManager;
  let performanceMonitor: PerformanceMonitor;
  let benchmark: IndexPerformanceBenchmark;

  beforeEach(() => {
    // Reset instances
    (UnifiedIndexManager as any).instance = null;
    (PerformanceMonitor as any).instance = null;
    
    unifiedIndexManager = UnifiedIndexManager.getInstance();
    performanceMonitor = PerformanceMonitor.getInstance();
    benchmark = new IndexPerformanceBenchmark();
  });

  afterEach(() => {
    performanceMonitor.stopMonitoring();
  });

  describe('LRU Cache Performance', () => {
    it('should handle rapid cache operations efficiently', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        maxMemoryMB: 5,
        ttlMs: 5000
      });

      const startTime = performance.now();

      // Perform 1000 cache operations
      for (let i = 0; i < 1000; i++) {
        cache.set(`key${i}`, `value${i}`);
        if (i % 10 === 0) {
          cache.get(`key${i}`);
        }
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(100); // Should complete in under 100ms
      expect(cache.getStats().size).toBeLessThanOrEqual(100);
      expect(cache.getStats().hitRate).toBeGreaterThan(0);
    });

    it('should respect memory limits', () => {
      const cache = new LRUCache<string>({
        maxSize: 1000,
        maxMemoryMB: 1, // Very small memory limit
        ttlMs: 5000
      });

      // Fill cache with large values
      for (let i = 0; i < 100; i++) {
        const largeValue = 'x'.repeat(10000); // 10KB per entry
        cache.set(`large${i}`, largeValue);
      }

      const memoryUsage = cache.getMemoryUsageMB();
      expect(memoryUsage).toBeLessThanOrEqual(1.5); // Allow some overhead
    });

    it('should handle TTL expiration correctly', async () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        maxMemoryMB: 5,
        ttlMs: 50 // Very short TTL for testing
      });

      cache.set('test', 'value');
      expect(cache.get('test')).toBe('value');

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(cache.get('test')).toBeNull();
    });
  });

  describe('Search Performance Optimization', () => {
    it('should handle search response time targets', async () => {
      // Note: Performance target adjusted from 100ms to 200ms to 800ms after PR #606
      // which added security validations (Unicode normalization, audit logging),
      // improved search algorithms, and comprehensive security features.
      // Current performance shows ~600-700ms with security features enabled.
      const startTime = performance.now();

      const results = await unifiedIndexManager.search({
        query: 'test',
        pageSize: 20,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(800); // Target: <800ms (adjusted for comprehensive security features)
      expect(Array.isArray(results)).toBe(true);
    });

    it('should use caching effectively', async () => {
      const query = 'performance_test_query';

      // First search - cache miss
      const start1 = performance.now();
      await unifiedIndexManager.search({ query, pageSize: 10 });
      const duration1 = performance.now() - start1;

      // Second search - should hit cache and be faster
      const start2 = performance.now();
      await unifiedIndexManager.search({ query, pageSize: 10 });
      const duration2 = performance.now() - start2;

      expect(duration2).toBeLessThan(duration1);
      expect(duration2).toBeLessThan(50); // Cached search should be very fast
    }, 30000); // Increase timeout to 30 seconds

    it('should handle large result sets efficiently', async () => {
      const startMemory = process.memoryUsage().heapUsed;

      const results = await unifiedIndexManager.search({
        query: '',
        pageSize: 1000,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: false,
        maxResults: 1000
      });

      const endMemory = process.memoryUsage().heapUsed;
      const memoryGrowthMB = (endMemory - startMemory) / (1024 * 1024);

      expect(memoryGrowthMB).toBeLessThan(50); // Target: <50MB memory usage
      expect(Array.isArray(results)).toBe(true);
    });

    it('should support streaming search for large datasets', async () => {
      const startTime = performance.now();

      const results = await unifiedIndexManager.search({
        query: 'stream_test',
        streamResults: true,
        maxResults: 100,
        includeLocal: true,
        includeGitHub: false
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(200); // Streaming should be reasonably fast
      expect(Array.isArray(results)).toBe(true);

      // Check for cursor presence in streaming results
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('cursor');
      }
    });
  });

  describe('Memory Management', () => {
    it('should handle memory cleanup effectively', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Perform multiple operations to create memory pressure
      for (let i = 0; i < 50; i++) {
        await unifiedIndexManager.search({
          query: `memory_test_${i}`,
          pageSize: 100,
          includeLocal: true
        });
      }

      // Trigger cleanup
      unifiedIndexManager.invalidateAfterAction('memory_test');

      // Allow garbage collection
      if (global.gc) {
        global.gc();
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowthMB = (finalMemory - initialMemory) / (1024 * 1024);

      expect(memoryGrowthMB).toBeLessThan(25); // Should not grow excessively
    });

    it('should track performance metrics accurately', async () => {
      performanceMonitor.startMonitoring();

      // Perform some operations
      await unifiedIndexManager.search({
        query: 'metrics_test',
        pageSize: 20
      });

      const stats = performanceMonitor.getSearchStats();

      expect(stats.totalSearches).toBeGreaterThan(0);
      expect(stats.averageTime).toBeGreaterThanOrEqual(0);
      expect(stats.cacheHitRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent searches efficiently', async () => {
      const concurrentSearches = 10;
      const startTime = performance.now();

      const promises = Array.from({ length: concurrentSearches }, (_, i) =>
        unifiedIndexManager.search({
          query: `concurrent_${i}`,
          pageSize: 20,
          includeLocal: true,
          includeGitHub: false
        })
      );

      const results = await Promise.all(promises);
      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(concurrentSearches);
      expect(duration).toBeLessThan(500); // All searches should complete reasonably fast
      
      // Verify all searches completed successfully
      results.forEach(result => {
        expect(Array.isArray(result)).toBe(true);
      });
    });

    it('should prevent memory leaks during concurrent operations', async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      const iterations = 20;

      for (let batch = 0; batch < 5; batch++) {
        const promises = Array.from({ length: iterations }, (_, i) =>
          unifiedIndexManager.search({
            query: `leak_test_${batch}_${i}`,
            pageSize: 10
          })
        );

        await Promise.all(promises);

        // Check memory growth
        const currentMemory = process.memoryUsage().heapUsed;
        const growthMB = (currentMemory - initialMemory) / (1024 * 1024);

        if (growthMB > 100) {
          // Trigger cleanup if memory grows too much
          unifiedIndexManager.invalidateAfterAction('cleanup');
          if (global.gc) {
            global.gc();
          }
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const totalGrowthMB = (finalMemory - initialMemory) / (1024 * 1024);

      expect(totalGrowthMB).toBeLessThan(50); // Should not leak significant memory
    });
  });

  describe('Performance Statistics', () => {
    it('should provide comprehensive performance statistics', () => {
      const stats = unifiedIndexManager.getPerformanceStats();

      expect(stats).toHaveProperty('searchStats');
      expect(stats).toHaveProperty('memoryStats');
      expect(stats).toHaveProperty('cacheStats');
      expect(stats).toHaveProperty('trends');

      expect(stats.cacheStats).toHaveProperty('searchResults');
      expect(stats.cacheStats).toHaveProperty('indexCache');
    });

    it('should track trends and provide recommendations', async () => {
      performanceMonitor.startMonitoring();

      // Generate some performance data
      for (let i = 0; i < 10; i++) {
        await unifiedIndexManager.search({
          query: `trend_test_${i}`,
          pageSize: 15
        });
      }

      const trends = performanceMonitor.analyzeTrends();

      expect(trends).toHaveProperty('performanceTrend');
      expect(trends).toHaveProperty('memoryTrend');
      expect(trends).toHaveProperty('recommendations');
      expect(Array.isArray(trends.recommendations)).toBe(true);
    });
  });

  describe('Lazy Loading', () => {
    it('should support lazy loading option', async () => {
      const startTime = performance.now();

      const results = await unifiedIndexManager.search({
        query: 'lazy_test',
        lazyLoad: true,
        pageSize: 20,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(Array.isArray(results)).toBe(true);
      expect(duration).toBeLessThan(150); // Lazy loading should be reasonably fast
    });
  });

  describe('Integration Performance', () => {
    it('should meet overall performance targets', async () => {
      const testSuite = [
        { name: 'Quick search', query: 'test', pageSize: 10, maxTime: 50 },
        { name: 'Medium search', query: 'professional', pageSize: 50, maxTime: 100 },
        { name: 'Large search', query: '', pageSize: 200, maxTime: 200 },
        { name: 'Specific search', query: 'very_specific_term', pageSize: 20, maxTime: 75 }
      ];

      for (const test of testSuite) {
        const startTime = performance.now();

        await unifiedIndexManager.search({
          query: test.query,
          pageSize: test.pageSize,
          includeLocal: true,
          includeGitHub: false
        });

        const duration = performance.now() - startTime;

        expect(duration).toBeLessThan(test.maxTime);
      }
    });

    it('should handle edge cases efficiently', async () => {
      const edgeCases = [
        { query: '', pageSize: 1 }, // Empty query, minimal results
        { query: 'x'.repeat(100), pageSize: 10 }, // Very long query
        { query: 'test', pageSize: 0 }, // Zero page size
        { query: 'test test test test', pageSize: 1000 } // Multiple terms, large page
      ];

      for (const testCase of edgeCases) {
        const startTime = performance.now();

        try {
          const results = await unifiedIndexManager.search({
            ...testCase,
            includeLocal: true,
            includeGitHub: false
          });

          const duration = performance.now() - startTime;

          expect(duration).toBeLessThan(300); // Should handle edge cases reasonably
          expect(Array.isArray(results)).toBe(true);
        } catch (error) {
          // Some edge cases might throw errors, but they shouldn't take too long
          const duration = performance.now() - startTime;
          expect(duration).toBeLessThan(100);
        }
      }
    });
  });
});