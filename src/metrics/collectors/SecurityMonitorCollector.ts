/**
 * Collects aggregate security-event counts from SecurityMonitor, broken down
 * by severity and event type. Accepts an injectable report function so the
 * collector can be tested without a live SecurityMonitor singleton.
 */

import type { IMetricCollector, MetricEntry } from '../types.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

const SOURCE = 'SecurityMonitor' as const;

interface SecurityReport {
  totalEvents: number;
  eventsBySeverity: Record<string, number>;
  eventsByType: Record<string, number>;
  recentCriticalEvents: unknown[];
}

export class SecurityMonitorCollector implements IMetricCollector {
  readonly name = 'security-monitor';
  readonly description =
    'Total security events and per-severity/per-type breakdowns from SecurityMonitor';

  private readonly reportFn: () => SecurityReport;

  constructor(reportFn?: () => SecurityReport) {
    this.reportFn = reportFn ?? (() => SecurityMonitor.generateSecurityReport());
  }

  collect(): MetricEntry[] {
    try {
      const report = this.reportFn();
      const entries: MetricEntry[] = [];

      entries.push({
        type: 'counter' as const,
        name: 'security.monitor.events_total',
        source: SOURCE,
        unit: 'count' as const,
        description: 'Total number of security events recorded',
        value: report.totalEvents,
      });

      for (const [severity, count] of Object.entries(report.eventsBySeverity)) {
        entries.push({
          type: 'gauge' as const,
          name: 'security.monitor.events_by_severity',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Security event count grouped by severity level',
          labels: { severity },
          value: count,
        });
      }

      for (const [type, count] of Object.entries(report.eventsByType)) {
        entries.push({
          type: 'gauge' as const,
          name: 'security.monitor.events_by_type',
          source: SOURCE,
          unit: 'count' as const,
          description: 'Security event count grouped by event type',
          labels: { type },
          value: count,
        });
      }

      return entries;
    } catch {
      return [];
    }
  }
}
