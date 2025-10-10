/**
 * Security Telemetry for DollhouseMCP
 *
 * Tracks and aggregates security metrics for blocked attacks,
 * providing insights into threat patterns and system defense effectiveness.
 *
 * Issue #1269: Enhanced telemetry for memory injection protection
 */

import { SecurityEvent } from '../securityMonitor.js';

export interface AttackVector {
  type: string;
  count: number;
  lastSeen: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  blockedPatterns: string[];
}

export interface SecurityMetrics {
  totalBlockedAttempts: number;
  uniqueAttackVectors: number;
  criticalAttacksBlocked: number;
  highSeverityBlocked: number;
  mediumSeverityBlocked: number;
  lowSeverityBlocked: number;
  topAttackVectors: AttackVector[];
  attacksPerHour: number[];
  lastUpdated: string;
}

export interface AttackTelemetryEntry {
  timestamp: string;
  attackType: string;
  pattern: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: string;
  blocked: boolean;
  metadata?: Record<string, any>;
}

export class SecurityTelemetry {
  private static attackHistory: AttackTelemetryEntry[] = [];
  private static readonly MAX_HISTORY = 10000; // Keep last 10k attack attempts
  private static readonly METRIC_WINDOW_HOURS = 24; // Track last 24 hours
  private static attackVectorMap: Map<string, AttackVector> = new Map();

  /**
   * Records a blocked attack attempt
   */
  static recordBlockedAttack(
    attackType: string,
    pattern: string,
    severity: SecurityEvent['severity'],
    source: string,
    metadata?: Record<string, any>
  ): void {
    const entry: AttackTelemetryEntry = {
      timestamp: new Date().toISOString(),
      attackType,
      pattern,
      severity,
      source,
      blocked: true,
      metadata
    };

    // Add to history with circular buffer
    this.attackHistory.push(entry);
    if (this.attackHistory.length > this.MAX_HISTORY) {
      this.attackHistory.shift();
    }

    // Update attack vector map
    const vectorKey = `${attackType}:${pattern}`;
    const existing = this.attackVectorMap.get(vectorKey);

    if (existing) {
      existing.count++;
      existing.lastSeen = entry.timestamp;
      if (!existing.blockedPatterns.includes(pattern)) {
        existing.blockedPatterns.push(pattern);
      }
    } else {
      this.attackVectorMap.set(vectorKey, {
        type: attackType,
        count: 1,
        lastSeen: entry.timestamp,
        severity,
        blockedPatterns: [pattern]
      });
    }
  }

  /**
   * Get aggregated security metrics
   */
  static getMetrics(): SecurityMetrics {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.METRIC_WINDOW_HOURS * 60 * 60 * 1000);

    // Filter to recent attacks
    const recentAttacks = this.attackHistory.filter(
      attack => new Date(attack.timestamp) >= windowStart
    );

    // Count by severity
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (const attack of recentAttacks) {
      switch (attack.severity) {
        case 'CRITICAL':
          criticalCount++;
          break;
        case 'HIGH':
          highCount++;
          break;
        case 'MEDIUM':
          mediumCount++;
          break;
        case 'LOW':
          lowCount++;
          break;
      }
    }

    // Calculate attacks per hour
    const attacksPerHour: number[] = new Array(24).fill(0);
    for (const attack of recentAttacks) {
      const attackDate = new Date(attack.timestamp);
      const hoursAgo = Math.floor((now.getTime() - attackDate.getTime()) / (60 * 60 * 1000));
      if (hoursAgo < 24) {
        attacksPerHour[23 - hoursAgo]++;
      }
    }

    // Get top attack vectors
    const vectorArray = Array.from(this.attackVectorMap.values());
    const topVectors = vectorArray
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalBlockedAttempts: recentAttacks.length,
      uniqueAttackVectors: new Set(recentAttacks.map(a => a.attackType)).size,
      criticalAttacksBlocked: criticalCount,
      highSeverityBlocked: highCount,
      mediumSeverityBlocked: mediumCount,
      lowSeverityBlocked: lowCount,
      topAttackVectors: topVectors,
      attacksPerHour,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get attack patterns by type
   */
  static getAttackPatternsByType(attackType: string): string[] {
    const patterns = new Set<string>();

    for (const attack of this.attackHistory) {
      if (attack.attackType === attackType) {
        patterns.add(attack.pattern);
      }
    }

    return Array.from(patterns);
  }

  /**
   * Get attack timeline for visualization
   */
  static getAttackTimeline(hours: number = 24): { hour: string; count: number; severity: Record<string, number> }[] {
    const now = new Date();
    const timeline: { hour: string; count: number; severity: Record<string, number> }[] = [];

    for (let i = hours - 1; i >= 0; i--) {
      const hourStart = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000);
      const hourEnd = new Date(now.getTime() - i * 60 * 60 * 1000);

      const hourAttacks = this.attackHistory.filter(attack => {
        const attackTime = new Date(attack.timestamp);
        // For the most recent hour (i=0), include attacks up to and including "now"
        return i === 0
          ? attackTime >= hourStart && attackTime <= now
          : attackTime >= hourStart && attackTime < hourEnd;
      });

      const severityCounts: Record<string, number> = {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0
      };

      for (const attack of hourAttacks) {
        severityCounts[attack.severity]++;
      }

      timeline.push({
        hour: hourStart.toISOString().split('T')[1].split(':')[0] + ':00',
        count: hourAttacks.length,
        severity: severityCounts
      });
    }

    return timeline;
  }

  /**
   * Get summary report for security audits
   */
  static generateReport(): string {
    const metrics = this.getMetrics();

    const report = `
=== Security Telemetry Report ===
Generated: ${new Date().toISOString()}

Total Blocked Attacks (24h): ${metrics.totalBlockedAttempts}
Unique Attack Vectors: ${metrics.uniqueAttackVectors}

Severity Breakdown:
- Critical: ${metrics.criticalAttacksBlocked}
- High: ${metrics.highSeverityBlocked}
- Medium: ${metrics.mediumSeverityBlocked}
- Low: ${metrics.lowSeverityBlocked}

Top Attack Vectors:
${metrics.topAttackVectors.map((v, i) =>
  `${i + 1}. ${v.type} (${v.count} attempts, severity: ${v.severity})`
).join('\n')}

Hourly Distribution (last 24h):
${metrics.attacksPerHour.map((count, i) =>
  `Hour ${23 - i}: ${count} attacks`
).join(', ')}
`;

    return report;
  }

  /**
   * Clear old telemetry data
   */
  static clearOldData(daysToKeep: number = 30): void {
    if (daysToKeep === 0) {
      // Clear all data immediately
      this.attackHistory = [];
      this.attackVectorMap.clear();
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.toISOString();

    const index = this.attackHistory.findIndex(
      attack => attack.timestamp >= cutoffTimestamp
    );

    if (index > 0) {
      this.attackHistory.splice(0, index);
    }

    // Clean up old vectors that haven't been seen recently
    for (const [key, vector] of this.attackVectorMap.entries()) {
      if (new Date(vector.lastSeen) < cutoffDate) {
        this.attackVectorMap.delete(key);
      }
    }
  }

  /**
   * Export telemetry data for external analysis
   */
  static exportData(): {
    history: AttackTelemetryEntry[];
    vectors: AttackVector[];
    metrics: SecurityMetrics;
  } {
    return {
      history: [...this.attackHistory],
      vectors: Array.from(this.attackVectorMap.values()),
      metrics: this.getMetrics()
    };
  }
}