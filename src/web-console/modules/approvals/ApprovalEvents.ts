import { approvalAuditEvents, sessionActivityEvents, users } from '../../../database/schema/index.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import type { ConsoleApprovalScope, ConsoleApprovalStatus } from './ApprovalDtos.js';
import { eq } from 'drizzle-orm';

export interface SessionApprovalDecisionEvent {
  readonly type: 'console.session.approval.decided.v1';
  readonly userId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: Extract<ConsoleApprovalStatus, 'approved' | 'denied'>;
  readonly scope: ConsoleApprovalScope;
  readonly toolName: string;
  readonly operation: string | null;
  readonly decisionSource: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

export interface ISessionApprovalEventSink {
  recordApprovalDecision(event: SessionApprovalDecisionEvent): Promise<void>;
}

export class InMemorySessionApprovalEventSink implements ISessionApprovalEventSink {
  private readonly events: SessionApprovalDecisionEvent[] = [];

  recordApprovalDecision(event: SessionApprovalDecisionEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  listEvents(): readonly SessionApprovalDecisionEvent[] {
    return [...this.events];
  }
}

export class PostgresSessionApprovalEventSink implements ISessionApprovalEventSink {
  constructor(private readonly db: DatabaseInstance) {}

  async recordApprovalDecision(event: SessionApprovalDecisionEvent): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      const principalRows = await tx
        .select({ accountCorrelationId: users.accountCorrelationId })
        .from(users)
        .where(eq(users.id, event.userId))
        .limit(1);
      const principal = firstPrincipal(principalRows);
      if (!principal) {
        throw new Error('Cannot record approval audit event for unknown user');
      }
      await tx.insert(sessionActivityEvents).values({
        userId: event.userId,
        sessionId: event.sessionId,
        occurredAt: event.occurredAt,
        level: 'info',
        subsystem: 'approvals',
        event: event.type,
        message: `Approval ${event.decision}`,
        correlationId: null,
        stableErrorCode: null,
      });
      await tx.insert(approvalAuditEvents).values({
        id: event.approvalId,
        occurredAt: event.occurredAt,
        userId: event.userId,
        accountCorrelationId: principal.accountCorrelationId,
        sessionId: event.sessionId,
        toolName: event.toolName,
        operation: event.operation,
        result: event.decision,
        decisionSource: event.decisionSource,
        correlationId: event.correlationId,
      }).onConflictDoNothing();
    });
  }
}

function firstPrincipal(rows: unknown): { readonly accountCorrelationId: string } | null {
  if (!Array.isArray(rows)) return null;
  const [row] = rows;
  if (!row || typeof row !== 'object') return null;
  const accountCorrelationId = (row as { readonly accountCorrelationId?: unknown }).accountCorrelationId;
  return typeof accountCorrelationId === 'string' ? { accountCorrelationId } : null;
}
