import * as path from 'node:path';
/**
 * Unit tests for MemoryStorageLayer
 */

import { MAX_CACHED_DIRECTORY_STATES } from '../../../src/storage/DirectoryStateCache.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { logger } from '../../../src/utils/logger.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { MemoryIndexData } from '../../../src/storage/MemoryIndexFile.js';

// ---- Helpers ----

const MEMORIES_DIR = path.resolve('data', 'memories');

function makeMeta(relPath: string, mtimeMs: number, sizeBytes = 500): StorageItemMetadata {
  return {
    relativePath: relPath,
    absolutePath: `${MEMORIES_DIR}/${relPath}`,
    mtimeMs,
    sizeBytes,
  };
}

function makeYaml(name: string, opts: { autoLoad?: boolean; priority?: number; memoryType?: string; description?: string } = {}): string {
  const lines = [
    `name: ${name}`,
    `description: "${opts.description ?? `Description of ${name}`}"`,
    'version: "1.0.0"',
    'author: "tester"',
    'tags: []',
  ];
  if (opts.autoLoad !== undefined) lines.push(`autoLoad: ${opts.autoLoad}`);
  if (opts.priority !== undefined) lines.push(`priority: ${opts.priority}`);
  if (opts.memoryType !== undefined) lines.push(`memoryType: "${opts.memoryType}"`);
  lines.push('entries:', '  - content: "sample entry"');
  return lines.join('\n');
}

function createMockBackend(overrides: Partial<IStorageBackend> = {}): IStorageBackend {
  return {
    listDirectories: jest.fn<any>().mockResolvedValue([]),
    listFiles: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue(makeMeta('test.yaml', 1000)),
    statMany: jest.fn<any>().mockResolvedValue({ stats: new Map(), failures: new Map() }),
    readFile: jest.fn<any>().mockResolvedValue(makeYaml('Test')),
    directoryExists: jest.fn<any>().mockResolvedValue(true),
    ...overrides,
  };
}

function makeMockFileOps(): FileOperationsService {
  return {
    readFile: jest.fn<any>(),
    writeFile: jest.fn<any>(),
    exists: jest.fn<any>(),
    readElementFile: jest.fn<any>(),
    deleteFile: jest.fn<any>(),
    createDirectory: jest.fn<any>(),
    listDirectory: jest.fn<any>().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn<any>(),
    renameFile: jest.fn<any>(),
    stat: jest.fn<any>(),
    resolvePath: jest.fn<any>(),
    validatePath: jest.fn<any>(),
    createFileExclusive: jest.fn<any>(),
    copyFile: jest.fn<any>(),
    chmod: jest.fn<any>(),
    appendFile: jest.fn<any>(),
  } as unknown as FileOperationsService;
}

/** Build a valid MemoryIndexData payload for mocking _index.json reads. */
function makeIndexData(
  entries: Record<string, { name: string; mtimeMs: number; autoLoad?: boolean; priority?: number }>,
): MemoryIndexData {
  const record: MemoryIndexData['entries'] = {};
  for (const [filePath, meta] of Object.entries(entries)) {
    record[filePath] = {
      filePath,
      name: meta.name,
      description: `Description of ${meta.name}`,
      version: '1.0.0',
      author: 'tester',
      tags: [],
      mtimeMs: meta.mtimeMs,
      sizeBytes: 500,
      autoLoad: meta.autoLoad,
      priority: meta.priority,
    };
  }
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    entryCount: Object.keys(record).length,
    entries: record,
  };
}

