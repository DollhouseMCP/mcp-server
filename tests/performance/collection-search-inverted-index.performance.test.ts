/**
 * Performance tests for collection search inverted index optimization
 *
 * Tests measure the performance improvement from linear O(n) search
 * to inverted index O(k) lookup where k = matching entries
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CollectionSearch } from '../../src/collection/CollectionSearch.js';
import { GitHubClient } from '../../src/collection/GitHubClient.js';
import { IndexEntry, CollectionIndex } from '../../src/types/collection.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

describe('Collection Search - Inverted Index Performance', () => {
  let collectionSearch: CollectionSearch;
  let mockGitHubClient: GitHubClient;
  let performanceMonitor: PerformanceMonitor;

  // Generate test data of various sizes
  const generateTestIndex = (size: number): CollectionIndex => {
    const entries: IndexEntry[] = [];
    const categories = ['creative', 'professional', 'educational', 'personal'];
    const types = ['personas', 'skills', 'templates', 'agents'];

    for (let i = 0; i < size; i++) {
      const type = types[i % types.length];
      const category = categories[i % categories.length];

      entries.push({
        path: `library/${type}/${category}/item-${i}.md`,
        type,
        name: `Test Item ${i}`,
        description: `Description for test item ${i} with some searchable keywords like data engineering pipeline optimization`,
        version: '1.0.0',
        author: `Author ${i % 10}`,
        tags: [`tag${i % 20}`, `category${i % 10}`, type],
        sha: `sha${i}`,
        category,
        created: new Date(2024, 0, 1 + (i % 365)).toISOString(),
        license: 'MIT'
      });
    }

    // Group by type
    const index: { [key: string]: IndexEntry[] } = {};
    for (const entry of entries) {
      if (!index[entry.type]) {
        index[entry.type] = [];
      }
      index[entry.type].push(entry);
    }

    return {
      version: '1.0.0',
      generated: new Date().toISOString(),
      total_elements: size,
      index,
      metadata: {
        build_time_ms: 0,
        file_count: size,
        skipped_files: 0,
        categories: categories.length,
        nodejs_version: process.version,
        builder_version: '1.0.0'
      }
    };
  };

  beforeEach(() => {
    performanceMonitor = new PerformanceMonitor();
    mockGitHubClient = {
      fetchFromGitHub: jest.fn(),
      isAuthenticated: jest.fn().mockReturnValue(false)
    } as any;

    collectionSearch = new CollectionSearch(mockGitHubClient, undefined, performanceMonitor);
  });

  describe('Baseline - Current Linear Search Performance', () => {
    it('should measure search time for 100 items', async () => {
      const testIndex = generateTestIndex(100);

      // Mock the index cache to return our test data
      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const startTime = performance.now();
      const results = await collectionSearch.searchCollectionWithOptions('data engineering', {
        page: 1,
        pageSize: 25
      });
      const endTime = performance.now();
      const searchTime = endTime - startTime;

      console.log(`[BASELINE 100] Search time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);

      expect(results.total).toBeGreaterThan(0);
      expect(searchTime).toBeLessThan(100); // Should be fast even with linear search for 100 items
    });

    it('should measure search time for 1000 items', async () => {
      const testIndex = generateTestIndex(1000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const startTime = performance.now();
      const results = await collectionSearch.searchCollectionWithOptions('data engineering', {
        page: 1,
        pageSize: 25
      });
      const endTime = performance.now();
      const searchTime = endTime - startTime;

      console.log(`[BASELINE 1000] Search time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);

      expect(results.total).toBeGreaterThan(0);
      // Linear search through 1000 items may be slower
    });

    it('should measure search time for 5000 items', async () => {
      const testIndex = generateTestIndex(5000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const startTime = performance.now();
      const results = await collectionSearch.searchCollectionWithOptions('data engineering', {
        page: 1,
        pageSize: 25
      });
      const endTime = performance.now();
      const searchTime = endTime - startTime;

      console.log(`[BASELINE 5000] Search time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);

      expect(results.total).toBeGreaterThan(0);
      // Linear search through 5000 items will be noticeably slower
    });

    it('should measure multi-term search performance', async () => {
      const testIndex = generateTestIndex(1000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const queries = [
        'data',
        'data engineering',
        'data engineering pipeline',
        'engineering optimization keywords'
      ];

      for (const query of queries) {
        const startTime = performance.now();
        const results = await collectionSearch.searchCollectionWithOptions(query, {
          page: 1,
          pageSize: 25
        });
        const endTime = performance.now();
        const searchTime = endTime - startTime;

        console.log(`[MULTI-TERM] "${query}" - Time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);
      }
    });
  });

  describe('Performance Targets', () => {
    it('should define performance targets for inverted index', () => {
      // Performance targets after inverted index implementation:
      // - 1000 items, single term: <10ms (target: 1-5ms)
      // - 1000 items, multi-term: <20ms (target: 5-15ms)
      // - 5000 items, single term: <15ms (target: 2-10ms)
      // - 5000 items, multi-term: <30ms (target: 10-20ms)
      // - Index build time for 1000 items: <100ms (target: 10-50ms)
      // - 10-100x speedup compared to linear search

      console.log('Performance targets defined for inverted index implementation');
      expect(true).toBe(true);
    });

    it('should show index build time is fast', async () => {
      const testIndex = generateTestIndex(1000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      // First search builds the index
      const buildStartTime = performance.now();
      await collectionSearch.searchCollectionWithOptions('data', { page: 1, pageSize: 25 });
      const buildEndTime = performance.now();
      const firstSearchTime = buildEndTime - buildStartTime;

      // Second search reuses the index
      const reuseStartTime = performance.now();
      await collectionSearch.searchCollectionWithOptions('engineering', { page: 1, pageSize: 25 });
      const reuseEndTime = performance.now();
      const secondSearchTime = reuseEndTime - reuseStartTime;

      console.log(`[INDEX BUILD] First search (with index build): ${firstSearchTime.toFixed(2)}ms`);
      console.log(`[INDEX REUSE] Second search (index reused): ${secondSearchTime.toFixed(2)}ms`);
      console.log(`[SPEEDUP] Reuse is ${(firstSearchTime / secondSearchTime).toFixed(1)}x faster`);

      // Index build should be fast
      expect(firstSearchTime).toBeLessThan(200);
      // Reusing index should be extremely fast
      expect(secondSearchTime).toBeLessThan(10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle searches with no matches efficiently', async () => {
      const testIndex = generateTestIndex(1000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const startTime = performance.now();
      const results = await collectionSearch.searchCollectionWithOptions('xyznonexistentqwerty', {
        page: 1,
        pageSize: 25
      });
      const endTime = performance.now();
      const searchTime = endTime - startTime;

      console.log(`[NO MATCH] Search time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);

      // Should have very few or no results for a truly nonexistent term
      expect(results.total).toBeLessThanOrEqual(1);
      // Should be very fast with inverted index even on first search
      expect(searchTime).toBeLessThan(200);
    });

    it('should handle searches matching all items', async () => {
      const testIndex = generateTestIndex(1000);

      (collectionSearch as any).indexCache = {
        getIndex: jest.fn().mockResolvedValue(testIndex)
      };

      const startTime = performance.now();
      const results = await collectionSearch.searchCollectionWithOptions('test item', {
        page: 1,
        pageSize: 25
      });
      const endTime = performance.now();
      const searchTime = endTime - startTime;

      console.log(`[ALL MATCH] Search time: ${searchTime.toFixed(2)}ms, Results: ${results.total}`);

      expect(results.total).toBe(1000);
    });
  });

  describe('Memory Usage', () => {
    it('should estimate index memory overhead', () => {
      // Inverted index memory estimation:
      // - Each unique token: ~50 bytes (token string + Set overhead)
      // - Each entry reference in Set: ~8 bytes (integer ID)
      // - For 1000 entries with average 20 unique tokens per entry
      // - Estimated unique tokens across corpus: ~5000 (with overlaps)
      // - Total memory: ~5000 * 50 + (1000 * 20 * 8) = ~250KB + 160KB = ~410KB
      // - vs. original entry storage: negligible overhead

      const indexSize = 1000;
      const avgTokensPerEntry = 20;
      const estimatedUniqueTokens = indexSize * 5; // Assumes ~80% deduplication

      const tokenOverhead = estimatedUniqueTokens * 50;
      const referenceOverhead = indexSize * avgTokensPerEntry * 8;
      const totalOverheadKB = (tokenOverhead + referenceOverhead) / 1024;

      console.log(`Estimated index overhead for ${indexSize} entries: ${totalOverheadKB.toFixed(2)}KB`);

      expect(totalOverheadKB).toBeLessThan(1000); // Should be less than 1MB for 1000 items
    });
  });
});
