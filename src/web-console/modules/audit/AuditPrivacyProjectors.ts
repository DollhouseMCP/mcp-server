import type {
  AdminAuditEventDto,
  ApprovalAuditEventDto,
  AuditPageDto,
  AuthenticationAuditEventDto,
} from './AuditDtos.js';
import {
  arrayValue,
  nullableNumberField,
  nullableStringField,
  numberField,
  objectValue,
  stringField,
} from '../../platform/ConsoleProjectorHelpers.js';
import { CONSOLE_CAPABILITIES } from '../../platform/ConsolePlatformTypes.js';
import { CONSOLE_ADMIN_AUDIT_ROLES } from '../../audit/IAdminAuditWriter.js';
import type {
  ConsoleAdminActorRole,
  ConsoleAdminAuditResult,
  ConsoleAdminAuditRedactedRecord,
} from '../../audit/IAdminAuditWriter.js';
import type { ConsoleCapability } from '../../platform/ConsolePlatformTypes.js';

export function projectAdminAuditPage(value: unknown): AuditPageDto<AdminAuditEventDto> {
  return projectPage(value, projectAdminAuditEvent);
}

export function projectAdminAuditEvent(value: unknown): AdminAuditEventDto {
  const record = objectValue(value);
  return {
    id: stringField(record, 'id'),
    sequence_id: numberField(record, 'sequence_id'),
    occurred_at: stringField(record, 'occurred_at'),
    actor_user_id: stringField(record, 'actor_user_id'),
    actor_sub: stringField(record, 'actor_sub'),
    actor_role: actorRoleField(record, 'actor_role'),
    actor_capability_role: actorCapabilityRoleField(record, 'actor_capability_role'),
    actor_console_session_hash: stringField(record, 'actor_console_session_hash'),
    capability: capabilityField(record, 'capability'),
    elevation_acr: nullableStringField(record, 'elevation_acr'),
    elevation_amr: stringArrayField(record, 'elevation_amr'),
    elevation_auth_time: nullableIntegerField(record, 'elevation_auth_time'),
    correlation_id: stringField(record, 'correlation_id'),
    endpoint: stringField(record, 'endpoint'),
    operation: stringField(record, 'operation'),
    resource_kind: nullableStringField(record, 'resource_kind'),
    resource_id: nullableStringField(record, 'resource_id'),
    target_user_id: nullableStringField(record, 'target_user_id'),
    args_redacted: jsonRecordField(record, 'args_redacted'),
    result: auditResultField(record, 'result'),
    error_code: nullableStringField(record, 'error_code'),
    result_detail_redacted: nullableJsonRecordField(record, 'result_detail_redacted'),
    client_ip: nullableStringField(record, 'client_ip'),
    user_agent: nullableStringField(record, 'user_agent'),
    chain_key_id: stringField(record, 'chain_key_id'),
    chain_prev: nullableStringField(record, 'chain_prev'),
    chain_hmac: stringField(record, 'chain_hmac'),
    integrity: adminIntegrityField(record),
  };
}

export function projectApprovalAuditPage(value: unknown): AuditPageDto<ApprovalAuditEventDto> {
  return projectPage(value, projectApprovalAuditEvent);
}

export function projectApprovalAuditEvent(value: unknown): ApprovalAuditEventDto {
  const record = objectValue(value);
  const integrity = objectValue(record.integrity);
  return {
    id: stringField(record, 'id'),
    occurred_at: stringField(record, 'occurred_at'),
    account_correlation_id: stringField(record, 'account_correlation_id'),
    session_id: stringField(record, 'session_id'),
    tool_name: stringField(record, 'tool_name'),
    operation: nullableStringField(record, 'operation'),
    result: stringField(record, 'result'),
    decision_source: nullableStringField(record, 'decision_source'),
    correlation_id: nullableStringField(record, 'correlation_id'),
    integrity: {
      status: integrity.status === 'verified' ? 'verified' : 'not_available',
      chain_key_id: nullableStringField(integrity, 'chain_key_id'),
      chain_prev: nullableStringField(integrity, 'chain_prev'),
      chain_hmac: nullableStringField(integrity, 'chain_hmac'),
    },
  };
}

