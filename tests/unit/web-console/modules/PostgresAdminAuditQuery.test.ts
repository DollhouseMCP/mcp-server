import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { AdminAuditRow } from '../../../../src/web-console/index.js';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const {
  PostgresAdminAuditQuery,
  computeAdminAuditChainHmac,
} = await import('../../../../src/web-console/index.js');

const NOW = new Date('2026-05-29T11:00:00.000Z');
const KEY = Buffer.alloc(32, 4);
const KEY_MATERIAL = { keyId: 'audit-key-1', key: KEY };
const OLD_KEY = Buffer.alloc(32, 5);
const OLD_KEY_MATERIAL = { keyId: 'audit-key-0', key: OLD_KEY };

function row(overrides: Partial<AdminAuditRow> = {}): AdminAuditRow {
  const base: AdminAuditRow = {
    id: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
    sequenceId: 1,
    occurredAt: NOW,
    actorUserId: '018f3d47-73ae-7f10-a0de-0742618d4fa1',
    actorSub: 'github_123',
    actorRole: null,
    actorCapabilityRole: 'account_admin',
    actorConsoleSessionHash: Buffer.alloc(32, 7),
    capability: 'console:admin:accounts',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: new Date('2026-05-29T10:55:00.000Z'),
    correlationId: '018f3d47-73ae-7f10-a0de-0742618d4fc1',
    endpoint: 'POST /api/v1/admin/accounts/users/{user_id}/disable',
    operation: 'accounts.users.disable',
    resourceKind: 'user_principal',
    resourceId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    targetUserId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    argsRedacted: { reason_present: true },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { runtime_commands: 1 },
    clientIp: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    chainKeyId: KEY_MATERIAL.keyId,
    chainPrev: null,
    chainHmac: Buffer.alloc(32, 0),
    ...overrides,
  };
  return {
    ...base,
    chainHmac: overrides.chainHmac ?? computeAdminAuditChainHmac(base, KEY, base.chainPrev),
  };
}

function dbRow(auditRow: AdminAuditRow): Record<string, unknown> {
  return {
    id: auditRow.id,
    sequence_id: auditRow.sequenceId,
    occurred_at: auditRow.occurredAt,
    actor_user_id: auditRow.actorUserId,
    actor_sub: auditRow.actorSub,
    actor_role: auditRow.actorRole,
    actor_capability_role: auditRow.actorCapabilityRole,
    actor_console_session_hash: auditRow.actorConsoleSessionHash,
    capability: auditRow.capability,
    elevation_acr: auditRow.elevationAcr,
    elevation_amr: auditRow.elevationAmr,
    elevation_auth_time: auditRow.elevationAuthTime,
    endpoint: auditRow.endpoint,
    operation: auditRow.operation,
    resource_kind: auditRow.resourceKind,
    resource_id: auditRow.resourceId,
    target_user_id: auditRow.targetUserId,
    args_redacted: auditRow.argsRedacted,
    result: auditRow.result,
    error_code: auditRow.errorCode,
    result_detail_redacted: auditRow.resultDetailRedacted,
    correlation_id: auditRow.correlationId,
    client_ip: auditRow.clientIp,
    user_agent: auditRow.userAgent,
    chain_key_id: auditRow.chainKeyId,
    chain_prev: auditRow.chainPrev,
    chain_hmac: auditRow.chainHmac,
  };
}

describe('PostgresAdminAuditQuery', () => {
  beforeEach(() => {
    transaction = { execute: jest.fn() };
    withSystemContextMock.mockClear();
  });

  it('maps rows and verifies HMAC content with the configured audit key', async () => {
    const first = row();
    transaction.execute.mockResolvedValueOnce([dbRow(first)]);
    const query = new PostgresAdminAuditQuery({} as DatabaseInstance, {
      resolve: () => Promise.resolve(KEY_MATERIAL),
    });

    const result = await query.listAdminAudit({ limit: 10, cursor: null });

    expect(result.items).toEqual([
      expect.objectContaining({
        id: first.id,
        args_redacted: { reason_present: true },
        chain_hmac: first.chainHmac.toString('hex'),
        integrity: { status: 'verified', reason: null },
      }),
    ]);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it('marks content tampering failed without throwing or hiding the row', async () => {
    const original = row();
    transaction.execute.mockResolvedValueOnce([dbRow({
      ...original,
      result: 'failed',
    })]);
    const query = new PostgresAdminAuditQuery({} as DatabaseInstance, {
      resolve: () => Promise.resolve(KEY_MATERIAL),
    });

    await expect(query.getAdminAudit(original.id)).resolves.toMatchObject({
      id: original.id,
      result: 'failed',
      integrity: { status: 'failed', reason: 'chain_hmac_mismatch' },
    });
  });

  it('verifies rotated historical rows through retained key lookup', async () => {
    const historical = row({
      chainKeyId: OLD_KEY_MATERIAL.keyId,
      chainHmac: Buffer.alloc(32, 0),
    });
    const signedHistorical = {
      ...historical,
      chainHmac: computeAdminAuditChainHmac(historical, OLD_KEY, historical.chainPrev),
    };
    transaction.execute.mockResolvedValueOnce([dbRow(signedHistorical)]);
    const resolveForKeyId = jest.fn((keyId: string) => Promise.resolve(
      keyId === OLD_KEY_MATERIAL.keyId ? OLD_KEY_MATERIAL : null,
    ));
    const query = new PostgresAdminAuditQuery({} as DatabaseInstance, {
      resolve: () => Promise.resolve(KEY_MATERIAL),
      resolveForKeyId,
    });

    await expect(query.getAdminAudit(signedHistorical.id)).resolves.toMatchObject({
      id: signedHistorical.id,
      chain_key_id: OLD_KEY_MATERIAL.keyId,
      integrity: { status: 'verified', reason: null },
    });
    expect(resolveForKeyId).toHaveBeenCalledWith(OLD_KEY_MATERIAL.keyId);
  });
});
