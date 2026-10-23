import type { ActivationMetricsTracker } from '../ActivationMetricsTracker.js';
import type { IMetricCollector, MetricEntry } from '../types.js';

export class ActivationMetricsCollector implements IMetricCollector {
  readonly name = 'activation-metrics';
  readonly description = 'Process-wide retained stale activation references.';

  constructor(private readonly tracker: ActivationMetricsTracker) {}

  collect(): MetricEntry[] {
    return [{
      type: 'counter',
      name: 'activation.stale_reference_retained',
      source: 'ActivationMetricsTracker',
      unit: 'count',
      description: 'Distinct stale references retained within the warning-key retention window.',
      value: this.tracker.getMetrics(),
    }];
  }
}
