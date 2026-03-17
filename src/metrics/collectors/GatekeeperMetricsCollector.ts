/**
 * Collector for Gatekeeper policy enforcement metrics.
 *
 * Reads from GatekeeperMetricsTracker and emits counter and gauge
 * metric entries for the MetricsManager pipeline.
 */
import type { IMetricCollector, MetricEntry } from '../types.js';
import type { GatekeeperMetricsTracker } from '../GatekeeperMetricsTracker.js';

export class GatekeeperMetricsCollector implements IMetricCollector {
  readonly name = 'GatekeeperMetricsCollector';
  readonly description = 'Gatekeeper policy enforcement: allowed/denied/confirmed, policy sources, permission levels.';

  constructor(private readonly tracker: GatekeeperMetricsTracker) {}

  collect(): MetricEntry[] {
    try {
      const m = this.tracker.getMetrics();

      const entries: MetricEntry[] = [
        {
          type: 'counter' as const,
          name: 'gatekeeper.decisions_total',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: 'Total Gatekeeper policy decisions.',
          value: m.totalDecisions,
        },
        {
          type: 'counter' as const,
          name: 'gatekeeper.allowed_total',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: 'Operations allowed by Gatekeeper.',
          value: m.allowed,
        },
        {
          type: 'counter' as const,
          name: 'gatekeeper.denied_total',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: 'Operations denied by Gatekeeper.',
          value: m.denied,
        },
        {
          type: 'counter' as const,
          name: 'gatekeeper.confirmations_pending_total',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: 'Operations requiring user confirmation.',
          value: m.confirmationsPending,
        },
      ];

      // Per-policy-source gauges
      for (const [source, count] of m.byPolicySource) {
        entries.push({
          type: 'gauge' as const,
          name: 'gatekeeper.by_policy_source',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: `Decisions from policy source: ${source}.`,
          labels: { policy_source: source },
          value: count,
        });
      }

      // Per-permission-level gauges
      for (const [level, count] of m.byPermissionLevel) {
        entries.push({
          type: 'gauge' as const,
          name: 'gatekeeper.by_permission_level',
          source: 'GatekeeperMetricsTracker',
          unit: 'operations' as const,
          description: `Decisions at permission level: ${level}.`,
          labels: { permission_level: level },
          value: count,
        });
      }

      return entries;
    } catch {
      return [];
    }
  }
}
