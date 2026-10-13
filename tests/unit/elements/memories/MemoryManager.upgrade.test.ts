import { jest, describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { MemoryUpgradeLifecycle } from '../../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

async function owned(body: (manager: MemoryManager, lifecycle: MemoryUpgradeLifecycle, memory: Memory) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-upgrade-unit-'));
  const metadata = createTestMetadataService();
  const locks = new FileLockManager();
  const files = new FileOperationsService(locks);
  const lifecycle = new MemoryUpgradeLifecycle();
  const manager = new MemoryManager({ portfolioManager: new PortfolioManager(files, { baseDir: directory }),
    fileLockManager: locks, fileOperationsService: files,
    validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadata),
    serializationService: new SerializationService(), metadataService: metadata,
    eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory(),
    memoryUpgradeLifecycle: lifecycle });
  const memory = new Memory({ name: 'Upgrade owned memory', description: 'Owned fixture' }, metadata);
  try { await body(manager, lifecycle, memory); }
  finally {
    // Never hide or discard an unresolved original write in fixture teardown.
    await lifecycle.quiesceAndDrain();
    manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Memory manager upgrade obligations', () => {
  it('pure invalid unacknowledged input does not register an unknown write or block disposal', () => owned(async (manager, lifecycle, memory) => {
    jest.spyOn(memory, 'validate').mockReturnValue({ valid: false, errors: ['Owned invalid candidate'] });
    await expect(manager.save(memory)).rejects.toThrow('Invalid memory');
    expect(lifecycle.getSummary()).toMatchObject({ writes: 0, failedWrites: 0, retainedOwners: 0 });
    expect(manager.hasRetainedMemoryWork()).toBe(false);
  }));

  it('definite pre-persistence refusal is retained and only an exact later known save reconciles it', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Retain this exact candidate');
    const known = manager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const original = known.saveMemoryKnown.bind(manager);
    known.saveMemoryKnown = async () => { throw new Error('Owned persistence fault'); };
    await expect(manager.save(memory)).rejects.toThrow('Owned persistence fault');
    expect(manager.hasRetainedMemoryWork()).toBe(true);
    expect(() => manager.dispose()).toThrow('retain');
    known.saveMemoryKnown = original;
    await manager.save(memory);
    expect(manager.hasRetainedMemoryWork()).toBe(false);
    expect(lifecycle.getSummary().failedWrites).toBe(0);
  }));

  it('fresh same-target FIFO preserves both independent Memory instances and rejects a stale loaded candidate', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Original entry');
    await manager.save(memory);
    let first: Memory | undefined;
    let second: Memory | undefined;
    await Promise.all([
      manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
        first = fresh;
        await fresh.addEntry('First accepted entry');
        await manager.save(fresh);
      }),
      manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
        second = fresh;
        await fresh.addEntry('Second accepted entry');
        await manager.save(fresh);
      }),
    ]);
    expect(first).not.toBe(second);
    await manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
      const entries = [...fresh.getEntries().values()].map(entry => entry.content);
      expect(entries).toEqual(expect.arrayContaining(['Original entry', 'First accepted entry', 'Second accepted entry']));
    });
    // The old instance must not overwrite the newer acknowledged state.
    await first!.addEntry('Unacknowledged stale candidate');
    await expect(manager.save(first!)).rejects.toMatchObject({ code: 'ECONTENTCONFLICT' });
    expect(lifecycle.getSummary().failedWrites).toBe(0);
    // This direct caller has not acknowledged or changed the head. AQL's
    // MemorySaveHandler separately retains its mutated non-ACK candidate.
  }));
});
