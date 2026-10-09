import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ContextTracker, type ExecutionContext } from '../../../../src/security/encryption/ContextTracker.js';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { STORAGE_LAYER_CONFIG } from '../../../../src/config/performance-constants.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(requiresOriginBinding = true) {
  const tracker = new ContextTracker();
  const memory = new Memory({ name: 'origin-memory' }, new MetadataService());
  const original: ExecutionContext = { type: 'test', timestamp: 1, requestId: 'original', session: {
    userId: 'owner', sessionId: 'session', tenantId: null, transport: 'http', createdAt: 0,
  } };
  const other: ExecutionContext = { ...original, requestId: 'later', session: { ...original.session! } };
  const cause = new Error('Original operation binding refused');
  let valid = true;
  const bindingCheck = jest.fn(() => {
    if (!valid || tracker.getContext() !== original) throw cause;
  });
  const observed: ExecutionContext[] = [];
  const manager = {
    isGuardedHeadUpdateEnabled: () => false,
    find: jest.fn(async () => memory),
    assertPersistable: jest.fn(async () => {}),
    save: jest.fn(async (_memory: Memory) => { observed.push(tracker.getContext()!); }),
    getMemoryProbeToken: jest.fn(() => 'original-target'),
    isMemoryDeletedAt: jest.fn(async () => false),
  };
  const handler = new MemorySaveHandler({ memoryManager: manager } as unknown as HandlerRegistry,
    name => `session:${name}`, tracker, requiresOriginBinding);
  type Retained = { memory: Memory; manager: unknown; context?: ExecutionContext; bindingCheck?: () => void };
  const state = handler as unknown as { pendingSaves: Map<string, Retained>; failedMemorySaves: Map<string, Retained> };
  const append = () => tracker.runAsync(original, () => handler.dispatch('addEntry', {
    element_name: 'origin-memory', content: 'Exact retained original content',
  }, bindingCheck));
  return { tracker, memory, original, other, cause, manager, handler, bindingCheck, state, append, observed,
    close: () => { valid = false; } };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

