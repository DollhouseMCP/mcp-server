import { jest, describe, it, expect } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { BackgroundValidator } from '../../../../src/security/validation/BackgroundValidator.js';
import type { PatternExtractor } from '../../../../src/security/validation/PatternExtractor.js';
import { TRUST_LEVELS } from '../../../../src/elements/memories/constants.js';
import { MemoryUpgradeLifecycle } from '../../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
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
  it('fresh file discovery follows each current owner root instead of the root-created storage resolver', () => owned(async (manager, _lifecycle, memory) => {
    const owner = new AsyncLocalStorage<string>();
    const internals = manager as unknown as { portfolioManager: PortfolioManager; getCacheNamespace: () => string };
    const originalDirectory = internals.portfolioManager.getElementDir.bind(internals.portfolioManager);
    const roots = new Map(['first', 'second'].map(key => [key, path.join(originalDirectory(ElementType.MEMORY), key)]));
    await Promise.all([...roots.values()].map(root => mkdir(root, { recursive: true })));
    jest.spyOn(internals.portfolioManager, 'getElementDir').mockImplementation(type =>
      owner.getStore() && type === ElementType.MEMORY ? roots.get(owner.getStore()!)! : originalDirectory(type));
    jest.spyOn(internals, 'getCacheNamespace').mockImplementation(() => owner.getStore() ?? 'default');
    const metadata = createTestMetadataService();
    try {
      await Promise.all([...roots.keys()].map(key => owner.run(key, async () => {
        const original = new Memory({ name: memory.metadata.name, description: 'Separate owned head' }, metadata);
        await original.addEntry(`${key} original`);
        await manager.save(original);
        await manager.runFreshMemoryMutation(original.metadata.name, async fresh => {
          expect([...fresh.getEntries().values()].map(entry => entry.content)).toEqual([`${key} original`]);
          await fresh.addEntry(`${key} durable append`);
          await manager.save(fresh);
        });
      })));
      await Promise.all([...roots.keys()].map(key => owner.run(key, () =>
        manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
          expect([...fresh.getEntries().values()].map(entry => entry.content).sort()).toEqual(
            [`${key} original`, `${key} durable append`].sort());
          expect(fresh.getFilePath()).toBeDefined();
        }))));
    } finally {
      jest.restoreAllMocks();
    }
  }));

  it('retains a background-validation candidate across disposal refusal and retries its exact known prewrite failure', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Ordinary benign text');
    await manager.save(memory);
    jest.spyOn(manager, 'list').mockResolvedValue([memory]);
    const validator = new BackgroundValidator({} as PatternExtractor, manager, { enabled: false }, lifecycle);
    const known = manager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const original = known.saveMemoryKnown.bind(manager);
    known.saveMemoryKnown = async () => { throw new Error('Owned prewrite interruption'); };
    await validator.processUntrustedMemories();
    expect(memory.getEntriesByTrustLevel(TRUST_LEVELS.VALIDATED)).toHaveLength(1);
    expect(validator.hasRetainedMemoryWork()).toBe(true);
    await expect(validator.dispose()).rejects.toThrow('Owned prewrite interruption');
    expect(() => manager.dispose()).toThrow('retain');
    known.saveMemoryKnown = original;
    await lifecycle.quiesceAndDrain();
    expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 0, retainedOwners: 0 });
    const persisted = await manager.load(memory.getFilePath()!);
    expect(persisted.getEntriesByTrustLevel(TRUST_LEVELS.VALIDATED).map(entry => entry.content)).toEqual(['Ordinary benign text']);
    expect(persisted.getEntries().size).toBe(1);
    await validator.dispose();
  }));

  it('retries the exact repaired candidate after an injected prewrite directory failure and clears drain', () => owned(async (manager, lifecycle, memory) => {
    memory.metadata.name = 'Upgrade repaired memory.backup-2025-11-14-22-40-57-303';
    await memory.addEntry('Preserve the exact repaired entry');
    const files = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const cause = Object.assign(new Error('Owned date directory failure'), { code: 'EIO' });
    const create = jest.spyOn(files, 'createDirectory').mockRejectedValueOnce(cause);
    try {
      await expect(manager.save(memory)).rejects.toMatchObject({ outcome: 'refused-before-write', cause });
      expect(create).toHaveBeenCalledTimes(1);
      expect(memory.metadata.name).toBe('Upgrade repaired memory');
      const repairedCandidate = memory.serialize();
      expect(lifecycle.getSummary()).toMatchObject({ writes: 0, failedWrites: 1, retainedOwners: 1 });
      expect(() => manager.dispose()).toThrow('retain');
      await manager.save(memory);
      expect(memory.serialize()).toBe(repairedCandidate);
      expect(lifecycle.getSummary()).toMatchObject({ writes: 0, failedWrites: 0, retainedOwners: 0 });
      const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
      const raw = new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
      expect(raw.metadata.name).toBe('Upgrade repaired memory');
      expect(raw.entries).toHaveLength(1);
      expect(raw.entries[0]).toMatchObject({ id: [...memory.getEntries().keys()][0], content: 'Preserve the exact repaired entry' });
      const persisted = await manager.load(memory.getFilePath()!);
      expect(persisted.metadata.name).toBe('Upgrade repaired memory');
      expect([...persisted.getEntries().values()].map(entry => entry.content)).toEqual(['Preserve the exact repaired entry']);
      await lifecycle.quiesceAndDrain();
      expect(lifecycle.getSummary().state).toBe('drained');
    } finally { create.mockRestore(); }
  }));

  it('retains a normalized background candidate through directory failure and known drain retry', () => owned(async (manager, lifecycle, memory) => {
    memory.metadata.name = 'Background repaired memory.backup-2025-11-14-22-40-57-303';
    await memory.addEntry('Preserve the validated normalized background entry');
    jest.spyOn(manager, 'list').mockResolvedValue([memory]);
    const validator = new BackgroundValidator({} as PatternExtractor, manager, { enabled: false }, lifecycle);
    const files = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const create = jest.spyOn(files, 'createDirectory').mockRejectedValueOnce(new Error('Owned background directory failure'));
    try {
      await validator.processUntrustedMemories();
      expect(create).toHaveBeenCalledTimes(1);
      expect(memory.metadata.name).toBe('Background repaired memory');
      expect(validator.hasRetainedMemoryWork()).toBe(true);
      expect(lifecycle.getSummary().failedWrites).toBe(1);
      const originalDescription = memory.metadata.description;
      memory.metadata.description = 'Changed after the normalized failure snapshot';
      await expect(validator.flushPendingSaves()).rejects.toThrow('without replay');
      await expect(manager.save(memory)).rejects.toThrow('without replay');
      expect(create).toHaveBeenCalledTimes(1);
      expect(lifecycle.getSummary().failedWrites).toBe(1);
      memory.metadata.description = originalDescription;
      await lifecycle.quiesceAndDrain();
      expect(lifecycle.getSummary()).toMatchObject({ state: 'drained', failedWrites: 0, retainedOwners: 0 });
      const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
      const raw = new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
      expect(raw.metadata.name).toBe('Background repaired memory');
      expect(raw.entries).toHaveLength(1);
      expect(raw.entries[0]).toMatchObject({ id: [...memory.getEntries().keys()][0],
        content: 'Preserve the validated normalized background entry', trustLevel: TRUST_LEVELS.VALIDATED });
      const persisted = await manager.load(memory.getFilePath()!);
      expect(persisted.metadata.name).toBe('Background repaired memory');
      expect(persisted.getEntriesByTrustLevel(TRUST_LEVELS.VALIDATED).map(entry => entry.content)).toEqual(
        ['Preserve the validated normalized background entry']);
      expect(persisted.getEntries().size).toBe(1);
      await validator.dispose();
    } finally { create.mockRestore(); jest.restoreAllMocks(); }
  }));

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
