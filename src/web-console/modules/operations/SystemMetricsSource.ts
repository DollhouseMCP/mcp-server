import type { MetricQueryOptions, MetricQueryResult } from '../../../metrics/types.js';

/**
 * Narrow port over the MCP server's in-process operational metrics sink
 * (`MemoryMetricsSink`), so the operations module can read "System A" metrics
 * (cache/perf/gatekeeper/security counters, system-wide) without depending on
 * the concrete sink. DI-swappable; absent when metrics collection is disabled
 * (`DOLLHOUSE_METRICS_ENABLED=false`), in which case the route degrades to an
 * empty result rather than failing.
 *
 * `MemoryMetricsSink.query` structurally satisfies this.
 */
export interface ISystemMetricsSource {
  query(options?: MetricQueryOptions): MetricQueryResult;
}