describe('MemoryStorageLayer', () => {
  let backend: IStorageBackend;
  let fileOps: FileOperationsService;
  let layer: MemoryStorageLayer;

  beforeEach(() => {
    backend = createMockBackend({
      listFiles: jest.fn<any>().mockResolvedValue(['baseline.yaml']),
      statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() }),
      readFile: jest.fn<any>().mockResolvedValue(makeYaml('Baseline')),
    });

    fileOps = makeMockFileOps();

    // By default, no _index.json exists (ENOENT)
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    (fileOps.readFile as jest.Mock<any>).mockRejectedValue(enoent);
    (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

    // The backend returns discovered directories
    (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['system']);

    layer = new MemoryStorageLayer(fileOps, {
      memoriesDir: MEMORIES_DIR,
      scanCooldownMs: 100,
      storageBackend: backend,
      indexDebounceMs: 50000, // Long debounce so scheduled writes don't fire during tests
    });
  });

  afterEach(async () => {
    // Prevent timers from leaking
    await layer.dispose();
  });

  it('schedules an index write only when a scan updates the index', async () => {
    await layer.scan();
    await layer['getState']().persistence.flush();
    const schedule = jest.spyOn(layer['getState']().persistence, 'request');
    try {
      layer.invalidate();
      await layer.scan();
      expect(schedule).not.toHaveBeenCalled();

      jest.mocked(backend.statMany).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 2000)],
      ]), failures: new Map() });
      layer.invalidate();
      await layer.scan();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule.mock.calls[0][0]()).toEqual(layer['getState']().table.persistableSnapshot());
    } finally {
      schedule.mockRestore();
    }
  });

  it('preserves exact element and memory scan logs and silent memory cooldown', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(5000);
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    const elementBackend = createMockBackend({
      listFiles: jest.fn<IStorageBackend['listFiles']>().mockResolvedValue(['sample.md']),
      statMany: jest.fn<IStorageBackend['statMany']>().mockResolvedValue({ stats: new Map([
        ['sample.md', makeMeta('sample.md', 1000)],
      ]), failures: new Map() }),
      readFile: jest.fn<IStorageBackend['readFile']>().mockResolvedValue('---\nname: Sample\n---\nContent'),
    });
    const element = new ElementStorageLayer(fileOps, {
      elementDir: path.resolve('data', 'skills'), fileExtension: '.md', scanCooldownMs: 100, storageBackend: elementBackend,
    });
    try {
      await element.scan();
      expect(debug).toHaveBeenCalledWith('ElementStorageLayer.scan: DISK SCAN for skills — 1 files, 1 added, 0 modified, 0 removed');
      debug.mockClear();
      await element.scan();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith('ElementStorageLayer.scan: COOLDOWN ACTIVE for skills — skipping disk I/O (100ms remaining)');

      debug.mockClear();
      await layer.scan();
      expect(debug).toHaveBeenCalledWith('MemoryStorageLayer.scan: DISK SCAN — 2 files, 1 added, 0 modified, 0 removed');
      debug.mockClear();
      await layer.scan();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      clock.mockRestore();
    }
  });

  it('preserves a final snapshot on clear without resetting hydration completion', async () => {
    await layer.scan();
    const state = layer['getState']();
    expect(state.hydrationStarted).toBe(true);
    const dispose = jest.spyOn(state.persistence, 'dispose');
    try {
      layer.clear();
      expect(dispose).not.toHaveBeenCalled();
      expect(state.persistence.hasPendingWrite()).toBe(true);
      await state.persistence.flush();
      expect(fileOps.writeFile).toHaveBeenCalled();
      expect(state.hydrationStarted).toBe(true);
      expect(state.table.everSucceeded).toBe(false);
    } finally {
      dispose.mockRestore();
    }
  });

  it('reads cold index status without scanning', async () => {
    expect(await layer.readIndexedPath(['Baseline'])).toEqual({ path: undefined, indexComplete: false, authoritative: false, unindexed: [] });
    expect(backend.statMany).not.toHaveBeenCalled();
    expect(await layer.findIndexedPath(['Baseline'])).toBe('system/baseline.yaml');
    expect(await layer.readIndexedPath(['Baseline'])).toEqual({ path: 'system/baseline.yaml', indexComplete: true, authoritative: true, unindexed: [] });
  });

  it.each([false, true])('leaves warm modified diffs for refresh (invalidated: %s)', async invalidate => {
    await layer.scan();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 3000)],
      ]), failures: new Map() });
      if (invalidate) layer.invalidate();
      expect(await layer.findIndexedPath(['Baseline'])).toBe('system/baseline.yaml');
      expect(await layer.readIndexedPath(['Baseline'])).toMatchObject({ indexComplete: true, authoritative: !invalidate });
      const diff = await layer.scan();
      expect(diff.modified).toContain('system/baseline.yaml');
    } finally {
      clock.mockRestore();
    }
  });

  // ----------------------------------------------------------------
  // 1. Cold start without _index.json
  // ----------------------------------------------------------------
  describe('cold start without _index.json', () => {
    it('should trigger full rebuild and index all files', async () => {
      const diff = await layer.scan();

      // Cold bootstrap stages performScan, then returns EMPTY_DIFF
      expect(diff.added).toEqual(['system/baseline.yaml']);
      expect(diff.modified).toEqual([]);
      expect(diff.removed).toEqual([]);

      // After rebuild, index should be populated
      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('Baseline');
    });

    it('should write _index.json after rebuild', async () => {
      await layer.scan();

      await layer['getState']().persistence.flush();
      // Durability is established by flush, after successful publication.
      expect(fileOps.writeFile).toHaveBeenCalled();
      const writtenContent = (fileOps.writeFile as jest.Mock<any>).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent) as MemoryIndexData;
      expect(parsed.version).toBe(2);
      expect(parsed.entryCount).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // 2. Cold start with valid _index.json
  // ----------------------------------------------------------------
  describe('cold start with valid _index.json', () => {
    it('should load entries from _index.json then run incremental scan', async () => {
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'Baseline', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));

      // statMany returns same mtime => no changes
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() });

      const diff = await layer.scan();

      // File unchanged since _index.json was written
      expect(diff.unchanged).toEqual(['system/baseline.yaml']);
      expect(diff.added).toEqual([]);
      expect(diff.modified).toEqual([]);

      // Index was pre-populated from _index.json
      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('Baseline');
    });
  });

  // ----------------------------------------------------------------
  // 3. Cooldown behavior
  // ----------------------------------------------------------------
  describe('cooldown behavior', () => {
    it('should return EMPTY_DIFF on second scan within cooldown with zero disk I/O', async () => {
      await layer.scan(); // cold start
      (backend.directoryExists as jest.Mock<any>).mockClear();
      (backend.listFiles as jest.Mock<any>).mockClear();

      const secondDiff = await layer.scan();

      expect(secondDiff.added).toEqual([]);
      expect(secondDiff.modified).toEqual([]);
      expect(secondDiff.removed).toEqual([]);
      expect(secondDiff.unchanged).toEqual([]);

      // No backend calls during cooldown
      expect(backend.directoryExists).not.toHaveBeenCalled();
      expect(backend.listFiles).not.toHaveBeenCalled();
    });

    it('should scan again after cooldown expires', async () => {
      const shortLayer = new MemoryStorageLayer(fileOps, {
        memoriesDir: MEMORIES_DIR,
        scanCooldownMs: 1,
        storageBackend: backend,
        indexDebounceMs: 50000,
      });

      await shortLayer.scan(); // cold start
      (backend.directoryExists as jest.Mock<any>).mockClear();

      await new Promise(resolve => setTimeout(resolve, 10));
      await shortLayer.scan();

      // directoryExists called again for the second scan
      expect(backend.directoryExists).toHaveBeenCalledTimes(1);

      await shortLayer.dispose();
    });
  });

  // ----------------------------------------------------------------
  // 4. Concurrent scan deduplication
  // ----------------------------------------------------------------
  describe('concurrent scan deduplication', () => {
    it('should return the same promise for concurrent scan() calls', async () => {
      // First call is cold start, which calls rebuildIndexForDir -> performScan
      // Need to set up so cold start loads from _index.json and runs incremental
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'Baseline', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() });

      // Cold start completes first
      await layer.scan();

      // Invalidate so next scan hits disk
      layer.invalidate();

      // Now fire three concurrent post-cold-start scans
      const [d1, d2, d3] = await Promise.all([
        layer.scan(),
        layer.scan(),
        layer.scan(),
      ]);

      // Scan deduplication: second and third should get same promise result
      expect(d1).toBe(d2);
      expect(d2).toBe(d3);
    });

    it('runs one trailing scan for freshness-sensitive callers', async () => {
      await layer.scan();
      (backend.directoryExists as jest.Mock<any>).mockClear();
      layer.invalidate();

      let markOlderScanStarted!: () => void;
      let releaseOlderScan!: () => void;
      const olderScanStarted = new Promise<void>((resolve) => {
        markOlderScanStarted = resolve;
      });
      const olderScanBlocked = new Promise<void>((resolve) => {
        releaseOlderScan = resolve;
      });
      (backend.directoryExists as jest.Mock<any>)
        .mockImplementationOnce(async () => {
          markOlderScanStarted();
          await olderScanBlocked;
          return true;
        })
        .mockResolvedValue(true);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 2000)],
      ]), failures: new Map() });

      const olderScan = layer.scan();
      await olderScanStarted;
      const freshScans = [
        layer.scan({ freshAfterInFlight: true }),
        layer.scan({ freshAfterInFlight: true }),
      ];
      releaseOlderScan();
      const [, firstFreshDiff, secondFreshDiff] = await Promise.all([olderScan, ...freshScans]);

      expect(backend.directoryExists).toHaveBeenCalledTimes(2);
      expect(firstFreshDiff.modified).toContain('system/baseline.yaml');
      expect(secondFreshDiff.modified).toContain('system/baseline.yaml');
    });
  });

  // ----------------------------------------------------------------
  // 5. Multi-directory scanning
  // ----------------------------------------------------------------
  describe('multi-directory scanning', () => {
    it('should discover system/, adapters/, date folders, and root', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue([
        'system', 'adapters', '2025-06-01', '2025-12-31', 'backups', '_index.json',
      ]);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.endsWith('system')) return ['core.yaml'];
        if (dir.endsWith('adapters')) return ['github.yaml'];
        if (dir.endsWith('2025-06-01')) return ['notes.yaml'];
        if (dir.endsWith('2025-12-31')) return ['year-end.yaml'];
        if (dir === MEMORIES_DIR) return ['legacy.yaml'];
        return [];
      });

      const allRelPaths = [
        'system/core.yaml',
        'adapters/github.yaml',
        '2025-06-01/notes.yaml',
        '2025-12-31/year-end.yaml',
        'legacy.yaml',
      ];

      const statsMap = new Map(
        allRelPaths.map(p => [p, makeMeta(p, 1000)])
      );
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: statsMap, failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        const filename = path.basename(absPath, '.yaml');
        return makeYaml(filename.charAt(0).toUpperCase() + filename.slice(1));
      });

      await layer.scan(); // cold start (no _index.json)

      const summaries = await layer.listSummaries();
      const names = summaries.map(s => s.name).sort();
      expect(names).toEqual(['Core', 'Github', 'Legacy', 'Notes', 'Year-end']);

      // backups/ and _index.json should NOT have been scanned
      const paths = await layer.getIndexedPaths();
      expect(paths).not.toContain('backups/anything.yaml');
    });
  });

  // ----------------------------------------------------------------
  // 6. fileFilter
  // ----------------------------------------------------------------
  describe('fileFilter', () => {
    it('should exclude files rejected by the filter', async () => {
      const filtered = new MemoryStorageLayer(fileOps, {
        memoriesDir: MEMORIES_DIR,
        scanCooldownMs: 100,
        storageBackend: backend,
        indexDebounceMs: 50000,
        fileFilter: (filename) => !filename.endsWith('.bak.yaml'),
      });

      (backend.listDirectories as jest.Mock<any>).mockResolvedValue([]);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue([
        'active.yaml', 'old.bak.yaml',
      ]);

      // Only the non-backup file should be stat'd
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['active.yaml', makeMeta('active.yaml', 1000)],
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Active'));

      await filtered.scan();

      const paths = await filtered.getIndexedPaths();
      expect(paths).toEqual(['active.yaml']);
      expect(paths).not.toContain('old.bak.yaml');

      await filtered.dispose();
    });
  });

  // ----------------------------------------------------------------
  // 7. scanMemorySnapshot(true)
  // ----------------------------------------------------------------
  describe('scanMemorySnapshot(true)', () => {
    it('should return only entries with autoLoad === true, sorted by priority', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['system']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.endsWith('system')) return ['core.yaml', 'optional.yaml'];
        if (dir === MEMORIES_DIR) return ['user.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/core.yaml', makeMeta('system/core.yaml', 1000)],
        ['system/optional.yaml', makeMeta('system/optional.yaml', 1000)],
        ['user.yaml', makeMeta('user.yaml', 1000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('core')) return makeYaml('Core', { autoLoad: true, priority: 10 });
        if (absPath.includes('optional')) return makeYaml('Optional', { autoLoad: false });
        if (absPath.includes('user')) return makeYaml('UserNotes', { autoLoad: true, priority: 5 });
        return makeYaml('Unknown');
      });

      await layer.scan();

      const autoLoaded = (await layer.scanMemorySnapshot(true)).entries;
      expect(autoLoaded).toHaveLength(2);
      // Sorted by priority ascending: 5 before 10
      expect(autoLoaded[0].name).toBe('UserNotes');
      expect(autoLoaded[0].priority).toBe(5);
      expect(autoLoaded[1].name).toBe('Core');
      expect(autoLoaded[1].priority).toBe(10);
    });

    it('should preserve auto-load metadata when entry prose matches scanner patterns', async () => {
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['scanner-research.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['scanner-research.yaml', makeMeta('scanner-research.yaml', 1000)],
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockResolvedValue(`
name: Scanner Research
description: Historical security examples
autoLoad: true
priority: 2
entries:
  - content: "Example using require('child_process') for analysis"
    trustLevel: untrusted
`);

      await layer.scan();

      expect((await layer.scanMemorySnapshot(true)).entries).toEqual([
        expect.objectContaining({
          name: 'Scanner Research',
          autoLoad: true,
          priority: 2,
        }),
      ]);
    });

    it.each([false, true])('pins entries and failures together while the resolver changes (autoload: %s)', async autoLoad => {
      let root = MEMORIES_DIR;
      const backend = createMockBackend({ listFiles: jest.fn<any>().mockResolvedValue(['bad.yaml']) });
      const files = makeMockFileOps();
      const layer = new MemoryStorageLayer(files, { memoriesDir: root, memoriesDirResolver: () => root, storageBackend: backend });
      const state = layer['getState']();
      state.hydrationStarted = true;
      (backend.statMany as jest.Mock<any>).mockImplementation(async () => {
        root = path.resolve('another-user');
        return { stats: new Map(), failures: new Map([['bad.yaml', Object.assign(new Error('denied'), { code: 'EACCES' })]]) };
      });
      try {
        const snapshot = await layer.scanMemorySnapshot(autoLoad);
        expect(snapshot.entries).toEqual([]);
        expect(snapshot.unindexed.get('bad.yaml')).toEqual({ name: 'Error', reason: 'Cannot inspect storage path "bad.yaml" (EACCES)', code: 'EACCES' });
        expect(layer['getState']().table.unindexed().size).toBe(0);
        expect(state.table.unindexed().has('bad.yaml')).toBe(true);
      } finally { await layer.dispose(); }
    });

    it('keeps auto-load reads on the scanned state while other directories are retained', async () => {
      await layer.dispose();
      layer = new MemoryStorageLayer(fileOps, {
        memoriesDir: MEMORIES_DIR, storageBackend: backend,
        retainDirectoryState: dir => dir !== MEMORIES_DIR,
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(makeIndexData({
        'hand-written.yaml': { name: 'Core', mtimeMs: 1000, autoLoad: true, priority: 1 },
      })));
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['hand-written.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['hand-written.yaml', makeMeta('hand-written.yaml', 1000)],
      ]), failures: new Map() });
      for (let index = 0; index <= MAX_CACHED_DIRECTORY_STATES; index++) {
        layer['getState'](path.resolve('retained', String(index)));
      }
      // More than the cap are non-idle: even the caller's MRU state is evicted after scan.
      await layer.scan();
      expect(layer.hasCompletedScan()).toBe(false);
      const entries = (await layer.scanMemorySnapshot(true)).entries;
      expect(entries).toEqual([expect.objectContaining({
        filePath: 'hand-written.yaml', name: 'Core', autoLoad: true, priority: 1,
      })]);
      expect(layer.hasCompletedScan()).toBe(false);
    });

    it('should return empty array when no entries have autoLoad === true', async () => {
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['regular.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['regular.yaml', makeMeta('regular.yaml', 1000)],
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Regular'));

      await layer.scan();

      expect((await layer.scanMemorySnapshot(true)).entries).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // 8. notifySaved()
  // ----------------------------------------------------------------
  describe('notifySaved()', () => {
    it('should update index and schedule debounced write', async () => {
      await layer.scan(); // cold start

      (backend.stat as jest.Mock<any>).mockResolvedValue(makeMeta('system/new.yaml', 5000));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('NewMemory'));

      const extractSpy = jest.spyOn(MemoryMetadataExtractor, 'extractMetadata');

      await layer.notifySaved('system/new.yaml', `${MEMORIES_DIR}/system/new.yaml`);

      expect(extractSpy).toHaveBeenCalled();
      expect(layer.getPathByName('NewMemory')).toBe('system/new.yaml');

      extractSpy.mockRestore();
    });

    it('should invalidate on failure instead of throwing', async () => {
      await layer.scan();

      (backend.readFile as jest.Mock<any>).mockRejectedValue(new Error('disk error'));
      (backend.stat as jest.Mock<any>).mockRejectedValue(new Error('disk error'));

      // Should not throw
      await expect(
        layer.notifySaved('bad.yaml', `${MEMORIES_DIR}/bad.yaml`)
      ).resolves.toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // 9. notifyDeleted()
  // ----------------------------------------------------------------
  describe('notifyDeleted()', () => {
    it('should remove entry from index', async () => {
      await layer.scan();

      expect(layer.getPathByName('Baseline')).toBe('system/baseline.yaml');

      layer.notifyDeleted('system/baseline.yaml');

      expect(layer.getPathByName('Baseline')).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // 10. Corrupt _index.json triggers rebuild
  // ----------------------------------------------------------------
  describe('corrupt _index.json triggers rebuild', () => {
    it('should fall back to full rebuild when _index.json read returns null', async () => {
      // Persistence returns null for corrupt JSON.
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue('not valid json {{{');

      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['system']);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['baseline.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Baseline'));

      // Cold start should detect corrupt index and rebuild
      await layer.scan();

      await layer['getState']().persistence.flush();
      // The write from cold bootstrap
      expect(fileOps.writeFile).toHaveBeenCalled();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('Baseline');
    });
  });

  // ----------------------------------------------------------------
  // 11. Modified file detected via mtime
  // ----------------------------------------------------------------
  describe('modified file detected via mtime', () => {
    it('should re-parse a file whose mtime changed', async () => {
      // Set up _index.json with an old entry
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'OldName', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));

      // statMany returns newer mtime
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 9999)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('UpdatedName'));

      const diff = await layer.scan();

      expect(diff.modified).toEqual(['system/baseline.yaml']);

      const summaries = await layer.listSummaries();
      expect(summaries[0].name).toBe('UpdatedName');
    });
  });

  // ----------------------------------------------------------------
  // 12. Directory doesn't exist
  // ----------------------------------------------------------------
  describe('directory does not exist', () => {
    it('should return empty results and clear index', async () => {
      (backend.directoryExists as jest.Mock<any>).mockResolvedValue(false);

      // No _index.json either
      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(0);
    });

    it('should report previously indexed paths as removed', async () => {
      // First, populate with valid _index.json
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'Baseline', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));

      // performScan sees directory exists on first scan
      (backend.directoryExists as jest.Mock<any>).mockResolvedValue(true);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() });

      await layer.scan(); // cold start populates index

      // Now directory disappears
      layer.invalidate();
      (backend.directoryExists as jest.Mock<any>).mockResolvedValue(false);

      const diff = await layer.scan();
      expect(diff.removed).toContain('system/baseline.yaml');
    });
  });

  // ----------------------------------------------------------------
  // 13. invalidate()
  // ----------------------------------------------------------------
  describe('invalidate()', () => {
    it('should reset cooldown so next scan hits disk', async () => {
      await layer.scan(); // cold start
      (backend.directoryExists as jest.Mock<any>).mockClear();

      // Within cooldown, no disk I/O
      await layer.scan();
      expect(backend.directoryExists).not.toHaveBeenCalled();

      // Invalidate resets cooldown
      layer.invalidate();
      await layer.scan();
      expect(backend.directoryExists).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // 14. clear()
  // ----------------------------------------------------------------
  describe('clear()', () => {
    it('should reset all state so next scan re-indexes everything as added', async () => {
      // Populate via _index.json
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'Baseline', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]), failures: new Map() });

      await layer.scan();
      expect(layer.getPathByName('Baseline')).toBe('system/baseline.yaml');

      layer.clear();

      expect(layer.getPathByName('Baseline')).toBeUndefined();

      // Summaries should be empty without a new scan
      // The snapshot applies the normal scan cooldown.
      expect((await layer.scanMemorySnapshot(true)).entries).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Additional edge cases
  // ----------------------------------------------------------------
  describe('getPathByName()', () => {
    it('should return undefined before any scan', () => {
      expect(layer.getPathByName('anything')).toBeUndefined();
    });
  });

  describe('listSummaries()', () => {
    it('should trigger a scan if not yet scanned', async () => {
      const summaries = await layer.listSummaries();
      // Cold start should have run
      expect(summaries).toHaveLength(1);
    });
  });

  describe('getIndexedPaths()', () => {
    it('should return all file paths after scan', async () => {
      await layer.scan();
      const paths = await layer.getIndexedPaths();
      expect(paths).toContain('system/baseline.yaml');
    });
  });

  describe('ENOENT during subdirectory listing', () => {
    it('should handle listFiles ENOENT for missing subdirectories', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['system', 'adapters']);

      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.endsWith('adapters')) throw enoent;
        if (dir.endsWith('system')) return ['core.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['system/core.yaml', makeMeta('system/core.yaml', 1000)],
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Core'));

      // Should not throw
      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('Core');
    });
  });

  // ----------------------------------------------------------------
  // Issue #654: Name-based deduplication across date folders
  // ----------------------------------------------------------------
  describe('name-based deduplication (Issue #654)', () => {
    it('should deduplicate memories with the same name across date folders', async () => {
      // Same memory "session-notes" in two date folders
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-01-19', '2026-01-26']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01-19') || dir.includes('2026-01-26')) return ['session-notes.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-01-19/session-notes.yaml', makeMeta('2026-01-19/session-notes.yaml', 1000)],
        ['2026-01-26/session-notes.yaml', makeMeta('2026-01-26/session-notes.yaml', 2000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('session-notes'));

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('session-notes');
      // Should keep the most recently modified copy
      expect(summaries[0].mtimeMs).toBe(2000);
    });

    it('should keep most recently modified copy when same name has different mtimes', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-01-10', '2026-01-20', '2026-01-30']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01')) return ['prefs.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-01-10/prefs.yaml', makeMeta('2026-01-10/prefs.yaml', 100)],
        ['2026-01-20/prefs.yaml', makeMeta('2026-01-20/prefs.yaml', 300)],
        ['2026-01-30/prefs.yaml', makeMeta('2026-01-30/prefs.yaml', 200)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('prefs'));

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].mtimeMs).toBe(300);
      expect(summaries[0].filePath).toBe('2026-01-20/prefs.yaml');
    });

    it('should deduplicate case-insensitively', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-01-01', '2026-01-02']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01-01')) return ['notes.yaml'];
        if (dir.includes('2026-01-02')) return ['notes2.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-01-01/notes.yaml', makeMeta('2026-01-01/notes.yaml', 1000)],
        ['2026-01-02/notes2.yaml', makeMeta('2026-01-02/notes2.yaml', 2000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('notes2')) return makeYaml('My-Notes');
        return makeYaml('my-notes');
      });

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      // Should keep the one with higher mtime
      expect(summaries[0].mtimeMs).toBe(2000);
    });

    it('should deduplicate canonical-equivalent Unicode names', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-04-01', '2026-04-02']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-04-01')) return ['cafe-a.yaml'];
        if (dir.includes('2026-04-02')) return ['cafe-b.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-04-01/cafe-a.yaml', makeMeta('2026-04-01/cafe-a.yaml', 1000)],
        ['2026-04-02/cafe-b.yaml', makeMeta('2026-04-02/cafe-b.yaml', 2000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('cafe-a')) return makeYaml('Cafe\u0301');
        return makeYaml('Café');
      });

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].mtimeMs).toBe(2000);
      expect(layer.getPathByName('Café')).toBe('2026-04-02/cafe-b.yaml');
    });

    it('should return deduplicated paths from getIndexedPaths()', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-02-01', '2026-02-15']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-02')) return ['log.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-02-01/log.yaml', makeMeta('2026-02-01/log.yaml', 1000)],
        ['2026-02-15/log.yaml', makeMeta('2026-02-15/log.yaml', 2000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('log'));

      await layer.scan();

      const paths = await layer.getIndexedPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe('2026-02-15/log.yaml');
    });

    it('should handle empty arrays without errors', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue([]);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue([]);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map(), failures: new Map() });

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(0);

      const paths = await layer.getIndexedPaths();
      expect(paths).toHaveLength(0);
    });

    it('should not deduplicate distinct memory names', async () => {
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-03-01']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-03-01')) return ['alpha.yaml', 'beta.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-03-01/alpha.yaml', makeMeta('2026-03-01/alpha.yaml', 1000)],
        ['2026-03-01/beta.yaml', makeMeta('2026-03-01/beta.yaml', 2000)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('alpha')) return makeYaml('alpha');
        return makeYaml('beta');
      });

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(2);
    });

    it('selects the most recently modified duplicate across date folders', async () => {
      // Date folders returned in random order
      (backend.listDirectories as jest.Mock<any>).mockResolvedValue(['2026-03-15', '2026-01-01', '2026-02-10']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-')) return ['context.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['2026-01-01/context.yaml', makeMeta('2026-01-01/context.yaml', 100)],
        ['2026-02-10/context.yaml', makeMeta('2026-02-10/context.yaml', 200)],
        ['2026-03-15/context.yaml', makeMeta('2026-03-15/context.yaml', 300)],
      ]), failures: new Map() });

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('context'));

      await layer.scan();

      // getPathByName should point to newest (last-scanned = newest date folder)
      const resolvedPath = layer.getPathByName('context');
      expect(resolvedPath).toBe('2026-03-15/context.yaml');
    });
  });
});

