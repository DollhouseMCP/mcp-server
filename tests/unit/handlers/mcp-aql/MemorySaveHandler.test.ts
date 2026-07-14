import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { logger } from '../../../../src/utils/logger.js';
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
  saveMemoryTracked(key: string, memory: unknown, manager: unknown): Promise<void>;
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
      return Promise.resolve({ id });
    }),
    getEntries: () => entries,
    removeEntry: jest.fn((id: string) => entries.delete(id)),
    clearAll: jest.fn(() => ({ cleared: true })),
  };
}

function makeHandler(memory: MockMemory, sessionId = 'sessA') {
  const manager = {
    find: jest.fn(() => Promise.resolve(memory)),
    save: jest.fn(() => Promise.resolve()),
    assertPersistable: jest.fn(() => Promise.resolve()),
  };
  const handlers = { memoryManager: manager } as unknown as HandlerCtorArgs[0];
  // Session-scoped key, matching MCPAQLHandler.sessionKey('name') => `${sessionId}:${name}`
  let currentSession = sessionId;
  const handler = new MemorySaveHandler(handlers, (name: string) => `${currentSession}:${name}`);
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

  describe('cleanupSession (#2329 multi-user correctness)', () => {
    it('does NOT write during session cleanup, leaving the debounce timer to persist', async () => {
      const memory = makeMemory('notes');
      const { handler, manager } = makeHandler(memory, 'sessA');

      await handler.dispatch('addEntry', { element_name: 'notes', content: 'hello' });
      expect(manager.save).not.toHaveBeenCalled(); // debounced, not yet written

      // Session closes before the timer fires. Cleanup must not itself write —
      // it runs outside the session context and would target the shared dir.
      handler.cleanupSession('sessA');
      expect(manager.save).not.toHaveBeenCalled();

      // The pending timer is intact and still fires, persisting the entry.
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(memory);
    });

    it('reports and drops an unrecovered failed save on session cleanup', async () => {
      const memory = makeMemory('doomed');
      const { handler, manager } = makeHandler(memory, 'sessA');
      const errorSpy = jest.spyOn(logger, 'error');

      // Force the debounced save to fail so the key enters the failure ledger.
      manager.save.mockReturnValueOnce(Promise.reject(new Error('EIO disk failure')));
      await handler.dispatch('addEntry', { element_name: 'doomed', content: 'x' });
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      await Promise.resolve();

      handler.cleanupSession('sessA');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unrecovered memory save'));
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

      // Drive two overlapping tracked saves for the same key directly.
      const pOld = internals.saveMemoryTracked(key, memory, manager);
      const pNew = internals.saveMemoryTracked(key, memory, manager).catch(() => { /* expected */ });

      rejectNew(new Error('newer save failed'));
      await pNew;
      resolveOld();
      await pOld;

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

      // Distinct session-scoped keys — no cross-session coalescing.
      expect(ctx.internals.pendingSaves.has('sessA:shared-name')).toBe(true);
      expect(ctx.internals.pendingSaves.has('sessB:shared-name')).toBe(true);
      expect(ctx.internals.pendingSaves.size).toBe(2);
    });
  });
});
