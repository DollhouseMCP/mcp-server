import { describe, test, expect } from '@jest/globals';
import { OperationalTelemetryCollector } from '../../../../src/metrics/collectors/OperationalTelemetryCollector.js';
import type { MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockTelemetry(enabled = true) {
  return { isEnabled: () => enabled };
}

function makeThrowingTelemetry() {
  return {
    isEnabled: (): never => {
      throw new Error('isEnabled failed');
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

describe('OperationalTelemetryCollector', () => {
  describe('metric count', () => {
    test('returns exactly 1 metric', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry() as never);
      const metrics = collector.collect();
      expect(metrics).toHaveLength(1);
    });
  });

  describe('metric type', () => {
    test('enabled is a gauge', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry() as never);
      const metrics = collector.collect();
      const entry = metrics[0];
      expect(entry.type).toBe('gauge');
    });
  });

  describe('metric name', () => {
    test('produces telemetry.operational.enabled', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry() as never);
      const metrics = collector.collect();
      const entry = findByName(metrics, 'telemetry.operational.enabled');
      expect(entry).toBeDefined();
    });
  });

  describe('metric unit', () => {
    test('unit is none (boolean flag)', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry() as never);
      const metrics = collector.collect();
      expect(metrics[0].unit).toBe('none');
    });
  });

  describe('metric value', () => {
    test('value is 1 when telemetry is enabled', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry(true) as never);
      const metrics = collector.collect();
      const entry = metrics[0];
      expect(entry.value).toBe(1);
    });

    test('value is 0 when telemetry is disabled', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry(false) as never);
      const metrics = collector.collect();
      const entry = metrics[0];
      expect(entry.value).toBe(0);
    });
  });

  describe('source', () => {
    test('source is OperationalTelemetry', () => {
      const collector = new OperationalTelemetryCollector(makeMockTelemetry() as never);
      const metrics = collector.collect();
      expect(metrics[0].source).toBe('OperationalTelemetry');
    });
  });

  describe('error handling', () => {
    test('returns [] when isEnabled() throws', () => {
      const collector = new OperationalTelemetryCollector(makeThrowingTelemetry() as never);
      const metrics = collector.collect();
      expect(metrics).toEqual([]);
    });
  });
});
