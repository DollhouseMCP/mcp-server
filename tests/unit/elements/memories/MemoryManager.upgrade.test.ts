import { jest, describe, it, expect } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { MemorySaveHandler } from '../../../../src/handlers/mcp-aql/MemorySaveHandler.js';
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

async function owned(body: (manager: MemoryManager, lifecycle: MemoryUpgradeLifecycle, memory: Memory) => Promise<void>, retainedFixture = false) {
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
    if (retainedFixture) {
      // Disposable unit fixture only: prove refusal without leaving a real
      // keepalive timer. The retained owners/candidates are never cleared.
      jest.useFakeTimers();
      try {
        await expect(lifecycle.quiesceAndDrain()).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
        expect(lifecycle.getSummary()).toMatchObject({ admitted: 0, writes: 0 });
        expect(lifecycle.getSummary().retainedOwners).toBeGreaterThan(0);
        expect(jest.getTimerCount()).toBe(1);
      } finally { jest.useRealTimers(); }
    } else {
      await lifecycle.quiesceAndDrain();
      manager.dispose();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Memory manager upgrade obligations', () => {
  it('does not duplicate an unacknowledged append after an injected definite prewrite failure', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Baseline retained');
    await manager.save(memory);
    const handler = new MemorySaveHandler({ memoryManager: manager, memoryUpgradeLifecycle: lifecycle } as
      ConstructorParameters<typeof MemorySaveHandler>[0], name => `owned-session:${name}`);
    const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
    const disk = async () => new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
    let source!: Memory;
    const fresh = manager.runFreshMemoryMutation.bind(manager);
    const lookup = jest.spyOn(manager, 'runFreshMemoryMutation').mockImplementation((name, mutate) => fresh(name, current => {
      source = current;
      return mutate(current);
    }));
    const paths = manager as unknown as { resolveMemorySavePath: (memory: Memory, filePath?: string) => Promise<string> };
    const create = jest.spyOn(paths, 'resolveMemorySavePath').mockRejectedValueOnce(new Error('Owned append path prewrite refusal'));
    const params = { element_name: memory.metadata.name, content: 'Original client retry' };
    try {
      const firstFailure = await handler.dispatch('addEntry', params).then(() => undefined, error => error);
      const firstEntries = [...source.getEntries().values()].map(entry => entry.content);
      const firstDisk = await disk();
      const firstSummary = lifecycle.getSummary();
      const receipt = await handler.dispatch('addEntry', params) as { id: string };
      const raw = await disk();
      await handler.dispatch('addEntry', params); // A later intentional identical append remains a distinct operation.
      const intentional = await disk();
      // Settle before assertions so a historical failure cannot hide the original operands.
      await lifecycle.quiesceAndDrain();
      await handler.dispose();
      expect(raw.entries.filter((entry: { content: string }) => entry.content === params.content)).toHaveLength(1);
      expect(firstFailure).toMatchObject({ outcome: 'refused-before-write' });
      expect(firstEntries).toEqual(['Baseline retained']);
      expect(firstDisk.entries.map((entry: { content: string }) => entry.content)).toEqual(['Baseline retained']);
      expect(firstSummary).toMatchObject({ failedWrites: 0, retainedOwners: 0 });
      expect(raw.entries.find((entry: { id: string }) => entry.id === receipt.id)?.content).toBe(params.content);
      expect(raw.entries.filter((entry: { content: string }) => entry.content === 'Baseline retained')).toHaveLength(1);
      expect(intentional.entries.filter((entry: { content: string }) => entry.content === params.content)).toHaveLength(2);
      expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 0, retainedOwners: 0 });
    } finally { create.mockRestore(); lookup.mockRestore(); }
  }));
  it('transfers persisted append read authority back to the same source instance', () => owned(async (manager, _lifecycle, memory) => {
    await memory.addEntry('Baseline retained');
    await manager.save(memory);
    await manager.runFreshMemoryMutation(memory.metadata.name, async source => {
      for (const content of ['First durable append', 'Second durable append']) {
        const before = source.captureAppendState();
        const candidate = source.createAppendCandidate();
        const entry = await candidate.addEntry(content);
        await manager.saveUnacknowledgedAppend(candidate, source);
        expect(manager.publishUnacknowledgedAppend(candidate, source, before, entry)).toBe(true);
      }
      expect([...source.getEntries().values()].map(entry => entry.content)).toEqual(
        ['Baseline retained', 'First durable append', 'Second durable append']);
    });
    await manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
      expect([...fresh.getEntries().values()].map(entry => entry.content)).toEqual(
        ['Baseline retained', 'First durable append', 'Second durable append']);
    });
  }));

  it('publishes a same-file relative alias and transfers authority for the next durable append', () => owned(async (manager, _lifecycle, memory) => {
    await memory.addEntry('Baseline retained');
    await manager.save(memory);
    const ids: string[] = [];
    await manager.runFreshMemoryMutation(memory.metadata.name, async source => {
      source.setFilePath(`.${path.sep}${source.getFilePath()!}`);
      for (const content of ['Alias durable append', 'Next durable append']) {
        const before = source.captureAppendState();
        const candidate = source.createAppendCandidate();
        const entry = await candidate.addEntry(content);
        await manager.saveUnacknowledgedAppend(candidate, source);
        expect(candidate.getFilePath()).not.toBe(source.getFilePath());
        expect(path.normalize(candidate.getFilePath()!)).toBe(path.normalize(source.getFilePath()!));
        expect(manager.publishUnacknowledgedAppend(candidate, source, before, entry)).toBe(true);
        ids.push(entry.id);
      }
    });
    await manager.runFreshMemoryMutation(memory.metadata.name, async fresh => {
      expect([...fresh.getEntries().values()].map(entry => entry.content)).toEqual(
        ['Baseline retained', 'Alias durable append', 'Next durable append']);
      for (const id of ids) expect([...fresh.getEntries().values()].filter(entry => entry.id === id)).toHaveLength(1);
    });
  }));

  it('refuses normalized aliases for database locators before publishing any staged entry', () => owned(async (manager, _lifecycle, memory) => {
    await memory.addEntry('Baseline retained');
    const sourceLocator = '12345678-1234-1234-1234-123456789abc';
    memory.setFilePath(sourceLocator);
    const internals = manager as unknown as { storageLayer: { writeContent?: () => Promise<void> } };
    const original = internals.storageLayer;
    const write = jest.fn(async () => { throw new Error('Database publication guard must not write'); });
    internals.storageLayer = { writeContent: write };
    try {
      const before = memory.captureAppendState();
      for (const locator of [`.${path.sep}${sourceLocator}`, sourceLocator.toUpperCase(), undefined]) {
        const candidate = memory.createAppendCandidate();
        const entry = await candidate.addEntry('Unpublished candidate');
        if (locator !== undefined) candidate.setFilePath(locator);
        expect(() => manager.publishUnacknowledgedAppend(candidate, memory, before, entry)).toThrow(expect.objectContaining({
          outcome: 'known-committed', cause: expect.objectContaining({ message: expect.stringContaining('Saved append locator changed') }),
        }));
        expect(memory.captureAppendState()).toEqual(before);
        expect(memory.getFilePath()).toBe(sourceLocator);
      }
      expect(write).not.toHaveBeenCalled();
    } finally { internals.storageLayer = original; }
  }));

  it('refuses an unacknowledged append if its source changes while the storage path is resolved', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Baseline retained'); await manager.save(memory);
    await manager.runFreshMemoryMutation(memory.metadata.name, async source => {
      const candidate = source.createAppendCandidate();
      await candidate.addEntry('Rejected staged append');
      const paths = manager as unknown as { resolveMemorySavePath: (memory: Memory, filePath?: string) => Promise<string> };
      const resolve = paths.resolveMemorySavePath.bind(manager);
      const path = jest.spyOn(paths, 'resolveMemorySavePath').mockImplementationOnce(async (...args) => {
        const result = await resolve(...args);
        await source.addEntry('Concurrent caller state');
        return result;
      });
      try {
        await expect(manager.saveUnacknowledgedAppend(candidate, source)).rejects.toMatchObject({ outcome: 'refused-before-write' });
        expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 0, writes: 0 });
      } finally { path.mockRestore(); }
      // The actual concurrent caller can persist its own state; the rejected
      // candidate is never replayed, copied, or acknowledged.
      await manager.save(source);
    });
    const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
    const raw = new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
    expect(raw.entries.map((entry: { content: string }) => entry.content)).toEqual(['Concurrent caller state', 'Baseline retained']);
  }));

  it('retains an unknown unacknowledged append without publishing or replaying it', () => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Baseline retained'); await manager.save(memory);
    const handler = new MemorySaveHandler({ memoryManager: manager, memoryUpgradeLifecycle: lifecycle } as
      ConstructorParameters<typeof MemorySaveHandler>[0], name => `owned-session:${name}`);
    const files = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const write = jest.spyOn(files, 'writeFile').mockRejectedValueOnce(new Error('Owned started write outcome unknown'));
    const params = { element_name: memory.metadata.name, content: 'Unknown client append' };
    try {
      await expect(handler.dispatch('addEntry', params)).rejects.toMatchObject({ outcome: 'unknown' });
      const retained = [...(handler as unknown as { failedMemorySaves: Map<string, { memory: Memory }> }).failedMemorySaves.values()][0].memory;
      expect([...retained.getEntries().values()].map(entry => entry.content)).toEqual(['Baseline retained', params.content]);
      await expect(handler.dispatch('addEntry', params)).rejects.toThrow('cannot be replayed');
      await expect(handler.flushPendingSaves()).rejects.toThrow('cannot be replayed');
      expect(write).toHaveBeenCalledTimes(1);
      const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
      const raw = new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
      expect(raw.entries.map((entry: { content: string }) => entry.content)).toEqual(['Baseline retained']);
      expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 1, writes: 0 });
    } finally { write.mockRestore(); }
  }, true));

  it.each(['source-state', 'saved-locator'])('retains a known committed append on %s publication conflict and never replays it', conflict => owned(async (manager, lifecycle, memory) => {
    await memory.addEntry('Baseline retained'); await manager.save(memory);
    const handler = new MemorySaveHandler({ memoryManager: manager, memoryUpgradeLifecycle: lifecycle } as
      ConstructorParameters<typeof MemorySaveHandler>[0], name => `owned-session:${name}`);
    const save = manager.saveUnacknowledgedAppend.bind(manager);
    const pending = jest.spyOn(manager, 'saveUnacknowledgedAppend').mockImplementation(async (candidate, source) => {
      await save(candidate, source);
      if (conflict === 'source-state') await source.addEntry('Owned concurrent RAM publication');
      else candidate.setFilePath('unexpected-saved-locator.yaml');
    });
    const files = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const write = jest.spyOn(files, 'writeFile');
    const params = { element_name: memory.metadata.name, content: 'Committed client append' };
    try {
      await expect(handler.dispatch('addEntry', params)).rejects.toMatchObject({ outcome: 'known-committed' });
      await expect(handler.dispatch('addEntry', params)).rejects.toThrow('cannot be replayed');
      await expect(handler.flushPendingSaves()).rejects.toThrow('cannot be replayed');
      expect(write).toHaveBeenCalledTimes(1);
      const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
      const raw = new SerializationService().parsePureYaml(await readFile(path.join(root, memory.getFilePath()!), 'utf8'));
      expect(raw.entries.map((entry: { content: string }) => entry.content)).toEqual([params.content, 'Baseline retained']);
      expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 0, writes: 0, retainedOwners: 1 });
    } finally { pending.mockRestore(); write.mockRestore(); }
  }, true));

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

  it.each(['old-source', 'saved-destination'])('refreshes explicit relocation authority when %s is externally edited', edited => owned(async (manager, lifecycle, memory) => {
    const baseline = await memory.addEntry('Original durable entry');
    await manager.save(memory);
    const root = (manager as unknown as { portfolioManager: PortfolioManager }).portfolioManager.getElementDir(ElementType.MEMORY);
    const oldLocator = memory.getFilePath()!;
    const destination = 'relocated-upgrade-memory.yaml';
    await manager.runFreshMemoryMutation(memory.metadata.name, async loaded => {
      await manager.save(loaded, destination);
      expect(loaded.getFilePath()).toBe(destination);
      const editedPath = path.join(root, edited === 'old-source' ? oldLocator : destination);
      const externalBytes = `${await readFile(editedPath, 'utf8')}\n# Owned external edit\n`;
      await writeFile(editedPath, externalBytes, 'utf8');
      const next = await loaded.addEntry('After explicit relocation');
      const result = await manager.save(loaded).then(() => ({ saved: true, error: undefined }), error => ({ saved: false, error }));
      const editedAfter = await readFile(editedPath, 'utf8');
      const finalDestination = new SerializationService().parsePureYaml(await readFile(path.join(root, destination), 'utf8'));
      // Settle first: a stale refusal is before write and must create no accepted obligation.
      await lifecycle.quiesceAndDrain();
      expect(lifecycle.getSummary()).toMatchObject({ failedWrites: 0, retainedOwners: 0, writes: 0 });
      expect(editedAfter).toBe(externalBytes);
      if (edited === 'old-source') {
        expect(result).toEqual({ saved: true, error: undefined });
        expect(finalDestination.entries.map((entry: { id: string }) => entry.id).sort()).toEqual([baseline.id, next.id].sort());
      } else {
        expect(result.saved).toBe(false);
        expect(result.error).toMatchObject({ code: 'ECONTENTCONFLICT' });
        expect(finalDestination.entries.map((entry: { id: string }) => entry.id)).toEqual([baseline.id]);
      }
    });
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
