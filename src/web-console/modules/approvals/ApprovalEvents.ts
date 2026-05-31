import { sessionActivityEvents } from '../../../database/schema/index.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import type { ConsoleApprovalScope, ConsoleApprovalStatus } from './ApprovalDtos.js';

export interface SessionApprovalDecisionEvent {
  readonly type: 'console.session.approval.decided.v1';
  readonly userId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: Extract<ConsoleApprovalStatus, 'approved' | 'denied'>;
  readonly scope: ConsoleApprovalScope;
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
    });
  }
}
