import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { describe, expect, it, jest } from '@jest/globals';

import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import type { AgentSnapshotReplacementRecord } from '../../../src/elements/agents/AgentSnapshotReplacementJournal.js';
import { ElementTransactionScope } from '../../../src/elements/base/ElementTransactionScope.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseAgentSnapshotReplacementJournal } from '../../../src/storage/DatabaseAgentSnapshotReplacementJournal.js';
import {
  afterAgentReplacementCommit,
  runInAgentReplacementTransaction,
} from '../../../src/storage/AgentReplacementTransactionContext.js';

describe('AgentReplacementTransactionContext', () => {
  it('routes database reads through the lease-owning transaction', async () => {
    const limit = jest.fn<() => Promise<Array<{ rawContent: string }>>>()
      .mockResolvedValue([{ rawContent: 'guarded bytes' }]);
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ limit }),
        }),
      }),
    } as unknown as DrizzleTx;
    const transaction = jest.fn<DatabaseInstance['transaction']>();
    const db = { transaction } as unknown as DatabaseInstance;
    const layer = new DatabaseStorageLayer(
      db,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      'agents',
    );
    const afterCommit: Array<() => void | Promise<void>> = [];

    const content = await runInAgentReplacementTransaction(
      tx,
      '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => layer.readContent('018f3d47-73ae-7f10-a0de-0742618d4fb2'),
      afterCommit,
    );

    expect(content).toBe('guarded bytes');
    expect(transaction).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('defers derived side effects until the owning transaction commits', async () => {
    const tx = {} as DrizzleTx;
    const afterCommit: Array<() => void | Promise<void>> = [];
    const callback = jest.fn();

    await runInAgentReplacementTransaction(
      tx,
      '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      async () => {
        expect(afterAgentReplacementCommit(callback)).toBe(true);
      },
      afterCommit,
    );

    expect(callback).not.toHaveBeenCalled();
    for (const operation of afterCommit) await operation();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not publish cache or state bookkeeping when the mutation-gate commit fails', async () => {
    const execute = jest.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const tx = { execute, select: activeUserSelect } as unknown as DrizzleTx;
    const transaction = jest.fn(async (operation: (activeTx: DrizzleTx) => Promise<unknown>) => {
      await operation(tx);
      throw new Error('forced commit failure');
    });
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      { transaction } as unknown as DatabaseInstance,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-a',
    );
    const visible = {
      cache: 'previous',
      persistedVersion: 3,
      appliedState: 'previous',
      definitionApplied: false,
    };

    await expect(journal.runWithAgentMutationGate('Test Agent', async () => {
      afterAgentReplacementCommit(() => {
        visible.cache = 'intended';
        visible.persistedVersion = 4;
        visible.appliedState = 'intended';
        visible.definitionApplied = true;
      });
    })).rejects.toThrow('forced commit failure');

    expect(visible).toEqual({
      cache: 'previous',
      persistedVersion: 3,
      appliedState: 'previous',
      definitionApplied: false,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('runs element rollback behavior when the outer database commit fails', async () => {
    const execute = jest.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const tx = { execute, select: activeUserSelect } as unknown as DrizzleTx;
    const commitFailure = new Error('forced outer commit failure');
    const transaction = jest.fn(async (operation: (activeTx: DrizzleTx) => Promise<unknown>) => {
      await operation(tx);
      throw commitFailure;
    });
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      { transaction } as unknown as DatabaseInstance,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-a',
    );
    const committed = jest.fn();
    const rolledBack = jest.fn<(error?: unknown) => void>();

    await expect(journal.runWithAgentMutationGate('Test Agent', async () => {
      const scope = new ElementTransactionScope('Agent', 'correlation-id');
      scope.addCommit(committed);
      scope.addRollback(rolledBack);
      await scope.run(async () => undefined);
    })).rejects.toThrow(commitFailure);

    expect(committed).not.toHaveBeenCalled();
    expect(rolledBack).toHaveBeenCalledTimes(1);
    expect(rolledBack).toHaveBeenCalledWith(commitFailure);
  });

  it('quarantines a malformed database journal without hiding an unrelated valid entry', async () => {
    const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
    const sessionId = 'session-a';
    const validOperationId = randomUUID();
    const malformedOperationId = randomUUID();
    const now = new Date();
    const validPayload = {
      version: 1,
      operationId: validOperationId,
      createdAt: now.toISOString(),
      ownerHost: 'test-host',
      ownerPid: process.pid,
      ownerIncarnation: null,
      ownerInstanceId: randomUUID(),
      recoveryNotBefore: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: now.toISOString(),
      leaseToken: randomUUID(),
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
        sessionId,
      },
      stateIncluded: false,
      previousAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      intendedAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    } as const;
    const validRow = {
      operationId: validOperationId,
      userId,
      sessionId,
      agentId: validPayload.stateKey.agentElementId,
      agentName: validPayload.agentName,
      ownerHost: validPayload.ownerHost,
      ownerPid: validPayload.ownerPid,
      ownerInstanceId: validPayload.ownerInstanceId,
      leaseToken: validPayload.leaseToken,
      heartbeatAt: now,
      leaseExpiresAt: now,
      payload: validPayload,
      createdAt: now,
      quarantinedAt: null,
      quarantineReason: null,
    };
    const malformedRow = {
      ...validRow,
      operationId: malformedOperationId,
      payload: {
        ...validPayload,
        operationId: malformedOperationId,
        previousAgentJson: '{not-json',
      },
    };
    const quarantineValues: unknown[] = [];
    const tx = {
      execute: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
      select: (selection?: unknown) => isActiveUserSelection(selection)
        ? activeUserSelect()
        : ({
            from: () => ({
              where: () => Promise.resolve([malformedRow, validRow]),
            }),
          }),
      update: () => ({
        set: (values: unknown) => {
          quarantineValues.push(values);
          return { where: () => Promise.resolve([]) };
        },
      }),
    } as unknown as DrizzleTx;
    const db = {
      transaction: async <T>(operation: (activeTx: DrizzleTx) => Promise<T>) => operation(tx),
    } as unknown as DatabaseInstance;
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      db,
      () => userId,
      () => sessionId,
    );

    const entries = await journal.list();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.record.operationId).toBe(validOperationId);
    expect(quarantineValues).toHaveLength(1);
    expect(quarantineValues[0]).toEqual(expect.objectContaining({
      quarantinedAt: expect.any(Date),
      quarantineReason: 'Agent replacement journal has an invalid schema',
      leaseExpiresAt: new Date(0),
    }));
  });

  it.each([
    ['PID reuse', { source: 'linux-proc', bootId: 'boot-a', processStartId: '200' }],
    ['host reboot', { source: 'linux-proc', bootId: 'boot-b', processStartId: '100' }],
  ] as const)('allows expired PostgreSQL lease takeover after %s', async (_label, currentIncarnation) => {
    const recordedIncarnation = {
      source: 'linux-proc' as const,
      bootId: 'boot-a',
      processStartId: '100',
    };
    const record: AgentSnapshotReplacementRecord = {
      version: 1,
      operationId: randomUUID(),
      createdAt: new Date(0).toISOString(),
      ownerHost: hostname(),
      ownerPid: process.pid,
      ownerIncarnation: recordedIncarnation,
      ownerInstanceId: randomUUID(),
      recoveryNotBefore: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString(),
      releasedAt: null,
      leaseToken: randomUUID(),
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: randomUUID(),
        sessionId: 'session-a',
      },
      stateIncluded: false,
      previousAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      intendedAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    };
    const db = { transaction: jest.fn() } as unknown as DatabaseInstance;
    const liveOwner = new DatabaseAgentSnapshotReplacementJournal(
      db,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-a',
      30_000,
      async () => recordedIncarnation,
    );
    const successor = new DatabaseAgentSnapshotReplacementJournal(
      db,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-b',
      30_000,
      async () => currentIncarnation,
    );

    await expect(liveOwner.isRecoveryEligible(record)).resolves.toBe(false);
    await expect(successor.isRecoveryEligible(record)).resolves.toBe(true);
  });

  it.each([
    ['recorded owner incarnation is missing', null, {
      source: 'linux-proc' as const,
      bootId: 'boot-a',
      processStartId: '100',
    }],
    ['current process incarnation is unavailable', {
      source: 'linux-proc' as const,
      bootId: 'boot-a',
      processStartId: '100',
    }, null],
  ] as const)('keeps an expired PostgreSQL journal owned when %s', async (
    _label,
    ownerIncarnation,
    currentIncarnation,
  ) => {
    const record: AgentSnapshotReplacementRecord = {
      version: 1,
      operationId: randomUUID(),
      createdAt: new Date(0).toISOString(),
      ownerHost: hostname(),
      ownerPid: process.pid,
      ownerIncarnation,
      ownerInstanceId: randomUUID(),
      recoveryNotBefore: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString(),
      releasedAt: null,
      leaseToken: randomUUID(),
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: randomUUID(),
        sessionId: 'session-a',
      },
      stateIncluded: false,
      previousAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      intendedAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    };
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      { transaction: jest.fn() } as unknown as DatabaseInstance,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-a',
      30_000,
      async () => currentIncarnation,
    );

    await expect(journal.isRecoveryEligible(record)).resolves.toBe(false);
  });

  it('allows an explicitly released PostgreSQL journal with unavailable incarnations', async () => {
    const record: AgentSnapshotReplacementRecord = {
      version: 1,
      operationId: randomUUID(),
      createdAt: new Date(0).toISOString(),
      ownerHost: hostname(),
      ownerPid: process.pid,
      ownerIncarnation: null,
      ownerInstanceId: randomUUID(),
      recoveryNotBefore: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString(),
      releasedAt: new Date().toISOString(),
      leaseToken: randomUUID(),
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: randomUUID(),
        sessionId: 'session-a',
      },
      stateIncluded: false,
      previousAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      intendedAgentJson: JSON.stringify({ metadata: { name: 'valid-agent' } }),
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    };
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      { transaction: jest.fn() } as unknown as DatabaseInstance,
      () => '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      () => 'session-a',
      30_000,
      async () => null,
    );

    await expect(journal.isRecoveryEligible(record)).resolves.toBe(true);
  });

  it('retains PostgreSQL journal ownership when the durable release update fails', async () => {
    const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
    const sessionId = 'session-a';
    let durableRow: Record<string, unknown> | null = null;
    let failRelease = true;
    const tx = {
      execute: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          durableRow = values;
        },
      }),
      select: (selection?: unknown) => isActiveUserSelection(selection)
        ? activeUserSelect()
        : ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: async () => [{
                    leaseToken: (durableRow as { leaseToken?: string } | null)?.leaseToken,
                  }],
                }),
              }),
            }),
          }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          return {
            where: () => ({
              returning: async () => {
                if (failRelease) throw new Error('forced PostgreSQL release failure');
                durableRow = { ...durableRow, ...values };
                return [{ operationId: (durableRow as { operationId?: string }).operationId }];
              },
            }),
          };
        },
      }),
    } as unknown as DrizzleTx;
    const db = {
      transaction: async <T>(operation: (activeTx: DrizzleTx) => Promise<T>) => operation(tx),
    } as unknown as DatabaseInstance;
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      db,
      () => userId,
      () => sessionId,
      30_000,
      async () => null,
    );
    const agentJson = JSON.stringify({ metadata: { name: 'valid-agent' } });
    const entry = await journal.create({
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: randomUUID(),
        sessionId,
      },
      stateIncluded: false,
      previousAgentJson: agentJson,
      intendedAgentJson: agentJson,
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    });

    await expect(journal.releaseOwnership(entry)).rejects.toThrow('forced PostgreSQL release failure');
    await expect(journal.runWhileOwned(entry, async () => 'still-owned')).resolves.toBe('still-owned');

    failRelease = false;
    await journal.releaseOwnership(entry);
    expect(durableRow).toEqual(expect.objectContaining({
      ownerProcessIncarnation: null,
      heartbeatAt: expect.any(Date),
      leaseExpiresAt: new Date(0),
      payload: expect.objectContaining({ releasedAt: expect.any(String) }),
    }));
    await expect(journal.runWhileOwned(entry, async () => undefined))
      .rejects.toThrow('lease was lost');
  });

  it.each(['release', 'remove', 'quarantine'] as const)(
    'retains PostgreSQL ownership when an outer %s transaction rolls back',
    async (teardown) => {
    const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
    const sessionId = 'session-a';
    let durableRow: Record<string, unknown> | null = null;
    const db = {
      transaction: async <T>(operation: (activeTx: DrizzleTx) => Promise<T>) => {
        let stagedRow = durableRow === null
          ? null
          : structuredClone(durableRow) as Record<string, unknown>;
        const tx = {
          execute: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
          insert: () => ({
            values: async (values: Record<string, unknown>) => {
              stagedRow = structuredClone(values);
            },
          }),
          select: (selection?: unknown) => isActiveUserSelection(selection)
            ? activeUserSelect()
            : ({
                from: () => ({
                  where: () => ({
                    for: () => ({
                      limit: async () => [{
                        leaseToken: (stagedRow as { leaseToken?: string } | null)?.leaseToken,
                      }],
                    }),
                  }),
                }),
              }),
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => ({
                returning: async () => {
                  if (!stagedRow) return [];
                  stagedRow = { ...stagedRow, ...structuredClone(values) };
                  return [{ operationId: stagedRow.operationId }];
                },
              }),
            }),
          }),
          delete: () => ({
            where: () => ({
              returning: async () => {
                if (!stagedRow) return [];
                const operationId = stagedRow.operationId;
                stagedRow = null;
                return [{ operationId }];
              },
            }),
          }),
        } as unknown as DrizzleTx;
        const result = await operation(tx);
        durableRow = stagedRow;
        return result;
      },
    } as unknown as DatabaseInstance;
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      db,
      () => userId,
      () => sessionId,
      30_000,
      async () => null,
    );
    const agentJson = JSON.stringify({ metadata: { name: 'valid-agent' } });
    const entry = await journal.create({
      agentName: 'valid-agent',
      filePath: randomUUID(),
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-agent',
        agentElementId: randomUUID(),
        sessionId,
      },
      stateIncluded: false,
      previousAgentJson: agentJson,
      intendedAgentJson: agentJson,
      previousDefinition: '',
      intendedDefinition: '',
      previousState: null,
      intendedState: null,
    });
    const teardownJournal = async (): Promise<void> => {
      if (teardown === 'release') {
        await journal.releaseOwnership(entry);
      } else if (teardown === 'remove') {
        await journal.remove(entry.record.operationId, entry.record.leaseToken);
      } else {
        await journal.quarantine(entry, 'forced test quarantine');
      }
    };

    await expect(journal.runWithAgentMutationGate('valid-agent', async () => {
      await teardownJournal();
      throw new Error('forced outer rollback');
    })).rejects.toThrow('forced outer rollback');

    const rolledBackRow = durableRow as Record<string, unknown> | null;
    if (!rolledBackRow) throw new Error('Expected durable replacement journal');
    expect(rolledBackRow.leaseToken).toBe(entry.record.leaseToken);
    expect((rolledBackRow.payload as { releasedAt?: unknown }).releasedAt).toBeNull();
    await expect(journal.runWhileOwned(entry, async () => 'still-owned'))
      .resolves.toBe('still-owned');

    await journal.runWithAgentMutationGate('valid-agent', teardownJournal);

    const finalizedRow = durableRow as Record<string, unknown> | null;
    if (teardown === 'release') {
      if (!finalizedRow) throw new Error('Expected released replacement journal');
      expect(finalizedRow.leaseToken).not.toBe(entry.record.leaseToken);
      expect((finalizedRow.payload as { releasedAt?: unknown }).releasedAt)
        .toEqual(expect.any(String));
    } else if (teardown === 'remove') {
      expect(finalizedRow).toBeNull();
    } else {
      if (!finalizedRow) throw new Error('Expected quarantined replacement journal');
      expect(Number.isFinite(Date.parse(String(finalizedRow.quarantinedAt)))).toBe(true);
      expect(finalizedRow.quarantineReason).toBe('forced test quarantine');
    }
    await expect(journal.runWhileOwned(entry, async () => undefined))
      .rejects.toThrow('lease was lost');
    },
  );
});

function activeUserSelect() {
  return {
    from: () => ({
      where: () => ({ limit: async () => [{ id: '018f3d47-73ae-7f10-a0de-0742618d4fb1' }] }),
    }),
  };
}

function isActiveUserSelection(selection: unknown): boolean {
  return !!selection && typeof selection === 'object' && Object.hasOwn(selection, 'id');
}
