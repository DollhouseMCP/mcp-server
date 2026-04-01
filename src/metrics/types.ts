/**
 * Core types for the Metrics Collection System.
 *
 * These types are shared across the MetricsManager, all sinks, and all collectors.
 */

// ---------------------------------------------------------------------------
// Metric type & unit
// ---------------------------------------------------------------------------

export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricUnit =
  | 'count'
  | 'bytes'
  | 'milliseconds'
  | 'seconds'
  | 'percent'
  | 'ratio'
  | 'operations'
  | 'megabytes'
  | 'none';

// ---------------------------------------------------------------------------
// Metric entries (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface BaseMetricEntry {
  readonly name: string;
  readonly source: string;
  readonly unit: MetricUnit;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface CounterEntry extends BaseMetricEntry {
  readonly type: 'counter';
  readonly value: number;
}

export interface GaugeEntry extends BaseMetricEntry {
  readonly type: 'gauge';
  readonly value: number;
}

export interface HistogramValue {
  readonly count: number;
  readonly sum: number;
  readonly min?: number;
  readonly max?: number;
  readonly avg?: number;
  readonly p50?: number;
  readonly p75?: number;
  readonly p90?: number;
  readonly p95?: number;
  readonly p99?: number;
}

export interface HistogramEntry extends BaseMetricEntry {
  readonly type: 'histogram';
  readonly value: HistogramValue;
}

export type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface MetricSnapshot {
  readonly id: string;
  readonly timestamp: string;
  readonly metrics: readonly MetricEntry[];
  readonly errors: readonly string[];
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Collector & Sink interfaces
// ---------------------------------------------------------------------------

export interface IMetricCollector {
  readonly name: string;
  readonly description: string;
  collect(): MetricEntry[] | Promise<MetricEntry[]>;
}

export interface IMetricsSink {
  readonly name: string;
  onSnapshot(snapshot: MetricSnapshot): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface MetricQueryOptions {
  names?: string[];
  source?: string;
  type?: MetricType;
  since?: string;
  until?: string;
  latest?: boolean;
  limit?: number;
  offset?: number;
}

export interface MetricQueryResult {
  readonly snapshots: readonly MetricSnapshot[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly oldestAvailable: string;
  readonly newestAvailable: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MetricsManagerConfig {
  readonly enabled: boolean;
  readonly collectionIntervalMs: number;
  readonly maxSnapshotSize: number;
  readonly collectorFailureThreshold: number;
  readonly collectionDurationWarnMs: number;
  readonly memorySnapshotCapacity: number;
}

// ---------------------------------------------------------------------------
// Helper: build config from env vars
// ---------------------------------------------------------------------------

/**
 * Map the flat env object (from Zod-parsed `process.env`) to a typed
 * `MetricsManagerConfig`. Keeps the mapping in one place so the DI container
 * only needs `buildMetricsManagerConfig(env)`.
 */
export function buildMetricsManagerConfig(envVars: {
  DOLLHOUSE_METRICS_ENABLED: boolean;
  DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS: number;
  DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE: number;
  DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD: number;
  DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS: number;
  DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY: number;
}): MetricsManagerConfig {
  return {
    enabled: envVars.DOLLHOUSE_METRICS_ENABLED,
    collectionIntervalMs: envVars.DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS,
    maxSnapshotSize: envVars.DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE,
    collectorFailureThreshold: envVars.DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD,
    collectionDurationWarnMs: envVars.DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS,
    memorySnapshotCapacity: envVars.DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY,
  };
}