describe('guarded fresh metadata discovery', () => {
  it('scoped discovery retains the injected backend and custom filter without changing its resolver or index', async () => {
    const fileOps = makeMockFileOps(); const backend = createMockBackend();
    const selected = path.resolve('selected-owner', 'memories');
    (backend.listFiles as jest.Mock<any>).mockResolvedValue(['first.yaml', 'second.yaml', 'excluded.yaml']);
    (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('duplicate'));
    const filter = jest.fn((filename: string) => filename !== 'excluded.yaml');
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: MEMORIES_DIR,
      memoriesDirResolver: () => path.resolve('root-context', 'memories'), storageBackend: backend, fileFilter: filter });
    try {
      const entries = await layer.readFreshSummariesAtDirectory(selected, true);
      expect(entries.map(entry => entry.name)).toEqual(['duplicate', 'duplicate']);
      expect(backend.listFiles).toHaveBeenCalledWith(selected, '.yaml');
      expect((backend.readFile as jest.Mock<any>).mock.calls.map(([value]) => value)).toEqual(
        [path.join(selected, 'first.yaml'), path.join(selected, 'second.yaml')]);
      expect(filter).toHaveBeenCalledWith('excluded.yaml');
      expect(backend.statMany).not.toHaveBeenCalled();
      expect(fileOps.writeFile).not.toHaveBeenCalled();
      jest.clearAllMocks();
      await layer.listSummaries({ freshMetadata: true });
      expect(backend.listFiles).toHaveBeenCalledWith(path.resolve('root-context', 'memories'), '.yaml');
    } finally { await layer.dispose(); }
  });

  it.each(['discover', 'enumerate', 'read', 'stat'])('propagates %s failures rather than returning a partial inventory', async step => {
    const fileOps = makeMockFileOps(); const backend = createMockBackend();
    const cause = Object.assign(new Error(`Controlled ${step} failure`), { code: 'EIO' });
    (backend.listFiles as jest.Mock<any>).mockResolvedValue(['head.yaml']);
    if (step === 'discover') (backend.listDirectories as jest.Mock<any>).mockRejectedValue(cause);
    if (step === 'enumerate') (backend.listFiles as jest.Mock<any>).mockRejectedValue(cause);
    if (step === 'read') (backend.readFile as jest.Mock<any>).mockRejectedValue(cause);
    if (step === 'stat') (backend.stat as jest.Mock<any>).mockRejectedValue(cause);
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: MEMORIES_DIR, storageBackend: backend });
    try {
      await expect(layer.listSummaries({ freshMetadata: true, preserveDuplicates: true })).rejects.toMatchObject({ cause });
      expect(fileOps.writeFile).not.toHaveBeenCalled();
    } finally { await layer.dispose(); }
  });
  it('pins its root through awaits and preserves duplicate observations without index writes', async () => {
    const fileOps = makeMockFileOps(); const backend = createMockBackend(); let root = MEMORIES_DIR;
    (backend.listDirectories as jest.Mock<any>).mockImplementation(async () => { root = path.resolve('other-user'); return []; });
    (backend.listFiles as jest.Mock<any>).mockResolvedValue(['first.yaml', 'second.yaml']);
    (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('duplicate'));
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: MEMORIES_DIR, memoriesDirResolver: () => root, storageBackend: backend });
    try {
      const entries = await layer.listSummaries({ freshMetadata: true, preserveDuplicates: true });
      expect(entries.map(entry => entry.name)).toEqual(['duplicate', 'duplicate']);
      expect(backend.listFiles).toHaveBeenCalledWith(MEMORIES_DIR, '.yaml');
      expect((backend.readFile as jest.Mock<any>).mock.calls.map(([value]) => value)).toEqual([path.join(MEMORIES_DIR, 'first.yaml'), path.join(MEMORIES_DIR, 'second.yaml')]);
      expect(fileOps.writeFile).not.toHaveBeenCalled();
    } finally { await layer.dispose(); }
  });
});

