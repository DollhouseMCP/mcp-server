import { describe, test, expect } from '@jest/globals';
import { TriggerMetricsTrackerCollector } from '../../../../src/metrics/collectors/TriggerMetricsTrackerCollector.js';
import type { GaugeEntry, MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockTracker(pendingCount = 5) {
  return { get pendingCount() { return pendingCount; } };
}

function makeThrowingTracker() {
  return {
    get pendingCount(): never {
      throw new Error('pendingCount accessor failed');
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

describe('TriggerMetricsTrackerCollector', () => {
  describe('metric count', () => {
    test('returns exactly 1 metric', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(metrics).toHaveLength(1);
    });
  });

  describe('metric type', () => {
    test('pending_current is a gauge', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = metrics[0] as GaugeEntry;
      expect(entry.type).toBe('gauge');
    });
  });

  describe('metric name', () => {
    test('produces portfolio.triggers.pending_current', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker() as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = findByName(metrics, 'portfolio.triggers.pending_current');
      expect(entry).toBeDefined();
    });
  });

  describe('metric unit', () => {
    test('unit is count', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(metrics[0].unit).toBe('count');
    });
  });

  describe('metric value', () => {
    test('value matches pendingCount from mock (default: 5)', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker(5) as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = metrics[0] as GaugeEntry;
      expect(entry.value).toBe(5);
    });

    test('value reflects a different pendingCount', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker(42) as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = metrics[0] as GaugeEntry;
      expect(entry.value).toBe(42);
    });

    test('value is 0 when pendingCount is 0', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker(0) as never);
      const metrics = collector.collect() as MetricEntry[];
      const entry = metrics[0] as GaugeEntry;
      expect(entry.value).toBe(0);
    });
  });

  describe('source', () => {
    test('source is TriggerMetricsTracker', () => {
      const collector = new TriggerMetricsTrackerCollector(makeMockTracker() as never);
      const metrics = collector.collect() as MetricEntry[];
      expect(metrics[0].source).toBe('TriggerMetricsTracker');
    });
  });

  describe('error handling', () => {
    test('returns [] when accessing pendingCount throws', () => {
      const collector = new TriggerMetricsTrackerCollector(makeThrowingTracker() as never);
      const metrics = collector.collect();
      expect(metrics).toEqual([]);
    });
  });
});
