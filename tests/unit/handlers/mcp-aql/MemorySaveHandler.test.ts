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
      return Promise.resolve({
        id,
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trustLevel: 'untrusted',
      });
    }),
    getEntries: () => entries,
    removeEntry: jest.fn((id: string) => entries.delete(id)),
    clearAll: jest.fn(() => ({ cleared: true })),
  };
}

function makeHandler(memory: MockMemory, sessionId = 'sessA', contextScope?: HandlerCtorArgs[2]) {
  const manager = {
    find: jest.fn(() => Promise.resolve(memory)),
    save: jest.fn(() => Promise.resolve()),
    assertPersistable: jest.fn(() => Promise.resolve()),
    getMemoryProbeToken: jest.fn(() => 'test-memory-probe'),
    isMemoryDeletedAt: jest.fn(() => Promise.resolve(false)),
  };
  const handlers = { memoryManager: manager } as unknown as HandlerCtorArgs[0];
  // Session-scoped key, matching MCPAQLHandler.sessionKey('name') => `${sessionId}:${name}`
  let currentSession = sessionId;
  const handler = new MemorySaveHandler(handlers, (name: string) => `${currentSession}:${name}`, contextScope);
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

    it('retries and reports an unrecovered failed save on session cleanup', async () => {
      const memory = makeMemory('doomed');
      const { handler, manager } = makeHandler(memory, 'sessA');
      const errorSpy = jest.spyOn(logger, 'error');

      // Force the debounced save to fail so the key enters the failure ledger.
      manager.save.mockRejectedValue(new Error('EIO disk failure'));
      await handler.dispatch('addEntry', { element_name: 'doomed', content: 'x' });
      jest.advanceTimersByTime(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 5);
      await Promise.resolve();
      await Promise.resolve();

      handler.cleanupSession('sessA');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Session cleanup retry failed'));
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

  describe('shutdown flush re-establishes per-user context (#2329 multi-user)', () => {
    // A time-sensitive context tracker: like AsyncLocalStorage, it exposes a
    // context ONLY while a request is notionally active. At process shutdown the
    // ambient context is gone. This distinguishes a correct implementation (which
    // captures the context when the save is SCHEDULED) from the regression the fix
    // guards against (re-fetching the context at FLUSH time, when it is empty).
    function timeSensitiveScope() {
      let ambient: unknown;
      const runContexts: unknown[] = [];
      const scope = {
        getContext: jest.fn(() => ambient),
        runAsync: jest.fn((ctx: unknown, fn: () => Promise<unknown>) => {
          runContexts.push(ctx);
          return fn();
        }),
      };
      return {
        scope,
        runContexts,
        setAmbient: (ctx: unknown) => { ambient = ctx; },
      };
    }

    it('replays the context captured at schedule time, not one re-fetched at shutdown', async () => {
      const memory = makeMemory('notes');
      const scheduledContext = { session: { userId: 'alice', sessionId: 'sessA' } };
      const { scope, runContexts, setAmbient } = timeSensitiveScope();
      const { handler, manager } = makeHandler(memory, 'sessA', scope as unknown as HandlerCtorArgs[2]);

      // Request active: the save captures alice's context as it is scheduled.
      setAmbient(scheduledContext);
      await handler.dispatch('addEntry', { element_name: 'notes', content: 'hi' });

      // Shutdown: ambient context is gone. A regression that re-fetched
      // getContext() here would get undefined, skip runAsync, and write to the
      // shared baseDir. A correct flush replays the captured context instead.
      setAmbient(undefined);
      await handler.flushPendingSaves();

      expect(scope.runAsync).toHaveBeenCalledTimes(1);
      expect(runContexts).toEqual([scheduledContext]);
      expect(manager.save).toHaveBeenCalledWith(memory);
    });

    it('flushes each session\'s save under its OWN captured context (no cross-user bleed)', async () => {
      const memory = makeMemory('notes');
      const ctxAlice = { session: { userId: 'alice', sessionId: 'sessA' } };
      const ctxBob = { session: { userId: 'bob', sessionId: 'sessB' } };
      const { scope, runContexts, setAmbient } = timeSensitiveScope();
      const ctx = makeHandler(memory, 'sessA', scope as unknown as HandlerCtorArgs[2]);

      // Alice schedules a save for 'notes' inside her request context.
      setAmbient(ctxAlice);
      await ctx.handler.dispatch('addEntry', { element_name: 'notes', content: 'from alice' });
      // Bob schedules a save for the SAME-named memory inside his own context.
      ctx.setSession('sessB');
      setAmbient(ctxBob);
      await ctx.handler.dispatch('addEntry', { element_name: 'notes', content: 'from bob' });

      // Two independent pending saves keyed by session.
      expect(ctx.internals.pendingSaves.size).toBe(2);

      // Shutdown flush with no ambient context: each save must run under its own
      // originating context — not undefined, not a single shared one, and not the
      // other user's (which would land alice's entry in bob's dir or vice versa).
      setAmbient(undefined);
      await ctx.handler.flushPendingSaves();

      expect(scope.runAsync).toHaveBeenCalledTimes(2);
      expect(runContexts).toContain(ctxAlice);
      expect(runContexts).toContain(ctxBob);
    });

    it('flushes directly when no context tracker is available (stdio / tests)', async () => {
      const memory = makeMemory('notes');
      const { handler, manager } = makeHandler(memory, 'sessA'); // no contextScope
      await handler.dispatch('addEntry', { element_name: 'notes', content: 'hi' });
      await handler.flushPendingSaves();
      expect(manager.save).toHaveBeenCalledWith(memory);
    });
  });
});
