import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createIntegrationContainer, type IntegrationContainer } from '../../../helpers/integration-container.js';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { SessionActivationRegistry } from '../../../../src/state/SessionActivationState.js';
import { logger } from '../../../../src/utils/logger.js';

describe('Memory activation references (#2924)', () => {
  let env: IntegrationContainer;
  let manager: MemoryManager;
  let tracker: ContextTracker;
  let registry: SessionActivationRegistry;
  const originalLimit = process.env.DOLLHOUSE_MAX_ACTIVE_MEMORIES;

  function memory(name: string): Memory {
    return new Memory({ name }, env.container.resolve('MetadataService'));
  }

  function inSession<T>(sessionId: string, fn: () => T): T {
    return tracker.run(tracker.createSessionContext('test', {
      userId: 'test-user', sessionId, tenantId: null, transport: 'http', createdAt: 0,
    }), fn);
  }

  beforeEach(async () => {
    process.env.DOLLHOUSE_MAX_ACTIVE_MEMORIES = '5';
    env = await createIntegrationContainer();
    manager = env.container.resolve('MemoryManager');
    tracker = env.container.resolve('ContextTracker');
    registry = env.container.resolve('SessionActivationRegistry');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await env.dispose();
    if (originalLimit === undefined) delete process.env.DOLLHOUSE_MAX_ACTIVE_MEMORIES;
    else process.env.DOLLHOUSE_MAX_ACTIVE_MEMORIES = originalLimit;
  });

  it.each(['empty', 'partial'])('preserves every threshold reference despite an %s discovery result', async kind => {
    const names = ['one', 'two', 'unloadable', 'evicted'];
    const state = registry.getOrCreate('A');
    names.forEach(name => state.memories.add(name));
    manager.clearCache();
    const found = memory('new-memory');
    jest.spyOn(manager, 'findByName').mockResolvedValue(found);
    const list = jest.spyOn(manager, 'list').mockResolvedValue(kind === 'empty' ? [] : [memory('one')]);
    await inSession('A', () => manager.activateMemory('new-memory'));
    expect([...state.memories]).toEqual([...names, 'new-memory']);
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps session references intact when delayed discovery completes after another session runs', async () => {
    const stateA = registry.getOrCreate('A');
    const stateB = registry.getOrCreate('B');
    ['one', 'two', 'three', 'four'].forEach(name => stateA.memories.add(name));
    stateB.memories.add('B-only');
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(manager, 'list').mockImplementation(async () => { await barrier; return []; });
    jest.spyOn(manager, 'findByName').mockResolvedValue(memory('new-memory'));
    await inSession('A', () => manager.activateMemory('new-memory'));
    await inSession('B', async () => { expect(tracker.getSessionContext()?.sessionId).toBe('B'); });
    release();
    await barrier;
    // The queued list continuation runs before this test's subsequent microtask.
    await Promise.resolve();
    expect([...stateB.memories]).toEqual(['B-only']);
    expect([...stateA.memories]).toEqual(['one', 'two', 'three', 'four', 'new-memory']);
  });

  it('keeps max warnings and explicit deactivation scoped to the intended session', async () => {
    const stateA = registry.getOrCreate('A');
    const stateB = registry.getOrCreate('B');
    ['one', 'two', 'three', 'four', 'five'].forEach(name => stateA.memories.add(name));
    stateB.memories.add('new-memory');
    const warn = jest.spyOn(logger, 'warn');
    jest.spyOn(manager, 'list').mockResolvedValue([]);
    jest.spyOn(manager, 'findByName').mockResolvedValue(memory('new-memory'));
    await inSession('A', () => manager.activateMemory('new-memory'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Active memories limit reached (5)'));
    await inSession('A', () => manager.deactivateMemory('new-memory'));
    expect([...stateA.memories]).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect([...stateB.memories]).toEqual(['new-memory']);
  });
});
