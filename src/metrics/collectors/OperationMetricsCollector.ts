/**
 * Collector for MCP-AQL operation metrics.
 *
 * Reads from OperationMetricsTracker and emits counter, histogram,
 * and gauge metric entries for the MetricsManager pipeline.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import { OperationMetricsTracker } from '../OperationMetricsTracker.js';

export class OperationMetricsCollector implements IMetricCollector {
  readonly name = 'OperationMetricsCollector';
  readonly description = 'MCP-AQL operation counts, durations, and endpoint breakdown.';

  constructor(private readonly tracker: OperationMetricsTracker) {}

  collect(): MetricEntry[] {
    try {
      const m = this.tracker.getMetrics();
      const pct = OperationMetricsTracker.percentiles(m.durations);

      const entries: MetricEntry[] = [
        {
          type: 'counter' as const,
          name: 'mcpaql.operations_total',
          source: 'OperationMetricsTracker',
          unit: 'operations' as const,
          description: 'Total MCP-AQL operations executed.',
          value: m.totalOps,
        },
        {
          type: 'counter' as const,
          name: 'mcpaql.operations_failed_total',
          source: 'OperationMetricsTracker',
          unit: 'operations' as const,
          description: 'Total MCP-AQL operations that failed.',
          value: m.failedOps,
        },
        {
          type: 'histogram' as const,
          name: 'mcpaql.duration',
          source: 'OperationMetricsTracker',
          unit: 'milliseconds' as const,
          description: 'MCP-AQL operation duration distribution.',
          value: {
            count: pct.count,
            sum: pct.sum,
            avg: pct.avg,
            p50: pct.p50,
            p95: pct.p95,
            p99: pct.p99,
          },
        },
      ];

      // Per-endpoint gauges
      for (const [endpoint, count] of m.byEndpoint) {
        entries.push({
          type: 'gauge' as const,
          name: 'mcpaql.by_endpoint',
          source: 'OperationMetricsTracker',
          unit: 'operations' as const,
          description: `Operations via ${endpoint} endpoint.`,
          labels: { endpoint },
          value: count,
        });
      }

      // Top 10 operations by count
      const topOps = [...m.byOperation.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [operation, count] of topOps) {
        entries.push({
          type: 'gauge' as const,
          name: 'mcpaql.by_operation',
          source: 'OperationMetricsTracker',
          unit: 'operations' as const,
          description: `Count for operation: ${operation}.`,
          labels: { operation },
          value: count,
        });
      }

      return entries;
    } catch {
      return [];
    }
  }
}
