import type { ConsolePageInfo } from '../../platform/ConsolePlatformTypes.js';
import type {
  RuntimeSessionAccountDto,
  RuntimeSessionOperationalDto,
  RuntimeSessionOperationalListDto,
  RuntimeSessionRevokeAllDto,
  RuntimeSessionSelfDto,
  RuntimeTerminationAcceptedDto,
  RuntimeTerminationCommandStatusDto,
} from './RuntimeSessionDtos.js';
import { isRuntimeTerminationReason } from '../../services/runtime/IRuntimeSessionControlStore.js';

const COMMAND_STATUS_VALUES = new Set<RuntimeTerminationCommandStatusDto['status']>([
  'pending', 'terminated', 'already_absent', 'failed',
]);

export function projectRuntimeSessionSelf(value: unknown): RuntimeSessionSelfDto {
  const record = objectValue(value);
  return {
    session_id: stringField(record, 'session_id'),
    transport: 'streamable-http',
    client_info: clientInfoField(record),
    created_at: stringField(record, 'created_at'),
    last_active_at: stringField(record, 'last_active_at'),
    request_count: numberField(record, 'request_count'),
    error_count: numberField(record, 'error_count'),
    status: 'active',
  };
}

// List envelopes: the snapshot family (`{sessions: [...]}`) — never a bare
// array, so the shape can grow (e.g. a reserved `pagination` member) without
// breaking consumers.
export function projectRuntimeSessionSelfList(value: unknown): { sessions: RuntimeSessionSelfDto[] } {
  return { sessions: arrayValue(objectValue(value).sessions).map(item => projectRuntimeSessionSelf(item)) };
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

export function projectRuntimeSessionAccountList(value: unknown): { sessions: RuntimeSessionAccountDto[] } {
  return { sessions: arrayValue(objectValue(value).sessions).map(item => projectRuntimeSessionAccount(item)) };
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

// Family-B cursor page (cross-user aggregate scales with the session population).
export function projectRuntimeSessionOperationalList(value: unknown): RuntimeSessionOperationalListDto {
  const record = objectValue(value);
  return {
    items: arrayValue(record.items).map(item => projectRuntimeSessionOperational(item)),
    page: projectConsolePageInfo(record.page),
  };
}

export function projectRuntimeCommandStatus(value: unknown): RuntimeTerminationCommandStatusDto {
  const record = objectValue(value);
  const status = record.status;
  const projectedStatus = typeof status === 'string' && COMMAND_STATUS_VALUES.has(status as RuntimeTerminationCommandStatusDto['status'])
    ? status as RuntimeTerminationCommandStatusDto['status']
    : 'pending';
  return {
    command_id: stringField(record, 'command_id'),
    status: projectedStatus,
    acknowledged_at: nullableStringField(record, 'acknowledged_at'),
    replica_id: nullableStringField(record, 'replica_id'),
    error_code: nullableStringField(record, 'error_code'),
  };
}

function projectConsolePageInfo(value: unknown): ConsolePageInfo {
  const page = objectValue(value);
  return {
    limit: numberField(page, 'limit'),
    cursor: nullableStringField(page, 'cursor'),
    next_cursor: nullableStringField(page, 'next_cursor'),
  };
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
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
