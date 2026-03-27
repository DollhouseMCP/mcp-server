/**
 * Collector for DefaultElementProvider buffer pool metrics.
 *
 * Reads buffer pool performance stats via a configurable stats function
 * (defaults to `DefaultElementProvider.getPerformanceStats`) and exposes
 * hit/miss/created totals, hit rate, current pool size, and max pool size.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import { DefaultElementProvider } from '../../portfolio/DefaultElementProvider.js';

interface PerformanceStats {
  bufferPool: {
    hits: number;
    misses: number;
    created: number;
    hitRate: number;
    poolSize: number;
    maxPoolSize: number;
  };
}

export class DefaultElementProviderCollector implements IMetricCollector {
  readonly name = 'element-provider';
  readonly description = 'Buffer pool metrics from DefaultElementProvider.';

  private readonly statsFn: () => PerformanceStats;

  constructor(statsFn?: () => PerformanceStats) {
    this.statsFn = statsFn ?? DefaultElementProvider.getPerformanceStats.bind(DefaultElementProvider);
  }

  collect(): MetricEntry[] {
    try {
      const stats = this.statsFn();
      const bp = stats.bufferPool;

      return [
        {
          type: 'counter' as const,
          name: 'portfolio.buffer_pool.hits_total',
          source: 'DefaultElementProvider',
          unit: 'count' as const,
          description: 'Total number of buffer pool hits.',
          value: bp.hits,
        },
        {
          type: 'counter' as const,
          name: 'portfolio.buffer_pool.misses_total',
          source: 'DefaultElementProvider',
          unit: 'count' as const,
          description: 'Total number of buffer pool misses.',
          value: bp.misses,
        },
        {
          type: 'counter' as const,
          name: 'portfolio.buffer_pool.created_total',
          source: 'DefaultElementProvider',
          unit: 'count' as const,
          description: 'Total number of buffers created (pool was empty).',
          value: bp.created,
        },
        {
          type: 'gauge' as const,
          name: 'portfolio.buffer_pool.hit_rate',
          source: 'DefaultElementProvider',
          unit: 'ratio' as const,
          description: 'Buffer pool hit rate (0–1).',
          value: bp.hitRate,
        },
        {
          type: 'gauge' as const,
          name: 'portfolio.buffer_pool.size_current',
          source: 'DefaultElementProvider',
          unit: 'count' as const,
          description: 'Current number of buffers held in the pool.',
          value: bp.poolSize,
        },
        {
          type: 'gauge' as const,
          name: 'portfolio.buffer_pool.size_max',
          source: 'DefaultElementProvider',
          unit: 'count' as const,
          description: 'Maximum configured buffer pool size.',
          value: bp.maxPoolSize,
        },
      ];
    } catch {
      return [];
    }
  }
}
