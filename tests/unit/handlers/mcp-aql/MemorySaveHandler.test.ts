import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { MemoryPersistenceCoordinator } from '../../../../src/handlers/mcp-aql/MemoryPersistenceCoordinator.js';
import { MemoryPersistenceConflictError } from '../../../../src/storage/DatabaseMemoryStorageLayer.js';
import { STORAGE_LAYER_CONFIG } from '../../../../src/config/performance-constants.js';

/**
 * Unit coverage for the #2329 durability behaviors that live in MemorySaveHandler
 * and are otherwise only exercised through the MCP-AQL integration path:
 * - session cleanup is NON-WRITING (leaves the debounce timer to fire in its
 *   propagated per-user context) — a write from the context-less disposal path
 *   would land in the flat shared dir;
 * - attempt ordering (a stale save completion cannot erase a newer failure);
 * - same-name memories in two sessions keep isolated pending/failed state.
 */

type HandlerCtorArgs = ConstructorParameters<typeof MemorySaveHandler>;

interface MockMemory {
  metadata: { name: string };
  entries: Map<string, unknown>;
  addEntry: jest.Mock;
  getEntries: () => Map<string, unknown>;
  removeEntry: jest.Mock;
  clearAll: jest.Mock;
}

/** Private surface of MemorySaveHandler exercised directly by these unit tests. */
interface HandlerInternals {
  saveMemoryTracked(key: string, memory: unknown, manager: unknown): Promise<boolean>;
  debouncedMemorySave(memoryName: string, memory: unknown, manager: unknown): void;
  failedMemorySaves: Map<string, unknown>;
  pendingSaves: Map<string, unknown>;
}

function makeMemory(name: string): MockMemory {
  const entries = new Map<string, unknown>();
  return {
    metadata: { name },
    entries,
    addEntry: jest.fn((content: string) => {
      const id = `entry-${entries.size + 1}`;
      entries.set(id, { content });
      return Promise.resolve({
        id,
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trustLevel: 'untrusted',
      });
    }),
    getEntries: () => entries,
    removeEntry: jest.fn((id: string) => entries.delete(id)),
    clearAll: jest.fn(() => {
      entries.clear();
      return { cleared: true };
    }),
  };
}

function makeHandler(
  memory: MockMemory,
  sessionId = 'sessA',
  contextScope?: HandlerCtorArgs[2],
  coordinator?: HandlerCtorArgs[3],
) {
  const manager = {
    find: jest.fn(() => Promise.resolve(memory)),
    save: jest.fn(() => Promise.resolve()),
    assertPersistable: jest.fn(() => Promise.resolve()),
    getMemoryStateToken: jest.fn(() => Promise.resolve('stable-memory-state')),
    getMemoryProbeToken: jest.fn(() => 'test-memory-probe'),
    isMemoryDeletedAt: jest.fn(() => Promise.resolve(false)),
    isDatabaseBacked: jest.fn(() => false),
    recoverMemoryPersistenceConflict: jest.fn(),
    runFileMutationExclusive: jest.fn(
      async (candidate: MockMemory, operation: (current: MockMemory) => Promise<unknown>) =>
        operation(candidate),
    ),
    runFileDeleteExclusive: jest.fn(
      async (_memoryName: string, operation: () => Promise<unknown>) => operation(),
    ),
  };
  const handlers = { memoryManager: manager } as unknown as HandlerCtorArgs[0];
  // Session-scoped key, matching MCPAQLHandler.sessionKey('name') => `${sessionId}:${name}`
  let currentSession = sessionId;
  const handler = new MemorySaveHandler(
    handlers,
    (name: string) => `${currentSession}:${name}`,
    contextScope,
    coordinator ?? new MemoryPersistenceCoordinator(),
  );
  const internals = handler as unknown as HandlerInternals;
  return {
    handler,
    manager,
    internals,
    setSession: (s: string) => { currentSession = s; },
  };
}

