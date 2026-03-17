/**
 * Unit tests for LRUCacheCollector.
 *
 * All dependencies are hand-written mocks — no jest.mock() calls.
 * Each test creates mock cache objects returning controlled stats.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { LRUCacheCollector } from '../../../../src/metrics/collectors/LRUCacheCollector.js';
import type { MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// CacheStats shape (mirrors what LRUCache.getStats() returns)
// ---------------------------------------------------------------------------

interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  memoryUsageMB: number;
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockCache(overrides: Partial<CacheStats> = {}) {
  return {
    getStats: (): CacheStats => ({
      size: 50,
      maxSize: 100,
      hitCount: 200,
      missCount: 50,
      evictionCount: 10,
      memoryUsageMB: 5.5,
      hitRate: 0.8,
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPECTED_METRIC_NAMES = [
  'cache.lru.hits_total',
  'cache.lru.misses_total',
  'cache.lru.evictions_total',
  'cache.lru.hit_rate',
  'cache.lru.size_current',
  'cache.lru.size_max',
  'cache.lru.memory_used_megabytes',
] as const;

function entriesForCache(entries: MetricEntry[], cacheName: string): MetricEntry[] {
  return entries.filter(e => e.labels?.['cache'] === cacheName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LRUCacheCollector', () => {
  // -------------------------------------------------------------------------
  // Single cache — output shape
  // -------------------------------------------------------------------------

  describe('single cache output shape', () => {
    test('returns 7 metrics for a single cache', () => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'my-cache', instance: cache as never }]);
      expect(collector.collect()).toHaveLength(7);
    });

    test('all 7 expected metric names are present', () => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'my-cache', instance: cache as never }]);
      const names = collector.collect().map(e => e.name);
      for (const expected of EXPECTED_METRIC_NAMES) {
        expect(names).toContain(expected);
      }
    });

    test('every entry carries a cache label matching the registered name', () => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'persona', instance: cache as never }]);
      const entries = collector.collect();
      for (const entry of entries) {
        expect(entry.labels).toEqual({ cache: 'persona' });
      }
    });

    test('every entry has source set to LRUCache', () => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'x', instance: cache as never }]);
      for (const entry of collector.collect()) {
        expect(entry.source).toBe('LRUCache');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multiple caches — N × 7 output
  // -------------------------------------------------------------------------

  describe('multiple caches', () => {
    test('returns 7 × N entries for N registered caches', () => {
      const caches = [
        { name: 'cache-a', instance: makeMockCache() as never },
        { name: 'cache-b', instance: makeMockCache({ size: 10 }) as never },
        { name: 'cache-c', instance: makeMockCache({ size: 30 }) as never },
      ];
      const collector = new LRUCacheCollector(caches);
      expect(collector.collect()).toHaveLength(21);
    });

    test('each cache contributes entries with its own label', () => {
      const caches = [
        { name: 'alpha', instance: makeMockCache() as never },
        { name: 'beta', instance: makeMockCache() as never },
      ];
      const collector = new LRUCacheCollector(caches);
      const entries = collector.collect();
      expect(entriesForCache(entries, 'alpha')).toHaveLength(7);
      expect(entriesForCache(entries, 'beta')).toHaveLength(7);
    });
  });

  // -------------------------------------------------------------------------
  // Counter types
  // -------------------------------------------------------------------------

  describe('counter metrics', () => {
    let entries: MetricEntry[];

    beforeEach(() => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'test', instance: cache as never }]);
      entries = collector.collect();
    });

    test('cache.lru.hits_total is a counter', () => {
      const entry = entries.find(e => e.name === 'cache.lru.hits_total');
      expect(entry?.type).toBe('counter');
    });

    test('hits_total value equals hitCount from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.hits_total');
      expect(entry?.value).toBe(200);
    });

    test('cache.lru.misses_total is a counter', () => {
      const entry = entries.find(e => e.name === 'cache.lru.misses_total');
      expect(entry?.type).toBe('counter');
    });

    test('misses_total value equals missCount from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.misses_total');
      expect(entry?.value).toBe(50);
    });

    test('cache.lru.evictions_total is a counter', () => {
      const entry = entries.find(e => e.name === 'cache.lru.evictions_total');
      expect(entry?.type).toBe('counter');
    });

    test('evictions_total value equals evictionCount from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.evictions_total');
      expect(entry?.value).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Gauge types
  // -------------------------------------------------------------------------

  describe('gauge metrics', () => {
    let entries: MetricEntry[];

    beforeEach(() => {
      const cache = makeMockCache();
      const collector = new LRUCacheCollector([{ name: 'test', instance: cache as never }]);
      entries = collector.collect();
    });

    test('cache.lru.hit_rate is a gauge', () => {
      const entry = entries.find(e => e.name === 'cache.lru.hit_rate');
      expect(entry?.type).toBe('gauge');
    });

    test('hit_rate value equals hitRate from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.hit_rate');
      expect(entry?.value).toBe(0.8);
    });

    test('cache.lru.size_current is a gauge', () => {
      const entry = entries.find(e => e.name === 'cache.lru.size_current');
      expect(entry?.type).toBe('gauge');
    });

    test('size_current value equals size from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.size_current');
      expect(entry?.value).toBe(50);
    });

    test('cache.lru.size_max is a gauge', () => {
      const entry = entries.find(e => e.name === 'cache.lru.size_max');
      expect(entry?.type).toBe('gauge');
    });

    test('size_max value equals maxSize from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.size_max');
      expect(entry?.value).toBe(100);
    });

    test('cache.lru.memory_used_megabytes is a gauge', () => {
      const entry = entries.find(e => e.name === 'cache.lru.memory_used_megabytes');
      expect(entry?.type).toBe('gauge');
    });

    test('memory_used_megabytes value equals memoryUsageMB from getStats()', () => {
      const entry = entries.find(e => e.name === 'cache.lru.memory_used_megabytes');
      expect(entry?.value).toBe(5.5);
    });
  });

  // -------------------------------------------------------------------------
  // Empty caches array
  // -------------------------------------------------------------------------

  describe('empty caches array', () => {
    test('returns [] when constructed with an empty array', () => {
      const collector = new LRUCacheCollector([]);
      expect(collector.collect()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Error isolation — per-cache fault tolerance
  // -------------------------------------------------------------------------

  describe('per-cache error isolation', () => {
    test('skips a cache that throws from getStats() and continues with remaining caches', () => {
      const goodCache = makeMockCache({ size: 5 });
      const badCache = {
        getStats: () => { throw new Error('cache unavailable'); },
      };

      const collector = new LRUCacheCollector([
        { name: 'broken', instance: badCache as never },
        { name: 'healthy', instance: goodCache as never },
      ]);

      const entries = collector.collect();
      // broken cache produces 0 entries; healthy cache produces 7
      expect(entries).toHaveLength(7);
      for (const entry of entries) {
        expect(entry.labels?.['cache']).toBe('healthy');
      }
    });

    test('all caches failing returns []', () => {
      const badCache = {
        getStats: () => { throw new Error('gone'); },
      };
      const collector = new LRUCacheCollector([
        { name: 'a', instance: badCache as never },
        { name: 'b', instance: badCache as never },
      ]);
      expect(collector.collect()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // IMetricCollector contract
  // -------------------------------------------------------------------------

  describe('IMetricCollector contract', () => {
    test('name is a non-empty string', () => {
      const collector = new LRUCacheCollector([]);
      expect(typeof collector.name).toBe('string');
      expect(collector.name.length).toBeGreaterThan(0);
    });

    test('description is a non-empty string', () => {
      const collector = new LRUCacheCollector([]);
      expect(typeof collector.description).toBe('string');
      expect(collector.description.length).toBeGreaterThan(0);
    });

    test('collect() returns an array', () => {
      const collector = new LRUCacheCollector([]);
      expect(Array.isArray(collector.collect())).toBe(true);
    });
  });
});
