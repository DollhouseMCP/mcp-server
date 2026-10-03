/**
 * Tests for Issue #2861 — rollover_memory seals older entries into read-only
 * archive volumes and resets the live memory under the same name.
 *
 * MemoryManager.rolloverMemory() writes and verifies every volume but does not
 * modify the live memory; the caller applies the result and saves through the
 * ordinary save path. These tests pin:
 * - volumes are standard memory YAML under memories/volumes/<memory>/, never listed
 * - dry runs write nothing
 * - oversized legacy memories (#2864) split into volumes within MAX_YAML_SIZE
 * - nothing is written when the live memory would still be too large
 * - a failure part-way removes the volumes written by that call
 * - the volume index survives save and reload, and numbering continues
 * - database storage mode is refused with a clear error
 */

import { jest } from '@jest/globals';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { ExclusiveCreateCleanupError, FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';
import { MEMORY_CONSTANTS, TRUST_LEVELS } from '../../../../src/elements/memories/constants.js';
import type { MemoryRolloverOptions } from '../../../../src/elements/memories/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

const metadataService = createTestMetadataService();

const options = (overrides: Partial<MemoryRolloverOptions> = {}): MemoryRolloverOptions => ({
  keepTags: [...MEMORY_CONSTANTS.ROLLOVER_DEFAULT_KEEP_TAGS],
  keepLatest: 0,
  dryRun: false,
  ...overrides,
});

/** A memory with `count` entries of roughly `entryChars` characters each. */
async function buildMemory(name: string, count: number, entryChars = 200): Promise<Memory> {
  const memory = new Memory({ name, description: `Rollover test memory ${name}` }, metadataService);
  const body = 'rollover test entry lorem ipsum dolor sit amet '.repeat(Math.ceil(entryChars / 47)).slice(0, entryChars);
  for (let i = 0; i < count; i++) {
    await memory.addEntry(`entry-${i}: ${body}`, ['sized']);
  }
  return memory;
}

describe('MemoryManager.rolloverMemory (#2861)', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof MemoryManager>;
  let testDir: string;
  let memoriesDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-rollover-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    container = new DollhouseContainer();
    container.replace('FileLockManager', () => new FileLockManager());
    container.replace('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.replace('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.replace('SerializationService', () => new SerializationService());
    container.replace('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.replace('MemoryManager', () => new MemoryManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      storageLayerFactory: createTestStorageFactory(),
    }));

    manager = container.resolve('MemoryManager');
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });

  afterAll(async () => {
    await container.dispose();
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  async function volumeFiles(slug: string): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(memoriesDir, 'volumes', slug))).sort();
    } catch {
      return [];
    }
  }

  it('writes a verified volume under memories/volumes/<memory>/ that is never listed', async () => {
    const memory = await buildMemory('Volume Basics', 6);
    await manager.save(memory, 'volume-basics.yaml');

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 2 }));

    expect(result.sealedCount).toBe(4);
    expect(result.keptCount).toBe(2);
    expect(result.sealedIds).toHaveLength(4);
    expect(result.volumes).toHaveLength(1);
    const [record] = result.volumes;
    expect(record.file).toBe('volumes/volume-basics/v0001.yaml');

    const written = await fs.readFile(path.join(memoriesDir, record.file), 'utf-8');
    expect(crypto.createHash('sha256').update(written, 'utf8').digest('hex')).toBe(record.sha256);
    expect(written).toContain('entry-0:');
    expect(written).not.toContain('entry-5:');

    // The live memory is untouched until the caller applies the result.
    expect(await memory.search({})).toHaveLength(6);

    const listed = (await manager.list()).map(m => m.metadata.name);
    expect(listed).toContain('Volume Basics');
    expect(listed.some(name => name.includes('volume'))).toBe(false);
  });

  it('writes nothing on a dry run', async () => {
    const memory = await buildMemory('Dry Run Memory', 5);

    const result = await manager.rolloverMemory(memory, options({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.sealedCount).toBe(5);
    expect(result.volumes).toHaveLength(1);
    expect(result.sealedIds).toEqual([]);
    expect(await volumeFiles('dry-run-memory')).toEqual([]);
  });

  it('previews occupied volume numbers without overwriting an existing file', async () => {
    const memory = await buildMemory('Occupied Preview', 3);
    const volumeDir = path.join(memoriesDir, 'volumes', 'occupied-preview');
    await fs.mkdir(volumeDir, { recursive: true });
    const occupiedPath = path.join(volumeDir, 'v0001.yaml');
    await fs.writeFile(occupiedPath, 'pre-existing owner bytes');

    const preview = await manager.rolloverMemory(memory, options({ dryRun: true }));
    expect(preview.volumes[0].file).toBe('volumes/occupied-preview/v0002.yaml');
    expect(await volumeFiles('occupied-preview')).toEqual(['v0001.yaml']);

    const actual = await manager.rolloverMemory(memory, options());
    expect(actual.volumes[0].file).toBe(preview.volumes[0].file);
    expect(await fs.readFile(occupiedPath, 'utf8')).toBe('pre-existing owner bytes');
  });

  it('rejects an unsafe persisted volume number and still assigns dry-run and live filenames safely', async () => {
    const memory = await buildMemory('Unsafe Index', 2);
    const serialized = JSON.parse(memory.serialize()) as { metadata: Record<string, unknown> };
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    serialized.metadata.volumes = [{
      volume: unsafe,
      file: `volumes/unsafe-index/v${unsafe}.yaml`,
      sealedAt: '2026-01-01T00:00:00.000Z',
      entryCount: 1,
      sha256: 'a'.repeat(64),
    }];
    const loaded = new Memory({ name: 'Unsafe Index' }, metadataService);
    loaded.deserialize(JSON.stringify(serialized));
    expect(loaded.getVolumeRecords()).toHaveLength(0);

    const preview = await manager.rolloverMemory(loaded, options({ dryRun: true }));
    expect(preview.volumes[0].file).toBe('volumes/unsafe-index/v0001.yaml');
    expect(await volumeFiles('unsafe-index')).toEqual([]);
    const actual = await manager.rolloverMemory(loaded, options());
    expect(actual.volumes[0].file).toBe(preview.volumes[0].file);
    expect(await volumeFiles('unsafe-index')).toEqual(['v0001.yaml']);
    loaded.applyRollover(actual.sealedIds, actual.volumes);
    expect(loaded.getVolumeRecords()).toEqual(actual.volumes);
    expect(loaded.metadata.volumes).toEqual(actual.volumes);
  });

  it('stops dry-run and live allocation when the next safe number is occupied', async () => {
    const first = Number.MAX_SAFE_INTEGER - 1;
    const memory = new Memory({
      name: 'Safe Boundary',
      volumes: [{
        volume: first,
        file: `volumes/safe-boundary/v${first}.yaml`,
        sealedAt: '2026-01-01T00:00:00.000Z',
        entryCount: 1,
        sha256: 'b'.repeat(64),
      }],
    }, metadataService);
    await memory.addEntry('seal this entry');
    const volumeDir = path.join(memoriesDir, 'volumes', 'safe-boundary');
    await fs.mkdir(volumeDir, { recursive: true });
    const occupied = Memory.volumeFileName(Number.MAX_SAFE_INTEGER);
    await fs.writeFile(path.join(volumeDir, occupied), 'pre-existing owner bytes');

    await expect(manager.rolloverMemory(memory, options({ dryRun: true })))
      .rejects.toThrow('positive safe integer');
    await expect(manager.rolloverMemory(memory, options()))
      .rejects.toThrow('positive safe integer');
    // The directory can change after a successful preview. Force an exclusive
    // create collision at the last safe integer to exercise the live allocator.
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const exists = jest.spyOn(fileOps, 'exists').mockResolvedValue(false);
    const create = jest.spyOn(fileOps, 'createFileExclusive').mockResolvedValue(false);
    try {
      await expect(manager.rolloverMemory(memory, options()))
        .rejects.toThrow('positive safe integer');
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      exists.mockRestore();
      create.mockRestore();
    }
    expect(await volumeFiles('safe-boundary')).toEqual([occupied]);
    expect(await fs.readFile(path.join(volumeDir, occupied), 'utf8')).toBe('pre-existing owner bytes');
    expect(memory.getVolumeRecords()).toHaveLength(1);
    expect(await memory.search({})).toHaveLength(1);
  });

  it('bounds dry-run and live collision probing to 1000 attempts', async () => {
    const memory = await buildMemory('No Free Number', 2);
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const exists = jest.spyOn(fileOps, 'exists').mockResolvedValue(true);
    try {
      await expect(manager.rolloverMemory(memory, options({ dryRun: true })))
        .rejects.toThrow('No free volume number');
      expect(exists).toHaveBeenCalledTimes(1000);
      exists.mockClear();
      await expect(manager.rolloverMemory(memory, options()))
        .rejects.toThrow('No free volume number');
      expect(exists).toHaveBeenCalledTimes(1000);
      exists.mockResolvedValue(false);
      const create = jest.spyOn(fileOps, 'createFileExclusive').mockResolvedValue(false);
      try {
        await expect(manager.rolloverMemory(memory, options()))
          .rejects.toThrow('No free volume number');
        expect(create).toHaveBeenCalledTimes(1000);
      } finally {
        create.mockRestore();
      }
    } finally {
      exists.mockRestore();
    }
    expect(await volumeFiles('no-free-number')).toEqual([]);
    expect(await memory.search({})).toHaveLength(2);
  });

  it('rejects a name with no safe archive slug before creating a volume', async () => {
    const memory = new Memory({ name: '日本語' }, metadataService);
    await memory.addEntry('old');
    await memory.addEntry('new');

    await expect(manager.rolloverMemory(memory, options({ keepLatest: 1, keepTags: [] })))
      .rejects.toThrow('no safe archive filename');
    await expect(fs.access(path.join(memoriesDir, 'volumes', 'v0001.yaml'))).rejects.toThrow();
  });

  it('seals nothing and writes nothing when every entry is kept', async () => {
    const memory = await buildMemory('All Kept', 3);

    const result = await manager.rolloverMemory(memory, options({ keepTags: ['sized'] }));

    expect(result.sealedCount).toBe(0);
    expect(await volumeFiles('all-kept')).toEqual([]);
  });

  it('splits an oversized legacy memory into volumes within MAX_YAML_SIZE (#2864)', async () => {
    // ~600KB: over the save limit, as a pre-#2329 file could be.
    const memory = await buildMemory('Oversized Legacy', 40, 16 * 1024);

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 2 }));

    expect(result.sealedCount).toBe(38);
    expect(result.volumes.length).toBeGreaterThan(1);
    expect(result.volumes.reduce((sum, v) => sum + v.entryCount, 0)).toBe(38);
    for (const record of result.volumes) {
      const written = await fs.readFile(path.join(memoriesDir, record.file), 'utf-8');
      expect(written.length).toBeLessThanOrEqual(MEMORY_CONSTANTS.MAX_YAML_SIZE);
    }

    memory.applyRollover(result.sealedIds, result.volumes);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('omits the marker when a reduced entry limit would evict a kept entry', async () => {
    const original = await buildMemory('Reduced Limit', 4);
    const serialized = JSON.parse(original.serialize()) as { metadata: Record<string, unknown> };
    serialized.metadata.maxEntries = 2;
    serialized.metadata.onFull = 'evict_oldest';
    const memory = new Memory({ name: 'Reduced Limit', maxEntries: 2, onFull: 'evict_oldest' }, metadataService);
    memory.deserialize(JSON.stringify(serialized));
    // Editing metadata does not change the instance's effective constructor
    // limit; the projected head must use the same capacity as the live head.
    memory.metadata.maxEntries = 5000;
    const keptIds = memory.planRollover([], 2).kept.map(entry => entry.id);

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 2, keepTags: [] }));

    expect(result.includeMarker).toBe(false);
    expect(result.markerEntry).toBeUndefined();
    memory.applyRollover(result.sealedIds, result.volumes);
    expect(memory.getStats().totalEntries).toBe(2);
    expect(memory.planRollover([], 2).kept.map(entry => entry.id)).toEqual(keptIds);
    expect(memory.getPolicyRemovedCount()).toBe(0);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('leaves the final count-limit slot for the next user entry', async () => {
    const memory = new Memory({ name: 'One Free Slot', maxEntries: 2, onFull: 'error' }, metadataService);
    await memory.addEntry('seal this');
    const kept = await memory.addEntry('keep this');

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 1, keepTags: [] }));
    expect(result.includeMarker).toBe(false);
    memory.applyRollover(result.sealedIds, result.volumes);
    expect(memory.getEntries().has(kept.id)).toBe(true);
    await expect(memory.addEntry('next user entry')).resolves.toBeDefined();
    expect(memory.getStats().totalEntries).toBe(2);
    expect(memory.getPolicyRemovedCount()).toBe(0);
  });

  it('never evicts an entry for a marker when maxEntries is clamped to 1000', () => {
    const memory = new Memory({ name: 'Clamped Limit', maxEntries: 5000, onFull: 'evict_oldest' }, metadataService);
    const serialized = JSON.parse(memory.serialize()) as { entries: Array<Record<string, unknown>> };
    serialized.entries = Array.from({ length: 1000 }, (_, index) => ({
      id: `kept-${index}`, timestamp: '2026-01-01T00:00:00.000Z',
      content: `kept ${index}`, tags: [], trustLevel: 'untrusted',
    }));
    memory.deserialize(JSON.stringify(serialized));
    memory.metadata.maxEntries = 5000;
    const keptIds = new Set(memory.planRollover([], 1000).kept.map(entry => entry.id));
    const marker = memory.prepareRolloverMarker('Archived earlier entries.', [1]);

    expect(memory.appendPreparedRolloverMarkerIfCapacity(marker)).toBe(false);
    expect(new Set(memory.planRollover([], 1000).kept.map(entry => entry.id))).toEqual(keptIds);
    expect(memory.getPolicyRemovedCount()).toBe(0);
  });

  it('uses the identical sanitized marker in projection and live memory', async () => {
    const memory = await buildMemory('Prepared Marker', 4);
    const result = await manager.rolloverMemory(memory, options({ keepLatest: 1, reason: 'exact entry' }));

    expect(result.markerEntry).toBeDefined();
    expect(result.markerEntry?.metadata?.rolloverVolumes).toEqual([1]);
    memory.applyRollover(result.sealedIds, result.volumes);
    expect(memory.appendPreparedRolloverMarkerIfCapacity(result.markerEntry!)).toBe(true);
    expect(memory.appendPreparedRolloverMarkerIfCapacity(result.markerEntry!)).toBe(false);
    expect(memory.getEntries().get(result.markerEntry!.id)).toBe(result.markerEntry);
    expect(memory.getPolicyRemovedCount()).toBe(0);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('projects expired kept entries without invoking on-load retention', async () => {
    const retention = { shouldEnforceOnLoad: () => true, isEnabled: () => true };
    const memory = new Memory({ name: 'Expired Kept', retentionDays: 1 }, metadataService, undefined, retention);
    const kept = await memory.addEntry('must stay live', ['pinned']);
    kept.expiresAt = new Date('2020-01-01T00:00:00.000Z');
    await memory.addEntry('seal me');

    const result = await manager.rolloverMemory(memory, options({ keepTags: ['pinned'], keepLatest: 0 }));
    memory.applyRollover(result.sealedIds, result.volumes);
    if (result.markerEntry) memory.appendPreparedRolloverMarkerIfCapacity(result.markerEntry);

    expect(memory.getEntries().has(kept.id)).toBe(true);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('archives every selected live entry without a second quarantine filter', async () => {
    const memory = new Memory({ name: 'Quarantined Archive' }, metadataService);
    const archived = await memory.addEntry('archive the exact bytes');
    archived.trustLevel = TRUST_LEVELS.QUARANTINED;
    await memory.addEntry('keep newest');

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 1, keepTags: [] }));
    expect(result.sealedCount).toBe(1);
    const yaml = await fs.readFile(path.join(memoriesDir, result.volumes[0].file), 'utf8');
    expect(yaml).toContain(archived.id);
    expect(yaml).toContain('archive the exact bytes');
    expect(result.volumes[0].entryCount).toBe(1);
  });

  it('keeps the actual post-rollover YAML within the limit at the marker boundary', async () => {
    const makeBoundaryMemory = (thirdSize: number): Memory => {
      const memory = new Memory({ name: 'Marker Boundary' }, metadataService);
      const serialized = JSON.parse(memory.serialize()) as { entries: Array<Record<string, unknown>> };
      serialized.entries = [
        { id: 'keep-3', timestamp: '2026-01-04T00:00:00.000Z', content: 'c'.repeat(thirdSize), tags: [] },
        { id: 'keep-2', timestamp: '2026-01-03T00:00:00.000Z', content: 'b'.repeat(100_000), tags: [] },
        { id: 'keep-1', timestamp: '2026-01-02T00:00:00.000Z', content: 'a'.repeat(100_000), tags: [] },
        { id: 'seal-1', timestamp: '2026-01-01T00:00:00.000Z', content: 'old', tags: [] },
      ];
      memory.deserialize(JSON.stringify(serialized));
      return memory;
    };

    // Find the largest retained payload accepted by preflight; it leaves less
    // room than a marker and exercises the exact serialized-head boundary.
    let low = 0;
    let high = 62_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const probe = makeBoundaryMemory(mid);
      try {
        await manager.rolloverMemory(probe, options({ dryRun: true, keepLatest: 3, keepTags: [] }));
        low = mid;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('still over the')) throw error;
        high = mid - 1;
      }
    }

    const memory = makeBoundaryMemory(low);
    const result = await manager.rolloverMemory(memory, options({ keepLatest: 3, keepTags: [] }));
    expect(result.includeMarker).toBe(false);
    memory.applyRollover(result.sealedIds, result.volumes);
    expect(memory.getStats().totalEntries).toBe(3);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('refuses before writing anything when the live memory would still be too large', async () => {
    const memory = await buildMemory('Still Too Big', 40, 16 * 1024);

    await expect(manager.rolloverMemory(memory, options({ keepLatest: 30 })))
      .rejects.toThrow('still over the');
    expect(await volumeFiles('still-too-big')).toEqual([]);
  });

  it('removes the volumes it wrote when a later volume fails, without changing the live memory', async () => {
    const memory = await buildMemory('Fails Midway', 40, 16 * 1024);
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const original = fileOps.createFileExclusive.bind(fileOps);
    let calls = 0;
    const spy = jest.spyOn(fileOps, 'createFileExclusive').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) throw new Error('simulated disk failure');
      return original(...args);
    });

    try {
      await expect(manager.rolloverMemory(memory, options({ keepLatest: 2 })))
        .rejects.toThrow('recorded volumes were removed');
    } finally {
      spy.mockRestore();
    }
    expect(await volumeFiles('fails-midway')).toEqual([]);
    expect(await memory.search({})).toHaveLength(40);
  });

  it('reports an incomplete cleanup instead of claiming a full rollback', async () => {
    const memory = await buildMemory('Cleanup Fails', 40, 16 * 1024);
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const create = fileOps.createFileExclusive.bind(fileOps);
    let calls = 0;
    const createSpy = jest.spyOn(fileOps, 'createFileExclusive').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) throw new Error('second volume failed');
      return create(...args);
    });
    const deleteSpy = jest.spyOn(fileOps, 'deleteFile').mockRejectedValueOnce(new Error('permission denied'));
    try {
      await expect(manager.rolloverMemory(memory, options({ keepLatest: 2 })))
        .rejects.toThrow(/cleanup failed and unindexed archive copies may remain.*volume 1: permission denied/);
    } finally {
      createSpy.mockRestore();
      deleteSpy.mockRestore();
    }
    expect(await volumeFiles('cleanup-fails')).toEqual(['v0001.yaml']);
    expect(await memory.search({})).toHaveLength(40);
  });

  it('reports an untracked partial volume when exclusive-create cleanup fails', async () => {
    const memory = await buildMemory('Partial Create', 2);
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const partialPath = path.join(memoriesDir, 'volumes', 'partial-create', 'v0001.yaml');
    const spy = jest.spyOn(fileOps, 'createFileExclusive').mockRejectedValueOnce(
      new ExclusiveCreateCleanupError(partialPath, new Error('disk full'), new Error('unlink denied')),
    );

    try {
      await expect(manager.rolloverMemory(memory, options({ keepLatest: 1, keepTags: [] })))
        .rejects.toThrow('unindexed archive copies may remain');
    } finally {
      spy.mockRestore();
    }
    expect(memory.getStats().totalEntries).toBe(2);
  });

  it('keeps the volume index across save and reload, and continues numbering', async () => {
    const memory = await buildMemory('Numbered Log', 4);
    const first = await manager.rolloverMemory(memory, options());
    memory.applyRollover(first.sealedIds, first.volumes);
    await manager.save(memory, 'numbered-log.yaml');

    const reloaded = await manager.load('numbered-log.yaml');
    expect(reloaded.getVolumeRecords()).toEqual(first.volumes);

    await reloaded.addEntry('entry after first rollover', ['sized']);
    const second = await manager.rolloverMemory(reloaded, options());
    expect(second.volumes.map(v => v.volume)).toEqual([2]);
    expect(await volumeFiles('numbered-log')).toEqual(['v0001.yaml', 'v0002.yaml']);
  });

  it('refuses in database storage mode with a clear error', async () => {
    const memory = await buildMemory('Database Mode', 2);
    const original = (manager as unknown as { storageLayer: unknown }).storageLayer;
    Object.defineProperty(manager, 'storageLayer', { value: { writeContent: async () => 'id' }, configurable: true });
    try {
      await expect(manager.rolloverMemory(memory, options()))
        .rejects.toThrow('not yet available in database storage mode');
    } finally {
      Object.defineProperty(manager, 'storageLayer', { value: original, configurable: true, writable: false });
    }
  });
});
