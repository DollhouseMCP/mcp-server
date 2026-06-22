import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { UserIntegrationRecord } from '../../../../src/web-console/stores/IUserIntegrationStore.js';
import type { PortfolioSyncJobRecord } from '../../../../src/web-console/stores/IPortfolioSyncJobStore.js';
import type {
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyRequestIdentity,
} from '../../../../src/web-console/stores/IIdempotencyStore.js';
import type { ConsoleAdminAuditEvent } from '../../../../src/web-console/audit/IAdminAuditWriter.js';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresConsoleSessionStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleSessionStore.js'
);
const { PostgresLoginTransactionStore } = await import(
  '../../../../src/web-console/stores/PostgresLoginTransactionStore.js'
);
const { PostgresUserIntegrationStore } = await import(
  '../../../../src/web-console/stores/PostgresUserIntegrationStore.js'
);
const { PostgresPortfolioSyncJobStore } = await import(
  '../../../../src/web-console/stores/PostgresPortfolioSyncJobStore.js'
);
const { PostgresIdempotencyStore } = await import(
  '../../../../src/web-console/stores/PostgresIdempotencyStore.js'
);
const { PostgresConsoleFactorStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleFactorStore.js'
);
const { PostgresConsoleAccountAdminStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js'
);
const { PostgresConsoleAccountAllowlistStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js'
);
const { PostgresConsoleSecurityInvalidationStore } = await import(
  '../../../../src/web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js'
);
const { PostgresRuntimeSessionControlStore } = await import(
  '../../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js'
);
const { PostgresAdminAuditWriter } = await import(
  '../../../../src/web-console/audit/PostgresAdminAuditWriter.js'
);
const { PostgresAccountAdminMutationTransactionRunner } = await import(
  '../../../../src/web-console/modules/account-admin/AccountAdminMutationTransaction.js'
);
const { PostgresConsoleIdentityResolver } = await import(
  '../../../../src/web-console/identity/PostgresConsoleIdentityResolver.js'
);
const { desc } = await import('drizzle-orm');
const { accountFactors } = await import('../../../../src/database/schema/index.js');
const { ConsoleStoreConflictError, ConsoleStoreValidationError } = await import(
  '../../../../src/web-console/stores/ConsoleStoreValidation.js'
);
const { PortfolioSyncAlreadyPendingError } = await import(
  '../../../../src/web-console/stores/IPortfolioSyncJobStore.js'
);

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const PRIMARY_SUB = 'github_user-7';
const AUDIT_KEY_ID = 'audit-key-test';
const BEFORE_NOW = new Date('2026-05-26T11:59:00.000Z');
const NOW = new Date('2026-05-26T12:00:00.000Z');
const FOUR_MINUTES = new Date('2026-05-26T12:04:00.000Z');
const FIVE_MINUTES = new Date('2026-05-26T12:05:00.000Z');
const THIRTY_MINUTES = new Date('2026-05-26T12:30:00.000Z');
const ONE_HOUR = new Date('2026-05-26T13:00:00.000Z');
const ALICE_EMAIL = 'alice@example.test';
const ALICE_DISPLAY_EMAIL = 'Alice@Example.Test';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const ALLOWLIST_ID = 'f0a8d9e6-b1a1-4d94-b600-bef99c8d4ed1';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';
const RUNTIME_SESSION_ID = 'mcp-session-1';
const RUNTIME_COMMAND_ID = '9f8a54b9-f195-41f0-802d-d0ec2fdfb30f';
const SELF_CAPABILITY = 'console:self';

