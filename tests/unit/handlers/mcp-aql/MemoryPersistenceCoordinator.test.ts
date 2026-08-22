import { describe, expect, it, jest } from '@jest/globals';

import { MemoryPersistenceCoordinator } from '../../../../src/handlers/mcp-aql/MemoryPersistenceCoordinator.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('MemoryPersistenceCoordinator', () => {
  it('lets an entered save finish before deletion and rejects its token afterward', async () => {
    const coordinator = new MemoryPersistenceCoordinator();
    const version = coordinator.capture('alice:Code Review');
    const saveEntered = deferred();
    const finishSave = deferred();
    const saveOperation = jest.fn(async () => {
      saveEntered.resolve();
      await finishSave.promise;
    });

    const save = coordinator.runSave(version, saveOperation);
    await saveEntered.promise;
    const deletion = coordinator.runDelete('alice:Code Review', async () => 'deleted');
    finishSave.resolve();

    await expect(save).resolves.toBe(true);
    await expect(deletion).resolves.toBe('deleted');
    await expect(coordinator.runSave(version, jest.fn(async () => undefined))).resolves.toBe(false);
  });

  it('invalidates a stale save waiting behind deletion without running it', async () => {
    const coordinator = new MemoryPersistenceCoordinator();
    const version = coordinator.capture('alice:Code Review');
    const deleteEntered = deferred();
    const finishDelete = deferred();
    const deletion = coordinator.runDelete('alice:Code Review', async () => {
      deleteEntered.resolve();
      await finishDelete.promise;
    });
    await deleteEntered.promise;
    const saveOperation = jest.fn(async () => undefined);
    const save = coordinator.runSave(version, saveOperation);

    finishDelete.resolve();
    await deletion;

    await expect(save).resolves.toBe(false);
    expect(saveOperation).not.toHaveBeenCalled();
  });

  it('reclaims successful deletion state while stale tokens remain fenced', async () => {
    const coordinator = new MemoryPersistenceCoordinator();
    const staleVersions = [];
    for (let index = 0; index < 100; index += 1) {
      const version = coordinator.capture(`alice:memory-${index}`);
      staleVersions.push(version);
      await coordinator.runDelete(version.key, async () => undefined);
      expect(coordinator.trackedKeyCountForTesting()).toBe(0);
    }

    const staleSave = jest.fn(async () => undefined);
    for (const version of staleVersions) {
      await expect(coordinator.runSave(version, staleSave)).resolves.toBe(false);
    }
    expect(staleSave).not.toHaveBeenCalled();

    const replacement = coordinator.capture('alice:memory-0');
    await expect(coordinator.runSave(replacement, jest.fn(async () => undefined))).resolves.toBe(true);
  });

  it('reclaims successful save state across many unique keys', async () => {
    const coordinator = new MemoryPersistenceCoordinator();

    for (let index = 0; index < 100; index += 1) {
      const version = coordinator.capture(`alice:memory-${index}`);
      await expect(coordinator.runSave(version, jest.fn(async () => undefined))).resolves.toBe(true);
      expect(coordinator.trackedKeyCountForTesting()).toBe(0);
    }
  });

  it('does not invalidate a token when deletion fails', async () => {
    const coordinator = new MemoryPersistenceCoordinator();
    const version = coordinator.capture('alice:retained-memory');

    await expect(coordinator.runDelete(version.key, async () => {
      throw new Error('storage delete failed');
    })).rejects.toThrow('storage delete failed');

    await expect(coordinator.runSave(version, jest.fn(async () => undefined))).resolves.toBe(true);
  });
});