describe('MemorySaveHandler retains each operation origin', () => {
  it('requires a binding before discovery or synchronous bookkeeping in composed mode', async () => {
    const f = fixture();
    await expect(f.handler.dispatch('addEntry', { element_name: 'origin-memory', content: 'denied' })).rejects.toThrow('binding required');
    expect(() => f.handler.cleanupDeletedMemory('origin-memory')).toThrow('binding required');
    expect(() => f.handler.getPendingGuardedMutation('origin-memory')).toThrow('binding required');
    expect(f.manager.find).not.toHaveBeenCalled(); expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.memory.getEntries().size).toBe(0);
  });
  it('checks the original binding after an awaited discovery before RAM mutation', async () => {
    const f = fixture(); const entered = barrier(); const resume = barrier();
    f.manager.find.mockImplementationOnce(async () => { entered.release(); await resume.promise; return f.memory; });
    const result = f.append().then(() => undefined, cause => cause);
    await entered.promise; f.close(); resume.release();
    expect(await result).toBe(f.cause); expect(f.memory.getEntries().size).toBe(0);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.state.pendingSaves.size).toBe(0);
  });
  it('checks after validation before applying an append or accepting a timer', async () => {
    const f = fixture(); const entered = barrier(); const resume = barrier();
    f.manager.assertPersistable.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const result = f.append().then(() => undefined, cause => cause);
    await entered.promise; f.close(); resume.release();
    expect(await result).toBe(f.cause); expect(f.memory.getEntries().size).toBe(0);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.state.pendingSaves.size).toBe(0);
  });
  it('runs a timer in its exact original context despite a later ambient invocation', async () => {
    const f = fixture(); await f.append(); const entry = f.state.pendingSaves.get('session:origin-memory')!;
    expect(entry.context).toBe(f.original); expect(entry.bindingCheck).toBe(f.bindingCheck);
    await f.tracker.runAsync(f.other, async () => {
      await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1);
      expect(f.tracker.getContext()).toBe(f.other);
    });
    expect(f.observed).toEqual([f.original]); expect(f.manager.save).toHaveBeenCalledWith(f.memory);
    expect(f.state.pendingSaves.size).toBe(0);
  });
  it('retains the exact pending instance when its timer origin is refused', async () => {
    const f = fixture(); await f.append(); const entry = f.state.pendingSaves.get('session:origin-memory')!;
    f.close();
    await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(entry);
    expect([...entry.memory.getEntries().values()][0].content).toBe('Exact retained original content');
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.getMemoryProbeToken).not.toHaveBeenCalled();
    await expect(f.handler.flushPendingSaves()).rejects.toBe(f.cause);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(entry);
  });
  it('retains the failure origin and restores it before a later request retries', async () => {
    const f = fixture(); await f.append(); const storageCause = new Error('storage failure');
    f.manager.save.mockRejectedValueOnce(storageCause);
    await expect(f.handler.flushPendingSaves()).rejects.toBe(storageCause);
    const failed = f.state.failedMemorySaves.get('session:origin-memory')!;
    expect(failed.context).toBe(f.original); expect(failed.bindingCheck).toBe(f.bindingCheck);
    expect(failed.memory).toBe(f.memory);
    await f.tracker.runAsync(f.other, () => f.handler.flushPendingSaves());
    expect(f.observed).toEqual([f.original]); expect(f.state.failedMemorySaves.size).toBe(0);
    expect(f.state.pendingSaves.size).toBe(0);
  });
  it('cannot erase failed work when its deletion probe outlives the original binding', async () => {
    const f = fixture(); const storageCause = new Error('failed clear');
    f.manager.save.mockRejectedValueOnce(storageCause);
    await expect(f.tracker.runAsync(f.original, () => f.handler.dispatch('clear', {
      element_name: 'origin-memory',
    }, f.bindingCheck))).rejects.toBe(storageCause);
    const failed = f.state.failedMemorySaves.get('session:origin-memory')!;
    const entered = barrier(); const resume = barrier();
    f.manager.isMemoryDeletedAt.mockImplementationOnce(async () => { entered.release(); await resume.promise; return true; });
    const result = f.handler.flushPendingSaves().then(() => undefined, cause => cause);
    await entered.promise; f.close(); resume.release();
    expect(await result).toBe(f.cause); expect(f.state.failedMemorySaves.get('session:origin-memory')).toBe(failed);
    expect(f.manager.save).toHaveBeenCalledTimes(1);
  });
  it('retains attempted work if binding changes during a save that already started', async () => {
    const f = fixture(); await f.append(); const entry = f.state.pendingSaves.get('session:origin-memory')!;
    const entered = barrier(); const resume = barrier();
    f.manager.save.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const result = f.handler.flushPendingSaves().then(() => undefined, cause => cause);
    await entered.promise; f.close(); resume.release();
    expect(await result).toBe(f.cause); expect(f.manager.save).toHaveBeenCalledTimes(1);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(entry);
    expect(f.state.failedMemorySaves.get('session:origin-memory')?.context).toBe(f.original);
  });
  it('does not adopt a retained candidate using a new invocation binding', async () => {
    const f = fixture(); await f.append(); const entry = f.state.pendingSaves.get('session:origin-memory')!;
    f.close(); const laterCheck = () => { expect(f.tracker.getContext()).toBe(f.other); };
    await expect(f.tracker.runAsync(f.other, () => f.handler.dispatch('addEntry', {
      element_name: 'origin-memory', content: 'Never applied by later invocation',
    }, laterCheck))).rejects.toBe(f.cause);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(entry);
    expect([...entry.memory.getEntries().values()].map(value => value.content)).toEqual(['Exact retained original content']);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('cannot adopt old work whose origin closes during a new invocation validation', async () => {
    const f = fixture(); await f.append(); const retained = f.state.pendingSaves.get('session:origin-memory')!;
    const before = [...f.memory.getEntries()]; const entered = barrier(); const resume = barrier();
    f.manager.assertPersistable.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const laterCheck = () => { if (f.tracker.getContext() !== f.other) throw new Error('Later context changed'); };
    const result = f.tracker.runAsync(f.other, () => f.handler.dispatch('addEntry', {
      element_name: 'origin-memory', content: 'Never adopted',
    }, laterCheck)).then(() => undefined, cause => cause);
    await entered.promise; f.close(); resume.release();
    expect(await result).toBe(f.cause); expect([...f.memory.getEntries()]).toEqual(before);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(retained);
    expect(retained.bindingCheck).toBe(f.bindingCheck); expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('refuses composed legacy clear before changing a retained sole-copy candidate', async () => {
    const f = fixture(); await f.append(); const retained = f.state.pendingSaves.get('session:origin-memory')!;
    const before = [...f.memory.getEntries()]; const clear = jest.spyOn(f.memory, 'clearAll');
    await expect(f.tracker.runAsync(f.original, () => f.handler.dispatch('clear', {
      element_name: 'origin-memory',
    }, f.bindingCheck))).rejects.toThrow('Retained deferred memory work');
    expect(clear).not.toHaveBeenCalled(); expect([...f.memory.getEntries()]).toEqual(before);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(retained);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('cannot let a stale scheduled timer callback erase a newer coalesced record', async () => {
    const f = fixture(); const scheduled = jest.spyOn(globalThis, 'setTimeout');
    await f.append(); const oldEntry = f.state.pendingSaves.get('session:origin-memory')!;
    const callback = scheduled.mock.calls.find(([, delay]) => delay === STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS)![0] as () => void;
    const laterCheck = () => { if (f.tracker.getContext() !== f.other) throw new Error('Later context changed'); };
    await f.tracker.runAsync(f.other, () => f.handler.dispatch('addEntry', {
      element_name: 'origin-memory', content: 'New retained content',
    }, laterCheck));
    const newer = f.state.pendingSaves.get('session:origin-memory')!;
    expect(newer).not.toBe(oldEntry); expect(newer.bindingCheck).toBe(laterCheck);
    // Deliver the actual old callback after replacement, modeling a scheduler
    // that already handed it off before cancellation. No timer internals used.
    callback(); await jest.advanceTimersByTimeAsync(0);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(newer);
    expect([...newer.memory.getEntries().values()].map(value => value.content)).toEqual([
      'Exact retained original content', 'New retained content',
    ]);
    expect(f.manager.save).toHaveBeenCalledTimes(1);
  });
  it('refuses clear when a preceding serialized append creates retained work during its wait', async () => {
    const f = fixture(); const entered = barrier(); const resume = barrier();
    f.manager.assertPersistable.mockImplementationOnce(async () => { entered.release(); await resume.promise; });
    const first = f.append(); await entered.promise;
    const tails = (MemorySaveHandler as unknown as { mutationTails: WeakMap<Memory, Promise<void>> }).mutationTails;
    const firstTail = tails.get(f.memory);
    expect(f.state.pendingSaves.size).toBe(0);
    const clear = jest.spyOn(f.memory, 'clearAll');
    const clearing = f.tracker.runAsync(f.original, () => f.handler.dispatch('clear', {
      element_name: 'origin-memory',
    }, f.bindingCheck)).then(() => undefined, cause => cause);
    for (let turn = 0; turn < 10 && tails.get(f.memory) === firstTail; turn++) await Promise.resolve();
    expect(tails.get(f.memory)).not.toBe(firstTail);
    resume.release(); await first;
    const retained = f.state.pendingSaves.get('session:origin-memory')!;
    expect(await clearing).toEqual(expect.objectContaining({ message: expect.stringContaining('Retained deferred memory work') }));
    expect(clear).not.toHaveBeenCalled(); expect(f.state.pendingSaves.get('session:origin-memory')).toBe(retained);
    expect([...f.memory.getEntries().values()].map(value => value.content)).toEqual(['Exact retained original content']);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('rechecks work created while a second append waited for mutation serialization', async () => {
    const f = fixture(); const enteredFirst = barrier(); const resumeFirst = barrier();
    const enteredSecond = barrier(); const resumeSecond = barrier();
    f.manager.assertPersistable.mockImplementationOnce(async () => { enteredFirst.release(); await resumeFirst.promise; });
    f.manager.assertPersistable.mockImplementationOnce(async () => { enteredSecond.release(); await resumeSecond.promise; });
    const first = f.append(); await enteredFirst.promise;
    const tails = (MemorySaveHandler as unknown as { mutationTails: WeakMap<Memory, Promise<void>> }).mutationTails;
    const firstTail = tails.get(f.memory);
    const laterCheck = () => { if (f.tracker.getContext() !== f.other) throw new Error('Later context changed'); };
    const second = f.tracker.runAsync(f.other, () => f.handler.dispatch('addEntry', {
      element_name: 'origin-memory', content: 'Never adopted after queued wait',
    }, laterCheck)).then(() => undefined, cause => cause);
    for (let turn = 0; turn < 10 && tails.get(f.memory) === firstTail; turn++) await Promise.resolve();
    expect(tails.get(f.memory)).not.toBe(firstTail);
    resumeFirst.release(); await first; await enteredSecond.promise;
    const retained = f.state.pendingSaves.get('session:origin-memory')!; f.close(); resumeSecond.release();
    expect(await second).toBe(f.cause); expect(f.state.pendingSaves.get('session:origin-memory')).toBe(retained);
    expect(retained.bindingCheck).toBe(f.bindingCheck);
    expect([...f.memory.getEntries().values()].map(value => value.content)).toEqual(['Exact retained original content']);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('retains the original queue when restoring its context fails before dispatch', async () => {
    const f = fixture(); await f.append(); const entry = f.state.pendingSaves.get('session:origin-memory')!;
    const restoreCause = new Error('Original context restoration failed');
    jest.spyOn(f.tracker, 'runAsync').mockRejectedValueOnce(restoreCause);
    await expect(f.handler.flushPendingSaves()).rejects.toBe(restoreCause);
    expect(f.state.pendingSaves.get('session:origin-memory')).toBe(entry);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.isMemoryDeletedAt).not.toHaveBeenCalled();
  });
  it('preserves ordinary context-less debounce behavior without a configured provider', async () => {
    const f = fixture(false);
    await f.handler.dispatch('addEntry', { element_name: 'origin-memory', content: 'ordinary' });
    await jest.advanceTimersByTimeAsync(STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS + 1);
    expect(f.manager.save).toHaveBeenCalledTimes(1); expect(f.state.pendingSaves.size).toBe(0);
  });
});
