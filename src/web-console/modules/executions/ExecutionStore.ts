import { and, desc, eq } from 'drizzle-orm';
import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import {
  PermissionLevel,
  type CliApprovalRecord,
  type ConfirmationRecord,
} from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import { agentStates, elements, sessions } from '../../../database/schema/index.js';
import type {
  GatekeeperConfirmationDto,
  GatekeeperPendingApprovalDto,
  SessionExecutionDetailDto,
  SessionExecutionOutputDto,
  SessionExecutionSummaryDto,
  SessionExecutionStatus,
  SessionGatekeeperDto,
} from './ExecutionDtos.js';

const DEFAULT_APPROVAL_TTL_MS = 300_000;

export interface SessionExecutionReader {
  list(userId: string, sessionId: string): Promise<readonly SessionExecutionSummaryDto[]>;
  find(userId: string, sessionId: string, goalId: string): Promise<SessionExecutionDetailDto | null>;
  stream(userId: string, sessionId: string, goalId: string): AsyncIterable<SessionExecutionDetailDto>;
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

  async *stream(userId: string, sessionId: string, goalId: string): AsyncIterable<SessionExecutionDetailDto> {
    await Promise.resolve();
    const record = cloneExecution(this.records.get(this.key(userId, sessionId, goalId)) ?? null);
    if (record) yield record;
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

interface AgentExecutionStateRow {
  readonly agentName: string;
  readonly sessionId: string;
  readonly goals: unknown;
  readonly decisions: unknown;
}

interface AgentGoalRecord {
  readonly id: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly completedAt?: Date | string;
  readonly notes?: string;
}

interface AgentDecisionRecord {
  readonly goalId: string;
  readonly timestamp: Date | string;
  readonly decision: string;
  readonly reasoning?: string;
  readonly outcome?: string;
}

export class PostgresSessionExecutionReader implements SessionExecutionReader {
  constructor(private readonly db: DatabaseInstance) {}

  async list(userId: string, sessionId: string): Promise<readonly SessionExecutionSummaryDto[]> {
    const rows = await this.loadRows(userId, sessionId);
    return rows
      .flatMap(row => executionRecordsFromRow(row))
      .map(toSummary)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async find(userId: string, sessionId: string, goalId: string): Promise<SessionExecutionDetailDto | null> {
    const rows = await this.loadRows(userId, sessionId);
    return rows
      .flatMap(row => executionRecordsFromRow(row))
      .find(record => record.goal_id === goalId) ?? null;
  }

  async *stream(userId: string, sessionId: string, goalId: string): AsyncIterable<SessionExecutionDetailDto> {
    const record = await this.find(userId, sessionId, goalId);
    if (record) yield record;
  }

  private loadRows(userId: string, sessionId: string): Promise<readonly AgentExecutionStateRow[]> {
    return withSystemContext(this.db, tx => tx
      .select({
        agentName: elements.name,
        sessionId: agentStates.sessionId,
        goals: agentStates.goals,
        decisions: agentStates.decisions,
      })
        .from(agentStates)
        .innerJoin(elements, and(eq(elements.id, agentStates.agentId), eq(elements.userId, userId)))
        .where(and(eq(agentStates.userId, userId), eq(agentStates.sessionId, sessionId)))
        .orderBy(desc(agentStates.lastActive), desc(agentStates.id)));
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

export class PostgresSessionGatekeeperReader implements SessionGatekeeperReader {
  constructor(private readonly db: DatabaseInstance) {}

  async get(userId: string, sessionId: string): Promise<SessionGatekeeperDto> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({
        confirmations: sessions.confirmations,
        cliApprovals: sessions.cliApprovals,
        permissionPromptActive: sessions.permissionPromptActive,
      })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.sessionId, sessionId)))
        .limit(1));
    const row = rows.at(0);
    if (!row) return emptyGatekeeperState(sessionId);
    const confirmations = confirmationEntries(row.confirmations).map(toConfirmationDto);
    const retainedApprovals = approvalEntries(row.cliApprovals);
    const pendingApprovals = retainedApprovals.filter(isPendingApproval).map(toPendingApprovalDto);
    return {
      session_id: sessionId,
      permission_prompt_active: row.permissionPromptActive,
      confirmation_count: confirmations.length,
      pending_approval_count: pendingApprovals.length,
      retained_approval_count: retainedApprovals.length,
      client: null,
      confirmations,
      pending_approvals: pendingApprovals,
    };
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

function executionRecordsFromRow(row: AgentExecutionStateRow): SessionExecutionDetailDto[] {
  const decisions = decisionRecords(row.decisions);
  return goalRecords(row.goals).map(goal => {
    const goalDecisions = decisions
      .filter(decision => decision.goalId === goal.id)
      .sort((left, right) => toTime(left.timestamp) - toTime(right.timestamp));
    const lastDecision = goalDecisions.at(-1);
    return {
      goal_id: goal.id,
      session_id: row.sessionId,
      agent_name: row.agentName,
      status: executionStatus(goal.status),
      progress: executionProgress(goal.status),
      started_at: toIso(goal.createdAt),
      updated_at: toIso(goal.updatedAt),
      completed_at: goal.completedAt ? toIso(goal.completedAt) : null,
      current_step: lastDecision?.decision ?? null,
      stable_error_code: goal.status === 'failed' ? 'agent_execution_failed' : null,
      output: executionOutput(goalDecisions, goal),
    };
  });
}

function goalRecords(value: unknown): AgentGoalRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isGoalRecord(item) ? [item] : []);
}