function hash(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function sessionRow(overrides: Partial<ConsoleSessionRecord & {
  elevatedCapabilities: string[];
  elevationExpiresAt: Date | null;
  elevationAcr: string | null;
  elevationAmr: string[] | null;
  elevationAuthTime: Date | null;
}> = {}) {
  return {
    idHash: hash(1),
    userId: USER_ID,
    authSub: PRIMARY_SUB,
    csrfTokenHash: hash(2),
    grantedCapabilities: [SELF_CAPABILITY],
    elevatedCapabilities: [],
    elevationExpiresAt: null,
    elevationAcr: null,
    elevationAmr: null,
    elevationAuthTime: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    idleExpiresAt: THIRTY_MINUTES,
    absoluteExpiresAt: ONE_HOUR,
    revokedAt: null,
    lastIp: null,
    userAgent: null,
    ...overrides,
  };
}

function loginTransaction(): ConsoleLoginTransaction {
  return {
    idHash: hash(3),
    flowKind: 'login',
    stateHash: hash(4),
    pkceVerifierEnc: Buffer.from('ciphertext'),
    userId: null,
    consoleSessionIdHash: null,
    requestedCapability: null,
    returnTo: '/api/v1/me',
    createdAt: NOW,
    expiresAt: FIVE_MINUTES,
    consumedAt: null,
  };
}

function userIntegrationRow(overrides: Partial<UserIntegrationRecord> = {}) {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'github',
    externalAccountLabel: 'alice',
    externalInstallationId: 'installation-123',
    authorizedPermissions: {
      repository_selection: 'selected',
      permissions: { contents: 'read' },
    },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'integration-key-v1',
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function portfolioSyncJobRow(overrides: Partial<PortfolioSyncJobRecord> = {}) {
  return {
    id: '90dc6b61-d6d8-455a-adb1-a227e7fdbf77',
    userId: USER_ID,
    integrationId: INTEGRATION_ID,
    direction: 'pull',
    conflictPolicy: 'fail',
    status: 'queued',
    claimVersion: 0,
    claimedByWorkerId: null,
    leaseUntil: null,
    attemptCount: 0,
    resultSummary: null,
    operationalErrorCode: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function idempotencyIdentity(): IdempotencyRequestIdentity {
  return {
    consoleSessionIdHash: hash(1),
    idempotencyKey: 'a51d7564-c85e-4e11-b319-dbc156d26f70',
    httpMethod: 'POST',
    canonicalTarget: '/api/v1/me/sessions/revoke',
    requestFingerprint: hash(7),
    createdAt: NOW,
    expiresAt: ONE_HOUR,
  };
}

function idempotencyClaim(): IdempotencyClaim {
  return {
    ...idempotencyIdentity(),
    claimId: 'bbe7c4c5-b59e-4bd0-9f8d-c892577ba944',
  };
}

function idempotencyRecord(): IdempotencyRecord {
  return {
    ...idempotencyClaim(),
    state: 'completed',
    responseStatus: 204,
    responseBodyPresent: false,
    responseBody: null,
  };
}

function returningChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function insertChain(rows: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn(() => chain);
  chain.onConflictDoUpdate = jest.fn(() => chain);
  chain.onConflictDoNothing = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingOrderedChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingJoinedChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function factorRow(overrides: Partial<{
  userId: string;
  factorId: string;
  factorType: 'totp';
  secretCiphertext: Buffer | null;
  enrolledAt: Date;
  disabledAt: Date | null;
  lastUsedAt: Date | null;
}> = {}) {
  return {
    userId: USER_ID,
    factorId: 'cd8f6d0e-7294-42bc-9e01-094890a820a8',
    factorType: 'totp' as const,
    secretCiphertext: Buffer.from('encrypted-totp-seed'),
    enrolledAt: NOW,
    disabledAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function roleRow(overrides: Partial<{
  id: string;
  userId: string;
  role: 'admin' | 'account_admin' | 'operator' | 'auditor' | 'security_admin';
  grantedAt: Date;
  grantedByUserId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}> = {}) {
  return {
    id: '117f4897-f16d-4402-b6bb-b95f18ea5e40',
    userId: USER_ID,
    role: 'account_admin' as const,
    grantedAt: NOW,
    grantedByUserId: null,
    revokedAt: null,
    revokedByUserId: null,
    ...overrides,
  };
}

function roleMutationRow(overrides: Partial<ReturnType<typeof roleRow>> = {}) {
  const row = roleRow(overrides);
  return {
    role: {
      id: row.id,
      userId: row.userId,
      role: row.role,
      grantedAt: row.grantedAt,
      grantedByUserId: row.grantedByUserId,
      revokedAt: row.revokedAt,
      revokedByUserId: row.revokedByUserId,
    },
  };
}

function principalProjectionRow(overrides: Partial<{
  user_id: string;
  primary_sub: string | null;
  username: string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean | null;
  auth_methods: string[] | null;
  roles: string[] | null;
  disabled_at: Date | null;
  created_at: Date;
  last_login_at: number | null;
  admin_factor_enrolled: boolean;
  account_correlation_id: string;
  authz_version: number;
}> = {}) {
  return {
    user_id: USER_ID,
    primary_sub: PRIMARY_SUB,
    username: 'alice',
    display_name: 'Alice',
    email: ALICE_EMAIL,
    email_verified: true,
    auth_methods: ['github'],
    roles: ['account_admin'],
    disabled_at: null,
    created_at: NOW,
    last_login_at: FIVE_MINUTES.getTime(),
    admin_factor_enrolled: true,
    account_correlation_id: ACCOUNT_CORRELATION_ID,
    authz_version: 3,
    ...overrides,
  };
}

function allowlistRow(overrides: Partial<{
  id: string;
  kind: 'email' | 'github_username' | 'github_id';
  normalizedValue: string;
  displayValue: string;
  note: string | null;
  createdByUserId: string;
  createdAt: Date;
  revokedByUserId: string | null;
  revokedAt: Date | null;
}> = {}) {
  return {
    id: ALLOWLIST_ID,
    kind: 'email' as const,
    normalizedValue: ALICE_EMAIL,
    displayValue: ALICE_DISPLAY_EMAIL,
    note: 'initial',
    createdByUserId: USER_ID,
    createdAt: FIVE_MINUTES,
    revokedByUserId: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  withSystemContextMock.mockClear();
  transaction = {};
});

describe('PostgresConsoleSessionStore', () => {
  it('uses one conditional update to attach elevation rather than a select/write race', async () => {
    const chain = returningChain([{ idHash: hash(1) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.setElevation(hash(1), {
      capabilities: ['console:admin:audit'],
      expiresAt: THIRTY_MINUTES,
      acr: 'urn:dollhouse:acr:admin',
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).resolves.toBe(true);

    expect(transaction.select).not.toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:audit'],
      elevatedCapabilities: ['console:admin:audit'],
    }));
  });

  it('clears elevation with one active-session conditional update', async () => {
    const chain = returningChain([{ idHash: hash(1) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevation(hash(1), FIVE_MINUTES)).resolves.toBe(true);

    expect(transaction.select).not.toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith({
      grantedCapabilities: [SELF_CAPABILITY],
      elevatedCapabilities: [],
      elevationExpiresAt: null,
      elevationAcr: null,
      elevationAmr: null,
      elevationAuthTime: null,
    });
  });

  it('returns false when clearing elevation updates no active elevated row', async () => {
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevation(hash(1), FIVE_MINUTES)).resolves.toBe(false);
  });

  it('clears all active elevated sessions for a user through a system-context conditional update', async () => {
    const chain = returningChain([{ idHash: hash(1) }, { idHash: hash(2) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevationsForUser(USER_ID, FIVE_MINUTES)).resolves.toBe(2);

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).not.toHaveBeenCalled();
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledWith({
      grantedCapabilities: [SELF_CAPABILITY],
      elevatedCapabilities: [],
      elevationExpiresAt: null,
      elevationAcr: null,
      elevationAmr: null,
      elevationAuthTime: null,
    });
    expect(chain.where).toHaveBeenCalledWith(expect.anything());
  });

  it('rejects unvalidated capabilities read from database state', async () => {
    transaction.select = jest.fn(() => selectingChain([sessionRow({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:unknown'],
    })]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.findActiveByIdHash(hash(1), FOUR_MINUTES))
      .rejects.toThrow(ConsoleStoreValidationError);
  });

  it('clones validated database state before returning it to callers', async () => {
    const row = sessionRow();
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    const returned = await store.findActiveByIdHash(hash(1), FOUR_MINUTES);
    returned?.idHash.fill(0);
    returned?.csrfTokenHash.fill(0);
    returned?.createdAt.setTime(0);

    expect(row.idHash).toEqual(hash(1));
    expect(row.csrfTokenHash).toEqual(hash(2));
    expect(row.createdAt).toEqual(NOW);
  });

  it('lists active sessions for a user ordered by recent use', async () => {
    const row = sessionRow({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:security'],
      elevatedCapabilities: ['console:admin:security'],
      elevationExpiresAt: THIRTY_MINUTES,
      elevationAcr: 'urn:dollhouse:acr:admin',
      elevationAmr: ['otp'],
      elevationAuthTime: FIVE_MINUTES,
    });
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    const sessions = await store.listActiveForUser(USER_ID, FOUR_MINUTES, 25);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.elevation?.expiresAt).toEqual(THIRTY_MINUTES);

    const chain = transaction.select.mock.results[0]?.value;
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(25);
  });

  it('uses conditional touch results and counts bulk revocation and cleanup writes', async () => {
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.touch(hash(1), {
      lastUsedAt: FOUR_MINUTES,
      idleExpiresAt: THIRTY_MINUTES,
    }, FOUR_MINUTES)).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(1) }, { idHash: hash(2) }]));
    await expect(store.revokeForUser(USER_ID, FIVE_MINUTES)).resolves.toBe(2);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(1) }]));
    await expect(store.revokeForUserSession(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.revokeForUserSession(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(2) }]));
    await expect(store.revokeForUserExcept(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(1);

    transaction.delete = jest.fn(() => returningChain([{ idHash: hash(1) }]));
    await expect(store.sweepExpired(ONE_HOUR)).resolves.toBe(1);
  });
});

describe('PostgresLoginTransactionStore', () => {
  it('normalizes duplicate transaction inserts to a store conflict', async () => {
    const conflict = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.reject(conflict)),
    }));
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.create(loginTransaction())).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('clones consumed encrypted transaction data returned from PostgreSQL', async () => {
    const row = { ...loginTransaction(), consumedAt: FOUR_MINUTES };
    const chain = returningChain([row]);
    transaction.update = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    const returned = await store.consume(hash(3), hash(4), FOUR_MINUTES);
    returned?.stateHash.fill(0);
    returned?.pkceVerifierEnc.fill(0);

    expect(row.stateHash).toEqual(hash(4));
    expect(row.pkceVerifierEnc).toEqual(Buffer.from('ciphertext'));
  });

  it('deletes consumed or expired transient transaction rows', async () => {
    transaction.delete = jest.fn(() => returningChain([{ idHash: hash(3) }]));
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.sweepExpired(FIVE_MINUTES)).resolves.toBe(1);
  });
});

