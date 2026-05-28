import type {
  RuntimeSessionAccountDto,
  RuntimeSessionOperationalDto,
  RuntimeSessionRevokeAllDto,
  RuntimeSessionSelfDto,
  RuntimeTerminationAcceptedDto,
} from './RuntimeSessionDtos.js';
import { isRuntimeTerminationReason } from '../../services/runtime/IRuntimeSessionControlStore.js';

export function projectRuntimeSessionSelf(value: unknown): RuntimeSessionSelfDto {
  const record = objectValue(value);
  return {
    session_id: stringField(record, 'session_id'),
    transport: 'streamable-http',
    client_info: clientInfoField(record),
    created_at: stringField(record, 'created_at'),
    last_active_at: stringField(record, 'last_active_at'),
    status: 'active',
  };
}

export function projectRuntimeSessionSelfList(value: unknown): RuntimeSessionSelfDto[] {
  return arrayValue(value).map(item => projectRuntimeSessionSelf(item));
}

export function projectRuntimeSessionAccount(value: unknown): RuntimeSessionAccountDto {
  const record = objectValue(value);
  return {
    session_id: stringField(record, 'session_id'),
    transport: 'streamable-http',
    created_at: stringField(record, 'created_at'),
    last_active_at: stringField(record, 'last_active_at'),
    status: 'active',
  };
}

export function projectRuntimeSessionAccountList(value: unknown): RuntimeSessionAccountDto[] {
  return arrayValue(value).map(item => projectRuntimeSessionAccount(item));
}

export function projectRuntimeSessionOperational(value: unknown): RuntimeSessionOperationalDto {
  const record = objectValue(value);
  return {
    ...projectRuntimeSessionAccount(record),
    account_correlation_id: stringField(record, 'account_correlation_id'),
    replica_id: stringField(record, 'replica_id'),
    request_count: numberField(record, 'request_count'),
    error_count: numberField(record, 'error_count'),
    lease_until: stringField(record, 'lease_until'),
    client_info: clientInfoField(record),
  };
}

export function projectRuntimeSessionOperationalList(value: unknown): RuntimeSessionOperationalDto[] {
  return arrayValue(value).map(item => projectRuntimeSessionOperational(item));
}

export function projectRuntimeTermination(value: unknown): RuntimeTerminationAcceptedDto {
  const record = objectValue(value);
  return {
    session_id: stringField(record, 'session_id'),
    command_id: stringField(record, 'command_id'),
    target_replica_id: stringField(record, 'target_replica_id'),
    reason: terminationReasonField(record),
    status: 'accepted',
  };
}

export function projectRuntimeRevokeAll(value: unknown): RuntimeSessionRevokeAllDto {
  const record = objectValue(value);
  return {
    user_id: stringField(record, 'user_id'),
    requested: numberField(record, 'requested'),
    commands: arrayValue(record.commands).map(item => projectRuntimeTermination(item)),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clientInfoField(record: Record<string, unknown>): RuntimeSessionSelfDto['client_info'] {
  const clientInfo = objectValue(record.client_info);
  const name = stringField(clientInfo, 'name');
  const version = stringField(clientInfo, 'version');
  return name || version
    ? {
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
      }
    : null;
}

function terminationReasonField(record: Record<string, unknown>): RuntimeTerminationAcceptedDto['reason'] {
  const value = record.reason;
  if (typeof value === 'string' && isRuntimeTerminationReason(value)) {
    return value;
  }
  throw new Error('Runtime termination response carried an unknown reason');
}
