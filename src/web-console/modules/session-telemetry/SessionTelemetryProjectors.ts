import {
  arrayValue,
  nullableStringField,
  numberField,
  objectValue,
  stringField,
  type UnknownRecord,
} from '../../platform/ConsoleProjectorHelpers.js';
import type {
  UserActivityDto,
  UserActivityPageDto,
  UserMetricDto,
  UserMetricResponseDto,
} from './SessionTelemetryDtos.js';

export function projectUserActivityPage(value: unknown): UserActivityPageDto {
  const record = objectValue(value);
  const page = objectValue(record.page);
  return {
    items: arrayValue(record.items).map(item => projectUserActivity(item)),
    page: {
      limit: numberField(page, 'limit'),
      cursor: nullableStringField(page, 'cursor'),
      next_cursor: nullableStringField(page, 'next_cursor'),
    },
  };
}

export function projectUserActivity(value: unknown): UserActivityDto {
  const record = objectValue(value);
  return {
    ts: stringField(record, 'ts'),
    session_id: stringField(record, 'session_id'),
    level: userActivityLevelField(record, 'level'),
    subsystem: stringField(record, 'subsystem'),
    event: stringField(record, 'event'),
    message: nullableStringField(record, 'message'),
    correlation_id: nullableStringField(record, 'correlation_id'),
    stable_error_code: nullableStringField(record, 'stable_error_code'),
  };
}

export function projectUserMetrics(value: unknown): UserMetricResponseDto {
  const record = objectValue(value);
  return {
    checked_at: stringField(record, 'checked_at'),
    metrics: arrayValue(record.metrics).map(item => projectUserMetric(item)),
  };
}

export function projectUserMetric(value: unknown): UserMetricDto {
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
      ...optionalString(dimensions, 'transport'),
      ...optionalString(dimensions, 'latency_bucket'),
    },
  };
}

function userActivityLevelField(record: UnknownRecord, key: string): UserActivityDto['level'] {
  const value = record[key];
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function metricKindField(record: UnknownRecord, key: string): UserMetricDto['kind'] {
  const value = record[key];
  if (value === 'counter' || value === 'gauge' || value === 'histogram') return value;
  return 'gauge';
}

function optionalString(record: UnknownRecord, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === 'string' ? { [key]: value } : {};
}
