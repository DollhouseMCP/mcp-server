/**
 * Collector for OperationalTelemetry enabled/disabled state.
 *
 * Emits a single gauge (1 = enabled, 0 = disabled) derived from
 * `OperationalTelemetry.isEnabled()`, allowing monitoring systems to
 * alert when telemetry is unexpectedly disabled.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import type { OperationalTelemetry } from '../../telemetry/OperationalTelemetry.js';

export class OperationalTelemetryCollector implements IMetricCollector {
  readonly name = 'OperationalTelemetryCollector';
  readonly description = 'Reports whether OperationalTelemetry is enabled (1) or disabled (0).';

  constructor(private readonly telemetry: OperationalTelemetry) {}

  collect(): MetricEntry[] {
    try {
      return [
        {
          type: 'gauge' as const,
          name: 'telemetry.operational.enabled',
          source: 'OperationalTelemetry',
          unit: 'count' as const,
          description: 'Operational telemetry enabled state: 1 = enabled, 0 = disabled.',
          value: this.telemetry.isEnabled() ? 1 : 0,
        },
      ];
    } catch {
      return [];
    }
  }
}
