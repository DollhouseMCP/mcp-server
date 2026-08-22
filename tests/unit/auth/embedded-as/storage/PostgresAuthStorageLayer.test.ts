import { describe, expect, it, jest } from '@jest/globals';

let transaction: {
  readonly insert: jest.Mock;
  readonly select?: jest.Mock;
  readonly execute?: jest.Mock;
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
  it('preserves an existing canonical user_id when AS account upsert has no user id', async () => {
    let conflictOptions: { readonly set?: Readonly<Record<string, unknown>> } | null = null;
    transaction = {
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

  it('gates same-process advisory locks before they consume the nested-work connection budget', async () => {
    transaction = {
      insert: jest.fn(),
      execute: jest.fn(async () => undefined),
    };
    withSystemContextMock.mockClear();
    const firstStorage = new PostgresAuthStorageLayer({ db: {} as never });
    const secondStorage = new PostgresAuthStorageLayer({ db: {} as never });
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const secondOperation = jest.fn(async () => undefined);

    const first = firstStorage.withGenericLock('AuthModeFingerprint', 'current', async () => {
      markFirstEntered?.();
      await firstBlocked;
    });
    await firstEntered;
    // Use a different record to prove the local gate protects the pool budget,
    // while PostgreSQL remains responsible for record-specific fencing.
    const second = secondStorage.withGenericLock('AnotherModel', 'another-key', secondOperation);
    await Promise.resolve();

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(withSystemContextMock).toHaveBeenCalledTimes(2);
    expect(secondOperation).toHaveBeenCalledTimes(1);
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
