import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MemorySaveHandler, type SaveContextScope } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { STORAGE_LAYER_CONFIG } from '../../../../src/config/performance-constants.js';
import type { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';

type Pending = { memory: Memory; manager: MemoryManager; context?: unknown };
type Internals = { pendingSaves: Map<string, Pending>; failedMemorySaves: Map<string, Pending> };
function barrier() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  let admitted = false;
  const memories = [new Memory({ name: 'queue-memory' }, new MetadataService())];
  const context = { type: 'test' as const, timestamp: 1, session: {
    userId: 'owned-user', sessionId: 'owned-session', tenantId: null, transport: 'http' as const, createdAt: 0,
  } };
  const manager = {
    isGuardedHeadUpdateEnabled: () => admitted,
    captureGuardedTenant: () => context.session.userId,
    loadGuardedMemoryByName: jest.fn(async (name: string) => memories.find(memory => memory.metadata.name === name)!),
    deriveGuardedMutation: jest.fn((source: Memory) => source.createAppendCandidate()),
    find: jest.fn(async (predicate: (memory: Memory) => boolean) => memories.find(predicate)),
    save: jest.fn(async (_memory: Memory): Promise<void> => {}),
    assertPersistable: jest.fn(async (_memory: Memory): Promise<void> => {}),
    getMemoryProbeToken: jest.fn((_memory: Memory) => 'original-owned-target'),
    isMemoryDeletedAt: jest.fn(async (_token: string | null) => false),
  };
  const scope: SaveContextScope = { getContext: () => context, runAsync: async (_context, body) => body() };
  const handler = new MemorySaveHandler({ memoryManager: manager } as unknown as ConstructorParameters<typeof MemorySaveHandler>[0],
    name => `owned-session:${name}`, scope);
  const internals = handler as unknown as Internals;
  const append = (name = 'queue-memory', content = 'Exact retained attempted content') =>
    handler.dispatch('addEntry', { element_name: name, content });
  return { handler, manager, internals, memories, context, scope, append, admit: (value = true) => { admitted = value; } };
}
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