describe('PostgresUserIntegrationStore', () => {
  it('lists active user integrations and clones credential ciphertext', async () => {
    const row = userIntegrationRow();
    const chain = selectingChain([row]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    const rows = await store.listByUser(USER_ID);
    rows[0]?.accessTokenCiphertext?.fill(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: row.id,
      userId: USER_ID,
      provider: 'github',
      externalAccountLabel: 'alice',
    });
    expect(row.accessTokenCiphertext).toEqual(Buffer.from('encrypted-access-token'));
    expect(chain.limit).toHaveBeenCalledWith(25);
  });

  it('finds one active provider integration for a user', async () => {
    const chain = selectingChain([userIntegrationRow()]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toMatchObject({
      provider: 'github',
      userId: USER_ID,
    });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });
});

describe('PostgresPortfolioSyncJobStore', () => {
  it('creates and finds owner-scoped portfolio sync jobs', async () => {
    const row = portfolioSyncJobRow();
    transaction.insert = jest.fn(() => insertChain([row]));
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.create({
      userId: USER_ID,
      integrationId: row.integrationId,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    })).resolves.toMatchObject({
      id: row.id,
      userId: USER_ID,
      status: 'queued',
    });
    await expect(store.findById(USER_ID, row.id)).resolves.toMatchObject({
      id: row.id,
      userId: USER_ID,
    });
  });

  it('maps pending-job unique violations to an already-pending error', async () => {
    transaction.insert = jest.fn(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.create({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    })).rejects.toThrow(PortfolioSyncAlreadyPendingError);
  });

  it('claims queued jobs with one atomic skip-locked update', async () => {
    const running = portfolioSyncJobRow({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      attemptCount: 1,
      startedAt: NOW,
    });
    transaction.execute = jest.fn(() => Promise.resolve([running]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.claimNext({
      workerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      now: NOW,
    })).resolves.toMatchObject({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
    });
    expect(transaction.execute).toHaveBeenCalledWith(expect.objectContaining({
      queryChunks: expect.any(Array),
    }));
  });

  it('returns null when atomic claim finds no eligible job', async () => {
    transaction.execute = jest.fn(() => Promise.resolve([]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.claimNext({
      workerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      now: NOW,
    })).resolves.toBeNull();
  });

  it('rejects stale completion and updates renew/fail rows through fenced predicates', async () => {
    const queued = portfolioSyncJobRow();
    const running = portfolioSyncJobRow({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      attemptCount: 1,
      startedAt: NOW,
    });
    const failed = portfolioSyncJobRow({
      ...running,
      status: 'failed',
      claimedByWorkerId: null,
      leaseUntil: null,
      resultSummary: { failed: 1 },
      operationalErrorCode: 'provider_unavailable',
      completedAt: FIVE_MINUTES,
    });
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.complete({
      jobId: queued.id,
      claimVersion: 0,
      resultSummary: { imported: 1 },
      completedAt: FIVE_MINUTES,
    })).resolves.toBeNull();

    transaction.update = jest.fn(() => returningChain([running]));
    await expect(store.renewLease({
      jobId: queued.id,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: THIRTY_MINUTES,
      now: NOW,
    })).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.renewLease({
      jobId: queued.id,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: THIRTY_MINUTES,
      now: FIVE_MINUTES,
    })).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([failed]));
    await expect(store.fail({
      jobId: queued.id,
      claimVersion: 1,
      operationalErrorCode: 'provider_unavailable',
      resultSummary: { failed: 1 },
      completedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      status: 'failed',
      operationalErrorCode: 'provider_unavailable',
    });
  });
});

