/**
 * Security Telemetry for DollhouseMCP
 *
 * Tracks and aggregates security metrics for blocked attacks,
 * providing insights into threat patterns and system defense effectiveness.
 *
 * Issue #1269: Enhanced telemetry for memory injection protection
 *
 * REFACTOR NOTE:
 * Converted from static class to instance-based for DI architecture compatibility.
 * Security Telemetry is now a singleton service managed by the DI container.
 */

import { SecurityEvent } from '../securityMonitor.js';
import { EvictingQueue } from '../../utils/EvictingQueue.js';
import { EventDeduplicator } from '../../utils/EventDeduplicator.js';

export interface AttackVector {
  type: string;
  count: number;
  lastSeen: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  blockedPatterns: string[];
}

export interface DeduplicationStats {
  /** Number of repeated events that were suppressed */
  suppressedEvents: number;
  /** Number of unique events that passed through */
  uniqueEvents: number;
  /** Current number of keys in the dedup cache */
  cacheSize: number;
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
  deduplication: DeduplicationStats;
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

/** Deduplication window: suppress identical log listener calls within this period */
const DEDUP_WINDOW_MS = 60_000;

/** Maximum dedup cache entries before LRU eviction */
const DEDUP_MAX_SIZE = 500;

/**
 * Security Telemetry Service
 *
 * DI-COMPATIBLE: Instance-based service for dependency injection.
 * Tracks security events, attack patterns, and generates metrics.
 */
export class SecurityTelemetry {
  private attackHistory = new EvictingQueue<AttackTelemetryEntry>(10000);
  private readonly METRIC_WINDOW_HOURS = 24; // Track last 24 hours
  private readonly attackVectorMap: Map<string, AttackVector> = new Map();
  private logListener?: (entry: AttackTelemetryEntry) => void;
  private readonly logDedup = new EventDeduplicator(DEDUP_WINDOW_MS, DEDUP_MAX_SIZE);

  addLogListener(fn: (entry: AttackTelemetryEntry) => void): () => void {
    this.logListener = fn;
    return () => { this.logListener = undefined; };
  }

  /**
   * Create a new SecurityTelemetry instance
   */
  constructor() {
    // Instance initialization
  }

  /**
   * Records a blocked attack attempt
   * FIX (PR #1313 review): Use UTC timestamps for consistency across timezones
   */
  recordBlockedAttack(
    attackType: string,
    pattern: string,
    severity: SecurityEvent['severity'],
    source: string,
    metadata?: Record<string, any>
  ): void {
    const entry: AttackTelemetryEntry = {
      timestamp: new Date().toISOString(), // ISO string is always UTC
      attackType,
      pattern,
      severity,
      source,
      blocked: true,
      metadata
    };

    // Bounded FIFO eviction — EvictingQueue handles capacity
    this.attackHistory.push(entry);

    // Deduplicate log listener calls — same attackType+pattern within 60s = suppress
    if (!this.logDedup.shouldSuppress(`${attackType}\0${pattern}`)) {
      this.logListener?.(entry);
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
  getMetrics(): SecurityMetrics {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.METRIC_WINDOW_HOURS * 60 * 60 * 1000);

    // Filter to recent attacks
    const recentAttacks = this.attackHistory.toArray().filter(
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
    // FIX (PR #1313 review): Ensure consistent UTC timezone handling for metrics
    const attacksPerHour: number[] = new Array(24).fill(0);
    const nowUTC = Date.now(); // Unix timestamp in UTC
    for (const attack of recentAttacks) {
      // attack.timestamp is ISO string (UTC), parse to get UTC time
      const attackTimeUTC = new Date(attack.timestamp).getTime();
      const hoursAgo = Math.floor((nowUTC - attackTimeUTC) / (60 * 60 * 1000));
      if (hoursAgo >= 0 && hoursAgo < 24) {
        attacksPerHour[23 - hoursAgo]++;
      }
    }

    // Get top attack vectors
    const vectorArray = Array.from(this.attackVectorMap.values());
    // FIX: Create copy before sorting to avoid mutation (SonarCloud S4043)
    const topVectors = [...vectorArray]
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
      deduplication: this.getDeduplicationStats(),
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Returns deduplication statistics for observability.
   * Tracks how many repeated log listener calls were suppressed
   * vs. how many unique events passed through.
   */
  getDeduplicationStats(): DeduplicationStats {
    const stats = this.logDedup.getStats();
    return {
      suppressedEvents: stats.suppressedCount,
      uniqueEvents: stats.processedCount,
      cacheSize: stats.cacheSize,
    };
  }

  /**
   * Get attack patterns by type
   */
  getAttackPatternsByType(attackType: string): string[] {
    const patterns = new Set<string>();

    for (const attack of this.attackHistory.toArray()) {
      if (attack.attackType === attackType) {
        patterns.add(attack.pattern);
      }
    }

    return Array.from(patterns);
  }

  /**
   * Get attack timeline for visualization
   */
  getAttackTimeline(hours: number = 24): { hour: string; count: number; severity: Record<string, number> }[] {
    const now = new Date();
    const timeline: { hour: string; count: number; severity: Record<string, number> }[] = [];

    for (let i = hours - 1; i >= 0; i--) {
      const hourStart = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000);
      const hourEnd = new Date(now.getTime() - i * 60 * 60 * 1000);

      const hourAttacks = this.attackHistory.toArray().filter(attack => {
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
  generateReport(): string {
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

Deduplication:
- Suppressed (repeated): ${metrics.deduplication.suppressedEvents}
- Unique (passed through): ${metrics.deduplication.uniqueEvents}
- Cache entries: ${metrics.deduplication.cacheSize}

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
  clearOldData(daysToKeep: number = 30): void {
    if (daysToKeep === 0) {
      // Clear all data immediately
      this.attackHistory.clear();
      this.attackVectorMap.clear();
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.toISOString();

    const remaining = this.attackHistory.toArray().filter(
      attack => attack.timestamp >= cutoffTimestamp
    );
    this.attackHistory.reset([...remaining]);

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
  exportData(): {
    history: AttackTelemetryEntry[];
    vectors: AttackVector[];
    metrics: SecurityMetrics;
  } {
    return {
      history: this.attackHistory.toJSON(),
      vectors: Array.from(this.attackVectorMap.values()),
      metrics: this.getMetrics()
    };
  }

  /**
   * Dispose of the telemetry service and clean up resources
   * Implements cleanup for proper DI lifecycle management
   */
  async dispose(): Promise<void> {
    this.attackHistory.clear();
    this.attackVectorMap.clear();
  }
}
