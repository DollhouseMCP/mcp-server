import { describe, expect, it, jest } from '@jest/globals';
import { PermissionLevel, type CliApprovalRecord } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';

let tx: { insert: jest.Mock; select?: jest.Mock } | null = null;
const withSystemContextMock = jest.fn(async (
  db: unknown,
  callback: (transaction: unknown) => Promise<unknown>,
) => callback(tx ?? db));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresSessionApprovalEventSink } = await import(
  '../../../../src/web-console/modules/approvals/ApprovalEvents.js'
);
const { PostgresOwnedActivityQuery } = await import(
  '../../../../src/web-console/modules/session-telemetry/OwnedActivityQuery.js'
);
const { PostgresSessionExecutionReader, PostgresSessionGatekeeperReader } = await import(
  '../../../../src/web-console/modules/executions/ExecutionStore.js'
);

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SESSION_ID = 'mcp-session-1';
const APPROVAL_ID = 'cli-018f3d47-73ae-7f10-a0de-0742618d4fb1';
const APPROVAL_DECIDED_EVENT = 'console.session.approval.decided.v1';
const NOW = new Date('2099-05-31T12:00:00.000Z');

describe('production session activity adapters', () => {
  it('persists approval decision events as owner-private session activity', async () => {
    const selectRows = [{ accountCorrelationId: '018f3d47-73ae-7f10-a0de-0742618d4fc1' }];
    const insertChain = {
      values: jest.fn(() => insertChain),
      onConflictDoNothing: jest.fn(() => Promise.resolve()),
    };
    const selectChain = {
      from: jest.fn(() => selectChain),
      where: jest.fn(() => selectChain),
      limit: jest.fn(() => Promise.resolve(selectRows)),
    };
    tx = {
      insert: jest.fn(() => insertChain),
      select: jest.fn(() => selectChain),
    };
    const sink = new PostgresSessionApprovalEventSink({} as never);

    await sink.recordApprovalDecision({
      type: APPROVAL_DECIDED_EVENT,
      userId: USER_ID,
      sessionId: SESSION_ID,
      approvalId: APPROVAL_ID,
      decision: 'approved',
      scope: 'session',
      toolName: 'Bash',
      operation: null,
      decisionSource: 'user_prompt',
      correlationId: '018f3d47-73ae-7f10-a0de-0742618d4fd1',
      occurredAt: NOW,
    });

    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(insertChain.values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: USER_ID,
      sessionId: SESSION_ID,
      occurredAt: NOW,
      level: 'info',
      subsystem: 'approvals',
      event: APPROVAL_DECIDED_EVENT,
      message: 'Approval approved',
      stableErrorCode: null,
    }));
    expect(insertChain.values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: APPROVAL_ID,
      userId: USER_ID,
      accountCorrelationId: selectRows[0].accountCorrelationId,
      sessionId: SESSION_ID,
      toolName: 'Bash',
      result: 'approved',
      decisionSource: 'user_prompt',
      correlationId: '018f3d47-73ae-7f10-a0de-0742618d4fd1',
    }));
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    tx = null;
  });

  it('queries owned activity rows with filters and stable cursor paging', async () => {
    const rows = [{
      occurredAt: NOW,
      sessionId: SESSION_ID,
      level: 'info',
      subsystem: 'approvals',
      event: APPROVAL_DECIDED_EVENT,
      message: 'Approval approved',
      correlationId: null,
      stableErrorCode: null,
    }, {
      occurredAt: new Date('2026-05-31T11:59:00.000Z'),
      sessionId: SESSION_ID,
      level: 'warn',
      subsystem: 'runtime',
      event: 'runtime.session.warning.v1',
      message: null,
      correlationId: null,
      stableErrorCode: 'runtime_warning',
    }];
    const db = queryDb(rows);
    const query = new PostgresOwnedActivityQuery(db as never);

    const page = await query.queryOwnedActivity(USER_ID, SESSION_ID, {
      limit: 1,
      cursor: null,
      level: 'info',
      subsystem: 'approvals',
      event: APPROVAL_DECIDED_EVENT,
    });

    expect(page.items).toEqual([{
      ts: NOW.toISOString(),
      session_id: SESSION_ID,
      level: 'info',
      subsystem: 'approvals',
      event: APPROVAL_DECIDED_EVENT,
      message: 'Approval approved',
      correlation_id: null,
      stable_error_code: null,
    }]);
    expect(page.page.next_cursor).not.toBeNull();
    expect(withSystemContextMock).toHaveBeenCalledWith(db, expect.any(Function));
  });

  it('projects persisted Gatekeeper state from the sessions table', async () => {
    const approval = approvalRecord();
    const db = queryDb([{
      confirmations: [['create_element:skill', {
        operation: 'create_element',
        elementType: 'skills',
        confirmedAt: NOW.toISOString(),
        permissionLevel: PermissionLevel.CONFIRM_SESSION,
        useCount: 2,
      }]],
      cliApprovals: [[approval.requestId, approval]],
      permissionPromptActive: true,
    }]);
    const reader = new PostgresSessionGatekeeperReader(db as never);

    await expect(reader.get(USER_ID, SESSION_ID)).resolves.toMatchObject({
      session_id: SESSION_ID,
      permission_prompt_active: true,
      confirmation_count: 1,
      pending_approval_count: 1,
      retained_approval_count: 1,
      confirmations: [expect.objectContaining({
        operation: 'create_element',
        element_type: 'skills',
        scope: 'session',
        use_count: 2,
      })],
      pending_approvals: [expect.objectContaining({
        approval_id: APPROVAL_ID,
        tool_name: 'Bash',
      })],
    });
    expect(withSystemContextMock).toHaveBeenCalledWith(db, expect.any(Function));
  });

  it('projects persisted agent goals as session executions', async () => {
    const db = queryDb([{
      agentName: 'CodeReviewer',
      sessionId: SESSION_ID,
      goals: [{
        id: 'goal-1',
        description: 'Review the console backend',
        status: 'in_progress',
        createdAt: new Date('2099-05-31T11:00:00.000Z'),
        updatedAt: NOW,
      }, {
        id: 'goal-2',
        description: 'Already completed',
        status: 'completed',
        createdAt: new Date('2099-05-31T10:00:00.000Z'),
        updatedAt: new Date('2099-05-31T10:30:00.000Z'),
        completedAt: new Date('2099-05-31T10:30:00.000Z'),
        notes: 'Done',
      }],
      decisions: [{
        goalId: 'goal-1',
        timestamp: NOW,
        decision: 'Read execution store',
        reasoning: 'Need durable projection',
        outcome: 'success',
      }, {
        goalId: 'goal-2',
        timestamp: new Date('2099-05-31T10:30:00.000Z'),
        decision: 'goal_complete',
        reasoning: 'Finished',
        outcome: 'success',
      }],
    }]);
    const reader = new PostgresSessionExecutionReader(db as never);

    await expect(reader.list(USER_ID, SESSION_ID)).resolves.toEqual([
      expect.objectContaining({
        goal_id: 'goal-1',
        session_id: SESSION_ID,
        agent_name: 'CodeReviewer',
        status: 'running',
        current_step: 'Read execution store',
      }),
      expect.objectContaining({
        goal_id: 'goal-2',
        status: 'succeeded',
        progress: 1,
      }),
    ]);
    await expect(reader.find(USER_ID, SESSION_ID, 'goal-1')).resolves.toMatchObject({
      goal_id: 'goal-1',
      output: [{
        kind: 'progress',
        message: 'Read execution store: Need durable projection',
        occurred_at: NOW.toISOString(),
      }],
    });
    expect(withSystemContextMock).toHaveBeenCalledWith(db, expect.any(Function));
  });
});

function queryDb(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.offset = jest.fn(() => Promise.resolve(rows));
  chain.then = Promise.resolve(rows).then.bind(Promise.resolve(rows)) as never;
  return {
    select: jest.fn(() => chain),
  };
}

function approvalRecord(): CliApprovalRecord {
  return {
    requestId: APPROVAL_ID,
    toolName: 'Bash',
    toolInputDigest: { command: 'npm test' },
    toolInputHash: 'hmac:v1',
    riskLevel: 'moderate',
    riskScore: 55,
    irreversible: false,
    requestedAt: NOW.toISOString(),
    consumed: false,
    scope: 'single',
    denyReason: 'Tool requires approval',
    policySource: 'operation_default',
    ttlMs: 300_000,
  };
}
