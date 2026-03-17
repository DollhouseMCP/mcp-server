/**
 * Collector for TriggerMetricsTracker metrics.
 *
 * Exposes the number of pending trigger metric entries that have not yet
 * been flushed, sourced from `TriggerMetricsTracker.pendingCount`.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import type { TriggerMetricsTracker } from '../../portfolio/enhanced-index/TriggerMetricsTracker.js';

export class TriggerMetricsTrackerCollector implements IMetricCollector {
  readonly name = 'TriggerMetricsTrackerCollector';
  readonly description = 'Pending trigger metric count from TriggerMetricsTracker.';

  constructor(private readonly tracker: TriggerMetricsTracker) {}

  collect(): MetricEntry[] {
    try {
      return [
        {
          type: 'gauge' as const,
          name: 'portfolio.triggers.pending_current',
          source: 'TriggerMetricsTracker',
          unit: 'count' as const,
          description: 'Number of trigger metric entries pending flush.',
          value: this.tracker.pendingCount,
        },
      ];
    } catch {
      return [];
    }
  }
}
