/**
 * Unit tests for MemorySaveHandler's failure-ledger retry guard (#2329,
 * Codex review on PR #2336, hardened per Codex P1 on PR #2337).
 *
 * The ledger retains the failing Memory instance so recovery can re-save the
 * exact state that was lost. But bookkeeping keys are session-scoped: if a
 * DIFFERENT session (sharing the same portfolio) deletes the memory, this
 * session's ledger entry survives — and a blind retry at flush would re-save
 * the retained instance, resurrecting the deleted memory.
 *
 * The guard must fail closed (Codex P1): the ledger holds the LAST copy of
 * unpersisted entries, so it is dropped only on a storage-confirmed deletion
 * (manager.isMemoryDeleted() === true). Ambiguous lookups (probe throws)
 * retry the save rather than drop.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

function makeMemory(name: string) {
  return {
    metadata: { name },
    addEntry: jest.fn(async () => ({
      id: 'entry-1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      trustLevel: 'untrusted',
    })),
    removeEntry: jest.fn(() => true),
    getEntries: jest.fn(() => new Map()),
    clearAll: jest.fn(async () => undefined),
  };
}

describe('MemorySaveHandler failure-ledger retry guard (#2329)', () => {
  let memory: ReturnType<typeof makeMemory>;
  let manager: {
    find: jest.Mock;
    save: jest.Mock;
    assertPersistable: jest.Mock;
    isMemoryDeletedAt: jest.Mock;
    getMemoryProbeToken: jest.Mock;
  };
  let handler: MemorySaveHandler;

  beforeEach(() => {
    memory = makeMemory('doomed-memory');
    manager = {
      find: jest.fn(async () => memory),
      save: jest.fn(async () => undefined),
      assertPersistable: jest.fn(async () => undefined),
      isMemoryDeletedAt: jest.fn(async () => false),
      getMemoryProbeToken: jest.fn(() => '/portfolio/users/a/memories/doomed-memory.yaml'),
    };
    handler = new MemorySaveHandler(
      { memoryManager: manager } as unknown as HandlerRegistry,
      (name) => `session-a:${name}`,
    );
  });

  async function seedFailedSave() {
    // addEntry succeeds (pre-flight passes), then the deferred save fails at flush.
    await handler.dispatch('addEntry', { element_name: 'doomed-memory', content: 'entry content' });
    manager.save.mockRejectedValueOnce(new Error('EIO: simulated disk failure'));
    await handler.flushPendingSaves();
    expect(manager.save).toHaveBeenCalledTimes(1);
  }

  it('drops the ledger entry instead of retrying when deletion is storage-confirmed', async () => {
    await seedFailedSave();

    // Codex P1 (PR #2337): the probe target must have been resolved when the
    // failure was RECORDED (session context live), not at retry time — and the
    // retry must probe that captured token.
    expect(manager.getMemoryProbeToken).toHaveBeenCalledWith(memory);

    // Another session (same portfolio) deleted the memory: storage confirms ENOENT.
    manager.isMemoryDeletedAt.mockResolvedValue(true);
    manager.save.mockClear();

    await handler.flushPendingSaves();
    expect(manager.isMemoryDeletedAt).toHaveBeenCalledWith('/portfolio/users/a/memories/doomed-memory.yaml');
    // No resurrection: the retained instance must NOT be re-saved.
    expect(manager.save).not.toHaveBeenCalled();

    // Ledger cleared: a further flush does nothing either.
    await handler.flushPendingSaves();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('retries and recovers when the memory still exists', async () => {
    await seedFailedSave();
    manager.save.mockClear();

    await handler.flushPendingSaves();
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(memory);

    // Success cleared the ledger — nothing left to retry.
    manager.save.mockClear();
    await handler.flushPendingSaves();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('fails closed and retries when the deletion probe throws (Codex P1: transient lookup failures must not drop the last copy)', async () => {
    await seedFailedSave();
    manager.isMemoryDeletedAt.mockRejectedValue(new Error('transient storage read failure'));
    manager.save.mockClear();

    await handler.flushPendingSaves();
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(memory);
  });

  it('applies the same guard during session cleanup', async () => {
    await seedFailedSave();
    manager.isMemoryDeletedAt.mockResolvedValue(true);
    manager.save.mockClear();

    handler.cleanupSession('session-a');
    // cleanupSession fires asynchronously; give the microtask queue a turn.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('retains a failed cleanup retry for the shutdown flush', async () => {
    await seedFailedSave();
    manager.save.mockClear();
    manager.save.mockRejectedValueOnce(new Error('cleanup retry still unavailable'));

    handler.cleanupSession('session-a');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(manager.save).toHaveBeenCalledTimes(1);

    manager.save.mockClear();
    await handler.flushPendingSaves();
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(memory);

    manager.save.mockClear();
    await handler.flushPendingSaves();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
