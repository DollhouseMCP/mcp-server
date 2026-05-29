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