export function projectAuthenticationAuditPage(value: unknown): AuditPageDto<AuthenticationAuditEventDto> {
  return projectPage(value, projectAuthenticationAuditEvent);
}

function projectAuthenticationAuditEvent(value: unknown): AuthenticationAuditEventDto {
  const record = objectValue(value);
  return {
    id: stringField(record, 'id'),
    occurred_at: stringField(record, 'occurred_at'),
    event: stringField(record, 'event'),
    actor_user_id: nullableStringField(record, 'actor_user_id'),
    actor_sub: nullableStringField(record, 'actor_sub'),
    capability: nullableCapabilityField(record, 'capability'),
    elevation_acr: nullableStringField(record, 'elevation_acr'),
    elevation_amr: stringArrayField(record, 'elevation_amr'),
    result: stringField(record, 'result'),
    error_code: nullableStringField(record, 'error_code'),
    correlation_id: nullableStringField(record, 'correlation_id'),
    client_ip: nullableStringField(record, 'client_ip'),
    user_agent: nullableStringField(record, 'user_agent'),
  };
}

function projectPage<T>(value: unknown, projector: (item: unknown) => T): AuditPageDto<T> {
  const record = objectValue(value);
  const page = objectValue(record.page);
  return {
    items: arrayValue(record.items).map(item => projector(item)),
    page: {
      limit: numberField(page, 'limit'),
      cursor: nullableStringField(page, 'cursor'),
      next_cursor: nullableStringField(page, 'next_cursor'),
    },
  };
}

function stringArrayField(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  return arrayValue(record[key]).filter((item): item is string => typeof item === 'string');
}

function nullableIntegerField(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = nullableNumberField(record, key);
  return value === null ? null : Math.floor(value);
}

function actorRoleField(record: Readonly<Record<string, unknown>>, key: string): ConsoleAdminActorRole | null {
  const value = record[key];
  return typeof value === 'string' && (CONSOLE_ADMIN_AUDIT_ROLES as readonly string[]).includes(value)
    ? value as ConsoleAdminActorRole
    : null;
}

function actorCapabilityRoleField(record: Readonly<Record<string, unknown>>, key: string): ConsoleAdminActorRole {
  return actorRoleField(record, key) ?? 'auditor';
}

function capabilityField(record: Readonly<Record<string, unknown>>, key: string): ConsoleCapability {
  const value = record[key];
  return typeof value === 'string' && (CONSOLE_CAPABILITIES as readonly string[]).includes(value)
    ? value as ConsoleCapability
    : 'console:admin:audit';
}

function nullableCapabilityField(record: Readonly<Record<string, unknown>>, key: string): ConsoleCapability | null {
  const value = record[key];
  return typeof value === 'string' && (CONSOLE_CAPABILITIES as readonly string[]).includes(value)
    ? value as ConsoleCapability
    : null;
}

function auditResultField(record: Readonly<Record<string, unknown>>, key: string): ConsoleAdminAuditResult {
  const value = record[key];
  if (
    value === 'approved' ||
    value === 'failed' ||
    value === 'replayed' ||
    value === 'rejected' ||
    value === 'conflict'
  ) {
    return value;
  }
  return 'failed';
}

function adminIntegrityField(record: Readonly<Record<string, unknown>>): AdminAuditEventDto['integrity'] {
  const integrity = objectValue(record.integrity);
  const status = integrity.status;
  return {
    status: status === 'verified' || status === 'failed' || status === 'not_available'
      ? status
      : 'not_available',
    reason: nullableStringField(integrity, 'reason'),
  };
}

function jsonRecordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): ConsoleAdminAuditRedactedRecord {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as ConsoleAdminAuditRedactedRecord
    : {};
}

function nullableJsonRecordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): ConsoleAdminAuditRedactedRecord | null {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as ConsoleAdminAuditRedactedRecord
    : null;
}
