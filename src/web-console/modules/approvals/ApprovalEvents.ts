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