describe('PostgresIdempotencyStore', () => {
  it('returns ownership of a newly inserted pending claim', async () => {
    const deleting = { where: jest.fn(() => Promise.resolve([])) };
    const pendingInsert = {
      onConflictDoNothing: jest.fn(() => ({
        returning: jest.fn(() => Promise.resolve([{}])),
      })),
    };
    const inserting = { values: jest.fn(() => pendingInsert) };
    transaction.delete = jest.fn(() => deleting);
    transaction.insert = jest.fn(() => inserting);
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    const result = await store.claim(idempotencyIdentity());

    expect(result).toMatchObject({
      kind: 'claimed',
      claim: idempotencyIdentity(),
    });
    expect(result.kind === 'claimed' && result.claim.claimId)
      .toMatch(/^[0-9a-f-]{36}$/);
    expect(inserting.values).toHaveBeenCalledWith(expect.objectContaining({
      state: 'pending',
      responseStatus: null,
      responseBodyPresent: null,
      responseBody: null,
    }));
  });

  it('reports a typed conflict if the winning record is no longer visible after insert conflict', async () => {
    const deleting = { where: jest.fn(() => Promise.resolve([])) };
    const inserting = {
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
      })),
    };
    transaction.delete = jest.fn(() => deleting);
    transaction.insert = jest.fn(() => inserting);
    transaction.select = jest.fn(() => selectingChain([]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.claim(idempotencyIdentity())).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('clones retained response state returned from PostgreSQL', async () => {
    const row = {
      ...idempotencyRecord(),
      responseStatus: 200,
      responseBodyPresent: true,
      responseBody: { ok: true },
    };
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    const returned = await store.find(hash(1), row.idempotencyKey, FOUR_MINUTES);
    returned?.requestFingerprint.fill(0);
    (returned?.responseBody as { ok: boolean }).ok = false;

    expect(row.requestFingerprint).toEqual(hash(7));
    expect(row.responseBody).toEqual({ ok: true });
  });

  it('rejects corrupt completed rows and counts deleted expired responses', async () => {
    transaction.select = jest.fn(() => selectingChain([{
      ...idempotencyRecord(),
      httpMethod: 'GET',
    }]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);
    await expect(store.find(hash(1), idempotencyRecord().idempotencyKey, FOUR_MINUTES))
      .rejects.toThrow(ConsoleStoreValidationError);

    transaction.delete = jest.fn(() => returningChain([{ idempotencyKey: idempotencyRecord().idempotencyKey }]));
    await expect(store.sweepExpired(ONE_HOUR)).resolves.toBe(1);
  });

  it('completes only the active pending claim token', async () => {
    const completed = idempotencyRecord();
    transaction.update = jest.fn(() => returningChain([completed]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.complete(idempotencyClaim(), {
      responseStatus: 204,
      responseBodyPresent: false,
      responseBody: null,
    })).resolves.toMatchObject({ state: 'completed', responseStatus: 204 });
  });

  it('rejects corrupt pending rows read during an insert conflict', async () => {
    transaction.delete = jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) }));
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
      })),
    }));
    transaction.select = jest.fn(() => selectingChain([{
      ...idempotencyClaim(),
      state: 'pending',
      httpMethod: 'GET',
      responseStatus: null,
      responseBodyPresent: null,
      responseBody: null,
    }]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.claim(idempotencyIdentity())).rejects.toThrow(ConsoleStoreValidationError);
  });
});

describe('PostgresConsoleFactorStore', () => {
  it('normalizes duplicate active TOTP inserts to a store conflict', async () => {
    const conflict = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.reject(conflict)),
    }));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.createTotpFactor(factorRow(), [hash(11)])).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('returns status-only active factor projection', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{
        factorId: '22222222-2222-4222-8222-222222222222',
        factorType: 'totp',
        enrolledAt: NOW,
        disabledAt: null,
        lastUsedAt: FIVE_MINUTES,
      }]))
      .mockReturnValueOnce(selectingChain([{ count: 2 }]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: true,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: FIVE_MINUTES,
      backupCodesRemaining: 2,
    });
  });

  it('falls back to latest disabled factor metadata when no active factor exists', async () => {
    const activeChain = selectingChain([]);
    const disabledChain = selectingChain([{
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: FIVE_MINUTES,
      lastUsedAt: FOUR_MINUTES,
    }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(activeChain)
      .mockReturnValueOnce(disabledChain);
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: false,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: FIVE_MINUTES,
      lastUsedAt: FOUR_MINUTES,
      backupCodesRemaining: 0,
    });
    expect(disabledChain.orderBy).toHaveBeenCalledWith(desc(accountFactors.disabledAt));
  });

  it('returns empty status when no active or disabled factor exists', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: false,
      factorType: null,
      enrolledAt: null,
      disabledAt: null,
      lastUsedAt: null,
      backupCodesRemaining: 0,
    });
  });

  it('clones AS-only active factor material from PostgreSQL', async () => {
    const row = factorRow();
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    const returned = await store.getActiveTotpFactorForAs(USER_ID);
    returned?.secretCiphertext.fill(0);

    expect(row.secretCiphertext).toEqual(Buffer.from('encrypted-totp-seed'));
  });

  it('rejects corrupt factor rows with an explicit null-ciphertext error', async () => {
    transaction.select = jest.fn(() => selectingChain([factorRow({ secretCiphertext: null })]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getActiveTotpFactorForAs(USER_ID))
      .rejects.toThrow('unexpected NULL ciphertext for active TOTP factor row');
  });

  it('conditionally updates factor use and rejects non-matching use attempts', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ factorId: factorRow().factorId }]));
    await expect(store.markTotpUsed(USER_ID, factorRow().factorId, FIVE_MINUTES)).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.markTotpUsed(USER_ID, '7acb0d42-8772-4326-a08f-f816b59fc176', FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.markTotpUsed(USER_ID, factorRow().factorId, BEFORE_NOW)).resolves.toBe(false);
  });

  it('consumes a matching active backup code once', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    const chain = returningChain([{ codeId: '7acb0d42-8772-4326-a08f-f816b59fc176' }]);
    transaction.update = jest.fn(() => chain);

    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(true);
    expect(chain.set).toHaveBeenCalledWith({ usedAt: FIVE_MINUTES });
    expect(chain.where).toHaveBeenCalledWith(expect.anything());

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(false);
  });

  it('does not consume backup codes for inactive, foreign, or not-yet-created factors', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));

    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), BEFORE_NOW)).resolves.toBe(false);
  });

  it('disables with a matching backup code in one transactional store operation', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([{ codeId: '7acb0d42-8772-4326-a08f-f816b59fc176' }]))
      .mockReturnValueOnce(returningChain([{ factorId: factorRow().factorId }]));

    await expect(store.disableActiveTotpWithBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES))
      .resolves.toBe(true);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('conditionally disables active TOTP and permits re-enrollment after disable', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ factorId: factorRow().factorId }]));
    await expect(store.disableActiveTotp(USER_ID, FIVE_MINUTES)).resolves.toBe(true);

    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.resolve()),
    }));
    await expect(store.createTotpFactor(factorRow({
      factorId: '7acb0d42-8772-4326-a08f-f816b59fc176',
      enrolledAt: FIVE_MINUTES,
    }), [hash(11), hash(12)])).resolves.toBeUndefined();

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.disableActiveTotp(USER_ID, FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.disableActiveTotp(USER_ID, BEFORE_NOW)).resolves.toBe(false);
  });
});

