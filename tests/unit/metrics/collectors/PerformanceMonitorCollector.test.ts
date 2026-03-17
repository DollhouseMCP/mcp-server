/**
 * Unit tests for PerformanceMonitorCollector.
 *
 * All dependencies are hand-written mocks — no jest.mock() calls.
 * Each test creates a fresh mock monitor returning controlled data.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { PerformanceMonitorCollector } from '../../../../src/metrics/collectors/PerformanceMonitorCollector.js';
import type { MetricEntry, HistogramEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockMonitor() {
  return {
    getMetrics: () => ({
      searchTimes: [10, 20, 30],
      systemStats: {
        cpuUsage: 1.5,
        uptime: 3600,
        freeMemory: 1073741824,
        totalMemory: 8589934592,
      },
    }),
    getSearchStats: () => ({
      totalSearches: 100,
      averageTime: 20,
      medianTime: 18,
      p95Time: 45,
      p99Time: 80,
      slowQueries: 5,
      cacheHitRate: 0.85,
    }),
    getMemoryStats: () => ({
      currentUsage: {
        heapUsed: 52428800,
        heapTotal: 104857600,
        rss: 157286400,
        external: 2097152,
      },
      growthRate: 0.5,
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEntry(entries: MetricEntry[], name: string): MetricEntry | undefined {
  return entries.find(e => e.name === name);
}

function requireEntry(entries: MetricEntry[], name: string): MetricEntry {
  const entry = findEntry(entries, name);
  if (!entry) throw new Error(`Expected metric "${name}" not found`);
  return entry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceMonitorCollector', () => {
  let monitor: ReturnType<typeof makeMockMonitor>;
  let collector: PerformanceMonitorCollector;

  beforeEach(() => {
    monitor = makeMockMonitor();
    collector = new PerformanceMonitorCollector(monitor as never);
  });

  // -------------------------------------------------------------------------
  // Output shape
  // -------------------------------------------------------------------------

  describe('output shape', () => {
    test('returns exactly 13 MetricEntry items', () => {
      const entries = collector.collect();
      expect(entries).toHaveLength(13);
    });

    test('all metric names use dotted namespace convention', () => {
      const entries = collector.collect();
      for (const entry of entries) {
        expect(entry.name).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
      }
    });

    test('every entry has source set to PerformanceMonitor', () => {
      const entries = collector.collect();
      for (const entry of entries) {
        expect(entry.source).toBe('PerformanceMonitor');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Counter types
  // -------------------------------------------------------------------------

  describe('counter metrics', () => {
    test('performance.search.searches_total is a counter', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.searches_total');
      expect(entry.type).toBe('counter');
    });

    test('searches_total value equals totalSearches from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.searches_total');
      expect(entry.value).toBe(100);
    });

    test('performance.search.slow_query_count is a counter', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.slow_query_count');
      expect(entry.type).toBe('counter');
    });

    test('slow_query_count value equals slowQueries from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.slow_query_count');
      expect(entry.value).toBe(5);
    });

    test('system.cpu.usage_seconds is a counter', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.cpu.usage_seconds');
      expect(entry.type).toBe('counter');
    });

    test('system.cpu.usage_seconds value equals cpuUsage from getMetrics()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.cpu.usage_seconds');
      expect(entry.value).toBe(1.5);
    });

    test('system.uptime_seconds is a counter', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.uptime_seconds');
      expect(entry.type).toBe('counter');
    });

    test('system.uptime_seconds value equals uptime from getMetrics()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.uptime_seconds');
      expect(entry.value).toBe(3600);
    });
  });

  // -------------------------------------------------------------------------
  // Gauge types
  // -------------------------------------------------------------------------

  describe('gauge metrics', () => {
    test('performance.search.cache_hit_rate is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.cache_hit_rate');
      expect(entry.type).toBe('gauge');
    });

    test('cache_hit_rate value equals cacheHitRate from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.cache_hit_rate');
      expect(entry.value).toBe(0.85);
    });

    test('system.memory.heap_used_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.heap_used_bytes');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.heap_total_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.heap_total_bytes');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.rss_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.rss_bytes');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.external_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.external_bytes');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.growth_rate is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.growth_rate');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.growth_rate value equals growthRate from getMemoryStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.growth_rate');
      expect(entry.value).toBe(0.5);
    });

    test('system.memory.free_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.free_bytes');
      expect(entry.type).toBe('gauge');
    });

    test('system.memory.total_bytes is a gauge', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'system.memory.total_bytes');
      expect(entry.type).toBe('gauge');
    });
  });

  // -------------------------------------------------------------------------
  // Histogram
  // -------------------------------------------------------------------------

  describe('histogram metric: performance.search.duration', () => {
    test('performance.search.duration is a histogram', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration');
      expect(entry.type).toBe('histogram');
    });

    test('histogram count equals searchTimes.length (3)', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.count).toBe(3);
    });

    test('histogram sum equals averageTime × count (20 × 3 = 60)', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.sum).toBe(60);
    });

    test('histogram p50 equals medianTime from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.p50).toBe(18);
    });

    test('histogram p95 equals p95Time from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.p95).toBe(45);
    });

    test('histogram p99 equals p99Time from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.p99).toBe(80);
    });

    test('histogram avg equals averageTime from getSearchStats()', () => {
      const entries = collector.collect();
      const entry = requireEntry(entries, 'performance.search.duration') as HistogramEntry;
      expect(entry.value.avg).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    test('returns [] when getMetrics() throws', () => {
      monitor.getMetrics = () => { throw new Error('source unavailable'); };
      const entries = collector.collect();
      expect(entries).toEqual([]);
    });

    test('returns [] when getSearchStats() throws', () => {
      monitor.getSearchStats = () => { throw new Error('stats unavailable'); };
      const entries = collector.collect();
      expect(entries).toEqual([]);
    });

    test('returns [] when getMemoryStats() throws', () => {
      monitor.getMemoryStats = () => { throw new Error('memory unavailable'); };
      const entries = collector.collect();
      expect(entries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // IMetricCollector contract
  // -------------------------------------------------------------------------

  describe('IMetricCollector contract', () => {
    test('collector has a name string', () => {
      expect(typeof collector.name).toBe('string');
      expect(collector.name.length).toBeGreaterThan(0);
    });

    test('collector has a description string', () => {
      expect(typeof collector.description).toBe('string');
      expect(collector.description.length).toBeGreaterThan(0);
    });

    test('collect() returns an array', () => {
      expect(Array.isArray(collector.collect())).toBe(true);
    });
  });
});
