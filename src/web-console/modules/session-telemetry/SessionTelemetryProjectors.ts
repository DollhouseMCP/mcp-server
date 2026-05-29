import {
  arrayValue,
  nullableStringField,
  numberField,
  objectValue,
  stringField,
  type UnknownRecord,
} from '../../platform/ConsoleProjectorHelpers.js';
import type { UserActivityDto, UserActivityPageDto } from './SessionTelemetryDtos.js';

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

function userActivityLevelField(record: UnknownRecord, key: string): UserActivityDto['level'] {
  const value = record[key];
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}
