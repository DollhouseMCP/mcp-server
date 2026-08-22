import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let rows: Record<string, unknown>[] = [];
let transaction: {
  execute: jest.Mock;
  select: jest.Mock;
  update: jest.Mock;
};

const withSystemContextMock = jest.fn((
  _db: unknown,
  callback: (tx: typeof transaction) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresSigningKeyStore } = await import(
  '../../../src/storage/signingKeys/PostgresSigningKeyStore.js'
);

const payloadEncryption = {
  encrypt: (payload: Record<string, unknown>) => payload,
  decrypt: (payload: unknown) => ({
    payload: payload as Record<string, unknown>,
    legacyPlaintext: false,
    rewrapRequired: false,
  }),
};

describe('PostgresSigningKeyStore consistent reads', () => {
  beforeEach(() => {
    withSystemContextMock.mockClear();
    rows = [];
    const terminal = {
      limit: jest.fn(() => Promise.resolve(rows)),
      orderBy: jest.fn(() => Promise.resolve(rows)),
    };
    const from = {
      where: jest.fn(() => terminal),
      for: jest.fn(() => Promise.resolve(rows)),
    };
    transaction = {
      execute: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => ({
        from: jest.fn(() => from),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve([])),
        })),
      })),
    };
  });

  it('selects and decodes an active key inside one shared-lock transaction', async () => {
    rows = [signingKeyRow('active-key', true)];
    const store = new PostgresSigningKeyStore({
      db: {} as never,
      payloadEncryption: payloadEncryption as never,
    });

    await expect(store.getActive('jwks')).resolves.toMatchObject({
      kid: 'active-key',
      active: true,
    });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(sqlText(transaction.execute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock_shared');
  });

  it('decodes an entire verification ring in one transaction', async () => {
    rows = [signingKeyRow('new-key', true), signingKeyRow('old-key', false)];
    const store = new PostgresSigningKeyStore({
      db: {} as never,
      payloadEncryption: payloadEncryption as never,
    });

    await expect(store.listByKind('jwks')).resolves.toHaveLength(2);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it('never rewrites a retained-key envelope during an ordinary read', async () => {
    rows = [signingKeyRow('retained-key', true)];
    const encryption = {
      encrypt: jest.fn((payload: Record<string, unknown>) => payload),
      decrypt: jest.fn((payload: unknown) => ({
        payload: payload as Record<string, unknown>,
        legacyPlaintext: false,
        rewrapRequired: true,
      })),
    };
    const store = new PostgresSigningKeyStore({
      db: {} as never,
      payloadEncryption: encryption as never,
    });

    await expect(store.getActive('jwks')).resolves.toMatchObject({ kid: 'retained-key' });
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('rewraps all required payloads only under the exclusive lifecycle lock', async () => {
    rows = [signingKeyRow('legacy-key', true)];
    const encryption = {
      encrypt: jest.fn((payload: Record<string, unknown>) => ({ encrypted: payload })),
      decrypt: jest.fn((payload: unknown) => ({
        payload: payload as Record<string, unknown>,
        legacyPlaintext: true,
        rewrapRequired: true,
      })),
    };
    const store = new PostgresSigningKeyStore({
      db: {} as never,
      payloadEncryption: encryption as never,
    });

    await expect(store.rewrapPayloadsUnderExclusiveLock()).resolves.toBe(1);
    expect(sqlText(transaction.execute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock');
    expect(sqlText(transaction.execute.mock.calls[0]?.[0])).not.toContain('lock_shared');
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });
});

function signingKeyRow(kid: string, active: boolean): Record<string, unknown> {
  return {
    kid,
    kind: 'jwks',
    payload: { kid, privateKey: {}, publicKey: {} },
    active,
    createdAt: new Date('2026-08-21T12:00:00.000Z'),
    rotatedAt: active ? null : new Date('2026-08-21T11:00:00.000Z'),
    retiredAt: null,
  };
}

function sqlText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: readonly unknown[] } | undefined)?.queryChunks ?? [];
  return chunks.map(chunk => {
    if (!chunk || typeof chunk !== 'object' || !('value' in chunk)) return '';
    return String((chunk as { value: readonly string[] }).value.join(''));
  }).join('');
}
