export type OperationHealthComponent =
  | 'database'
  | 'auth_server'
  | 'gatekeeper'
  | 'runtime_control'
  | 'security_invalidation'
  | 'api_mount';

export type OperationHealthStatus = 'ok' | 'degraded' | 'unavailable' | 'not_ready';

export interface OperationHealthComponentDto {
  readonly component: OperationHealthComponent;
  readonly status: OperationHealthStatus;
  readonly checked_at: string;
  readonly failure_codes: readonly string[];
}

export interface OperationHealthSummaryDto {
  readonly status: OperationHealthStatus;
  readonly checked_at: string;
  readonly components: readonly OperationHealthComponentDto[];
}

export type OperationLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OperationalLogDto {
  readonly ts: string;
  readonly level: OperationLogLevel;
  readonly subsystem: string;
  readonly event: string;
  readonly correlation_id: string | null;
  readonly account_correlation_id: string | null;
  readonly session_id: string | null;
  readonly replica: string;
  readonly duration_ms: number | null;
  readonly status_code: number | null;
  readonly error_code: string | null;
}

export interface OperationalLogPageDto {
  readonly items: readonly OperationalLogDto[];
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly next_cursor: string | null;
  };
}

export type OperationalMetricKind = 'counter' | 'gauge' | 'histogram';

export interface OperationalMetricDto {
  readonly name: string;
  readonly kind: OperationalMetricKind;
  readonly value: number;
  readonly unit: string;
  readonly dimensions: {
    readonly subsystem?: string;
    readonly event?: string;
    readonly status_family?: string;
    readonly error_code?: string;
    readonly replica?: string;
    readonly transport?: string;
    readonly latency_bucket?: string;
    readonly account_correlation_id?: string;
  };
}

export interface OperationalMetricResponseDto {
  readonly checked_at: string;
  readonly metrics: readonly OperationalMetricDto[];
}

export type OperatorConfigSensitivity = 'public_admin' | 'secret_write_only';
export type OperatorConfigMutability = 'dynamic' | 'restart_required' | 'read_only';
export type OperatorConfigSchemaType = 'boolean' | 'integer' | 'number' | 'string' | 'object';

export interface OperatorConfigValueSchemaDto {
  readonly type: OperatorConfigSchemaType;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly min_length?: number;
  readonly max_length?: number;
}

export interface OperatorConfigSettingDto {
  readonly key: string;
  readonly schema_version: number;
  readonly sensitivity: OperatorConfigSensitivity;
  readonly mutability: OperatorConfigMutability;
  readonly value_schema: OperatorConfigValueSchemaDto;
  readonly effective_at: string | null;
  readonly pending_restart: boolean;
  readonly etag: string;
  readonly value?: unknown;
  readonly configured?: boolean;
}

export interface OperatorConfigListDto {
  readonly items: readonly OperatorConfigSettingDto[];
}

/**
 * System metrics (System A) — the in-process operational metrics snapshots from
 * MemoryMetricsSink, projected for the admin Metrics surface. System-wide
 * aggregates (counters/gauges/histograms by source), NOT per-session.
 */
export type SystemMetricType = 'counter' | 'gauge' | 'histogram';

export interface SystemHistogramValueDto {
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

export interface SystemMetricEntryDto {
  readonly name: string;
  readonly source: string;
  readonly unit: string;
  readonly type: SystemMetricType;
  readonly value: number | SystemHistogramValueDto;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface SystemMetricSnapshotDto {
  readonly id: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  readonly metrics: readonly SystemMetricEntryDto[];
  readonly errors: readonly string[];
}

export interface SystemMetricsResponseDto {
  readonly snapshots: readonly SystemMetricSnapshotDto[];
  readonly total: number;
  readonly has_more: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly oldest_available: string;
  readonly newest_available: string;
}
