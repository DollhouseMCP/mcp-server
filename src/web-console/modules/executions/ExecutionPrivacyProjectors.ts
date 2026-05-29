import type {
  GatekeeperConfirmationDto,
  GatekeeperPendingApprovalDto,
  SessionExecutionDetailDto,
  SessionExecutionListDto,
  SessionExecutionOutputDto,
  SessionExecutionStatus,
  SessionExecutionSummaryDto,
  SessionGatekeeperDto,
} from './ExecutionDtos.js';

const EXECUTION_STATUSES = new Set<SessionExecutionStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export function projectSessionExecutionList(value: unknown): SessionExecutionListDto {
  const input = asRecord(value);
  return {
    executions: Array.isArray(input.executions)
      ? input.executions.map(projectSessionExecutionSummary)
      : [],
  };
}

export function projectSessionExecution(value: unknown): SessionExecutionDetailDto {
  const input = asRecord(value);
  return {
    ...projectSessionExecutionSummary(input),
    output: Array.isArray(input.output) ? input.output.map(projectExecutionOutput) : [],
  };
}

export function projectSessionGatekeeper(value: unknown): SessionGatekeeperDto {
  const input = asRecord(value);
  const client = asRecordOrNull(input.client);
  return {
    session_id: stringField(input.session_id),
    permission_prompt_active: booleanField(input.permission_prompt_active),
    confirmation_count: numberField(input.confirmation_count),
    pending_approval_count: numberField(input.pending_approval_count),
    retained_approval_count: numberField(input.retained_approval_count),
    client: client
      ? {
        name: nullableString(client.name),
        version: nullableString(client.version),
      }
      : null,
    confirmations: Array.isArray(input.confirmations) ? input.confirmations.map(projectConfirmation) : [],
    pending_approvals: Array.isArray(input.pending_approvals)
      ? input.pending_approvals.map(projectPendingApproval)
      : [],
  };
}

function projectSessionExecutionSummary(value: unknown): SessionExecutionSummaryDto {
  const input = asRecord(value);
  return {
    goal_id: stringField(input.goal_id),
    session_id: stringField(input.session_id),
    agent_name: stringField(input.agent_name),
    status: executionStatus(input.status),
    progress: nullableNumber(input.progress),
    started_at: stringField(input.started_at),
    updated_at: stringField(input.updated_at),
    completed_at: nullableString(input.completed_at),
    current_step: nullableString(input.current_step),
    stable_error_code: nullableString(input.stable_error_code),
  };
}

function projectExecutionOutput(value: unknown): SessionExecutionOutputDto {
  const input = asRecord(value);
  const kind = input.kind === 'result' || input.kind === 'error' ? input.kind : 'progress';
  return {
    kind,
    message: stringField(input.message),
    occurred_at: stringField(input.occurred_at),
  };
}

function projectConfirmation(value: unknown): GatekeeperConfirmationDto {
  const input = asRecord(value);
  return {
    operation: stringField(input.operation),
    element_type: nullableString(input.element_type),
    scope: input.scope === 'once' ? 'once' : 'session',
    confirmed_at: stringField(input.confirmed_at),
    use_count: numberField(input.use_count),
  };
}

function projectPendingApproval(value: unknown): GatekeeperPendingApprovalDto {
  const input = asRecord(value);
  return {
    approval_id: stringField(input.approval_id),
    tool_name: stringField(input.tool_name),
    risk_level: stringField(input.risk_level),
    risk_score: numberField(input.risk_score),
    irreversible: booleanField(input.irreversible),
    reason: stringField(input.reason),
    policy_source: nullableString(input.policy_source),
    requested_at: stringField(input.requested_at),
    expires_at: stringField(input.expires_at),
  };
}

function executionStatus(value: unknown): SessionExecutionStatus {
  return typeof value === 'string' && EXECUTION_STATUSES.has(value as SessionExecutionStatus)
    ? value as SessionExecutionStatus
    : 'queued';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean {
  return value === true;
}
