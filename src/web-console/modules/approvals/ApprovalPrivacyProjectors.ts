import type {
  ConsoleApprovalScope,
  ConsoleApprovalStatus,
  SessionApprovalDto,
  SessionApprovalListDto,
} from './ApprovalDtos.js';

const APPROVAL_STATUSES = new Set<ConsoleApprovalStatus>([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled_session_terminated',
]);

export function projectSessionApproval(value: unknown): SessionApprovalDto {
  const input = asRecord(value);
  return {
    approval_id: stringField(input.approval_id),
    session_id: stringField(input.session_id),
    status: approvalStatus(input.status),
    tool_name: stringField(input.tool_name),
    tool_input_digest: recordField(input.tool_input_digest),
    tool_input_detail: nullableRecord(input.tool_input_detail),
    risk_level: stringField(input.risk_level),
    risk_score: numberField(input.risk_score),
    irreversible: booleanField(input.irreversible),
    reason: stringField(input.reason),
    policy_source: nullableString(input.policy_source),
    scope: approvalScope(input.scope),
    requested_at: stringField(input.requested_at),
    expires_at: stringField(input.expires_at),
    decided_at: nullableString(input.decided_at),
  };
}

export function projectSessionApprovalList(value: unknown): SessionApprovalListDto {
  const input = asRecord(value);
  return {
    approvals: Array.isArray(input.approvals)
      ? input.approvals.map(projectSessionApproval)
      : [],
  };
}

function approvalStatus(value: unknown): ConsoleApprovalStatus {
  return typeof value === 'string' && APPROVAL_STATUSES.has(value as ConsoleApprovalStatus)
    ? value as ConsoleApprovalStatus
    : 'pending';
}

function approvalScope(value: unknown): ConsoleApprovalScope {
  return value === 'session' ? 'session' : 'once';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanField(value: unknown): boolean {
  return value === true;
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : null;
}
