import { describe, test, expect } from '@jest/globals';
import { FileLockManagerCollector } from '../../../../src/metrics/collectors/FileLockManagerCollector.js';
import type { CounterEntry, GaugeEntry, MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockLockManager() {
  return {
    getMetrics: () => ({
      totalRequests: 500,
      activeLocksCount: 3,
      timeouts: 7,
      concurrentWaits: 12,
      avgWaitTimeByResource: {},
      activeLocks: [],
    }),
  };
}

function makeThrowingLockManager() {
  return {
    getMetrics: (): never => {
      throw new Error('getMetrics failed');
    },
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

describe('FileLockManagerCollector', () => {
  describe('metric count', () => {
    test('returns exactly 4 metrics', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(metrics).toHaveLength(4);
    });
  });

  describe('metric types', () => {
    test('requests_total is a counter', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.requests_total') as CounterEntry;
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('timeouts_total is a counter', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.timeouts_total') as CounterEntry;
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('concurrent_waits_total is a counter', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.concurrent_waits_total') as CounterEntry;
      expect(entry).toBeDefined();
      expect(entry.type).toBe('counter');
    });

    test('active_current is a gauge', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.active_current') as GaugeEntry;
      expect(entry).toBeDefined();
      expect(entry.type).toBe('gauge');
    });
  });

  describe('metric names', () => {
    test('all metric names use the lock.file. prefix', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      for (const metric of metrics) {
        expect(metric.name).toMatch(/^lock\.file\./);
      }
    });

    test('produces lock.file.requests_total', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(findByName(metrics, 'lock.file.requests_total')).toBeDefined();
    });

    test('produces lock.file.active_current', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(findByName(metrics, 'lock.file.active_current')).toBeDefined();
    });

    test('produces lock.file.timeouts_total', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(findByName(metrics, 'lock.file.timeouts_total')).toBeDefined();
    });

    test('produces lock.file.concurrent_waits_total', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(findByName(metrics, 'lock.file.concurrent_waits_total')).toBeDefined();
    });
  });

  describe('metric values', () => {
    test('requests_total value matches totalRequests from mock', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.requests_total') as CounterEntry;
      expect(entry.value).toBe(500);
    });

    test('active_current value matches activeLocksCount from mock', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.active_current') as GaugeEntry;
      expect(entry.value).toBe(3);
    });

    test('timeouts_total value matches timeouts from mock', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.timeouts_total') as CounterEntry;
      expect(entry.value).toBe(7);
    });

    test('concurrent_waits_total value matches concurrentWaits from mock', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'lock.file.concurrent_waits_total') as CounterEntry;
      expect(entry.value).toBe(12);
    });
  });

  describe('source', () => {
    test('all metrics report source as FileLockManager', () => {
      const collector = new FileLockManagerCollector(makeMockLockManager() as never);
      const metrics = collector.collect() as MetricEntry[];
      for (const metric of metrics) {
        expect(metric.source).toBe('FileLockManager');
      }
    });
  });

  describe('error handling', () => {
    test('returns [] when getMetrics() throws', () => {
      const collector = new FileLockManagerCollector(makeThrowingLockManager() as never);
      const metrics = collector.collect();
      expect(metrics).toEqual([]);
    });
  });
});