describe('PostgresConsoleIdentityResolver', () => {
  it('returns the canonical security state with roles from user_admin_roles', async () => {
    // The resolver does two selects: the principal (sub→user), then the active
    // roles from user_admin_roles (the authoritative per-user role store).
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{
        sub: PRIMARY_SUB,
        userId: USER_ID,
        disabledAt: null,
        authzVersion: 4,
      }]))
      .mockReturnValueOnce(selectingOrderedChain([{ role: 'admin' }]));
    const resolver = new PostgresConsoleIdentityResolver({} as DatabaseInstance);

    await expect(resolver.resolveEnabledPrincipal(PRIMARY_SUB)).resolves.toEqual({
      sub: PRIMARY_SUB,
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
      roles: ['admin'],
    });
  });
});

describe('PostgresConsoleAccountAdminStore', () => {
  it('writes role grants through the role table and bumps principal authz version', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.insert = jest.fn(() => insertChain([roleRow()]));
    transaction.update = jest.fn(() => returningChain([]));

    await expect(store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ userId: USER_ID, role: 'account_admin' });

    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it('translates duplicate role grants to a store conflict', async () => {
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);

    await expect(store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    })).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('revokes account-admin roles through an atomic orphan-checked statement', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([roleMutationRow({ revokedAt: FIVE_MINUTES, revokedByUserId: SECOND_USER_ID })]);
    transaction.update = jest.fn();

    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'account_admin',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ revokedAt: FIVE_MINUTES });

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('revokes non-account-admin roles and bumps authz version in one system transaction', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([roleRow({
        role: 'operator',
        revokedAt: FIVE_MINUTES,
        revokedByUserId: SECOND_USER_ID,
      })]))
      .mockReturnValueOnce(returningChain([]));

    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'operator',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ revokedAt: FIVE_MINUTES });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('returns null for no-op role and principal state changes', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'operator',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toBeNull();

    transaction.execute = jest.fn(() => Promise.resolve([]));
    await expect(store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES })).resolves.toBeNull();
    await expect(store.enablePrincipal({ userId: USER_ID, enabledAt: THIRTY_MINUTES })).resolves.toBeNull();
  });

  it('counts enabled account administrators', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.execute = jest.fn(() => Promise.resolve([{ count: '2' }]));
    await expect(store.countEnabledAccountsAdmins()).resolves.toBe(2);
  });

  it('bumps authz_version when disabling and enabling principals', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.execute = jest.fn(() => Promise.resolve([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }]));

    await expect(store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES }))
      .resolves.toEqual({ userId: USER_ID, authzVersion: 2, disabledAt: FIVE_MINUTES, changedAt: FIVE_MINUTES });

    transaction.update = jest.fn(() => returningChain([{ userId: USER_ID, authzVersion: 3, disabledAt: null }]));
    await expect(store.enablePrincipal({ userId: USER_ID, enabledAt: THIRTY_MINUTES }))
      .resolves.toEqual({ userId: USER_ID, authzVersion: 3, disabledAt: null, changedAt: THIRTY_MINUTES });
  });

  it('projects account directory rows without private content', async () => {
    const row = principalProjectionRow();
    transaction.execute = jest.fn(() => Promise.resolve([row]));
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);

    await expect(store.listPrincipals({ sub: PRIMARY_SUB, limit: 20 })).resolves.toEqual([{
      userId: USER_ID,
      primarySub: PRIMARY_SUB,
      username: 'alice',
      displayName: 'Alice',
      email: ALICE_EMAIL,
      emailVerified: true,
      authMethods: ['github'],
      roles: ['account_admin'],
      disabledAt: null,
      createdAt: NOW,
      lastLoginAt: FIVE_MINUTES,
      adminFactorEnrolled: true,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      authzVersion: 3,
    }]);

    transaction.execute = jest.fn(() => Promise.resolve([principalProjectionRow({ roles: ['unknown'] })]));
    await expect(store.findPrincipal(USER_ID)).rejects.toThrow('unknown administrative role');

    transaction.execute = jest.fn(() => Promise.resolve([row]));
    await expect(store.findPrincipalByAccountCorrelationId(ACCOUNT_CORRELATION_ID))
      .resolves.toMatchObject({ userId: USER_ID, accountCorrelationId: ACCOUNT_CORRELATION_ID });
  });

  it('updates principal display name before re-projecting account metadata', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ id: USER_ID }]));
    transaction.execute = jest.fn(() => Promise.resolve([principalProjectionRow({ display_name: 'Alice Console' })]));

    await expect(store.updatePrincipalProfile({
      userId: USER_ID,
      displayName: 'Alice Console',
      updatedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      userId: USER_ID,
      displayName: 'Alice Console',
    });
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(1);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.updatePrincipalProfile({
      userId: USER_ID,
      displayName: null,
      updatedAt: FIVE_MINUTES,
    })).resolves.toBeNull();
  });
});