describe('bounded directory state', () => {
  it('bounds idle churn, rebuilds evicted directories and retains a flat directory', async () => {
    let dir = path.resolve('users', 'original');
    const backend = createMockBackend();
    const fileOps = makeMockFileOps();
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, memoriesDirResolver: () => dir, storageBackend: backend, indexDebounceMs: 60000 });
    const original = layer['getState']();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) await layer.scan();
    expect(layer['dirStates'].size).toBe(1);
    expect(layer['getState']()).toBe(original);
    await original.persistence.flush();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      dir = path.resolve('users', String(i));
      await layer.scan();
      await layer['getState']().persistence.flush();
    }
    expect(layer['dirStates'].size).toBe(MAX_CACHED_DIRECTORY_STATES);
    dir = path.resolve('users', 'original');
    expect(layer['getState']()).not.toBe(original);
    await layer.scan();
    expect(layer.hasCompletedScan()).toBe(true);
    const rebuilt = layer['getState']();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) await layer.scan();
    expect(layer['getState']()).toBe(rebuilt);
    await layer.dispose();
  });
  it('pins a scan and its trailing waiter while other directories churn', async () => {
    let dir = path.resolve('users', 'busy');
    let release!: (exists: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { release = resolve; });
    const backend = createMockBackend({ directoryExists: jest.fn<any>().mockImplementation((location: string) => location === path.resolve('users', 'busy') ? waiting : Promise.resolve(false)) });
    const fileOps = makeMockFileOps();
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, memoriesDirResolver: () => dir, storageBackend: backend, indexDebounceMs: 60000 });
    const busy = layer['getState']();
    const scan = layer.scan();
    const trailing = layer.scan({ freshAfterInFlight: true });
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      dir = path.resolve('users', String(i));
      await layer.scan();
      await layer['getState']().persistence.flush();
    }
    dir = path.resolve('users', 'busy');
    expect(layer['getState']()).toBe(busy);
    release(false);
    await Promise.all([scan, trailing]);
    await busy.persistence.flush();
    expect(layer['getState']()).toBe(busy);
    expect(layer['dirStates'].size).toBe(MAX_CACHED_DIRECTORY_STATES);
    await layer.dispose();
  });
});

