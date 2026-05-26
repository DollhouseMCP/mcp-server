import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { IdempotencyRecord } from '../../../../src/web-console/stores/IIdempotencyStore.js';

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
const { PostgresConsoleIdentityResolver } = await import(
  '../../../../src/web-console/identity/PostgresConsoleIdentityResolver.js'
);
const { ConsoleStoreConflictError, ConsoleStoreValidationError } = await import(
  '../../../../src/web-console/stores/ConsoleStoreValidation.js'
);

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
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
    authSub: 'github_user-7',
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

function idempotencyRecord(): IdempotencyRecord {
  return {
    consoleSessionIdHash: hash(1),
    idempotencyKey: 'a51d7564-c85e-4e11-b319-dbc156d26f70',
    httpMethod: 'POST',
    canonicalTarget: '/api/v1/me/sessions/revoke',
    requestFingerprint: hash(7),
    responseStatus: 204,
    responseBody: null,
    createdAt: NOW,
    expiresAt: ONE_HOUR,
  };
}

function returningChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
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

    await expect(store.saveCompleted(idempotencyRecord())).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('clones retained response state returned from PostgreSQL', async () => {
    const row = { ...idempotencyRecord(), responseBody: { ok: true } };
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
});

describe('PostgresConsoleIdentityResolver', () => {
  it('returns the queried canonical security state for an enabled principal', async () => {
    transaction.select = jest.fn(() => selectingChain([{
      sub: 'github_user-7',
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
    }]));
    const resolver = new PostgresConsoleIdentityResolver({} as DatabaseInstance);

    await expect(resolver.resolveEnabledPrincipal('github_user-7')).resolves.toEqual({
      sub: 'github_user-7',
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
    });
  });
});
