/**
 * Collects blocked-attack counts and per-severity breakdowns from a
 * SecurityTelemetry instance. The current hour's attack rate is surfaced as a
 * gauge so dashboards can display a rolling "attacks this hour" reading.
 */

import type { IMetricCollector, MetricEntry } from '../types.js';
import type { SecurityTelemetry } from '../../security/telemetry/SecurityTelemetry.js';

const SOURCE = 'SecurityTelemetry' as const;

export class SecurityTelemetryCollector implements IMetricCollector {
  readonly name = 'security-telemetry';
  readonly description =
    'Blocked attack counts, unique vectors, and severity breakdown from SecurityTelemetry';

  constructor(private readonly telemetry: SecurityTelemetry) {}

  collect(): MetricEntry[] {
    try {
      const m = this.telemetry.getMetrics();

      const currentHour = new Date().getHours();
      const attacksThisHour = (m.attacksPerHour as number[])[currentHour] ?? 0;

      const entries: MetricEntry[] = [
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_24h',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Total blocked attack attempts in the last 24 hours',
          value: m.totalBlockedAttempts,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.unique_vectors',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Number of distinct attack vectors observed',
          value: m.uniqueAttackVectors,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_by_severity',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Blocked attacks broken down by severity',
          labels: { severity: 'critical' },
          value: m.criticalAttacksBlocked,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_by_severity',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Blocked attacks broken down by severity',
          labels: { severity: 'high' },
          value: m.highSeverityBlocked,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_by_severity',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Blocked attacks broken down by severity',
          labels: { severity: 'medium' },
          value: m.mediumSeverityBlocked,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_by_severity',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Blocked attacks broken down by severity',
          labels: { severity: 'low' },
          value: m.lowSeverityBlocked,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.attacks_per_hour',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Attack attempts recorded in the current clock hour',
          value: attacksThisHour,
        },
      ];

      return entries;
    } catch {
      return [];
    }
  }
}
