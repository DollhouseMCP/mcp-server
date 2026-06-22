import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../../../src/database/connection.js';

const executeMock = jest.fn<() => Promise<unknown[]>>();

jest.unstable_mockModule('../../../../../src/database/admin.js', () => ({
  withSystemContext: jest.fn(async (_db, callback: (tx: { execute: typeof executeMock }) => Promise<unknown>) =>
    callback({ execute: executeMock }),
  ),
}));

const { PostgresRateLimitStore } = await import('../../../../../src/auth/embedded-as/storage/PostgresRateLimitStore.js');

describe('PostgresRateLimitStore', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('retries CAS conflicts with the latest stored state', async () => {
    executeMock
      .mockResolvedValueOnce([{ state: { failures: 1 }, version: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: { failures: 2 }, version: 2 }])
      .mockResolvedValueOnce([{ version: 3 }]);
    const store = new PostgresRateLimitStore({} as DatabaseInstance);
    const seenStates: Array<{ failures: number } | null> = [];

    const result = await store.update<{ failures: number }, number>(
      'login',
      'alice@example.com',
      (prev) => {
        seenStates.push(prev);
        const failures = (prev?.failures ?? 0) + 1;
        return { state: { failures }, result: failures };
      },
      { maxRetries: 2 },
    );

    expect(result).toEqual({ state: { failures: 3 }, result: 3 });
    expect(seenStates).toEqual([{ failures: 1 }, { failures: 2 }]);
    expect(executeMock).toHaveBeenCalledTimes(4);
  });

  it('throws when CAS conflicts exhaust retry budget', async () => {
    executeMock
      .mockResolvedValueOnce([{ state: { failures: 1 }, version: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: { failures: 2 }, version: 2 }])
      .mockResolvedValueOnce([]);
    const store = new PostgresRateLimitStore({} as DatabaseInstance);

    await expect(store.update(
      'login',
      'alice@example.com',
      (prev: { failures: number } | null) => ({
        state: { failures: (prev?.failures ?? 0) + 1 },
      }),
      { maxRetries: 2 },
    )).rejects.toThrow('Rate limit CAS failed after 2 attempts');
  });

  it('binds expiresAt as ISO text for timestamptz casts', async () => {
    const queries: unknown[] = [];
    executeMock.mockImplementation(async (query: unknown) => {
      queries.push(query);
      return queries.length === 1 ? [] : [{ version: 1 }];
    });
    const store = new PostgresRateLimitStore({} as DatabaseInstance);
    const expiresAt = Date.UTC(2026, 5, 2, 4, 0, 0);

    await store.update(
      'open_dcr_registration',
      '198.51.100.25',
      () => ({ state: { count: 1, windowStartedAt: expiresAt } }),
      { expiresAt },
    );

    const insertQuery = queries[1] as { queryChunks?: unknown[] };
    expect(insertQuery.queryChunks).toContain('2026-06-02T04:00:00.000Z');
    expect(insertQuery.queryChunks?.some((chunk) => chunk instanceof Date)).toBe(false);
  });
});