describe('MemorySaveHandler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('synchronous file durability', () => {
    it('persists durably before session cleanup can run', async () => {
      const memory = makeMemory('notes');
      const { handler, manager } = makeHandler(memory, 'sessA');

      await handler.dispatch('addEntry', { element_name: 'notes', content: 'hello' });
      expect(manager.save).toHaveBeenCalledWith(memory, undefined, { durable: true });

      // Session closes before the timer fires. Cleanup must not itself write —
      // it runs outside the session context and would target the shared dir.
      handler.cleanupSession('sessA');
      expect(manager.save).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('acquires the coordinator before the filesystem guard for writes and deletes', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('notes');
      const { handler, manager } = makeHandler(memory, 'sessA', undefined, coordinator);
      const order: string[] = [];
      const originalRunMutation = coordinator.runMutation.bind(coordinator);
      const originalRunDelete = coordinator.runDelete.bind(coordinator);
      jest.spyOn(coordinator, 'runMutation').mockImplementation(async (version, operation) => {
        order.push('write-coordinator');
        return originalRunMutation(version, operation);
      });
      jest.spyOn(coordinator, 'runDelete').mockImplementation(async (key, operation) => {
        order.push('delete-coordinator');
        return originalRunDelete(key, operation);
      });
      manager.runFileMutationExclusive.mockImplementation(
        async (candidate: MockMemory, operation: (current: MockMemory) => Promise<unknown>) => {
          order.push('write-filesystem');
          return operation(candidate);
        },
      );
      manager.runFileDeleteExclusive.mockImplementation(
        async (_memoryName: string, operation: () => Promise<unknown>) => {
          order.push('delete-filesystem');
          return operation();
        },
      );

      await handler.dispatch('addEntry', { element_name: 'notes', content: 'hello' });
      await handler.runDeleteExclusive('notes', async () => undefined);

      expect(order).toEqual([
        'write-coordinator',
        'write-filesystem',
        'delete-coordinator',
        'delete-filesystem',
      ]);
    });

    it('rejects a failed file save without leaving retry bookkeeping', async () => {
      const memory = makeMemory('doomed');
      const { handler, manager, internals } = makeHandler(memory, 'sessA');
      manager.save.mockRejectedValue(new Error('EIO disk failure'));
      await expect(handler.dispatch('addEntry', {
        element_name: 'doomed',
        content: 'x',
      })).rejects.toThrow('Entry NOT saved');

      handler.cleanupSession('sessA');
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(internals.failedMemorySaves.size).toBe(0);
      expect(internals.pendingSaves.size).toBe(0);
    });

    it('clears and durably saves the fresh snapshot held by the file mutation guard', async () => {
      const staleMemory = makeMemory('notes');
      staleMemory.entries.set('stale', { content: 'stale' });
      const freshMemory = makeMemory('notes');
      freshMemory.entries.set('concurrent', { content: 'concurrent' });
      const { handler, manager } = makeHandler(staleMemory, 'sessA');
      manager.runFileMutationExclusive.mockImplementation(
        async (_candidate: MockMemory, operation: (current: MockMemory) => Promise<unknown>) =>
          operation(freshMemory),
      );

      await expect(handler.dispatch('clear', { element_name: 'notes' }))
        .resolves.toEqual({ cleared: true });

      expect(staleMemory.clearAll).not.toHaveBeenCalled();
      expect(freshMemory.clearAll).toHaveBeenCalledWith(true);
      expect(manager.save).toHaveBeenCalledWith(
        freshMemory,
        undefined,
        { durable: true },
      );
    });

    it('releases the pending-save lease when clear cancels its timer', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('notes');
      const { handler, manager, internals } = makeHandler(memory, 'sessA', undefined, coordinator);

      internals.debouncedMemorySave('notes', memory, manager);
      expect(internals.pendingSaves.size).toBe(1);
      expect(coordinator.trackedKeyCountForTesting()).toBe(1);

      await expect(handler.dispatch('clear', { element_name: 'notes' }))
        .resolves.toEqual({ cleared: true });

      expect(internals.pendingSaves.size).toBe(0);
      expect(coordinator.trackedKeyCountForTesting()).toBe(0);
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await jest.advanceTimersByTimeAsync(0);
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('does not silently retry a failed destructive clear on a later user action', async () => {
      const memory = makeMemory('notes');
      memory.entries.set('existing', { content: 'keep' });
      const { handler, manager, internals } = makeHandler(memory);
      manager.save.mockRejectedValueOnce(new Error('disk unavailable'));

      await expect(handler.dispatch('clear', { element_name: 'notes' }))
        .rejects.toThrow('disk unavailable');
      expect(internals.failedMemorySaves.size).toBe(0);
      expect(manager.recoverMemoryPersistenceConflict).toHaveBeenCalledWith(memory);
      await expect(handler.dispatch('addEntry', { element_name: 'notes', content: 'new entry' }))
        .resolves.toMatchObject({ id: 'entry-1' });
      expect(manager.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('attempt ordering (#2329)', () => {
    it('a stale save completion cannot erase a newer failure', async () => {
      const memory = makeMemory('race');
      const { manager, internals } = makeHandler(memory, 'sessA');
      const key = 'sessA:race';

      let resolveOld!: () => void;
      let rejectNew!: (e: Error) => void;
      const oldSave = new Promise<void>(res => { resolveOld = res; });
      const newSave = new Promise<void>((_, rej) => { rejectNew = rej; });
      manager.save
        .mockReturnValueOnce(oldSave)   // attempt 1 (older, will succeed late)
        .mockReturnValueOnce(newSave);  // attempt 2 (newer, fails)

      // Drive two tracked saves for the same key. Persistence is serialized so
      // the newer attempt cannot overtake the older write.
      const pOld = internals.saveMemoryTracked(key, memory, manager);
      const pNew = internals.saveMemoryTracked(key, memory, manager).catch(() => { /* expected */ });

      await Promise.resolve();
      expect(manager.save).toHaveBeenCalledTimes(1);
      resolveOld();
      await pOld;
      await Promise.resolve();
      expect(manager.save).toHaveBeenCalledTimes(2);
      rejectNew(new Error('newer save failed'));
      await pNew;

      // The newer failure must survive the older save's late success.
      expect(internals.failedMemorySaves.has(key)).toBe(true);
    });
  });

  describe('session isolation (#2329)', () => {
    it('keeps same-named memories in two sessions independent', async () => {
      const memory = makeMemory('shared-name');
      const ctx = makeHandler(memory, 'sessA');
      // Two different sessions writing a memory with the SAME name.
      await ctx.handler.dispatch('addEntry', { element_name: 'shared-name', content: 'from A' });
      ctx.setSession('sessB');
      await ctx.handler.dispatch('addEntry', { element_name: 'shared-name', content: 'from B' });

      expect(ctx.manager.save).toHaveBeenCalledTimes(2);
      expect(ctx.internals.pendingSaves.size).toBe(0);
    });
  });

  describe('database persistence acknowledgment', () => {
    it('persists a database-backed entry before reporting success', async () => {
      const memory = makeMemory('shared-memory');
      const { handler, manager } = makeHandler(memory);
      manager.isDatabaseBacked.mockReturnValue(true);

      let resolveSave!: () => void;
      manager.save.mockReturnValue(new Promise<void>((resolve) => {
        resolveSave = resolve;
      }));

      let completed = false;
      const result = handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'persist me',
      }).then((value) => {
        completed = true;
        return value;
      });

      for (let i = 0; i < 10 && manager.save.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(manager.save).toHaveBeenCalledWith(memory, undefined, undefined);
      expect(completed).toBe(false);

      resolveSave();
      await expect(result).resolves.toMatchObject({ id: 'entry-1' });
      expect(completed).toBe(true);
    });

    it('holds the coordinator lock across database mutation and persistence', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('shared-memory');
      const first = makeHandler(memory, 'first', undefined, coordinator);
      const second = makeHandler(memory, 'second', undefined, coordinator);
      first.manager.isDatabaseBacked.mockReturnValue(true);
      second.manager.isDatabaseBacked.mockReturnValue(true);

      let releaseFirstSave!: () => void;
      first.manager.save.mockReturnValue(new Promise<void>(resolve => { releaseFirstSave = resolve; }));

      const add = first.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'persist before clear',
      });
      for (let index = 0; index < 10 && first.manager.save.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      const clear = second.handler.dispatch('clear', { element_name: 'shared-memory' });
      await Promise.resolve();

      expect(memory.clearAll).not.toHaveBeenCalled();
      releaseFirstSave();
      await expect(add).resolves.toMatchObject({ id: 'entry-1' });
      await expect(clear).resolves.toEqual({ cleared: true });
      expect(memory.getEntries().size).toBe(0);
      expect(first.manager.save).toHaveBeenCalledTimes(1);
      expect(second.manager.save).toHaveBeenCalledTimes(1);
      expect(first.manager.save.mock.invocationCallOrder[0])
        .toBeLessThan(memory.clearAll.mock.invocationCallOrder[0]);
      expect(memory.clearAll.mock.invocationCallOrder[0])
        .toBeLessThan(second.manager.save.mock.invocationCallOrder[0]);
    });

    it('rejects instead of acknowledging a failed database-backed write', async () => {
      const memory = makeMemory('shared-memory');
      const { handler, manager, internals } = makeHandler(memory);
      manager.isDatabaseBacked.mockReturnValue(true);
      manager.save.mockRejectedValue(new Error('concurrent memory update'));

      const result = handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'do not acknowledge',
      });
      await expect(result).rejects.toThrow(
        "Entry NOT saved to memory 'shared-memory': concurrent memory update",
      );

      expect(internals.pendingSaves.size).toBe(0);
      expect(internals.failedMemorySaves.has('sessA:shared-memory')).toBe(false);
      await handler.flushPendingSaves();
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('rejects when deletion invalidates the synchronous database save', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('shared-memory');
      const request = makeHandler(memory, 'request', undefined, coordinator);
      const deletion = makeHandler(memory, 'delete', undefined, coordinator);
      request.manager.isDatabaseBacked.mockReturnValue(true);

      let resolveFind!: (value: MockMemory) => void;
      request.manager.find.mockReturnValue(new Promise<MockMemory>((resolve) => {
        resolveFind = resolve;
      }));

      const add = request.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'must not be acknowledged',
      });
      await deletion.handler.runDeleteExclusive('shared-memory', async () => undefined);
      resolveFind(memory);

      await expect(add).rejects.toThrow('changed or was deleted in another session');
      expect(request.manager.save).not.toHaveBeenCalled();
      expect(request.manager.recoverMemoryPersistenceConflict).toHaveBeenCalledWith(memory);
      expect(request.internals.failedMemorySaves.size).toBe(0);
    });

    it('does not retain deterministic CAS conflicts in the retry ledger', async () => {
      const memory = makeMemory('shared-memory');
      const { handler, manager, internals } = makeHandler(memory);
      manager.isDatabaseBacked.mockReturnValue(true);
      manager.save.mockRejectedValue(new MemoryPersistenceConflictError('shared-memory'));

      await expect(handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'stale mutation',
      })).rejects.toThrow('reload it before saving again');

      expect(internals.failedMemorySaves.size).toBe(0);
      expect(manager.recoverMemoryPersistenceConflict).toHaveBeenCalledWith(memory);

      const reloaded = makeMemory('shared-memory');
      manager.find.mockResolvedValue(reloaded);
      manager.save.mockResolvedValue(undefined);
      await expect(handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'fresh mutation after reload',
      })).resolves.toMatchObject({ id: 'entry-1' });

      // One failed CAS plus one fresh save: there is no extra retry of the stale
      // instance from the failure ledger.
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenLastCalledWith(reloaded, undefined, undefined);
      expect(internals.failedMemorySaves.size).toBe(0);
    });

    it('persists file-backed entries durably before returning', async () => {
      const memory = makeMemory('local-memory');
      const { handler, manager, internals } = makeHandler(memory);

      await expect(handler.dispatch('addEntry', {
        element_name: 'local-memory',
        content: 'save later',
      })).resolves.toMatchObject({ id: 'entry-1' });

      expect(manager.save).toHaveBeenCalledWith(memory, undefined, { durable: true });
      expect(internals.pendingSaves.size).toBe(0);
    });
  });

  describe('cross-session delete coordination', () => {
    function scopeFor(userId: string, sessionId: string): HandlerCtorArgs[2] {
      const context = {
        type: 'llm-request' as const,
        timestamp: Date.now(),
        session: { userId, sessionId, transport: 'streamable-http' as const },
      };
      return {
        getContext: () => context,
        runAsync: async (_context, fn) => fn(),
      };
    }

    it('does not let another session\'s delayed save resurrect a deleted memory', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('shared-memory');
      const sessionA = makeHandler(memory, 'session-a', scopeFor('alice', 'session-a'), coordinator);
      const sessionB = makeHandler(memory, 'session-b', scopeFor('alice', 'session-b'), coordinator);
      const deleteOperation = jest.fn(async () => ({ deleted: true }));

      await sessionA.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'queued before deletion',
      });
      expect(sessionA.manager.save).toHaveBeenCalledTimes(1);

      await sessionB.handler.runDeleteExclusive('shared-memory', deleteOperation);
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      await Promise.resolve();

      expect(deleteOperation).toHaveBeenCalledTimes(1);
      expect(sessionA.manager.save).toHaveBeenCalledTimes(1);
      expect(sessionA.internals.failedMemorySaves.size).toBe(0);
    });

    it('retains an acknowledged pending save when deletion fails so shutdown and restart preserve it', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('shared-memory');
      const session = makeHandler(memory, 'session-a', scopeFor('alice', 'session-a'), coordinator);
      let persistedEntries: Array<[string, unknown]> = [];
      session.manager.save.mockImplementation(async (savedMemory: MockMemory) => {
        persistedEntries = [...savedMemory.getEntries().entries()];
      });

      await expect(session.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'acknowledged before failed deletion',
      })).resolves.toMatchObject({ id: 'entry-1' });
      expect(session.internals.pendingSaves.size).toBe(0);

      await expect(session.handler.runDeleteExclusive('shared-memory', async () => {
        throw new Error('storage delete failed');
      })).rejects.toThrow('storage delete failed');

      // The entry was already durable before the failed delete began.
      expect(session.internals.pendingSaves.size).toBe(0);
      await session.handler.flushPendingSaves();
      expect(session.manager.save).toHaveBeenCalledTimes(1);

      // Model process restart from the state written by the shutdown flush.
      const restartedMemory = makeMemory('shared-memory');
      for (const [id, entry] of persistedEntries) {
        restartedMemory.entries.set(id, entry);
      }
      const restarted = makeHandler(restartedMemory, 'session-after-restart');
      await expect(restarted.manager.find('shared-memory')).resolves.toBe(restartedMemory);
      expect(restartedMemory.getEntries().get('entry-1')).toEqual({
        content: 'acknowledged before failed deletion',
      });
    });

    it('captures deletion fencing before a delayed memory lookup', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const memory = makeMemory('shared-memory');
      const sessionA = makeHandler(memory, 'session-a', scopeFor('alice', 'session-a'), coordinator);
      const sessionB = makeHandler(memory, 'session-b', scopeFor('alice', 'session-b'), coordinator);

      let resolveFind!: (value: MockMemory) => void;
      sessionA.manager.find.mockReturnValue(new Promise<MockMemory>((resolve) => {
        resolveFind = resolve;
      }));

      const add = sessionA.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'loaded after deletion',
      });
      await sessionB.handler.runDeleteExclusive('shared-memory', async () => undefined);
      resolveFind(memory);
      await expect(add).rejects.toThrow('changed or was deleted in another session');

      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await jest.advanceTimersByTimeAsync(0);
      expect(sessionA.manager.save).not.toHaveBeenCalled();
      expect(sessionA.manager.recoverMemoryPersistenceConflict).toHaveBeenCalledWith(memory);
      expect(sessionA.internals.failedMemorySaves.size).toBe(0);
    });

    it('does not invalidate a different user\'s same-named memory save', async () => {
      const coordinator = new MemoryPersistenceCoordinator();
      const aliceMemory = makeMemory('shared-memory');
      const bobMemory = makeMemory('shared-memory');
      const alice = makeHandler(aliceMemory, 'alice-session', scopeFor('alice', 'alice-session'), coordinator);
      const bob = makeHandler(bobMemory, 'bob-session', scopeFor('bob', 'bob-session'), coordinator);

      await alice.handler.dispatch('addEntry', {
        element_name: 'shared-memory',
        content: 'alice pending',
      });
      await bob.handler.runDeleteExclusive('shared-memory', async () => undefined);
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      await Promise.resolve();

      expect(alice.manager.save).toHaveBeenCalledWith(aliceMemory, undefined, { durable: true });
      expect(bob.manager.save).not.toHaveBeenCalled();
    });
  });

});
