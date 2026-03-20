/**
 * CacheMemoryBudget - Global memory coordinator for LRU cache instances
 *
 * Tracks aggregate memory usage across all registered LRU caches and enforces
 * a configurable global ceiling. When total memory exceeds the budget, evicts
 * entries from the least-active (coldest) cache first.
 *
 * Phase 4 of the Cache Consolidation RFC (CACHE-DESIGN.md).
 */

import { LRUCache } from './LRUCache.js';
import { logger } from '../utils/logger.js';

export interface CacheMemoryBudgetOptions {
  /** Global memory limit in bytes (default: 150 MB) */
  globalLimitBytes: number;
  /** Maximum evictions per enforce() call to prevent runaway loops (default: 50) */
  maxEvictionsPerEnforce?: number;
}

export interface BudgetCacheReport {
  name: string;
  entries: number;
  memoryMB: number;
  hitRate: number;
  lastActivityMs: number;
}

export interface BudgetReport {
  caches: BudgetCacheReport[];
  totalMemoryMB: number;
  budgetMB: number;
  utilizationPercent: number;
}

export class CacheMemoryBudget {
  private readonly registeredCaches = new Set<LRUCache<any>>();
  private readonly globalLimitBytes: number;
  private readonly maxEvictionsPerEnforce: number;
  private enforcing = false;

  constructor(options: CacheMemoryBudgetOptions) {
    this.globalLimitBytes = options.globalLimitBytes;
    this.maxEvictionsPerEnforce = options.maxEvictionsPerEnforce ?? 50;
  }

  /**
   * Register a cache instance with this budget. Idempotent.
   */
  register(cache: LRUCache<any>): void {
    this.registeredCaches.add(cache);
  }

  /**
   * Unregister a cache instance (e.g., during dispose). Idempotent.
   */
  unregister(cache: LRUCache<any>): void {
    this.registeredCaches.delete(cache);
  }

  /**
   * Get the number of registered caches.
   */
  getRegisteredCacheCount(): number {
    return this.registeredCaches.size;
  }

  /**
   * Get the sum of memory usage across all registered caches.
   */
  getTotalMemoryBytes(): number {
    let total = 0;
    for (const cache of this.registeredCaches) {
      total += cache.getMemoryUsageBytes();
    }
    return total;
  }

  /**
   * Enforce the global memory budget by evicting entries from the coldest
   * (least recently active) cache until total usage is under the limit.
   *
   * Called automatically via onSet callbacks registered on each cache.
   * Includes a reentrancy guard to prevent cascading enforcement.
   */
  enforce(): void {
    if (this.enforcing) {
      return;
    }

    const totalBytes = this.getTotalMemoryBytes();
    if (totalBytes <= this.globalLimitBytes) {
      return;
    }

    this.enforcing = true;
    try {
      // Sort caches by last activity time ascending (coldest first)
      const sorted = [...this.registeredCaches].sort(
        (a, b) => a.getLastActivityTimestamp() - b.getLastActivityTimestamp()
      );

      let evictions = 0;
      let currentTotal = totalBytes;

      for (const cache of sorted) {
        while (
          currentTotal > this.globalLimitBytes &&
          evictions < this.maxEvictionsPerEnforce
        ) {
          const memBefore = cache.getMemoryUsageBytes();
          const evicted = cache.evictOne();
          if (!evicted) {
            break; // Cache is empty, move to next
          }
          const memAfter = cache.getMemoryUsageBytes();
          currentTotal -= (memBefore - memAfter);
          evictions++;
        }

        if (currentTotal <= this.globalLimitBytes) {
          break;
        }
      }

      if (evictions > 0) {
        const cacheNames = sorted
          .filter(c => c.getStats().evictionCount > 0)
          .map(c => c.getName())
          .join(', ');
        logger.info(
          `[CacheMemoryBudget] Budget enforced: evicted ${evictions} entries from [${cacheNames}], ` +
          `memory ${(totalBytes / (1024 * 1024)).toFixed(1)}MB → ${(currentTotal / (1024 * 1024)).toFixed(1)}MB ` +
          `(limit: ${(this.globalLimitBytes / (1024 * 1024)).toFixed(1)}MB)`
        );
      }
    } finally {
      this.enforcing = false;
    }
  }

  /**
   * Get a diagnostic report of all registered caches.
   */
  getReport(): BudgetReport {
    const caches: BudgetCacheReport[] = [];
    let totalBytes = 0;

    for (const cache of this.registeredCaches) {
      const stats = cache.getStats();
      const memBytes = cache.getMemoryUsageBytes();
      totalBytes += memBytes;

      caches.push({
        name: cache.getName(),
        entries: stats.size,
        memoryMB: Number((memBytes / (1024 * 1024)).toFixed(2)),
        hitRate: stats.hitRate,
        lastActivityMs: cache.getLastActivityTimestamp(),
      });
    }

    const budgetMB = Number((this.globalLimitBytes / (1024 * 1024)).toFixed(2));
    const totalMemoryMB = Number((totalBytes / (1024 * 1024)).toFixed(2));

    const report: BudgetReport = {
      caches,
      totalMemoryMB,
      budgetMB,
      utilizationPercent: budgetMB > 0
        ? Number(((totalMemoryMB / budgetMB) * 100).toFixed(1))
        : 0,
    };

    // Log summary at info level for operational visibility
    if (caches.length > 0) {
      const lowHitCaches = caches.filter(c => {
        const stats = [...this.registeredCaches].find(rc => rc.getName() === c.name)?.getStats();
        const totalOps = (stats?.hitCount ?? 0) + (stats?.missCount ?? 0);
        return totalOps > 100 && c.hitRate < 0.5;
      });
      if (lowHitCaches.length > 0) {
        logger.warn(
          `[CacheMemoryBudget] Low hit rate caches: ${lowHitCaches.map(c => `${c.name} (${(c.hitRate * 100).toFixed(0)}%)`).join(', ')}`
        );
      }
    }

    return report;
  }
}
