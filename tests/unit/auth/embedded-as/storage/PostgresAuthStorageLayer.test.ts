import { describe, expect, it, jest } from '@jest/globals';

let transaction: {
  readonly insert: jest.Mock;
  readonly select?: jest.Mock;
  readonly execute?: jest.Mock;
  readonly update?: jest.Mock;
};
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: typeof transaction) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresAuthStorageLayer } = await import(
  '../../../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js'
);

describe('PostgresAuthStorageLayer', () => {
  it('reads the shared database clock for distributed auth leases', async () => {
    transaction = {
      insert: jest.fn(),
      execute: jest.fn(() => Promise.resolve([{ now_ms: '1770000000123' }])),
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await expect(storage.genericNow()).resolves.toBe(1_770_000_000_123);
    expect(sqlText(transaction.execute?.mock.calls[0]?.[0])).toContain('statement_timestamp()');
  });

  it('uses database time for generic record expiry and TTL calculation', async () => {
    const whereCalls: unknown[] = [];
    const valuesCalls: Array<Record<string, unknown>> = [];
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn((condition: unknown) => {
            whereCalls.push(condition);
            return { limit: jest.fn(() => Promise.resolve([])) };
          }),
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          valuesCalls.push(values);
          return { onConflictDoUpdate: jest.fn(() => Promise.resolve()) };
        }),
      })),
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await storage.genericGet('Session', 'session-1');
    await storage.genericSet('ModeFingerprint', 'current', { fingerprint: 'value' }, 60);

    expect(sqlText(whereCalls[0])).toContain('NOW()');
    expect(valuesCalls[0]?.expiresAt).not.toBeInstanceOf(Date);
    expect(sqlText(valuesCalls[0]?.expiresAt)).toContain('statement_timestamp()');
  });
  it('preserves an existing canonical user_id when AS account upsert has no user id', async () => {
    let conflictOptions: { readonly set?: Readonly<Record<string, unknown>> } | null = null;
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })),
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          onConflictDoUpdate: jest.fn((options: typeof conflictOptions) => {
            conflictOptions = options;
            return Promise.resolve();
          }),
        })),
      })),
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await storage.upsertAccount({
      sub: 'local_alice',
      provider: 'local',
      externalSub: 'alice',
      email: 'alice@example.test',
      emailVerified: false,
      createdAt: 1,
      updatedAt: 2,
    });

    expect(conflictOptions?.set?.userId).toBeDefined();
    expect(conflictOptions?.set?.userId).not.toBeNull();
  });

  it('rejects a late account upsert after account deletion wins the subject lock', async () => {
    const insert = jest.fn();
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([{ reason: 'account_deleted' }])),
          })),
        })),
      })),
      insert,
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await expect(storage.upsertAccount({
      sub: 'github_deleted',
      provider: 'github',
      externalSub: '42',
      email: 'deleted@example.test',
      emailVerified: true,
      createdAt: 1,
      updatedAt: 2,
    })).rejects.toThrow('auth subject belongs to a deleted account');

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a late identity audit event for a deleted account', async () => {
    const insert = jest.fn();
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([{ reason: 'account_deleted' }])),
          })),
        })),
      })),
      insert,
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await expect(storage.recordIdentityEvent({
      type: 'auth.oauth.token_issued',
      sub: 'github_deleted',
      timestamp: 2,
      details: { email: 'deleted@example.test' },
    })).rejects.toThrow('auth subject belongs to a deleted account');

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('keeps expiry OR predicates parenthesized when composing auth_kv lookups', async () => {
    const whereCalls: unknown[] = [];
    transaction = {
      insert: jest.fn(),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn((condition: unknown) => {
            whereCalls.push(condition);
            return { limit: jest.fn(() => Promise.resolve([])) };
          }),
        })),
      })),
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await storage.genericFindByUid('session-uid');

    expect(sqlText(whereCalls[0])).toContain('( IS NULL OR  > NOW())');
  });

  it('locks and revalidates a grant principal before persisting OIDC state', async () => {
    const returning = jest.fn(() => Promise.resolve([{ id: 'grant-1' }]));
    const insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(() => ({ returning })),
      })),
    }));
    const limit = jest.fn()
      .mockResolvedValueOnce([{ sub: 'github_42', userId: '00000000-0000-4000-8000-000000000001' }])
      .mockResolvedValueOnce([{ id: '00000000-0000-4000-8000-000000000001' }])
      .mockResolvedValueOnce([]);
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(() => ({ limit })) })) })),
      insert,
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await storage.genericSet('Grant', 'grant-1', { accountId: 'github_42' }, 60);

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledTimes(3);
    expect(transaction.execute.mock.invocationCallOrder[0])
      .toBeLessThan(insert.mock.invocationCallOrder[0]);
  });

  it('rejects a late OIDC grant write after account deletion wins the principal lock', async () => {
    const insert = jest.fn();
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })) })),
      })),
      insert,
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });

    await expect(storage.genericSet('Grant', 'grant-1', { accountId: 'github_deleted' }, 60))
      .rejects.toThrow('auth principal is no longer active');
    expect(insert).not.toHaveBeenCalled();
  });

  it('conditionally replaces a generic record only when its exact snapshot still wins', async () => {
    const returning = jest.fn()
      .mockResolvedValueOnce([{ id: 'mode-fingerprint' }])
      .mockResolvedValueOnce([]);
    const where = jest.fn(() => ({ returning }));
    const set = jest.fn(() => ({ where }));
    const update = jest.fn(() => ({ set }));
    transaction = {
      insert: jest.fn(),
      update,
    };
    const storage = new PostgresAuthStorageLayer({ db: {} as never });
    const expected = { authorizationGeneration: 1, fingerprint: 'old' };
    const replacement = { authorizationGeneration: 2, fingerprint: 'new' };

    await expect(storage.genericCompareAndSet(
      'ModeFingerprint',
      'current',
      expected,
      replacement,
    )).resolves.toBe(true);
    await expect(storage.genericCompareAndSet(
      'ModeFingerprint',
      'current',
      expected,
      replacement,
    )).resolves.toBe(false);

    expect(update).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, { payload: replacement, expiresAt: null });
    expect(sqlText(where.mock.calls[0]?.[0])).toContain('::jsonb');
  });
});

function sqlText(statement: unknown): string {
  return queryChunks(statement)
    .map(chunk => typeof chunk === 'object' && chunk !== null && 'value' in chunk
      ? stringChunkValue(chunk.value)
      : '')
    .join('');
}

function stringChunkValue(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('') : String(value);
}

function queryChunks(statement: unknown): readonly unknown[] {
  return typeof statement === 'object' && statement !== null && 'queryChunks' in statement
    ? (statement as { queryChunks: readonly unknown[] }).queryChunks.flatMap(queryChunks)
    : [statement];
}
