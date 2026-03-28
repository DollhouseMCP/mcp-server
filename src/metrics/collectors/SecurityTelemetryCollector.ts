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

      // attacksPerHour is a 24-element array indexed by hours-ago (0 = current hour)
      const attacksThisHour = Array.isArray(m.attacksPerHour) ? (m.attacksPerHour[0] ?? 0) : 0;

      const entries: MetricEntry[] = [
        {
          type: 'gauge' as const,
          name: 'security.telemetry.blocked_total',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Total blocked attack attempts since process start',
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
        {
          type: 'gauge' as const,
          name: 'security.telemetry.dedup_suppressed',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Repeated events suppressed by deduplication',
          value: m.deduplication.suppressedEvents,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.dedup_unique',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Unique events that passed through deduplication',
          value: m.deduplication.uniqueEvents,
        },
        {
          type: 'gauge' as const,
          name: 'security.telemetry.dedup_cache_size',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Current deduplication cache size',
          value: m.deduplication.cacheSize,
        },
      ];

      return entries;
    } catch {
      return [];
    }
  }
}
