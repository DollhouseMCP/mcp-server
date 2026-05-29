import type {
  OperationHealthComponentDto,
  OperationHealthSummaryDto,
  OperationalLogDto,
  OperationalLogPageDto,
  OperationalMetricDto,
  OperationalMetricResponseDto,
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

function projectOperationalLog(value: unknown): OperationalLogDto {
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

function projectOperationalMetric(value: unknown): OperationalMetricDto {
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

function optionalString(record: UnknownRecord, key: string): Record<string, string> {
  return optionalStringField(record, key);
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