it('protects pending and flushing memory indexes until the write completes', async () => {
  let dir = path.resolve('users', 'writing');
  const fileOps = makeMockFileOps();
  let release!: () => void;
  const writing = new Promise<void>(resolve => { release = resolve; });
  (fileOps.writeFile as jest.Mock<any>).mockReturnValue(writing);
  const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, memoriesDirResolver: () => dir, indexDebounceMs: 60000 });
  const state = layer['getState']();
  state.persistence.request(() => ({ entries: [], blocked: {}, generation: 1 }), () => {});
  const churn = () => {
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      dir = path.resolve('users', String(i));
      layer['getState']();
    }
    dir = path.resolve('users', 'writing');
    expect(layer['getState']()).toBe(state);
  };
  churn();
  const flush = state.persistence.flush();
  churn();
  release();
  await flush;
  for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
    dir = path.resolve('finished', String(i));
    layer['getState']();
  }
  dir = path.resolve('users', 'writing');
  expect(layer['getState']()).not.toBe(state);
  await layer.dispose();
});

it.each(['save', 'delete'])('does not persist a partial cold index after %s', async operation => {
  let dir = MEMORIES_DIR;
  const fileOps = makeMockFileOps();
  (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(makeIndexData({
    'existing.yaml': { name: 'Existing', mtimeMs: 1000 },
    'changed.yaml': { name: 'Changed', mtimeMs: 1000 },
  })));
  const paths = operation === 'save' ? ['existing.yaml', 'changed.yaml'] : ['existing.yaml'];
  const backend = createMockBackend({
    listFiles: jest.fn<any>().mockImplementation((directory: string) => Promise.resolve(directory === MEMORIES_DIR ? paths : [])),
    statMany: jest.fn<any>().mockResolvedValue({ stats: new Map(paths.map(file => [file, makeMeta(file, file === 'changed.yaml' ? 2000 : 1000)])), failures: new Map() }),
    readFile: jest.fn<any>().mockResolvedValue(makeYaml('Updated')),
  });
  const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, memoriesDirResolver: () => dir, storageBackend: backend });
  const original = layer['getState']();
  for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES; i++) {
    dir = path.resolve('idle', String(i));
    layer['getState']();
  }
  dir = MEMORIES_DIR;
  expect(layer['getState']()).not.toBe(original);
  if (operation === 'save') await layer.notifySaved('changed.yaml', `${dir}/changed.yaml`);
  else layer.notifyDeleted('changed.yaml');
  await layer['getState']().persistence.flush();
  expect(fileOps.writeFile).not.toHaveBeenCalled();
  expect((await layer['getState']().persistence.read())?.entries.length).toBe(2);
  await layer.scan();
  await layer['getState']().persistence.flush();
  const calls = (fileOps.writeFile as jest.Mock<any>).mock.calls;
  const persisted = JSON.parse(calls.at(-1)![1] as string) as MemoryIndexData;
  expect(persisted.entryCount).toBe(paths.length);
  expect(persisted.entries['existing.yaml'].name).toBe('Existing');
  await layer.dispose();
});