describe('PostgresConsoleSecurityInvalidationStore', () => {
  it('appends invalidation events and lists them by durable sequence', async () => {
    const row = {
      sequenceId: 7,
      eventId: 'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      kind: 'principal_disabled' as const,
      urgency: 'acknowledged' as const,
      userId: USER_ID,
      consoleSessionIdHash: null,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    };
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    transaction.insert = jest.fn(() => insertChain([row]));

    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    })).resolves.toMatchObject({ sequenceId: 7, eventId: row.eventId });

    transaction.select = jest.fn(() => selectingChain([row]));
    await expect(store.listEventsAfter(6, 10)).resolves.toHaveLength(1);
  });

  it('records monotonic cursors, live leases, and acknowledgements with upserts', async () => {
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    const cursorChain = insertChain();
    const leaseChain = insertChain();
    const ackChain = insertChain([{ commandId: RUNTIME_COMMAND_ID }]);
    transaction.insert = jest.fn()
      .mockReturnValueOnce(cursorChain)
      .mockReturnValueOnce(leaseChain)
      .mockReturnValueOnce(ackChain);

    await expect(store.recordReplicaCursor('replica-a', 7, FIVE_MINUTES)).resolves.toBeUndefined();
    await expect(store.acquireReplicaLease({
      replicaId: 'replica-a',
      renewedAt: FIVE_MINUTES,
      leaseUntil: THIRTY_MINUTES,
    })).resolves.toBeUndefined();
    await expect(store.acknowledgeEvent(
      'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      'replica-a',
      THIRTY_MINUTES,
    )).resolves.toBeUndefined();

    expect(transaction.insert).toHaveBeenCalledTimes(3);
    expect(cursorChain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ lastSequenceId: expect.anything() }),
    }));
    expect(ackChain.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.any(Array),
    }));
    expect(ackChain.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('reads cursors, live replicas, and acknowledgement IDs', async () => {
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{ lastSequenceId: 12 }]))
      .mockReturnValueOnce(selectingOrderedChain([{ replicaId: 'replica-a' }, { replicaId: 'replica-b' }]))
      .mockReturnValueOnce(selectingOrderedChain([{ replicaId: 'replica-b' }]));

    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(0);
    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(12);
    await expect(store.listLiveReplicaIds(FIVE_MINUTES)).resolves.toEqual(['replica-a', 'replica-b']);
    await expect(store.listAcknowledgedReplicaIds('e6174fd8-f6ef-4286-8bd2-3f3eb30194c1'))
      .resolves.toEqual(['replica-b']);
  });
});

describe('PostgresRuntimeSessionControlStore', () => {
  const presenceRow = {
    sessionId: RUNTIME_SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    replicaId: 'replica-a',
    transport: 'streamable-http' as const,
    clientName: 'Dollhouse CLI',
    clientVersion: '1.0.0',
    startedAt: NOW,
    lastActiveAt: FIVE_MINUTES,
    requestCount: 3,
    errorCount: 1,
    leaseUntil: THIRTY_MINUTES,
    status: 'active' as const,
    closedAt: null,
  };
  const commandRow = {
    commandId: RUNTIME_COMMAND_ID,
    kind: 'terminate_session',
    sessionId: RUNTIME_SESSION_ID,
    targetReplicaId: 'replica-a',
    reason: 'admin_terminated' as const,
    requestedAt: NOW,
    requestedByKind: 'admin' as const,
    requestedByUserId: SECOND_USER_ID,
    invalidationEventId: null,
  };
  const ackRow = {
    commandId: RUNTIME_COMMAND_ID,
    replicaId: 'replica-a',
    acknowledgedAt: FIVE_MINUTES,
    result: 'terminated' as const,
    errorCode: null,
  };

  it('upserts runtime presence and maps heartbeat/closing updates', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    const registerChain = insertChain([presenceRow]);
    const heartbeatChain = returningChain([presenceRow]);
    const closingChain = returningChain([{ ...presenceRow, status: 'closing', closedAt: THIRTY_MINUTES }]);
    transaction.insert = jest.fn(() => registerChain);
    transaction.update = jest.fn()
      .mockReturnValueOnce(heartbeatChain)
      .mockReturnValueOnce(closingChain);

    await expect(store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: 'streamable-http',
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    })).resolves.toMatchObject({
      sessionId: RUNTIME_SESSION_ID,
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
    });
    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: FIVE_MINUTES,
      requestCount: 3,
      errorCount: 1,
      leaseUntil: THIRTY_MINUTES,
    })).resolves.toMatchObject({ kind: 'updated', presence: { requestCount: 3, errorCount: 1 } });
    await expect(store.markPresenceClosing(RUNTIME_SESSION_ID, THIRTY_MINUTES))
      .resolves.toMatchObject({ status: 'closing', closedAt: THIRTY_MINUTES });

    expect(registerChain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ sessionId: RUNTIME_SESSION_ID }),
    }));
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('reads runtime presence for self/admin/operator projections', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([presenceRow]))
      .mockReturnValueOnce(selectingChain([presenceRow]))
      .mockReturnValueOnce(selectingChain([presenceRow]));

    await expect(store.findPresence(RUNTIME_SESSION_ID, NOW)).resolves.toMatchObject({ sessionId: RUNTIME_SESSION_ID });
    await expect(store.listPresenceByUser(USER_ID, { now: NOW })).resolves.toHaveLength(1);
    await expect(store.listOperationalPresence({ now: NOW })).resolves.toHaveLength(1);
  });

  it('sweeps stale runtime presence rows', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.delete = jest.fn(() => returningChain([{ sessionId: RUNTIME_SESSION_ID }]));

    await expect(store.sweepStalePresence(ONE_HOUR)).resolves.toBe(1);

    expect(transaction.delete).toHaveBeenCalledTimes(1);
  });

  it('creates runtime termination commands and idempotent acknowledgements', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    const commandChain = insertChain([commandRow]);
    const ackChain = insertChain([{ commandId: RUNTIME_COMMAND_ID }]);
    transaction.insert = jest.fn()
      .mockReturnValueOnce(commandChain)
      .mockReturnValueOnce(ackChain);

    await expect(store.createTerminationCommand({
      commandId: RUNTIME_COMMAND_ID,
      sessionId: RUNTIME_SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'admin_terminated',
      requestedAt: NOW,
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    })).resolves.toMatchObject({
      commandId: RUNTIME_COMMAND_ID,
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    });
    await expect(store.acknowledgeCommand({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
    })).resolves.toBe(true);

    expect(commandChain.returning).toHaveBeenCalled();
    expect(ackChain.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.anything(),
    }));
  });

  it('reads pending commands and acknowledgements', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingJoinedChain([{ command: commandRow }]))
      .mockReturnValueOnce(selectingChain([ackRow]));

    await expect(store.listPendingCommandsForReplica('replica-a')).resolves.toEqual([
      expect.objectContaining({ commandId: RUNTIME_COMMAND_ID }),
    ]);
    await expect(store.getCommandAck(RUNTIME_COMMAND_ID)).resolves.toEqual({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
      errorCode: null,
    });
  });

  it('maps lost heartbeat ownership reasons for missing, replica-mismatched, and closing sessions', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]));
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{ replicaId: 'replica-b', status: 'active' }]))
      .mockReturnValueOnce(selectingChain([{ replicaId: 'replica-a', status: 'closing' }]));

    const heartbeat = {
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: FIVE_MINUTES,
      requestCount: 3,
      errorCount: 1,
      leaseUntil: THIRTY_MINUTES,
    };
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'missing' });
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'replica_mismatch' });
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'closing' });
  });
});

