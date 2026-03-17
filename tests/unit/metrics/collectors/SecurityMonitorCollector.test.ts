/**
 * Unit tests for SecurityMonitorCollector.
 *
 * The collector accepts an optional injectable reportFn so we never need to
 * touch the SecurityMonitor singleton. All mocks are hand-written objects.
 */

import { describe, test, expect } from '@jest/globals';
import { SecurityMonitorCollector } from '../../../../src/metrics/collectors/SecurityMonitorCollector.js';
import type { MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

interface SecurityReport {
  totalEvents: number;
  eventsBySeverity: Record<string, number>;
  eventsByType: Record<string, number>;
  recentCriticalEvents: unknown[];
}

function makeMockReportFn(): () => SecurityReport {
  return () => ({
    totalEvents: 42,
    eventsBySeverity: { CRITICAL: 2, HIGH: 10, MEDIUM: 20, LOW: 10 },
    eventsByType: { injection: 15, xss: 12, traversal: 15 },
    recentCriticalEvents: [],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(entries: MetricEntry[], name: string): MetricEntry[] {
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

describe('SecurityMonitorCollector', () => {
  // -------------------------------------------------------------------------
  // events_total counter
  // -------------------------------------------------------------------------

  describe('events_total counter', () => {
    test('emits security.monitor.events_total as a counter', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = collector.collect();
      const match = entries.find(e => e.name === 'security.monitor.events_total');
      expect(match).toBeDefined();
      expect(match?.type).toBe('counter');
    });

    test('events_total value equals totalEvents from the report', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = collector.collect();
      const match = entries.find(e => e.name === 'security.monitor.events_total');
      expect(match?.value).toBe(42);
    });

    test('events_total source is SecurityMonitor', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = collector.collect();
      const match = entries.find(e => e.name === 'security.monitor.events_total');
      expect(match?.source).toBe('SecurityMonitor');
    });
  });

  // -------------------------------------------------------------------------
  // events_by_severity gauges
  // -------------------------------------------------------------------------

  describe('events_by_severity gauges', () => {
    test('emits one gauge per severity level from eventsBySeverity', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = collector.collect();
      const bySevertiy = findByName(entries, 'security.monitor.events_by_severity');
      // CRITICAL, HIGH, MEDIUM, LOW = 4
      expect(bySevertiy).toHaveLength(4);
    });

    test('each events_by_severity entry is a gauge', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = findByName(collector.collect(), 'security.monitor.events_by_severity');
      for (const entry of entries) {
        expect(entry.type).toBe('gauge');
      }
    });

    test('CRITICAL severity gauge has value 2', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_severity',
        'severity',
        'CRITICAL',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(2);
    });

    test('HIGH severity gauge has value 10', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_severity',
        'severity',
        'HIGH',
      );
      expect(entry?.value).toBe(10);
    });

    test('MEDIUM severity gauge has value 20', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_severity',
        'severity',
        'MEDIUM',
      );
      expect(entry?.value).toBe(20);
    });

    test('LOW severity gauge has value 10', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_severity',
        'severity',
        'LOW',
      );
      expect(entry?.value).toBe(10);
    });

    test('events_by_severity entries carry a severity label', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = findByName(collector.collect(), 'security.monitor.events_by_severity');
      for (const entry of entries) {
        expect(entry.labels).toHaveProperty('severity');
        expect(typeof entry.labels?.['severity']).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // events_by_type gauges
  // -------------------------------------------------------------------------

  describe('events_by_type gauges', () => {
    test('emits one gauge per event type from eventsByType', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const byType = findByName(collector.collect(), 'security.monitor.events_by_type');
      // injection, xss, traversal = 3
      expect(byType).toHaveLength(3);
    });

    test('each events_by_type entry is a gauge', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = findByName(collector.collect(), 'security.monitor.events_by_type');
      for (const entry of entries) {
        expect(entry.type).toBe('gauge');
      }
    });

    test('injection type gauge has value 15', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_type',
        'type',
        'injection',
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(15);
    });

    test('xss type gauge has value 12', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_type',
        'type',
        'xss',
      );
      expect(entry?.value).toBe(12);
    });

    test('traversal type gauge has value 15', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entry = findWithLabel(
        collector.collect(),
        'security.monitor.events_by_type',
        'type',
        'traversal',
      );
      expect(entry?.value).toBe(15);
    });

    test('events_by_type entries carry a type label', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      const entries = findByName(collector.collect(), 'security.monitor.events_by_type');
      for (const entry of entries) {
        expect(entry.labels).toHaveProperty('type');
        expect(typeof entry.labels?.['type']).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Empty breakdown maps — boundary case
  // -------------------------------------------------------------------------

  describe('empty breakdown maps', () => {
    test('produces only events_total when eventsBySeverity is empty', () => {
      const reportFn = () => ({
        totalEvents: 7,
        eventsBySeverity: {},
        eventsByType: { sql: 7 },
        recentCriticalEvents: [],
      });
      const collector = new SecurityMonitorCollector(reportFn);
      const entries = collector.collect();
      const bySeverity = findByName(entries, 'security.monitor.events_by_severity');
      expect(bySeverity).toHaveLength(0);
    });

    test('produces only events_total when eventsByType is empty', () => {
      const reportFn = () => ({
        totalEvents: 3,
        eventsBySeverity: { HIGH: 3 },
        eventsByType: {},
        recentCriticalEvents: [],
      });
      const collector = new SecurityMonitorCollector(reportFn);
      const entries = collector.collect();
      const byType = findByName(entries, 'security.monitor.events_by_type');
      expect(byType).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    test('returns [] when the reportFn throws', () => {
      const throwingFn = () => { throw new Error('SecurityMonitor unavailable'); };
      const collector = new SecurityMonitorCollector(throwingFn);
      expect(collector.collect()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Testability via injected reportFn
  // -------------------------------------------------------------------------

  describe('injectable reportFn', () => {
    test('accepts and uses a custom reportFn', () => {
      const customReport: SecurityReport = {
        totalEvents: 99,
        eventsBySeverity: { LOW: 99 },
        eventsByType: {},
        recentCriticalEvents: [],
      };
      const collector = new SecurityMonitorCollector(() => customReport);
      const entries = collector.collect();
      const total = entries.find(e => e.name === 'security.monitor.events_total');
      expect(total?.value).toBe(99);
    });

    test('different reportFn instances produce independent results', () => {
      const collectorA = new SecurityMonitorCollector(() => ({
        totalEvents: 1,
        eventsBySeverity: {},
        eventsByType: {},
        recentCriticalEvents: [],
      }));
      const collectorB = new SecurityMonitorCollector(() => ({
        totalEvents: 999,
        eventsBySeverity: {},
        eventsByType: {},
        recentCriticalEvents: [],
      }));

      const totalA = collectorA.collect().find(e => e.name === 'security.monitor.events_total');
      const totalB = collectorB.collect().find(e => e.name === 'security.monitor.events_total');
      expect(totalA?.value).toBe(1);
      expect(totalB?.value).toBe(999);
    });
  });

  // -------------------------------------------------------------------------
  // IMetricCollector contract
  // -------------------------------------------------------------------------

  describe('IMetricCollector contract', () => {
    test('name is a non-empty string', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      expect(typeof collector.name).toBe('string');
      expect(collector.name.length).toBeGreaterThan(0);
    });

    test('description is a non-empty string', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      expect(typeof collector.description).toBe('string');
      expect(collector.description.length).toBeGreaterThan(0);
    });

    test('collect() returns an array', () => {
      const collector = new SecurityMonitorCollector(makeMockReportFn());
      expect(Array.isArray(collector.collect())).toBe(true);
    });
  });
});
