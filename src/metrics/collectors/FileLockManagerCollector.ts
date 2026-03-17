/**
 * Collector for FileLockManager metrics.
 *
 * Exposes lock request totals, active lock count, timeout count, and
 * concurrent-wait count sourced from `FileLockManager.getMetrics()`.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import type { FileLockManager } from '../../security/fileLockManager.js';

export class FileLockManagerCollector implements IMetricCollector {
  readonly name = 'FileLockManagerCollector';
  readonly description = 'Metrics from the FileLockManager: requests, active locks, timeouts, and concurrent waits.';

  constructor(private readonly lockManager: FileLockManager) {}

  collect(): MetricEntry[] {
    try {
      const m = this.lockManager.getMetrics();

      return [
        {
          type: 'counter' as const,
          name: 'lock.file.requests_total',
          source: 'FileLockManager',
          unit: 'count' as const,
          description: 'Total number of file lock requests.',
          value: m.totalRequests,
        },
        {
          type: 'gauge' as const,
          name: 'lock.file.active_current',
          source: 'FileLockManager',
          unit: 'count' as const,
          description: 'Number of currently active file locks.',
          value: m.activeLocksCount,
        },
        {
          type: 'counter' as const,
          name: 'lock.file.timeouts_total',
          source: 'FileLockManager',
          unit: 'count' as const,
          description: 'Total number of file lock timeouts.',
          value: m.timeouts,
        },
        {
          type: 'counter' as const,
          name: 'lock.file.concurrent_waits_total',
          source: 'FileLockManager',
          unit: 'count' as const,
          description: 'Total number of concurrent lock wait events.',
          value: m.concurrentWaits,
        },
      ];
    } catch {
      return [];
    }
  }
}
