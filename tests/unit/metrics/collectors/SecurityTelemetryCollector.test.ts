/**
 * Unit tests for SecurityTelemetryCollector.
 *
 * The collector wraps a SecurityTelemetry instance and reads `getMetrics()`.
 * All dependencies are hand-written mocks — no jest.mock() calls.
 *
 * Important implementation detail: attacks_per_hour is the value for the
 * *current clock hour* (new Date().getHours()), not a sum. The mock returns
 * `index * 2` for each slot, so we derive the expected value the same way
 * at assertion time.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { SecurityTelemetryCollector } from '../../../../src/metrics/collectors/SecurityTelemetryCollector.js';
import type { MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockTelemetry() {
  return {
    getMetrics: () => ({
      totalBlockedAttempts: 100,
      uniqueAttackVectors: 8,
      criticalAttacksBlocked: 5,
      highSeverityBlocked: 20,
      mediumSeverityBlocked: 45,
      lowSeverityBlocked: 30,
      attacksPerHour: new Array(24).fill(0).map((_, i) => i * 2),
      topAttackVectors: [],
      lastUpdated: new Date().toISOString(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(entries: MetricEntry[], name: string): MetricEntry | undefined {
  return entries.find(e => e.name === name);
}

function findAllByName(entries: MetricEntry[], name: string): MetricEntry[] {
  return entries.filter(e => e.name === name);
}

function findWithLabel(
  entries: MetricEntry[],
  name: string,
  labelKey: string,
  labelValue: string,
): MetricEntry | undefined {
  return entries.find(
    e => e.name === name && e.labels?.[labelKey] === labelValue,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecurityTelemetryCollector', () => {
  let telemetry: ReturnType<typeof makeMockTelemetry>;
  let collector: SecurityTelemetryCollector;

  beforeEach(() => {
    telemetry = makeMockTelemetry();
    collector = new SecurityTelemetryCollector(telemetry as never);
  });

  // -------------------------------------------------------------------------
  // blocked_24h gauge
  // -------------------------------------------------------------------------

  describe('blocked_24h gauge', () => {
    test('emits security.telemetry.blocked_24h as a gauge', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.blocked_24h');
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('gauge');
    });

    test('blocked_24h value equals totalBlockedAttempts from getMetrics()', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.blocked_24h');
      expect(entry?.value).toBe(100);
    });

    test('blocked_24h source is SecurityTelemetry', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.blocked_24h');
      expect(entry?.source).toBe('SecurityTelemetry');
    });
  });

  // -------------------------------------------------------------------------
  // unique_vectors gauge
  // -------------------------------------------------------------------------

  describe('unique_vectors gauge', () => {
    test('emits security.telemetry.unique_vectors as a gauge', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.unique_vectors');
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('gauge');
    });

    test('unique_vectors value equals uniqueAttackVectors from getMetrics()', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.unique_vectors');
      expect(entry?.value).toBe(8);
    });

    test('unique_vectors source is SecurityTelemetry', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.unique_vectors');
      expect(entry?.source).toBe('SecurityTelemetry');
    });
  });

  // -------------------------------------------------------------------------
  // blocked_by_severity gauges — 4 entries with severity labels
  // -------------------------------------------------------------------------

  describe('blocked_by_severity gauges', () => {
    test('emits exactly 4 blocked_by_severity entries', () => {
      const entries = findAllByName(collector.collect(), 'security.telemetry.blocked_by_severity');
      expect(entries).toHaveLength(4);
    });

    test('all blocked_by_severity entries are gauges', () => {
      const entries = findAllByName(collector.collect(), 'security.telemetry.blocked_by_severity');
      for (const entry of entries) {
        expect(entry.type).toBe('gauge');
      }
    });

    test('critical severity gauge value equals criticalAttacksBlocked', () => {
      const entry = findWithLabel(
        collector.collect(),
        'security.telemetry.blocked_by_severity',
        'severity',
        'critical',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(5);
    });

    test('high severity gauge value equals highSeverityBlocked', () => {
      const entry = findWithLabel(
        collector.collect(),
        'security.telemetry.blocked_by_severity',
        'severity',
        'high',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(20);
    });

    test('medium severity gauge value equals mediumSeverityBlocked', () => {
      const entry = findWithLabel(
        collector.collect(),
        'security.telemetry.blocked_by_severity',
        'severity',
        'medium',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(45);
    });

    test('low severity gauge value equals lowSeverityBlocked', () => {
      const entry = findWithLabel(
        collector.collect(),
        'security.telemetry.blocked_by_severity',
        'severity',
        'low',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(30);
    });

    test('all blocked_by_severity entries carry a severity label', () => {
      const entries = findAllByName(collector.collect(), 'security.telemetry.blocked_by_severity');
      for (const entry of entries) {
        expect(entry.labels).toHaveProperty('severity');
        expect(typeof entry.labels?.['severity']).toBe('string');
      }
    });

    test('all blocked_by_severity entries have source SecurityTelemetry', () => {
      const entries = findAllByName(collector.collect(), 'security.telemetry.blocked_by_severity');
      for (const entry of entries) {
        expect(entry.source).toBe('SecurityTelemetry');
      }
    });
  });

  // -------------------------------------------------------------------------
  // attacks_per_hour gauge
  // -------------------------------------------------------------------------

  describe('attacks_per_hour gauge', () => {
    test('emits security.telemetry.attacks_per_hour as a gauge', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.attacks_per_hour');
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('gauge');
    });

    test('attacks_per_hour value reflects the current clock hour slot', () => {
      // The collector reads attacksPerHour[currentHour]. Our mock produces index*2,
      // so slot N = N*2. We derive the expected value the same way.
      const currentHour = new Date().getHours();
      const expectedValue = currentHour * 2;

      const entry = findByName(collector.collect(), 'security.telemetry.attacks_per_hour');
      expect(entry?.value).toBe(expectedValue);
    });

    test('attacks_per_hour source is SecurityTelemetry', () => {
      const entry = findByName(collector.collect(), 'security.telemetry.attacks_per_hour');
      expect(entry?.source).toBe('SecurityTelemetry');
    });
  });

  // -------------------------------------------------------------------------
  // Total metric count
  // -------------------------------------------------------------------------

  describe('total output count', () => {
    test('returns exactly 7 metric entries', () => {
      // blocked_24h, unique_vectors, 4×blocked_by_severity, attacks_per_hour
      expect(collector.collect()).toHaveLength(7);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    test('returns [] when getMetrics() throws', () => {
      telemetry.getMetrics = () => { throw new Error('telemetry unavailable'); };
      expect(collector.collect()).toEqual([]);
    });

    test('returns [] immediately without partial output when source throws', () => {
      telemetry.getMetrics = () => { throw new Error('gone'); };
      const entries = collector.collect();
      expect(entries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Zero values — boundary case
  // -------------------------------------------------------------------------

  describe('zero-value boundary case', () => {
    test('reports zero counts when all attack fields are 0', () => {
      telemetry.getMetrics = () => ({
        totalBlockedAttempts: 0,
        uniqueAttackVectors: 0,
        criticalAttacksBlocked: 0,
        highSeverityBlocked: 0,
        mediumSeverityBlocked: 0,
        lowSeverityBlocked: 0,
        attacksPerHour: new Array(24).fill(0),
        topAttackVectors: [],
        lastUpdated: new Date().toISOString(),
      });

      const entries = collector.collect();
      for (const entry of entries) {
        expect(entry.value).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // IMetricCollector contract
  // -------------------------------------------------------------------------

  describe('IMetricCollector contract', () => {
    test('name is a non-empty string', () => {
      expect(typeof collector.name).toBe('string');
      expect(collector.name.length).toBeGreaterThan(0);
    });

    test('description is a non-empty string', () => {
      expect(typeof collector.description).toBe('string');
      expect(collector.description.length).toBeGreaterThan(0);
    });

    test('collect() returns an array', () => {
      expect(Array.isArray(collector.collect())).toBe(true);
    });
  });
});