it.each(['Σημειώσεις', 'Історія'])('keeps %s in duplicate listings and autoload snapshots', async name => {
  // Exercise storage ownership independently of the parser's mixed-script policy.
  const extract = jest.spyOn(MemoryMetadataExtractor, 'extractMetadata').mockImplementation((_content, filePath) => ({
    filePath, name, autoLoad: true, priority: 1, description: 'Useful memory description',
  }));
  const fileOps = makeMockFileOps();
  const backend = createMockBackend({
    listFiles: jest.fn<any>().mockResolvedValue(['a.yaml', 'b.yaml']),
    statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([
      ['a.yaml', makeMeta('a.yaml', 100)], ['b.yaml', makeMeta('b.yaml', 200)],
    ]), failures: new Map() }),
    stat: jest.fn<any>().mockImplementation(async (file: string) => makeMeta(path.basename(file), file.endsWith('b.yaml') ? 200 : 100)),
    readFile: jest.fn<any>().mockResolvedValue(makeYaml(name, { autoLoad: true, priority: 1, description: 'Useful memory description' })),
  });
  const layer = new MemoryStorageLayer(fileOps, { memoriesDir: MEMORIES_DIR, storageBackend: backend });
  try {
    await layer.scan();
    expect([...layer['getState']().table.unindexed()]).toEqual([]);
    expect((await layer.listSummaries()).map(value => value.filePath)).toEqual(['b.yaml']);
    expect(await layer.getIndexedPaths()).toEqual(['b.yaml']);
    expect(layer.getPathByName(name)).toBe('b.yaml');
    expect((await layer.scanMemorySnapshot(true)).entries.map(value => value.filePath)).toEqual(['b.yaml']);
    expect((await layer.readFreshSummariesAtDirectory(MEMORIES_DIR)).map(value => value.filePath)).toEqual(['b.yaml']);
    jest.mocked(backend.stat).mockResolvedValue(makeMeta('b.yaml', 300));
    jest.mocked(backend.readFile).mockRejectedValue(new Error('unreadable'));
    await layer.notifySaved('b.yaml', path.join(MEMORIES_DIR, 'b.yaml'));
    expect(layer['getState']().table.persistableSnapshot()?.blocked['b.yaml'].mtimeMs).toBe(300);
  } finally { await layer.dispose(); extract.mockRestore(); }
});

