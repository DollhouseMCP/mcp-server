import { describe, expect, it, beforeEach, jest } from '@jest/globals';

let mockRows: unknown[] = [];

jest.unstable_mockModule('../../../src/database/admin.js', () => ({
  withSystemContext: jest.fn(async () => mockRows),
}));

const { StaticAuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');
const { DatabaseConfirmationStore } = await import('../../../src/state/DatabaseConfirmationStore.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const auditResolver = new StaticAuditHmacKeyResolver('66'.repeat(32));

describe('DatabaseConfirmationStore approval audit methods', () => {
  beforeEach(() => {
    mockRows = [];
  });

  it('getRawApprovalDetail returns null when raw detail was not retained', async () => {
    const store = new DatabaseConfirmationStore({} as any, USER_ID, 'session-a', auditResolver);
    store.saveCliApproval('cli-redacted', {
      requestId: 'cli-redacted',
      toolName: 'Bash',
      toolInputDigest: { command: { redacted: true } },
      toolInputHash: 'hmac_v1:test',
      riskLevel: 'moderate',
      riskScore: 50,
      irreversible: false,
      requestedAt: new Date().toISOString(),
      consumed: false,
      scope: 'single',
      denyReason: 'test',
    });

    await expect(store.getRawApprovalDetail('session-a', 'cli-redacted')).resolves.toBeNull();
  });

  it('findApprovals scans rows across sessions and never returns raw detail', async () => {
    mockRows = [{
      userId: USER_ID,
      sessionId: 'session-b',
      cliApprovals: [[
        'cli-retained',
        {
          requestId: 'cli-retained',
          toolName: 'Bash',
          toolInputDigest: { command: { redacted: true } },
          toolInputHash: 'hmac_v1:test',
          toolInputDetail: { command: 'npm test' },
          riskLevel: 'moderate',
          riskScore: 50,
          irreversible: false,
          requestedAt: new Date().toISOString(),
          consumed: false,
          scope: 'single',
          denyReason: 'test',
        },
      ]],
    }];
    const store = new DatabaseConfirmationStore({} as any, USER_ID, 'session-a', auditResolver);

    const refs = await store.findApprovals({});

    expect(refs).toEqual([
      expect.objectContaining({
        sessionId: 'session-b',
        approvalId: 'cli-retained',
        digest: { command: { redacted: true } },
      }),
    ]);
    expect(JSON.stringify(refs)).not.toContain('npm test');
  });
});