function isGoalRecord(value: unknown): value is AgentGoalRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AgentGoalRecord>;
  return typeof record.id === 'string' &&
    typeof record.description === 'string' &&
    typeof record.status === 'string' &&
    isDateLike(record.createdAt) &&
    isDateLike(record.updatedAt);
}

function decisionRecords(value: unknown): AgentDecisionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isDecisionRecord(item) ? [item] : []);
}

function isDecisionRecord(value: unknown): value is AgentDecisionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AgentDecisionRecord>;
  return typeof record.goalId === 'string' &&
    typeof record.decision === 'string' &&
    isDateLike(record.timestamp);
}

function executionStatus(status: string): SessionExecutionStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

function executionProgress(status: string): number | null {
  if (status === 'pending') return 0;
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 1;
  return null;
}

function executionOutput(
  decisions: readonly AgentDecisionRecord[],
  goal: AgentGoalRecord,
): readonly SessionExecutionOutputDto[] {
  const output: SessionExecutionOutputDto[] = decisions.map(decision => ({
    kind: decision.outcome === 'failure' ? 'error' : 'progress',
    message: decision.reasoning ? `${decision.decision}: ${decision.reasoning}` : decision.decision,
    occurred_at: toIso(decision.timestamp),
  }));
  if (goal.completedAt && goal.notes) {
    output.push({
      kind: goal.status === 'failed' ? 'error' : 'result',
      message: goal.notes,
      occurred_at: toIso(goal.completedAt),
    });
  }
  return output;
}

function isDateLike(value: unknown): value is Date | string {
  return value instanceof Date || typeof value === 'string';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
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

function confirmationEntries(value: unknown): ConfirmationRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!isEntry(entry)) return [];
    const record = entry[1];
    return isConfirmationRecord(record) ? [record] : [];
  });
}

function approvalEntries(value: unknown): CliApprovalRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!isEntry(entry)) return [];
    const record = entry[1];
    return isCliApprovalRecord(record) ? [record] : [];
  });
}

function isEntry(value: unknown): value is readonly [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string';
}

function isConfirmationRecord(value: unknown): value is ConfirmationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ConfirmationRecord>;
  return typeof record.operation === 'string' &&
    typeof record.confirmedAt === 'string' &&
    (record.permissionLevel === PermissionLevel.CONFIRM_SESSION ||
      record.permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE) &&
    typeof record.useCount === 'number';
}

function isCliApprovalRecord(value: unknown): value is CliApprovalRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CliApprovalRecord>;
  return typeof record.requestId === 'string' &&
    typeof record.toolName === 'string' &&
    typeof record.requestedAt === 'string' &&
    typeof record.riskLevel === 'string' &&
    typeof record.riskScore === 'number' &&
    typeof record.irreversible === 'boolean' &&
    typeof record.denyReason === 'string' &&
    (record.scope === 'single' || record.scope === 'tool_session');
}

function isPendingApproval(record: CliApprovalRecord): boolean {
  if (record.approvedAt || record.deniedAt || record.expiredAt || record.cancelledAt || record.consumed) return false;
  const expiresAt = new Date(record.requestedAt).getTime() + (record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS);
  return expiresAt > Date.now();
}