it('retains failed persistence under directory pressure and recovers without another mutation', async () => {
  jest.useFakeTimers();
  const fileOps = makeMockFileOps();
  const saved = makeIndexData({ 'a.yaml': { name: 'Old', mtimeMs: 1 } });
  jest.mocked(fileOps.readFile).mockResolvedValue(JSON.stringify(saved));
  jest.mocked(fileOps.writeFile).mockRejectedValue(new Error('disk full'));
  const backend = createMockBackend({
    listFiles: jest.fn<any>().mockResolvedValue(['a.yaml']),
    stat: jest.fn<any>().mockResolvedValue(makeMeta('a.yaml', 1)),
    statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([['a.yaml', makeMeta('a.yaml', 1)]]), failures: new Map() }),
    readFile: jest.fn<any>().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' })),
  });
  const originalDir = path.resolve('retention', 'original'); let dir = originalDir;
  const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, memoriesDirResolver: () => dir, storageBackend: backend, indexDebounceMs: 100 });
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    await layer.notifySaved('a.yaml', path.join(dir, 'a.yaml'));
    await layer.scan(); const state = layer['getState']();
    expect(await state.persistence.flush()).toBe(false);
    for (let index = 0; index < MAX_CACHED_DIRECTORY_STATES + 5; index++) {
      dir = path.resolve('retention', String(index)); await layer.readIndexedPath(['Old']);
    }
    dir = originalDir;
    expect(layer['getState']()).toBe(state);
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ authoritative: false, path: undefined, unindexed: ['a.yaml'] });
    expect(warn.mock.calls.filter(([message]) => String(message).includes('beyond cache capacity'))).toHaveLength(1);
    jest.mocked(fileOps.writeFile).mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(100);
    expect(state.table.hasUnsavedChanges()).toBe(false);
    expect(state.persistence.hasPendingWrite()).toBe(false);
  } finally { await layer.dispose(); warn.mockRestore(); jest.useRealTimers(); }
});
