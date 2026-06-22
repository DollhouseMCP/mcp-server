import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const {
  PostgresSessionActivationEventSink,
  PostgresSessionActivationStateAdapter,
} = await import('../../../../src/web-console/modules/activations/PostgresSessionActivationStateAdapter.js');

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SESSION_ID = 'runtime-session-1';
const NOW = new Date('2026-05-31T12:00:00.000Z');

function activationRow(overrides: Partial<{
  sessionId: string;
  elementType: 'personas' | 'skills';
  elementName: string;
  activatedAt: Date;
}> = {}) {
  return {
    sessionId: SESSION_ID,
    elementType: 'personas' as const,
    elementName: 'analyst',
    activatedAt: NOW,
    ...overrides,
  };
}

function selectingChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function insertChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn(() => chain);
  chain.onConflictDoNothing = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function deleteChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

describe('PostgresSessionActivationStateAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transaction = {
      select: jest.fn(),
      insert: jest.fn(),
      delete: jest.fn(),
    };
  });

  it('lists activation records ordered by the PostgreSQL query', async () => {
    transaction.select.mockReturnValue(selectingChain([
      activationRow(),
      activationRow({ elementType: 'skills', elementName: 'reviewer' }),
    ]));
    const adapter = new PostgresSessionActivationStateAdapter({} as never, () => NOW);

    await expect(adapter.list(SESSION_ID)).resolves.toEqual([
      { type: 'personas', name: 'analyst', activatedAt: NOW },
      { type: 'skills', name: 'reviewer', activatedAt: NOW },
    ]);

    const chain = transaction.select.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(chain.where).toHaveBeenCalled();
    expect(chain.orderBy).toHaveBeenCalled();
  });

  it('inserts a new activation and reports changed', async () => {
    transaction.insert.mockReturnValue(insertChain([activationRow()]));
    const adapter = new PostgresSessionActivationStateAdapter({} as never, () => NOW);

    await expect(adapter.activate(SESSION_ID, 'personas', 'analyst')).resolves.toEqual({
      record: { type: 'personas', name: 'analyst', activatedAt: NOW },
      changed: true,
    });

    const insert = transaction.insert.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(insert.values).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      elementType: 'personas',
      elementName: 'analyst',
      activatedAt: NOW,
    });
    expect(insert.onConflictDoNothing).toHaveBeenCalled();
  });

  it('returns the existing activation when insert conflicts', async () => {
    transaction.insert.mockReturnValue(insertChain([]));
    transaction.select.mockReturnValue(selectingChain([activationRow({ activatedAt: new Date('2026-05-31T11:00:00.000Z') })]));
    const adapter = new PostgresSessionActivationStateAdapter({} as never, () => NOW);

    await expect(adapter.activate(SESSION_ID, 'personas', 'analyst')).resolves.toEqual({
      record: {
        type: 'personas',
        name: 'analyst',
        activatedAt: new Date('2026-05-31T11:00:00.000Z'),
      },
      changed: false,
    });
  });

  it('deactivates only matching activation records', async () => {
    transaction.delete.mockReturnValue(deleteChain([{ sessionId: SESSION_ID }]));
    const adapter = new PostgresSessionActivationStateAdapter({} as never, () => NOW);

    await expect(adapter.deactivate(SESSION_ID, 'personas', 'analyst')).resolves.toBe(true);

    const chain = transaction.delete.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(chain.where).toHaveBeenCalled();
    expect(chain.returning).toHaveBeenCalled();
  });
});

describe('PostgresSessionActivationEventSink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transaction = {
      insert: jest.fn(),
    };
  });

  it('persists private activation-change events', async () => {
    transaction.insert.mockReturnValue({
      values: jest.fn(() => Promise.resolve([])),
    });
    const sink = new PostgresSessionActivationEventSink({} as never);

    await sink.recordActivationChanged({
      type: 'console.session.activation.changed.v1',
      userId: USER_ID,
      sessionId: SESSION_ID,
      elementType: 'personas',
      elementName: 'analyst',
      action: 'activated',
      occurredAt: NOW,
    });

    const insert = transaction.insert.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(insert.values).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      elementType: 'personas',
      elementName: 'analyst',
      action: 'activated',
      occurredAt: NOW,
    });
  });
});
