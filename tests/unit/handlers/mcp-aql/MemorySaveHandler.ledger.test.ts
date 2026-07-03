/**
 * Unit tests for MemorySaveHandler's failure-ledger retry guard (#2329,
 * Codex review on PR #2336).
 *
 * The ledger retains the failing Memory instance so recovery can re-save the
 * exact state that was lost. But bookkeeping keys are session-scoped: if a
 * DIFFERENT session (sharing the same portfolio) deletes the memory, this
 * session's ledger entry survives — and a blind retry at flush would re-save
 * the retained instance, resurrecting the deleted memory. Every ledger retry
 * must therefore re-check existence through the entry's own manager first.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

function makeMemory(name: string) {
  return {
    metadata: { name },
    addEntry: jest.fn(async () => ({ id: 'entry-1' })),
    removeEntry: jest.fn(() => true),
    getEntries: jest.fn(() => new Map()),
    clearAll: jest.fn(async () => undefined),
  };
}

describe('MemorySaveHandler failure-ledger retry guard (#2329)', () => {
  let memory: ReturnType<typeof makeMemory>;
  let manager: { find: jest.Mock; save: jest.Mock; assertPersistable: jest.Mock };
  let handler: MemorySaveHandler;

  beforeEach(() => {
    memory = makeMemory('doomed-memory');
    manager = {
      find: jest.fn(async () => memory),
      save: jest.fn(async () => undefined),
      assertPersistable: jest.fn(async () => undefined),
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

  it('drops the ledger entry instead of retrying when the memory no longer exists', async () => {
    await seedFailedSave();

    // Another session (same portfolio) deleted the memory: find() now misses.
    manager.find.mockResolvedValue(undefined);
    manager.save.mockClear();

    await handler.flushPendingSaves();
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

  it('still retries when the existence check itself fails (lookup errors must not drop data)', async () => {
    await seedFailedSave();
    manager.find.mockRejectedValue(new Error('transient index failure'));
    manager.save.mockClear();

    await handler.flushPendingSaves();
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('applies the same guard during session cleanup', async () => {
    await seedFailedSave();
    manager.find.mockResolvedValue(undefined);
    manager.save.mockClear();

    handler.cleanupSession('session-a');
    // cleanupSession fires asynchronously; give the microtask queue a turn.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(manager.save).not.toHaveBeenCalled();
  });
});
