import { describe, test, expect } from '@jest/globals';
import { DefaultElementProviderCollector } from '../../../../src/metrics/collectors/DefaultElementProviderCollector.js';
import type { MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerformanceStats {
  bufferPool: {
    hits: number;
    misses: number;
    created: number;
    hitRate: number;
    poolSize: number;
    maxPoolSize: number;
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockStatsFn(): () => PerformanceStats {
  return () => ({
    bufferPool: {
      hits: 150,
      misses: 30,
      created: 45,
      hitRate: 0.833,
      poolSize: 20,
      maxPoolSize: 50,
    },
  });
}

function makeThrowingStatsFn(): () => PerformanceStats {
  return (): never => {
    throw new Error('statsFn failed');
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(metrics: MetricEntry[], name: string): MetricEntry | undefined {
  return metrics.find(m => m.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultElementProviderCollector', () => {
  describe('metric count', () => {
    test('returns exactly 6 metrics', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(metrics).toHaveLength(6);
    });
  });

  describe('metric types', () => {
    test('hits_total is a counter', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.hits_total');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('misses_total is a counter', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.misses_total');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('created_total is a counter', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.created_total');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('hit_rate is a gauge', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.hit_rate');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('gauge');
    });

    test('size_current is a gauge', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.size_current');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('gauge');
    });

    test('size_max is a gauge', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.size_max');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('gauge');
    });
  });

  describe('metric names', () => {
    test('all metric names use the portfolio.buffer_pool. prefix', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      for (const metric of metrics) {
        expect(metric.name).toMatch(/^portfolio\.buffer_pool\./);
      }
    });

    test('produces portfolio.buffer_pool.hits_total', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.hits_total')).toBeDefined();
    });

    test('produces portfolio.buffer_pool.misses_total', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.misses_total')).toBeDefined();
    });

    test('produces portfolio.buffer_pool.created_total', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.created_total')).toBeDefined();
    });

    test('produces portfolio.buffer_pool.hit_rate', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.hit_rate')).toBeDefined();
    });

    test('produces portfolio.buffer_pool.size_current', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.size_current')).toBeDefined();
    });

    test('produces portfolio.buffer_pool.size_max', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      expect(findByName(metrics, 'portfolio.buffer_pool.size_max')).toBeDefined();
    });
  });

  describe('metric values', () => {
    test('hits_total value matches bufferPool.hits from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.hits_total');
      expect(entry.value).toBe(150);
    });

    test('misses_total value matches bufferPool.misses from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.misses_total');
      expect(entry.value).toBe(30);
    });

    test('created_total value matches bufferPool.created from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.created_total');
      expect(entry.value).toBe(45);
    });

    test('hit_rate value matches bufferPool.hitRate from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.hit_rate');
      expect(entry.value).toBe(0.833);
    });

    test('size_current value matches bufferPool.poolSize from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.size_current');
      expect(entry.value).toBe(20);
    });

    test('size_max value matches bufferPool.maxPoolSize from mock', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      const entry = findByName(metrics, 'portfolio.buffer_pool.size_max');
      expect(entry.value).toBe(50);
    });
  });

  describe('source', () => {
    test('all metrics report source as DefaultElementProvider', () => {
      const collector = new DefaultElementProviderCollector(makeMockStatsFn());
      const metrics = collector.collect();
      for (const metric of metrics) {
        expect(metric.source).toBe('DefaultElementProvider');
      }
    });
  });

  describe('statsFn injection', () => {
    test('accepts an injected statsFn and uses its return values', () => {
      const customStatsFn = () => ({
        bufferPool: {
          hits: 999,
          misses: 1,
          created: 2,
          hitRate: 0.998,
          poolSize: 7,
          maxPoolSize: 10,
        },
        metadataCache: { size: 5, maxSize: 25 },
      });

      const collector = new DefaultElementProviderCollector(customStatsFn);
      const metrics = collector.collect();
      const hitsEntry = findByName(metrics, 'portfolio.buffer_pool.hits_total');
      expect(hitsEntry.value).toBe(999);
    });

    test('can be constructed without a statsFn', () => {
      expect(() => new DefaultElementProviderCollector()).not.toThrow();
    });
  });

  describe('error handling', () => {
    test('returns [] when statsFn throws', () => {
      const collector = new DefaultElementProviderCollector(makeThrowingStatsFn());
      const metrics = collector.collect();
      expect(metrics).toEqual([]);
    });
  });
});