describe('admitted profile refuses deferred work without losing its sole copy', () => {
  it('refuses a new immediate request before discovery while original deferred content and context remain', async () => {
    const f = fixture(); await f.append(); const pending = f.internals.pendingSaves.get('owned-session:queue-memory')!;
    const contents = [...pending.memory.getEntries()]; f.manager.find.mockClear(); f.admit();
    await expect(f.append(undefined, 'Never accepted')).rejects.toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.manager.find).not.toHaveBeenCalled(); expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.internals.pendingSaves.get('owned-session:queue-memory')).toBe(pending);
    expect(pending.context).toBe(f.context); expect([...pending.memory.getEntries()]).toEqual(contents);
  });
  it('a timer observes admission and retains its exact candidate without calling save or rebind', async () => {
    const f = fixture(); await f.append(); const pending = f.internals.pendingSaves.get('owned-session:queue-memory'); f.admit();
    await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.getMemoryProbeToken).not.toHaveBeenCalled();
    expect(f.internals.pendingSaves.get('owned-session:queue-memory')).toBe(pending);
  });
  it('flag-off cannot restart a refused timer or report a successful shutdown drain', async () => {
    const f = fixture(); await f.append(); f.admit();
    await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1); f.admit(false);
    await expect(f.handler.dispose()).rejects.toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.internals.pendingSaves.size).toBe(1);
  });
  it('session cleanup and flush refuse failure-ledger replay before deletion probes', async () => {
    const f = fixture(); await f.append(); f.manager.save.mockRejectedValueOnce(new Error('original storage failure'));
    await f.handler.flushPendingSaves();
    const failed = f.internals.failedMemorySaves.get('owned-session:queue-memory'); expect(failed?.memory).toBe(f.memories[0]);
    f.manager.save.mockClear(); f.admit(); f.handler.cleanupSession('owned-session'); await Promise.resolve();
    await expect(f.handler.flushPendingSaves()).rejects.toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.manager.isMemoryDeletedAt).not.toHaveBeenCalled(); expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.internals.failedMemorySaves.get('owned-session:queue-memory')).toBe(failed);
  });
  it('does not discard retained failure content when an ordinary deletion probe returns after admission', async () => {
    const f = fixture(); await f.append(); f.manager.save.mockRejectedValueOnce(new Error('original storage failure'));
    await f.handler.flushPendingSaves(); const failed = f.internals.failedMemorySaves.get('owned-session:queue-memory');
    const entered = barrier(); const resume = barrier();
    f.manager.isMemoryDeletedAt.mockImplementationOnce(async () => { entered.release(); await resume.promise; return true; });
    f.manager.save.mockClear(); const pending = f.handler.flushPendingSaves();
    const outcome = pending.then(() => undefined, cause => cause);
    try { await entered.promise; f.admit(); f.handler.cleanupSession('owned-session'); }
    finally { resume.release(); }
    expect(await outcome).toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.internals.failedMemorySaves.get('owned-session:queue-memory')).toBe(failed);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('rejects destructive bookkeeping cleanup after admission and preserves the same instance', async () => {
    const f = fixture(); await f.append(); const pending = f.internals.pendingSaves.get('owned-session:queue-memory'); f.admit();
    expect(() => f.handler.cleanupDeletedMemory('queue-memory')).toThrow('Deferred memory work');
    expect(f.internals.pendingSaves.get('owned-session:queue-memory')).toBe(pending);
    f.admit(false); expect(() => f.handler.cleanupDeletedMemory('queue-memory')).toThrow('Deferred memory work');
  });
  it('refuses after awaited validation before applying a legacy append to the source Memory', async () => {
    const f = fixture(); const entered = barrier(); const resume = barrier();
    f.manager.assertPersistable.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const pending = f.append(); const outcome = pending.then(() => undefined, cause => cause);
    try { await entered.promise; f.admit(); } finally { resume.release(); }
    expect(await outcome).toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.memories[0].getEntries().size).toBe(0); expect(f.internals.pendingSaves.size).toBe(0);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('retains in-flight and later queued candidates when admission closes during an already-started save', async () => {
    const f = fixture(); f.memories.push(new Memory({ name: 'second-memory' }, new MetadataService()));
    await f.append(); await f.append('second-memory', 'Second exact retained content');
    const first = f.internals.pendingSaves.get('owned-session:queue-memory');
    const second = f.internals.pendingSaves.get('owned-session:second-memory');
    const entered = barrier(); const resume = barrier();
    f.manager.save.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const pending = f.handler.flushPendingSaves(); const outcome = pending.then(() => undefined, cause => cause);
    try { await entered.promise; f.admit(); } finally { resume.release(); }
    expect(await outcome).toMatchObject({ code: 'EDEFERREDMEMORY' });
    // The started write did complete. Refusal does not claim cancellation or rollback.
    expect(f.manager.save).toHaveBeenCalledTimes(1);
    expect(f.internals.pendingSaves.get('owned-session:queue-memory')).toBe(first);
    expect(f.internals.pendingSaves.get('owned-session:second-memory')).toBe(second);
    expect(f.internals.failedMemorySaves.get('owned-session:queue-memory')?.memory).toBe(first?.memory);
    f.admit(false); await expect(f.handler.flushPendingSaves()).rejects.toMatchObject({ code: 'EDEFERREDMEMORY' });
    expect(f.manager.save).toHaveBeenCalledTimes(1);
  });
  it('re-observes admission when context restoration rejects before the tracked save begins', async () => {
    const f = fixture(); await f.append(); const queued = f.internals.pendingSaves.get('owned-session:queue-memory');
    const cause = new Error('Original context restoration failure'); const entered = barrier(); const resume = barrier();
    f.scope.runAsync = async () => { entered.release(); await resume.promise; throw cause; };
    const pending = f.handler.flushPendingSaves(); const outcome = pending.then(() => undefined, error => error);
    try { await entered.promise; f.admit(); } finally { resume.release(); }
    expect(await outcome).toBe(cause);
    expect(f.internals.pendingSaves.get('owned-session:queue-memory')).toBe(queued);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.isMemoryDeletedAt).not.toHaveBeenCalled();
  });
  it('preserves ordinary legacy timer flush and confirmed deletion cleanup', async () => {
    const f = fixture(); await f.append();
    await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1);
    expect(f.manager.save).toHaveBeenCalledTimes(1); expect(f.internals.pendingSaves.size).toBe(0);
    await f.append(); f.manager.save.mockRejectedValueOnce(new Error('legacy failure')); await f.handler.flushPendingSaves();
    f.manager.isMemoryDeletedAt.mockResolvedValueOnce(true); f.manager.save.mockClear();
    await f.handler.flushPendingSaves(); expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.internals.failedMemorySaves.size).toBe(0);
  });
});
