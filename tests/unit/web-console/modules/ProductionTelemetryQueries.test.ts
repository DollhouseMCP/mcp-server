import { describe, expect, it, jest } from '@jest/globals';

const withSystemContextMock = jest.fn(async (
  db: unknown,
  callback: (transaction: unknown) => Promise<unknown>,
) => callback(db));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresConsoleTelemetryQuery } = await import(
  '../../../../src/web-console/modules/operations/OperationsTelemetry.js'
);
const { PostgresOwnedMetricQuery } = await import(
  '../../../../src/web-console/modules/session-telemetry/OwnedMetricQuery.js'
);

const NOW = new Date('2099-05-31T12:00:00.000Z');
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SESSION_ID = 'mcp-session-1';
const ACCOUNT_CORRELATION_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';
const CORRELATION_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb3';
const REPLICA_ID = 'replica-a';
const RUNTIME_WARNING_EVENT = 'runtime.session.warning.v1';
const RUNTIME_WARNING_CODE = 'runtime_warning';

describe('production telemetry query adapters', () => {
  it('projects operational logs from durable session activity events', async () => {
    const db = executeDb([{
      ts: NOW,
      level: 'warn',
      subsystem: 'runtime',
      event: RUNTIME_WARNING_EVENT,
      correlation_id: CORRELATION_ID,
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      session_id: SESSION_ID,
      replica: REPLICA_ID,
      duration_ms: null,
      status_code: null,
      error_code: RUNTIME_WARNING_CODE,
    }, {
      ts: new Date('2099-05-31T11:59:00.000Z'),
      level: 'info',
      subsystem: 'approvals',
      event: 'console.session.approval.decided.v1',
      correlation_id: null,
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      session_id: SESSION_ID,
      replica: REPLICA_ID,
      duration_ms: null,
      status_code: null,
      error_code: null,
    }]);
    const query = new PostgresConsoleTelemetryQuery(db, {
      replicaId: REPLICA_ID,
      now: () => NOW,
    });

    await expect(query.queryOperationalLogs({
      limit: 1,
      cursor: null,
      level: 'warn',
      subsystem: 'runtime',
      event: null,
    })).resolves.toEqual({
      items: [{
        ts: NOW.toISOString(),
        level: 'warn',
        subsystem: 'runtime',
        event: RUNTIME_WARNING_EVENT,
        correlation_id: CORRELATION_ID,
        account_correlation_id: ACCOUNT_CORRELATION_ID,
        session_id: SESSION_ID,
        replica: REPLICA_ID,
        duration_ms: null,
        status_code: null,
        error_code: RUNTIME_WARNING_CODE,
      }],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: expect.any(String),
      },
    });
    expect(withSystemContextMock).toHaveBeenCalledWith(db, expect.any(Function));
  });

  it('aggregates operational metrics from durable activity events', async () => {
    const db = executeDb([{
      subsystem: 'runtime',
      event: RUNTIME_WARNING_EVENT,
      error_code: RUNTIME_WARNING_CODE,
      value: 2,
    }, {
      subsystem: 'approvals',
      event: 'console.session.approval.decided.v1',
      error_code: null,
      value: 1,
    }]);
    const query = new PostgresConsoleTelemetryQuery(db, {
      replicaId: REPLICA_ID,
      now: () => NOW,
    });

    await expect(query.queryOperationalMetrics({
      subsystem: 'runtime',
      name: 'session.activity.errors',
    })).resolves.toEqual({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: 'session.activity.errors',
        kind: 'counter',
        value: 2,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          event: RUNTIME_WARNING_EVENT,
          error_code: RUNTIME_WARNING_CODE,
          replica: REPLICA_ID,
        },
      }],
    });
  });

  it('aggregates owned metrics by user and session only', async () => {
    const db = executeDb([{
      subsystem: 'runtime',
      event: RUNTIME_WARNING_EVENT,
      error_code: RUNTIME_WARNING_CODE,
      value: '3',
    }]);
    const query = new PostgresOwnedMetricQuery(db, { now: () => NOW });

    await expect(query.queryOwnedMetrics(USER_ID, SESSION_ID, {
      subsystem: 'runtime',
      name: null,
    })).resolves.toEqual({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: 'session.activity.events',
        kind: 'counter',
        value: 3,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          event: RUNTIME_WARNING_EVENT,
        },
      }, {
        name: 'session.activity.errors',
        kind: 'counter',
        value: 3,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          event: RUNTIME_WARNING_EVENT,
          error_code: RUNTIME_WARNING_CODE,
        },
      }],
    });
  });
});

function executeDb(rows: readonly unknown[]) {
  return {
    execute: jest.fn(() => Promise.resolve(rows)),
  };
}
