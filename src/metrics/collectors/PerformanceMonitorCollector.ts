/**
 * Collects search-performance and system-resource metrics from a PerformanceMonitor
 * instance. Returns an empty array (never throws) when the source is unavailable.
 */

import type { IMetricCollector, MetricEntry } from '../types.js';
import type { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';

const SOURCE = 'PerformanceMonitor' as const;

export class PerformanceMonitorCollector implements IMetricCollector {
  readonly name = 'performance-monitor';
  readonly description =
    'Search performance timings, cache hit rate, and system memory/CPU from PerformanceMonitor';

  constructor(private readonly monitor: PerformanceMonitor) {}

  collect(): MetricEntry[] {
    try {
      const metrics = this.monitor.getMetrics();
      const searchStats = this.monitor.getSearchStats();
      const memStats = this.monitor.getMemoryStats();

      const searchTimes: number[] = metrics.searchTimes ?? [];
      const histCount = searchTimes.length;
      const histSum = searchStats.averageTime * histCount;

      const entries: MetricEntry[] = [
        {
          type: 'counter' as const,
          name: 'performance.search.searches_total',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Total number of searches performed',
          value: searchStats.totalSearches,
        },
        {
          type: 'histogram' as const,
          name: 'performance.search.duration',
          source: SOURCE,
          unit: 'milliseconds' as const,
          description: 'Distribution of search durations',
          value: {
            count: histCount,
            sum: histSum,
            avg: searchStats.averageTime,
            p50: searchStats.medianTime,
            p95: searchStats.p95Time,
            p99: searchStats.p99Time,
          },
        },
        {
          type: 'counter' as const,
          name: 'performance.search.slow_query_count',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Number of searches that exceeded the slow-query threshold',
          value: searchStats.slowQueries,
        },
        {
          type: 'gauge' as const,
          name: 'performance.search.cache_hit_rate',
          source: SOURCE,
          unit: 'ratio' as const,
          description: 'Fraction of searches served from cache',
          value: searchStats.cacheHitRate,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.heap_used_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'V8 heap used (bytes)',
          value: memStats.currentUsage.heapUsed,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.heap_total_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'V8 heap total (bytes)',
          value: memStats.currentUsage.heapTotal,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.rss_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'Process resident set size (bytes)',
          value: memStats.currentUsage.rss,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.external_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'V8 external memory (bytes)',
          value: memStats.currentUsage.external,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.growth_rate',
          source: SOURCE,
          unit: 'megabytes' as const,
          description: 'Heap growth rate (MB/s)',
          value: memStats.growthRate,
        },
        {
          type: 'counter' as const,
          name: 'system.cpu.usage_seconds',
          source: SOURCE,
          unit: 'seconds' as const,
          description: 'CPU time consumed by the process (seconds)',
          value: metrics.systemStats.cpuUsage,
        },
        {
          type: 'counter' as const,
          name: 'system.uptime_seconds',
          source: SOURCE,
          unit: 'seconds' as const,
          description: 'Process uptime (seconds)',
          value: metrics.systemStats.uptime,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.free_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'System free memory (bytes)',
          value: metrics.systemStats.freeMemory,
        },
        {
          type: 'gauge' as const,
          name: 'system.memory.total_bytes',
          source: SOURCE,
          unit: 'bytes' as const,
          description: 'System total memory (bytes)',
          value: metrics.systemStats.totalMemory,
        },
      ];

      return entries;
    } catch {
      return [];
    }
  }
}
