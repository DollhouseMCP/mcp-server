import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import {
  PermissionLevel,
  type CliApprovalRecord,
  type ConfirmationRecord,
} from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import type {
  GatekeeperConfirmationDto,
  GatekeeperPendingApprovalDto,
  SessionExecutionDetailDto,
  SessionExecutionSummaryDto,
  SessionGatekeeperDto,
} from './ExecutionDtos.js';

const DEFAULT_APPROVAL_TTL_MS = 300_000;

export interface SessionExecutionReader {
  list(userId: string, sessionId: string): Promise<readonly SessionExecutionSummaryDto[]>;
  find(userId: string, sessionId: string, goalId: string): Promise<SessionExecutionDetailDto | null>;
}

export interface SessionGatekeeperReader {
  get(userId: string, sessionId: string): Promise<SessionGatekeeperDto>;
}

export class InMemorySessionExecutionReader implements SessionExecutionReader {
  private readonly records = new Map<string, SessionExecutionDetailDto>();

  seed(userId: string, sessionId: string, record: SessionExecutionDetailDto): void {
    this.records.set(this.key(userId, sessionId, record.goal_id), cloneExecutionRecord(record));
  }

  list(userId: string, sessionId: string): Promise<readonly SessionExecutionSummaryDto[]> {
    const prefix = this.prefix(userId, sessionId);
    return Promise.resolve(Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => toSummary(record))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
  }

  find(userId: string, sessionId: string, goalId: string): Promise<SessionExecutionDetailDto | null> {
    return Promise.resolve(cloneExecution(this.records.get(this.key(userId, sessionId, goalId)) ?? null));
  }

  private prefix(userId: string, sessionId: string): string {
    return `${userId}\u0000${sessionId}\u0000`;
  }

  private key(userId: string, sessionId: string, goalId: string): string {
    return `${this.prefix(userId, sessionId)}${goalId}`;
  }
}

export class EmptySessionGatekeeperReader implements SessionGatekeeperReader {
  get(_userId: string, sessionId: string): Promise<SessionGatekeeperDto> {
    return Promise.resolve(emptyGatekeeperState(sessionId));
  }
}

/**
 * Projects live Gatekeeper state for an already-authorized MCP session.
 * Callers must verify runtime-session ownership before invoking this reader;
 * it is keyed by session ID and does not perform user scoping internally.
 */
export class GatekeeperSessionStateReader implements SessionGatekeeperReader {
  constructor(private readonly gatekeeper: Gatekeeper) {}

  get(_userId: string, sessionId: string): Promise<SessionGatekeeperDto> {
    const session = this.gatekeeper.getRegisteredSession(sessionId);
    if (!session) return Promise.resolve(emptyGatekeeperState(sessionId));
    const summary = session.getSummary();
    const pendingApprovals = session.getPendingCliApprovals().map(toPendingApprovalDto);
    const confirmations = session.getActiveConfirmations().map(toConfirmationDto);
    return Promise.resolve({
      session_id: sessionId,
      permission_prompt_active: summary.permissionPromptActive,
      confirmation_count: summary.confirmationCount,
      pending_approval_count: pendingApprovals.length,
      retained_approval_count: summary.cliApprovalCount,
      client: summary.clientInfo
        ? {
          name: summary.clientInfo.name,
          version: summary.clientInfo.version,
        }
        : null,
      confirmations,
      pending_approvals: pendingApprovals,
    });
  }
}

function emptyGatekeeperState(sessionId: string): SessionGatekeeperDto {
  return {
    session_id: sessionId,
    permission_prompt_active: false,
    confirmation_count: 0,
    pending_approval_count: 0,
    retained_approval_count: 0,
    client: null,
    confirmations: [],
    pending_approvals: [],
  };
}

function toSummary(record: SessionExecutionDetailDto): SessionExecutionSummaryDto {
  return {
    goal_id: record.goal_id,
    session_id: record.session_id,
    agent_name: record.agent_name,
    status: record.status,
    progress: record.progress,
    started_at: record.started_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
    current_step: record.current_step,
    stable_error_code: record.stable_error_code,
  };
}

function cloneExecution(record: SessionExecutionDetailDto | null): SessionExecutionDetailDto | null {
  if (!record) return null;
  return cloneExecutionRecord(record);
}

function cloneExecutionRecord(record: SessionExecutionDetailDto): SessionExecutionDetailDto {
  return {
    ...record,
    output: record.output.map(item => ({ ...item })),
  };
}

function toConfirmationDto(record: ConfirmationRecord): GatekeeperConfirmationDto {
  return {
    operation: record.operation,
    element_type: record.elementType ?? null,
    scope: record.permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE ? 'once' : 'session',
    confirmed_at: record.confirmedAt,
    use_count: record.useCount,
  };
}

function toPendingApprovalDto(record: CliApprovalRecord): GatekeeperPendingApprovalDto {
  return {
    approval_id: record.requestId,
    tool_name: record.toolName,
    risk_level: record.riskLevel,
    risk_score: record.riskScore,
    irreversible: record.irreversible,
    reason: record.denyReason,
    policy_source: record.policySource ?? null,
    requested_at: record.requestedAt,
    expires_at: new Date(new Date(record.requestedAt).getTime() + (record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS))
      .toISOString(),
  };
}