describe('PostgresAdminAuditWriter', () => {
  it('serializes audit appends through the admin chain head', async () => {
    const event = adminAuditEvent();
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 5);
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([{ sequence_id: '1', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(event)).resolves.toBeUndefined();

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(sqlText(0)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(1)).toContain('FOR UPDATE');
    expect(sqlText(2)).toContain('INSERT INTO admin_audit_events');
    expect(sqlText(3)).toContain('UPDATE admin_audit_chain_heads');

    const insertChunks = sqlChunks(2);
    expect(insertChunks).toContain(AUDIT_KEY_ID);
    expect(insertChunks).toContain(null);
    expect(insertChunks).toContainEqual(expectedAuditHmac(event, key, null));
    expect(sqlChunks(3)).toContain(returnedChainHmac);
  });

  it('chains subsequent audit events to the previous HMAC value', async () => {
    const event = adminAuditEvent();
    const previous = Buffer.alloc(32, 4);
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 6);
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: '7', last_chain_hmac: previous }])
      .mockResolvedValueOnce([{ sequence_id: '8', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(event)).resolves.toBeUndefined();

    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(sqlChunks(2)).toContainEqual(previous);
    expect(sqlChunks(2)).toContainEqual(expectedAuditHmac(event, key, previous));
    expect(sqlChunks(3)).toContainEqual(returnedChainHmac);
  });

  it('rejects missing audit chain rows and missing inserted audit rows', async () => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(writer.write(adminAuditEvent())).rejects.toThrow('admin audit chain head is unavailable');

    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(adminAuditEvent())).rejects.toThrow('admin audit append did not return a row');
  });

  it('rejects oversized redacted audit payloads before writing', async () => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn();

    await expect(writer.write(adminAuditEvent({
      argsRedacted: { value: 'x'.repeat(4096) },
    }))).rejects.toThrow('argsRedacted');

    expect(transaction.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['actorConsoleSessionHash', { actorConsoleSessionHash: Buffer.alloc(31, 8) }, 'actor session hash'],
    ['actorSub', { actorSub: ' ' }, 'actorSub'],
    ['actorCapabilityRole', { actorCapabilityRole: ' ' as never }, 'actorCapabilityRole'],
    ['endpoint', { endpoint: ' ' }, 'endpoint'],
    ['operation', { operation: ' ' }, 'operation'],
    ['correlationId', { correlationId: ' ' }, 'correlationId'],
  ])('validates audit event field %s', async (_field, overrides, message) => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn();

    await expect(writer.write(adminAuditEvent(overrides))).rejects.toThrow(message);
    expect(transaction.execute).not.toHaveBeenCalled();
  });
});

describe('PostgresConsoleAccountAllowlistStore', () => {
  it('uses active-entry filters and maps allowlist rows without exposing revoked history', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn(() => selectingOrderedChain([allowlistRow()]));

    await expect(store.listActive()).resolves.toEqual([{
      id: ALLOWLIST_ID,
      kind: 'email',
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
      note: 'initial',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
      revokedByUserId: null,
      revokedAt: null,
    }]);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it('finds a single active allowlist row by id', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn(() => selectingChain([allowlistRow()]));

    await expect(store.findActive(ALLOWLIST_ID)).resolves.toMatchObject({
      id: ALLOWLIST_ID,
      normalizedValue: ALICE_EMAIL,
    });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it('checks account allowlist sign-in authority through active rows only', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: ALLOWLIST_ID }]))
      .mockReturnValueOnce(selectingChain([{ id: ALLOWLIST_ID }]))
      .mockReturnValueOnce(selectingChain([]));

    await expect(store.hasActiveEntries()).resolves.toBe(true);
    await expect(store.matchesIdentity({ email: 'Alice@Example.Test' })).resolves.toBe(true);
    await expect(store.matchesIdentity({ githubId: '123' })).resolves.toBe(false);
    expect(transaction.select).toHaveBeenCalledTimes(3);
  });

  it('normalizes inserted allowlist values and maps duplicate active entries to conflicts', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    const insert = insertChain([allowlistRow()]);
    transaction.insert = jest.fn(() => insert);

    await expect(store.add({
      kind: 'email',
      value: ` ${ALICE_DISPLAY_EMAIL} `,
      note: 'initial',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
    });
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
    }));

    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    await expect(store.add({
      kind: 'email',
      value: ALICE_EMAIL,
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('updates and removes only active allowlist rows', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    const update = returningChain([allowlistRow({ note: null })]);
    transaction.update = jest.fn(() => update);

    await expect(store.update({
      id: ALLOWLIST_ID,
      note: null,
    })).resolves.toMatchObject({ note: null });
    expect(update.set).toHaveBeenCalledWith({ note: null });

    transaction.select = jest.fn(() => selectingChain([allowlistRow({ note: 'initial' })]));
    transaction.update = jest.fn();
    await expect(store.update({ id: ALLOWLIST_ID })).resolves.toMatchObject({ note: 'initial' });
    expect(transaction.update).not.toHaveBeenCalled();

    const remove = returningChain([allowlistRow({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    })]);
    transaction.update = jest.fn(() => remove);
    await expect(store.remove({
      id: ALLOWLIST_ID,
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    })).resolves.toMatchObject({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    });
    expect(remove.set).toHaveBeenCalledWith({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    });
  });
});

