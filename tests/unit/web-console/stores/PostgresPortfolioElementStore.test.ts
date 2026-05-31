import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresPortfolioElementStore } = await import(
  '../../../../src/web-console/stores/PostgresPortfolioElementStore.js'
);
const {
  PortfolioElementAlreadyExistsError,
  PortfolioElementVersionConflictError,
} = await import('../../../../src/web-console/stores/IPortfolioElementStore.js');

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const NOW = new Date('2026-05-31T12:00:00.000Z');

function portfolioRow(overrides: Partial<{
  userId: string;
  type: 'personas' | 'skills';
  name: string;
  canonicalName: string;
  displayName: string | null;
  version: number;
  updatedAt: Date;
  validationStatus: 'valid' | 'invalid' | 'unknown';
  tags: string[];
  metadata: Record<string, unknown>;
  content: string;
}> = {}) {
  return {
    id: '70bd5f3d-0a5a-4f44-95d8-4e56dcfcb174',
    userId: USER_ID,
    type: 'personas' as const,
    name: 'analyst',
    canonicalName: 'analyst',
    displayName: 'Analyst',
    version: 1,
    updatedAt: NOW,
    validationStatus: 'valid' as const,
    tags: ['ops'],
    metadata: { source: 'test' },
    content: 'name: Analyst',
    ...overrides,
  };
}

function insertChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function returningChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function deleteChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate'), { code: '23505' });
}

describe('PostgresPortfolioElementStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transaction = {
      insert: jest.fn(),
      select: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
  });

  it('creates canonicalized user-owned portfolio elements', async () => {
    transaction.insert.mockReturnValue(insertChain([portfolioRow()]));
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.create({
      userId: USER_ID,
      type: 'personas',
      name: 'Analyst.md',
      displayName: 'Analyst',
      metadata: { source: 'test' },
      content: 'name: Analyst',
      tags: ['ops'],
      now: NOW,
    })).resolves.toMatchObject({
      userId: USER_ID,
      type: 'personas',
      name: 'analyst',
      canonicalName: 'analyst',
      version: 1,
    });

    expect(transaction.insert).toHaveBeenCalled();
    const values = (transaction.insert.mock.results[0]?.value as Record<string, jest.Mock>).values;
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      name: 'analyst',
      canonicalName: 'analyst',
      version: 1,
      validationStatus: 'valid',
    }));
  });

  it('maps unique constraint failures to portfolio conflict errors', async () => {
    const chain = insertChain([]);
    chain.returning.mockRejectedValue(uniqueViolation());
    transaction.insert.mockReturnValue(chain);
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.create({
      userId: USER_ID,
      type: 'personas',
      name: 'Analyst',
      displayName: null,
      metadata: {},
      content: 'content',
      tags: [],
      now: NOW,
    })).rejects.toBeInstanceOf(PortfolioElementAlreadyExistsError);
  });

  it('updates only the expected element version', async () => {
    transaction.update.mockReturnValue(returningChain([portfolioRow({ version: 2, content: 'updated' })]));
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.update({
      userId: USER_ID,
      type: 'personas',
      canonicalName: 'analyst',
      expectedVersion: 1,
      content: 'updated',
      now: NOW,
    })).resolves.toMatchObject({
      version: 2,
      content: 'updated',
    });

    const set = (transaction.update.mock.results[0]?.value as Record<string, jest.Mock>).set;
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      version: 2,
      updatedAt: NOW,
      validationStatus: 'valid',
      content: 'updated',
    }));
  });

  it('distinguishes stale versions from missing elements on update', async () => {
    transaction.update.mockReturnValue(returningChain([]));
    transaction.select.mockReturnValue(selectingChain([portfolioRow()]));
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.update({
      userId: USER_ID,
      type: 'personas',
      canonicalName: 'analyst',
      expectedVersion: 4,
      content: 'updated',
      now: NOW,
    })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
  });

  it('returns deleted records with the response version advanced', async () => {
    transaction.delete.mockReturnValue(deleteChain([portfolioRow({ version: 3 })]));
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.delete({
      userId: USER_ID,
      type: 'personas',
      canonicalName: 'analyst',
      expectedVersion: 3,
      now: NOW,
    })).resolves.toMatchObject({
      version: 4,
      updatedAt: NOW,
    });
  });

  it('lists summaries through the owner-scoped table query', async () => {
    transaction.select.mockReturnValue(selectingChain([portfolioRow(), portfolioRow({
      type: 'skills',
      name: 'reviewer',
      canonicalName: 'reviewer',
    })]));
    const store = new PostgresPortfolioElementStore({} as never);

    await expect(store.listByUser(USER_ID, { tag: 'OPS' })).resolves.toHaveLength(2);

    const selectChain = transaction.select.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(selectChain.where).toHaveBeenCalled();
    expect(selectChain.orderBy).toHaveBeenCalled();
  });
});
