import type {
  OperationHealthComponentDto,
  OperationHealthSummaryDto,
  OperatorConfigListDto,
  OperatorConfigSettingDto,
  OperationalLogDto,
  OperationalLogPageDto,
  OperationalMetricDto,
  OperationalMetricResponseDto,
  SystemHistogramValueDto,
  SystemMetricEntryDto,
  SystemMetricSnapshotDto,
  SystemMetricsResponseDto,
  SystemMetricType,
} from './OperationsDtos.js';
import {
  arrayValue,
  nullableNumberField,
  nullableStringField,
  numberField,
  objectValue,
  optionalStringField,
  stringField,
  type UnknownRecord,
} from '../../platform/ConsoleProjectorHelpers.js';

export function projectOperationHealthSummary(value: unknown): OperationHealthSummaryDto {
  const record = objectValue(value);
  return {
    status: healthStatusField(record, 'status'),
    checked_at: stringField(record, 'checked_at'),
    components: arrayValue(record.components).map(item => projectOperationHealthComponent(item)),
  };
}

export function projectOperationHealthComponent(value: unknown): OperationHealthComponentDto {
  const record = objectValue(value);
  return {
    component: componentField(record, 'component'),
    status: healthStatusField(record, 'status'),
    checked_at: stringField(record, 'checked_at'),
    failure_codes: arrayValue(record.failure_codes).filter((item): item is string => typeof item === 'string'),
  };
}

export function projectOperationalLogs(value: unknown): OperationalLogPageDto {
  const record = objectValue(value);
  const page = objectValue(record.page);
  return {
    items: arrayValue(record.items).map(item => projectOperationalLog(item)),
    page: {
      limit: numberField(page, 'limit'),
      cursor: nullableStringField(page, 'cursor'),
      next_cursor: nullableStringField(page, 'next_cursor'),
    },
  };
}

export function projectOperationalMetrics(value: unknown): OperationalMetricResponseDto {
  const record = objectValue(value);
  return {
    checked_at: stringField(record, 'checked_at'),
    metrics: arrayValue(record.metrics).map(item => projectOperationalMetric(item)),
  };
}

export function projectOperatorConfigList(value: unknown): OperatorConfigListDto {
  const record = objectValue(value);
  return {
    items: arrayValue(record.items).map(item => projectOperatorConfigSetting(item)),
  };
}

export function projectOperatorConfigSetting(value: unknown): OperatorConfigSettingDto {
  const record = objectValue(value);
  const sensitivity = configSensitivityField(record, 'sensitivity');
  const base = {
    key: stringField(record, 'key'),
    schema_version: numberField(record, 'schema_version'),
    sensitivity,
    mutability: configMutabilityField(record, 'mutability'),
    value_schema: projectValueSchema(record.value_schema),
    effective_at: nullableStringField(record, 'effective_at'),
    pending_restart: record.pending_restart === true,
    etag: stringField(record, 'etag'),
  };
  if (sensitivity === 'secret_write_only') {
    return {
      ...base,
      configured: record.configured === true,
    };
  }
  return {
    ...base,
    value: cloneAllowedValue(record.value),
  };
}

export function projectOperationalLog(value: unknown): OperationalLogDto {
  const record = objectValue(value);
  return {
    ts: stringField(record, 'ts'),
    level: logLevelField(record, 'level'),
    subsystem: stringField(record, 'subsystem'),
    event: stringField(record, 'event'),
    correlation_id: nullableStringField(record, 'correlation_id'),
    account_correlation_id: nullableStringField(record, 'account_correlation_id'),
    session_id: nullableStringField(record, 'session_id'),
    replica: stringField(record, 'replica'),
    duration_ms: nullableNumberField(record, 'duration_ms'),
    status_code: nullableNumberField(record, 'status_code'),
    error_code: nullableStringField(record, 'error_code'),
  };
}

export function projectOperationalMetric(value: unknown): OperationalMetricDto {
  const record = objectValue(value);
  const dimensions = objectValue(record.dimensions);
  return {
    name: stringField(record, 'name'),
    kind: metricKindField(record, 'kind'),
    value: numberField(record, 'value'),
    unit: stringField(record, 'unit'),
    dimensions: {
      ...optionalString(dimensions, 'subsystem'),
      ...optionalString(dimensions, 'event'),
      ...optionalString(dimensions, 'status_family'),
      ...optionalString(dimensions, 'error_code'),
      ...optionalString(dimensions, 'replica'),
      ...optionalString(dimensions, 'transport'),
      ...optionalString(dimensions, 'latency_bucket'),
      ...optionalString(dimensions, 'account_correlation_id'),
    },
  };
}

function projectValueSchema(value: unknown): OperatorConfigSettingDto['value_schema'] {
  const record = objectValue(value);
  return {
    type: schemaTypeField(record, 'type'),
    ...optionalNumber(record, 'minimum'),
    ...optionalNumber(record, 'maximum'),
    ...optionalNumber(record, 'min_length'),
    ...optionalNumber(record, 'max_length'),
  };
}

