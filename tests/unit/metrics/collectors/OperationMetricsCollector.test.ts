import { describe, test, expect } from '@jest/globals';
import { OperationMetricsCollector } from '../../../../src/metrics/collectors/OperationMetricsCollector.js';
import { OperationMetricsTracker } from '../../../../src/metrics/OperationMetricsTracker.js';
import type { CounterEntry, HistogramEntry, GaugeEntry, MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(entries: MetricEntry[], name: string): MetricEntry[] {
  return entries.filter(e => e.name === name);
}

function findOne(entries: MetricEntry[], name: string): MetricEntry {
  const matches = findByName(entries, name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OperationMetricsCollector', () => {
  test('emits correct metric names with zero activity', () => {
    const tracker = new OperationMetricsTracker();
    const collector = new OperationMetricsCollector(tracker);
    const entries = collector.collect();

    const ops = findOne(entries, 'mcpaql.operations_total') as CounterEntry;
    expect(ops.value).toBe(0);
    expect(ops.type).toBe('counter');

    const failed = findOne(entries, 'mcpaql.operations_failed_total') as CounterEntry;
    expect(failed.value).toBe(0);

    const duration = findOne(entries, 'mcpaql.duration') as HistogramEntry;
    expect(duration.type).toBe('histogram');
    expect(duration.value.count).toBe(0);
    expect(duration.value.sum).toBe(0);
  });

  test('counters reflect recorded operations', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('create_element', 'CREATE', 10, true);
    tracker.record('delete_element', 'DELETE', 8, false);

    const collector = new OperationMetricsCollector(tracker);
    const entries = collector.collect();

    const ops = findOne(entries, 'mcpaql.operations_total') as CounterEntry;
    expect(ops.value).toBe(3);

    const failed = findOne(entries, 'mcpaql.operations_failed_total') as CounterEntry;
    expect(failed.value).toBe(1);
  });

  test('histogram values match actual durations', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('op1', 'READ', 10, true);
    tracker.record('op2', 'READ', 20, true);
    tracker.record('op3', 'READ', 30, true);

    const collector = new OperationMetricsCollector(tracker);
    const entries = collector.collect();

    const duration = findOne(entries, 'mcpaql.duration') as HistogramEntry;
    expect(duration.value.count).toBe(3);
    expect(duration.value.sum).toBe(60);
    expect(duration.value.avg).toBeCloseTo(20);
  });

  test('emits per-endpoint gauges', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('get_element', 'READ', 3, true);
    tracker.record('create_element', 'CREATE', 10, true);

    const collector = new OperationMetricsCollector(tracker);
    const entries = collector.collect();

    const endpointEntries = findByName(entries, 'mcpaql.by_endpoint') as GaugeEntry[];
    expect(endpointEntries.length).toBe(2);

    const readEntry = endpointEntries.find(e => e.labels?.['endpoint'] === 'READ');
    expect(readEntry?.value).toBe(2);

    const createEntry = endpointEntries.find(e => e.labels?.['endpoint'] === 'CREATE');
    expect(createEntry?.value).toBe(1);
  });

  test('emits per-operation gauges capped at top 10', () => {
    const tracker = new OperationMetricsTracker();
    // Record 12 distinct operations
    for (let i = 0; i < 12; i++) {
      tracker.record(`op_${i}`, 'READ', 5, true);
    }
    // Give op_0 extra counts so it sorts to the top
    for (let i = 0; i < 5; i++) {
      tracker.record('op_0', 'READ', 5, true);
    }

    const collector = new OperationMetricsCollector(tracker);
    const entries = collector.collect();

    const opEntries = findByName(entries, 'mcpaql.by_operation') as GaugeEntry[];
    expect(opEntries.length).toBe(10);

    // op_0 should be first (highest count = 6)
    const op0 = opEntries.find(e => e.labels?.['operation'] === 'op_0');
    expect(op0?.value).toBe(6);
  });

  test('returns empty array when tracker throws', () => {
    const brokenTracker = {
      getMetrics: (): never => { throw new Error('broken'); },
    } as unknown as OperationMetricsTracker;

    const collector = new OperationMetricsCollector(brokenTracker);
    expect(collector.collect()).toEqual([]);
  });

  test('collector name and description are set', () => {
    const tracker = new OperationMetricsTracker();
    const collector = new OperationMetricsCollector(tracker);
    expect(collector.name).toBe('operation-metrics');
    expect(collector.description).toBeTruthy();
  });
});
