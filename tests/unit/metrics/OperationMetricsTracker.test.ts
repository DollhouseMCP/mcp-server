import { describe, test, expect } from '@jest/globals';
import { OperationMetricsTracker } from '../../../src/metrics/OperationMetricsTracker.js';

describe('OperationMetricsTracker', () => {
  // ---------------------------------------------------------------------------
  // record()
  // ---------------------------------------------------------------------------

  test('starts with zero counts', () => {
    const tracker = new OperationMetricsTracker();
    const m = tracker.getMetrics();
    expect(m.totalOps).toBe(0);
    expect(m.failedOps).toBe(0);
    expect(m.durations).toHaveLength(0);
    expect(m.byEndpoint.size).toBe(0);
    expect(m.byOperation.size).toBe(0);
  });

  test('increments totalOps on every record call', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('create_element', 'CREATE', 10, true);
    tracker.record('delete_element', 'DELETE', 8, false);
    expect(tracker.getMetrics().totalOps).toBe(3);
  });

  test('increments failedOps only on failure', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('create_element', 'CREATE', 10, false);
    tracker.record('delete_element', 'DELETE', 8, false);
    expect(tracker.getMetrics().failedOps).toBe(2);
  });

  test('records durations in order', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('op1', 'READ', 1.5, true);
    tracker.record('op2', 'READ', 3.7, true);
    tracker.record('op3', 'READ', 0.2, true);
    expect(tracker.getMetrics().durations).toEqual([1.5, 3.7, 0.2]);
  });

  test('evicts oldest durations beyond 1000', () => {
    const tracker = new OperationMetricsTracker();
    for (let i = 0; i < 1005; i++) {
      tracker.record('op', 'READ', i, true);
    }
    const durations = tracker.getMetrics().durations;
    expect(durations).toHaveLength(1000);
    // First 5 should have been evicted; earliest remaining is 5
    expect(durations[0]).toBe(5);
    expect(durations[999]).toBe(1004);
  });

  test('aggregates by endpoint', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('get_element', 'READ', 3, true);
    tracker.record('create_element', 'CREATE', 10, true);
    const m = tracker.getMetrics();
    expect(m.byEndpoint.get('READ')).toBe(2);
    expect(m.byEndpoint.get('CREATE')).toBe(1);
  });

  test('aggregates by operation', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('list_elements', 'READ', 5, true);
    tracker.record('list_elements', 'READ', 3, true);
    tracker.record('create_element', 'CREATE', 10, true);
    const m = tracker.getMetrics();
    expect(m.byOperation.get('list_elements')).toBe(2);
    expect(m.byOperation.get('create_element')).toBe(1);
  });

  test('getMetrics returns defensive copies', () => {
    const tracker = new OperationMetricsTracker();
    tracker.record('op', 'READ', 5, true);
    const m1 = tracker.getMetrics();
    m1.durations.push(999);
    m1.byEndpoint.set('FAKE', 100);
    const m2 = tracker.getMetrics();
    expect(m2.durations).toEqual([5]);
    expect(m2.byEndpoint.has('FAKE')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // percentiles()
  // ---------------------------------------------------------------------------

  test('percentiles returns zeros for empty array', () => {
    const result = OperationMetricsTracker.percentiles([]);
    expect(result).toEqual({ count: 0, sum: 0, avg: 0, p50: 0, p95: 0, p99: 0 });
  });

  test('percentiles returns correct values for single element', () => {
    const result = OperationMetricsTracker.percentiles([42]);
    expect(result.count).toBe(1);
    expect(result.sum).toBe(42);
    expect(result.avg).toBe(42);
    expect(result.p50).toBe(42);
    expect(result.p95).toBe(42);
    expect(result.p99).toBe(42);
  });

  test('percentiles computes correct sum and avg', () => {
    const result = OperationMetricsTracker.percentiles([10, 20, 30]);
    expect(result.count).toBe(3);
    expect(result.sum).toBe(60);
    expect(result.avg).toBeCloseTo(20);
  });

  test('percentiles does not mutate input array', () => {
    const input = [30, 10, 20];
    OperationMetricsTracker.percentiles(input);
    expect(input).toEqual([30, 10, 20]);
  });

  test('p50 of [1,2,3,4] is the median (nearest-rank)', () => {
    // 4 elements, p50: ceil(4 * 0.5) - 1 = 1 → sorted[1] = 2
    const result = OperationMetricsTracker.percentiles([1, 2, 3, 4]);
    expect(result.p50).toBe(2);
  });

  test('p95 and p99 with 100 elements', () => {
    // Values 1..100
    const durations = Array.from({ length: 100 }, (_, i) => i + 1);
    const result = OperationMetricsTracker.percentiles(durations);
    // p95: ceil(100 * 0.95) - 1 = 94 → sorted[94] = 95
    expect(result.p95).toBe(95);
    // p99: ceil(100 * 0.99) - 1 = 98 → sorted[98] = 99
    expect(result.p99).toBe(99);
  });

  test('p50 of 10 elements uses nearest-rank correctly', () => {
    // Values 1..10, p50: ceil(10 * 0.5) - 1 = 4 → sorted[4] = 5
    const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = OperationMetricsTracker.percentiles(durations);
    expect(result.p50).toBe(5);
  });

  test('percentiles handles unsorted input', () => {
    const result = OperationMetricsTracker.percentiles([50, 10, 90, 30, 70]);
    expect(result.count).toBe(5);
    expect(result.sum).toBe(250);
    // sorted: [10, 30, 50, 70, 90], p50: ceil(5*0.5)-1 = 2 → 50
    expect(result.p50).toBe(50);
  });
});
