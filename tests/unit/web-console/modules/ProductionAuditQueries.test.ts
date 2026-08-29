import { describe, expect, it, jest } from '@jest/globals';

const withSystemContextMock = jest.fn(async (
  db: unknown,
  callback: (transaction: unknown) => Promise<unknown>,
) => callback(db));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const {
  PostgresApprovalAuditQuery,
  PostgresAuthenticationAuditQuery,
} = await import('../../../../src/web-console/modules/audit/index.js');

const { integrityFromApprovalAuditVerification } = await import(
  '../../../../src/web-console/modules/audit/PostgresProductionAuditQueries.js'
);

type AuditQueryDatabase = ConstructorParameters<typeof PostgresApprovalAuditQuery>[0];

const NOW = new Date('2099-05-31T12:00:00.000Z');
const APPROVAL_ID = 'cli-018f3d47-73ae-7f10-a0de-0742618d4fb1';
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';
const ACCOUNT_CORRELATION_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb3';
const CORRELATION_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb4';

describe('production audit query adapters', () => {
  it('lists metadata-only approval audit rows with not-available integrity', async () => {
    const db = executeDb([{
      id: APPROVAL_ID,
      occurred_at: NOW,
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      session_id: 'mcp-session-1',
      tool_name: 'Bash',
      operation: null,
      result: 'approved',
      decision_source: 'user_prompt',
      correlation_id: CORRELATION_ID,
    }, {
      id: 'cli-018f3d47-73ae-7f10-a0de-0742618d4fb5',
      occurred_at: NOW,
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      session_id: 'mcp-session-1',
      tool_name: 'Read',
      operation: null,
      result: 'denied',
      decision_source: 'user_prompt',
      correlation_id: null,
    }]);
    const query = new PostgresApprovalAuditQuery(db as unknown as AuditQueryDatabase);

    const page = await query.listApprovalAudit({ limit: 1, cursor: null });

    expect(page).toEqual({
      items: [{
        id: APPROVAL_ID,
        occurred_at: NOW.toISOString(),
        account_correlation_id: ACCOUNT_CORRELATION_ID,
        session_id: 'mcp-session-1',
        tool_name: 'Bash',
        operation: null,
        result: 'approved',
        decision_source: 'user_prompt',
        correlation_id: CORRELATION_ID,
        integrity: {
          status: 'not_available',
          chain_key_id: null,
          chain_prev: null,
          chain_hmac: null,
        },
      }],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: expect.any(String),
      },
    });
    expect(withSystemContextMock).toHaveBeenCalledWith(db, expect.any(Function));
  });

  it('only reports verified integrity when a real verification succeeds', () => {
    expect(integrityFromApprovalAuditVerification({ available: false })).toEqual({
      status: 'not_available',
      chain_key_id: null,
      chain_prev: null,
      chain_hmac: null,
    });
    expect(integrityFromApprovalAuditVerification({
      available: true,
      verified: false,
      chainKeyId: 'key-1',
      chainPrev: null,
      chainHmac: 'hmac-1',
    })).toEqual({
      status: 'not_available',
      chain_key_id: null,
      chain_prev: null,
      chain_hmac: null,
    });
    expect(integrityFromApprovalAuditVerification({
      available: true,
      verified: true,
      chainKeyId: 'key-1',
      chainPrev: 'prev-0',
      chainHmac: 'hmac-1',
    })).toEqual({
      status: 'verified',
      chain_key_id: 'key-1',
      chain_prev: 'prev-0',
      chain_hmac: 'hmac-1',
    });
  });

  it('returns a single approval audit row by id', async () => {
    const db = executeDb([{
      id: APPROVAL_ID,
      occurred_at: NOW.toISOString(),
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      session_id: 'mcp-session-1',
      tool_name: 'Bash',
      operation: 'tool.execute',
      result: 'denied',
      decision_source: 'user_prompt',
      correlation_id: null,
    }]);
    const query = new PostgresApprovalAuditQuery(db as unknown as AuditQueryDatabase);

    await expect(query.getApprovalAudit(APPROVAL_ID)).resolves.toMatchObject({
      id: APPROVAL_ID,
      operation: 'tool.execute',
      result: 'denied',
      integrity: { status: 'not_available' },
    });
  });

  it('projects authentication identity events without proof values', async () => {
    const db = executeDb([{
      id: 'auth-event-1',
      occurred_at: NOW.getTime(),
      event: 'auth.admin_step_up.granted',
      actor_user_id: USER_ID,
      actor_sub: 'github_123',
      details: {
        capability: 'console:admin:audit',
        elevation_acr: 'urn:dollhouse:acr:admin-stepup',
        elevation_amr: ['otp', 123],
        result: 'approved',
        error_code: null,
        correlation_id: CORRELATION_ID,
        client_ip: '203.0.113.11',
        user_agent: 'Mozilla/5.0',
        totp_code: '123456',
      },
    }]);
    const query = new PostgresAuthenticationAuditQuery(db as unknown as AuditQueryDatabase);

    await expect(query.listAuthenticationAudit({ limit: 25, cursor: null })).resolves.toEqual({
      items: [{
        id: 'auth-event-1',
        occurred_at: NOW.toISOString(),
        event: 'auth.admin_step_up.granted',
        actor_user_id: USER_ID,
        actor_sub: 'github_123',
        capability: 'console:admin:audit',
        elevation_acr: 'urn:dollhouse:acr:admin-stepup',
        elevation_amr: ['otp'],
        result: 'approved',
        error_code: null,
        correlation_id: CORRELATION_ID,
        client_ip: '203.0.113.11',
        user_agent: 'Mozilla/5.0',
      }],
      page: {
        limit: 25,
        cursor: null,
        next_cursor: null,
      },
    });
  });
});

function executeDb(rows: readonly unknown[]) {
  return {
    execute: jest.fn(() => Promise.resolve(rows)),
  };
}
