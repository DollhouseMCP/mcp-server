/**
 * Central coordinator for the Metrics Collection System.
 *
 * Registers collectors and sinks, runs periodic collection cycles,
 * assembles immutable MetricSnapshot objects, and dispatches them
 * to all registered sinks.
 */

import type { ILogger } from '../types/ILogger.js';
import type {
  IMetricCollector,
  IMetricsSink,
  MetricEntry,
  MetricSnapshot,
  MetricsManagerConfig,
} from './types.js';

interface CollectorRecord {
  collector: IMetricCollector;
  consecutiveFailures: number;
  disabled: boolean;
}

export class MetricsManager {
  private readonly collectors: CollectorRecord[] = [];
  private readonly sinks: IMetricsSink[] = [];
  private readonly config: MetricsManagerConfig;
  private readonly logger: ILogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotCounter = 0;
  private collectionsCompleted = 0;
  private collectorErrorsTotal = 0;
  private sinkErrorsTotal = 0;
  private lastCollectionDurationMs = 0;
  private closed = false;
  private readonly processStartTime: string;

  constructor(config: MetricsManagerConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
    this.processStartTime = new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  registerCollector(collector: IMetricCollector): void {
    this.assertOpen();
    this.collectors.push({
      collector,
      consecutiveFailures: 0,
      disabled: false,
    });
  }

  registerSink(sink: IMetricsSink): void {
    this.assertOpen();
    this.sinks.push(sink);
  }

  start(): void {
    this.assertOpen();
    if (this.timer !== null) {
      this.logger.warn('MetricsManager.start() called but timer already running');
      return;
    }

    if (this.config.collectionIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.collectNow();
      }, this.config.collectionIntervalMs);

      // Allow the process to exit even if the timer is still running
      if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
        this.timer.unref();
      }
    }
  }

  async collectNow(): Promise<MetricSnapshot> {
    this.assertOpen();

    const startTime = performance.now();
    const { entries, errors } = await this.collectFromCollectors();
    entries.push(...this.buildSelfMonitoringMetrics());

    const durationMs = performance.now() - startTime;
    const snapshot: MetricSnapshot = {
      id: `SNAP-${Date.now()}-${this.snapshotCounter++}`,
      timestamp: new Date().toISOString(),
      metrics: entries,
      errors,
      durationMs,
    };

    this.warnIfOversized(snapshot);
    this.warnIfSlow(snapshot, durationMs);
    this.deepFreezeSnapshot(snapshot);
    this.dispatchToSinks(snapshot);

    this.collectionsCompleted++;
    this.lastCollectionDurationMs = durationMs;

    return snapshot;
  }

  private async collectFromCollectors(): Promise<{ entries: MetricEntry[]; errors: string[] }> {
    const entries: MetricEntry[] = [];
    const errors: string[] = [];

    for (const record of this.collectors) {
      if (record.disabled) continue;

      try {
        const result = await Promise.resolve(record.collector.collect());
        record.consecutiveFailures = 0;
        entries.push(...result);
      } catch (err) {
        record.consecutiveFailures++;
        this.collectorErrorsTotal++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${record.collector.name}: ${message}`);

        this.logger.warn(
          `Collector "${record.collector.name}" failed (${record.consecutiveFailures}/${this.config.collectorFailureThreshold})`,
          { error: message },
        );

        if (record.consecutiveFailures >= this.config.collectorFailureThreshold) {
          record.disabled = true;
          this.logger.error(
            `Collector "${record.collector.name}" disabled after ${record.consecutiveFailures} consecutive failures`,
          );
        }
      }
    }

    return { entries, errors };
  }

  private warnIfOversized(snapshot: MetricSnapshot): void {
    const serializedSize = JSON.stringify(snapshot).length;
    if (serializedSize > this.config.maxSnapshotSize) {
      this.logger.warn(
        `Snapshot size ${serializedSize} bytes exceeds limit ${this.config.maxSnapshotSize}`,
        { snapshotId: snapshot.id, size: serializedSize },
      );
    }
  }

  private warnIfSlow(snapshot: MetricSnapshot, durationMs: number): void {
    if (durationMs > this.config.collectionDurationWarnMs && this.collectionsCompleted >= 3) {
      this.logger.warn(
        `Collection took ${durationMs.toFixed(1)}ms (threshold: ${this.config.collectionDurationWarnMs}ms)`,
        { snapshotId: snapshot.id },
      );
    }
  }

  private deepFreezeSnapshot(snapshot: MetricSnapshot): void {
    Object.freeze(snapshot.metrics);
    for (const entry of snapshot.metrics) {
      if (entry.value !== null && typeof entry.value === 'object') {
        Object.freeze(entry.value);
      }
      Object.freeze(entry);
    }
    Object.freeze(snapshot.errors);
    Object.freeze(snapshot);
  }

  private dispatchToSinks(snapshot: MetricSnapshot): void {
    for (const sink of this.sinks) {
      try {
        sink.onSnapshot(snapshot);
      } catch (err) {
        this.sinkErrorsTotal++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Sink "${sink.name}" failed: ${message}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;

    // Stop timer
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Final collection
    await this.collectNow();

    // Set closed AFTER final collection
    this.closed = true;

    // Flush and close all sinks
    await Promise.allSettled(this.sinks.map(s => s.flush()));
    await Promise.allSettled(this.sinks.map(s => s.close()));
  }

  getManagerStats(): {
    collectionsCompleted: number;
    collectorErrorsTotal: number;
    sinkErrorsTotal: number;
    lastCollectionDurationMs: number;
    collectorsRegistered: number;
    sinksRegistered: number;
    disabledCollectors: number;
    processStartTime: string;
  } {
    return {
      collectionsCompleted: this.collectionsCompleted,
      collectorErrorsTotal: this.collectorErrorsTotal,
      sinkErrorsTotal: this.sinkErrorsTotal,
      lastCollectionDurationMs: this.lastCollectionDurationMs,
      collectorsRegistered: this.collectors.length,
      sinksRegistered: this.sinks.length,
      disabledCollectors: this.collectors.filter(r => r.disabled).length,
      processStartTime: this.processStartTime,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('MetricsManager is closed');
    }
  }

  private buildSelfMonitoringMetrics(): MetricEntry[] {
    const source = 'MetricsManager';
    const unit = 'count' as const;

    return [
      {
        type: 'gauge' as const,
        name: 'metrics.manager.collectors_registered',
        source,
        unit,
        value: this.collectors.length,
      },
      {
        type: 'gauge' as const,
        name: 'metrics.manager.sinks_registered',
        source,
        unit,
        value: this.sinks.length,
      },
      {
        type: 'counter' as const,
        name: 'metrics.manager.collector_errors_total',
        source,
        unit,
        value: this.collectorErrorsTotal,
      },
      {
        type: 'counter' as const,
        name: 'metrics.manager.sink_errors_total',
        source,
        unit,
        value: this.sinkErrorsTotal,
      },
      {
        type: 'gauge' as const,
        name: 'metrics.manager.last_collection_duration_ms',
        source,
        unit: 'milliseconds' as const,
        value: this.lastCollectionDurationMs,
      },
      {
        type: 'counter' as const,
        name: 'metrics.manager.snapshots_taken_total',
        source,
        unit,
        value: this.snapshotCounter,
      },
      {
        type: 'gauge' as const,
        name: 'metrics.manager.disabled_collectors',
        source,
        unit,
        value: this.collectors.filter(r => r.disabled).length,
      },
    ];
  }
}