describe('PostgresAccountAdminMutationTransactionRunner', () => {
  it('composes account mutation, invalidation append, and audit append in one system transaction', async () => {
    const auditEvent = adminAuditEvent();
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 5);
    const invalidationRow = {
      sequenceId: 7,
      eventId: 'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      kind: 'principal_disabled' as const,
      urgency: 'acknowledged' as const,
      userId: USER_ID,
      consoleSessionIdHash: null,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    };
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      db: {} as DatabaseInstance,
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
      },
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([{ sequence_id: '1', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);
    transaction.insert = jest.fn(() => insertChain([invalidationRow]));

    const result = await runner.run(async tx => {
      const stateChange = await tx.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES });
      const invalidation = await tx.appendSecurityInvalidationEvent({
        kind: 'principal_disabled',
        urgency: 'acknowledged',
        userId: USER_ID,
        authzVersion: stateChange?.authzVersion ?? null,
        reason: 'admin_disabled',
        payload: { revokedSessions: 1 },
        createdAt: FIVE_MINUTES,
        createdByUserId: SECOND_USER_ID,
      });
      await tx.writeAdminAuditEvent(auditEvent);
      return { stateChange, invalidation };
    });

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(result.stateChange).toEqual({
      userId: USER_ID,
      authzVersion: 2,
      disabledAt: FIVE_MINUTES,
      changedAt: FIVE_MINUTES,
    });
    expect(result.invalidation).toMatchObject({ sequenceId: 7, eventId: invalidationRow.eventId });
    expect(transaction.execute).toHaveBeenCalledTimes(5);
    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(sqlText(0)).toContain('UPDATE users');
    expect(sqlText(1)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(3)).toContain('INSERT INTO admin_audit_events');
  });

  it('propagates audit append failures so the transaction can roll back the mutation', async () => {
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      db: {} as DatabaseInstance,
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(runner.run(async tx => {
      await tx.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES });
      await tx.writeAdminAuditEvent(adminAuditEvent());
    })).rejects.toThrow('admin audit chain head is unavailable');

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(3);
    expect(sqlText(0)).toContain('UPDATE users');
    expect(sqlText(1)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(2)).toContain('FOR UPDATE');
  });

  it('propagates operation callback failures through the transaction boundary', async () => {
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      db: {} as DatabaseInstance,
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });

    await expect(runner.run(async () => {
      await Promise.resolve();
      throw new Error('abort');
    })).rejects.toThrow('abort');

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate role grants to a typed conflict through the transaction runner path', async () => {
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      db: {} as DatabaseInstance,
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));

    await expect(runner.run(tx => tx.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    }))).rejects.toThrow(ConsoleStoreConflictError);

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });
});

function adminAuditEvent(overrides: Partial<ConsoleAdminAuditEvent> = {}): ConsoleAdminAuditEvent {
  return {
    occurredAt: FIVE_MINUTES,
    actorUserId: USER_ID,
    actorSub: PRIMARY_SUB,
    actorRole: null,
    actorCapabilityRole: 'account_admin',
    actorConsoleSessionHash: hash(8),
    capability: 'console:admin:accounts',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: BEFORE_NOW,
    correlationId: '497ed92c-22a8-4a6f-87e3-5b458bfe9d38',
    endpoint: 'POST /api/v1/admin/accounts/users/{user_id}/disable',
    operation: 'accounts.user.disable',
    resourceKind: 'user',
    resourceId: USER_ID,
    targetUserId: USER_ID,
    argsRedacted: { reason: 'bounded' },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { authzVersion: 2 },
    clientIp: '192.0.2.10',
    userAgent: 'console-test',
    ...overrides,
  };
}

function sqlChunks(callIndex: number): readonly unknown[] {
  const statement = transaction.execute.mock.calls[callIndex]?.[0] as { queryChunks?: readonly unknown[] } | undefined;
  return statement?.queryChunks ?? [];
}

function sqlText(callIndex: number): string {
  return sqlChunks(callIndex)
    .map(chunk => typeof chunk === 'object' && chunk !== null && 'value' in chunk
      ? String((chunk as { value: readonly string[] }).value.join(''))
      : '')
    .join('');
}

function expectedAuditHmac(event: ConsoleAdminAuditEvent, key: Buffer, chainPrev: Buffer | null): Buffer {
  const canonical = JSON.stringify({
    occurredAt: event.occurredAt.toISOString(),
    actorUserId: event.actorUserId,
    actorSub: event.actorSub,
    actorRole: event.actorRole,
    actorCapabilityRole: event.actorCapabilityRole,
    actorConsoleSessionHash: event.actorConsoleSessionHash.toString('hex'),
    capability: event.capability,
    elevationAcr: event.elevationAcr,
    elevationAmr: [...event.elevationAmr],
    elevationAuthTime: event.elevationAuthTime ? event.elevationAuthTime.toISOString() : null,
    endpoint: event.endpoint,
    operation: event.operation,
    resourceKind: event.resourceKind,
    resourceId: event.resourceId,
    targetUserId: event.targetUserId,
    argsRedacted: event.argsRedacted,
    result: event.result,
    errorCode: event.errorCode,
    resultDetailRedacted: event.resultDetailRedacted,
    correlationId: event.correlationId,
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    chainPrev: chainPrev ? chainPrev.toString('hex') : null,
  });
  return createHmac('sha256', key).update(canonical).digest();
}
