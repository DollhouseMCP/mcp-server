/**
 * Collects hit/miss/eviction and sizing metrics for one or more named LRUCache
 * instances. Each cache is collected independently; a failure on one does not
 * prevent the others from being reported.
 */

import type { IMetricCollector, MetricEntry } from '../types.js';
import type { LRUCache } from '../../cache/LRUCache.js';

const SOURCE = 'LRUCache' as const;

export class LRUCacheCollector implements IMetricCollector {
  readonly name = 'lru-cache';
  readonly description =
    'Hit rate, eviction counts, size, and memory usage for registered LRU caches';

  constructor(
    private readonly caches: Array<{ name: string; instance: LRUCache<unknown> }>,
  ) {}

  collect(): MetricEntry[] {
    const entries: MetricEntry[] = [];

    for (const { name, instance } of this.caches) {
      try {
        const stats = instance.getStats();
        const labels = { cache: name } as const;

        entries.push(
          {
            type: 'counter' as const,
            name: 'cache.lru.hits_total',
            source: SOURCE,
            unit: 'count' as const,
            description: 'Total cache hits',
            labels,
            value: stats.hitCount,
          },
          {
            type: 'counter' as const,
            name: 'cache.lru.misses_total',
            source: SOURCE,
            unit: 'count' as const,
            description: 'Total cache misses',
            labels,
            value: stats.missCount,
          },
          {
            type: 'counter' as const,
            name: 'cache.lru.evictions_total',
            source: SOURCE,
            unit: 'count' as const,
            description: 'Total entries evicted from cache',
            labels,
            value: stats.evictionCount,
          },
          {
            type: 'gauge' as const,
            name: 'cache.lru.hit_rate',
            source: SOURCE,
            unit: 'ratio' as const,
            description: 'Fraction of lookups that resulted in a cache hit',
            labels,
            value: stats.hitRate,
          },
          {
            type: 'gauge' as const,
            name: 'cache.lru.size_current',
            source: SOURCE,
            unit: 'count' as const,
            description: 'Current number of entries in cache',
            labels,
            value: stats.size,
          },
          {
            type: 'gauge' as const,
            name: 'cache.lru.size_max',
            source: SOURCE,
            unit: 'count' as const,
            description: 'Maximum capacity of the cache',
            labels,
            value: stats.maxSize,
          },
          {
            type: 'gauge' as const,
            name: 'cache.lru.memory_used_megabytes',
            source: SOURCE,
            unit: 'megabytes' as const,
            description: 'Estimated memory used by cached entries (MB)',
            labels,
            value: stats.memoryUsageMB,
          },
        );
      } catch (err) {
        // Record failure as a metric so it's visible in the dashboard.
        // Individual cache failures should not prevent other caches from reporting.
        entries.push({
          type: 'gauge' as const,
          name: 'cache.lru.collection_error',
          source: SOURCE,
          unit: 'count' as const,
          description: `Failed to collect stats: ${err instanceof Error ? err.message : String(err)}`,
          labels: { cache: name },
          value: 1,
        });
      }
    }

    return entries;
  }
}
