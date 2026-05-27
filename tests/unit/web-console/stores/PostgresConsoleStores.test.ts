import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
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
const { PostgresIdempotencyStore } = await import(
  '../../../../src/web-console/stores/PostgresIdempotencyStore.js'
);
const { PostgresConsoleFactorStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleFactorStore.js'
);
const { PostgresConsoleAccountAdminStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js'
);
const { PostgresConsoleSecurityInvalidationStore } = await import(
  '../../../../src/web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js'
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
    grantedCapabilities: ['console:self'],
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
    email: 'alice@example.test',
    email_verified: true,
    auth_methods: ['github'],
    roles: ['account_admin'],
    disabled_at: null,
    created_at: NOW,
    last_login_at: FIVE_MINUTES.getTime(),
    admin_factor_enrolled: true,
    account_correlation_id: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
    authz_version: 3,
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
      grantedCapabilities: ['console:self', 'console:admin:audit'],
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
      grantedCapabilities: ['console:self'],
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

  it('rejects unvalidated capabilities read from database state', async () => {
    transaction.select = jest.fn(() => selectingChain([sessionRow({
      grantedCapabilities: ['console:self', 'console:admin:unknown'],
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

  it('uses conditional touch results and counts bulk revocation and cleanup writes', async () => {
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.touch(hash(1), {
      lastUsedAt: FOUR_MINUTES,
      idleExpiresAt: THIRTY_MINUTES,
    }, FOUR_MINUTES)).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(1) }, { idHash: hash(2) }]));
    await expect(store.revokeForUser(USER_ID, FIVE_MINUTES)).resolves.toBe(2);

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
    transaction.select = jest.fn(() => selectingChain([{
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: FIVE_MINUTES,
    }]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: true,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: FIVE_MINUTES,
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
  it('returns the queried canonical security state for an enabled principal', async () => {
    transaction.select = jest.fn(() => selectingChain([{
      sub: PRIMARY_SUB,
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
    }]));
    const resolver = new PostgresConsoleIdentityResolver({} as DatabaseInstance);

    await expect(resolver.resolveEnabledPrincipal(PRIMARY_SUB)).resolves.toEqual({
      sub: PRIMARY_SUB,
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
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
      email: 'alice@example.test',
      emailVerified: true,
      authMethods: ['github'],
      roles: ['account_admin'],
      disabledAt: null,
      createdAt: NOW,
      lastLoginAt: FIVE_MINUTES,
      adminFactorEnrolled: true,
      accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
      authzVersion: 3,
    }]);

    transaction.execute = jest.fn(() => Promise.resolve([principalProjectionRow({ roles: ['unknown'] })]));
    await expect(store.findPrincipal(USER_ID)).rejects.toThrow('unknown administrative role');

    transaction.execute = jest.fn(() => Promise.resolve([row]));
    await expect(store.findPrincipalByAccountCorrelationId('7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8'))
      .resolves.toMatchObject({ userId: USER_ID, accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8' });
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
    const ackChain = insertChain();
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