function optionalString(record: UnknownRecord, key: string): Record<string, string> {
  return optionalStringField(record, key);
}

function optionalNumber(record: UnknownRecord, key: string): Record<string, number> {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function componentField(record: UnknownRecord, key: string): OperationHealthComponentDto['component'] {
  const value = record[key];
  if (
    value === 'database' ||
    value === 'auth_server' ||
    value === 'gatekeeper' ||
    value === 'runtime_control' ||
    value === 'security_invalidation' ||
    value === 'api_mount'
  ) {
    return value;
  }
  return 'api_mount';
}

function healthStatusField(record: UnknownRecord, key: string): OperationHealthComponentDto['status'] {
  const value = record[key];
  if (value === 'ok' || value === 'degraded' || value === 'unavailable' || value === 'not_ready') return value;
  return 'unavailable';
}

function logLevelField(record: UnknownRecord, key: string): OperationalLogDto['level'] {
  const value = record[key];
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function metricKindField(record: UnknownRecord, key: string): OperationalMetricDto['kind'] {
  const value = record[key];
  if (value === 'counter' || value === 'gauge' || value === 'histogram') return value;
  return 'gauge';
}

function configSensitivityField(record: UnknownRecord, key: string): OperatorConfigSettingDto['sensitivity'] {
  const value = record[key];
  return value === 'secret_write_only' ? value : 'public_admin';
}

function configMutabilityField(record: UnknownRecord, key: string): OperatorConfigSettingDto['mutability'] {
  const value = record[key];
  if (value === 'dynamic' || value === 'restart_required' || value === 'read_only') return value;
  return 'read_only';
}

function schemaTypeField(record: UnknownRecord, key: string): OperatorConfigSettingDto['value_schema']['type'] {
  const value = record[key];
  if (value === 'boolean' || value === 'integer' || value === 'number' || value === 'string' || value === 'object') {
    return value;
  }
  return 'object';
}

function cloneAllowedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(cloneAllowedValue);
  if (value && typeof value === 'object') return structuredClone(value);
  return null;
}

// System metrics (System A): explicit field allowlist at the trust boundary.
// Snapshots carry name/source/unit/type/value (+ optional labels); nothing else
// is forwarded.
export function projectSystemMetrics(value: unknown): SystemMetricsResponseDto {
  const record = objectValue(value);
  return {
    snapshots: arrayValue(record.snapshots).map(projectSystemMetricSnapshot),
    total: numberField(record, 'total'),
    has_more: record.hasMore === true,
    limit: numberField(record, 'limit'),
    offset: numberField(record, 'offset'),
    oldest_available: stringField(record, 'oldestAvailable'),
    newest_available: stringField(record, 'newestAvailable'),
  };
}

function projectSystemMetricSnapshot(value: unknown): SystemMetricSnapshotDto {
  const record = objectValue(value);
  return {
    id: stringField(record, 'id'),
    timestamp: stringField(record, 'timestamp'),
    duration_ms: numberField(record, 'durationMs'),
    metrics: arrayValue(record.metrics).map(projectSystemMetricEntry),
    errors: arrayValue(record.errors).filter((e): e is string => typeof e === 'string'),
  };
}

function projectSystemMetricEntry(value: unknown): SystemMetricEntryDto {
  const record = objectValue(value);
  const type = systemMetricTypeField(record, 'type');
  return {
    name: stringField(record, 'name'),
    source: stringField(record, 'source'),
    unit: stringField(record, 'unit'),
    type,
    value: type === 'histogram' ? projectHistogram(record.value) : numberField(record, 'value'),
    ...projectMetricLabels(record.labels),
  };
}

function projectHistogram(value: unknown): SystemHistogramValueDto {
  const record = objectValue(value);
  return {
    count: numberField(record, 'count'),
    sum: numberField(record, 'sum'),
    ...numericOptional(record, 'min'),
    ...numericOptional(record, 'max'),
    ...numericOptional(record, 'avg'),
    ...numericOptional(record, 'p50'),
    ...numericOptional(record, 'p75'),
    ...numericOptional(record, 'p90'),
    ...numericOptional(record, 'p95'),
    ...numericOptional(record, 'p99'),
  };
}

function numericOptional<K extends string>(record: UnknownRecord, key: K): Partial<Record<K, number>> {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } as Record<K, number> : {};
}

function projectMetricLabels(value: unknown): { labels?: Record<string, string> } {
  if (!value || typeof value !== 'object') return {};
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') labels[key] = raw;
  }
  return Object.keys(labels).length > 0 ? { labels } : {};
}

function systemMetricTypeField(record: UnknownRecord, key: string): SystemMetricType {
  const value = record[key];
  return value === 'counter' || value === 'gauge' || value === 'histogram' ? value : 'gauge';
}
