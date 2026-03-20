/**
 * Unit tests for MemoryStorageLayer
 */

import path from 'path';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { MemoryIndexData } from '../../../src/storage/MemoryIndexFile.js';

// ---- Helpers ----

const MEMORIES_DIR = '/data/memories';

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
    listFiles: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue(makeMeta('test.yaml', 1000)),
    statMany: jest.fn<any>().mockResolvedValue(new Map()),
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
    version: 1,
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
      statMany: jest.fn<any>().mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ])),
      readFile: jest.fn<any>().mockResolvedValue(makeYaml('Baseline')),
    });

    fileOps = makeMockFileOps();

    // By default, no _index.json exists (ENOENT)
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    (fileOps.readFile as jest.Mock<any>).mockRejectedValue(enoent);
    (fileOps.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

    // listDirectory returns subdirectories
    (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['system']);

    layer = new MemoryStorageLayer(fileOps, {
      memoriesDir: MEMORIES_DIR,
      scanCooldownMs: 100,
      storageBackend: backend,
      indexDebounceMs: 50000, // Long debounce so scheduled writes don't fire during tests
    });
  });

  afterEach(() => {
    // Prevent timers from leaking
    layer.dispose();
  });

  // ----------------------------------------------------------------
  // 1. Cold start without _index.json
  // ----------------------------------------------------------------
  describe('cold start without _index.json', () => {
    it('should trigger full rebuild and index all files', async () => {
      const diff = await layer.scan();

      // rebuildIndex clears + performScan, then returns EMPTY_DIFF
      expect(diff.added).toEqual([]);
      expect(diff.modified).toEqual([]);
      expect(diff.removed).toEqual([]);

      // After rebuild, index should be populated
      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('Baseline');
    });

    it('should write _index.json after rebuild', async () => {
      await layer.scan();

      // rebuildIndex calls indexFile.write() directly (not debounced)
      expect(fileOps.writeFile).toHaveBeenCalled();
      const writtenContent = (fileOps.writeFile as jest.Mock<any>).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent) as MemoryIndexData;
      expect(parsed.version).toBe(1);
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
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]));

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

      shortLayer.dispose();
    });
  });

  // ----------------------------------------------------------------
  // 4. Concurrent scan deduplication
  // ----------------------------------------------------------------
  describe('concurrent scan deduplication', () => {
    it('should return the same promise for concurrent scan() calls', async () => {
      // First call is cold start, which calls rebuildIndex -> performScan
      // Need to set up so cold start loads from _index.json and runs incremental
      const cachedData = makeIndexData({
        'system/baseline.yaml': { name: 'Baseline', mtimeMs: 1000 },
      });
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(cachedData));

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]));

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
  });

  // ----------------------------------------------------------------
  // 5. Multi-directory scanning
  // ----------------------------------------------------------------
  describe('multi-directory scanning', () => {
    it('should discover system/, adapters/, date folders, and root', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue([
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
      (backend.statMany as jest.Mock<any>).mockResolvedValue(statsMap);

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

      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue([]);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue([
        'active.yaml', 'old.bak.yaml',
      ]);

      // Only the non-backup file should be stat'd
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['active.yaml', makeMeta('active.yaml', 1000)],
      ]));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Active'));

      await filtered.scan();

      const paths = await filtered.getIndexedPaths();
      expect(paths).toEqual(['active.yaml']);
      expect(paths).not.toContain('old.bak.yaml');

      filtered.dispose();
    });
  });

  // ----------------------------------------------------------------
  // 7. getAutoLoadEntries()
  // ----------------------------------------------------------------
  describe('getAutoLoadEntries()', () => {
    it('should return only entries with autoLoad === true, sorted by priority', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['system']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.endsWith('system')) return ['core.yaml', 'optional.yaml'];
        if (dir === MEMORIES_DIR) return ['user.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/core.yaml', makeMeta('system/core.yaml', 1000)],
        ['system/optional.yaml', makeMeta('system/optional.yaml', 1000)],
        ['user.yaml', makeMeta('user.yaml', 1000)],
      ]));

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('core')) return makeYaml('Core', { autoLoad: true, priority: 10 });
        if (absPath.includes('optional')) return makeYaml('Optional', { autoLoad: false });
        if (absPath.includes('user')) return makeYaml('UserNotes', { autoLoad: true, priority: 5 });
        return makeYaml('Unknown');
      });

      await layer.scan();

      const autoLoaded = layer.getAutoLoadEntries();
      expect(autoLoaded).toHaveLength(2);
      // Sorted by priority ascending: 5 before 10
      expect(autoLoaded[0].name).toBe('UserNotes');
      expect(autoLoaded[0].priority).toBe(5);
      expect(autoLoaded[1].name).toBe('Core');
      expect(autoLoaded[1].priority).toBe(10);
    });

    it('should return empty array when no entries have autoLoad === true', async () => {
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['regular.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['regular.yaml', makeMeta('regular.yaml', 1000)],
      ]));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Regular'));

      await layer.scan();

      expect(layer.getAutoLoadEntries()).toEqual([]);
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
      // indexFile.read() returns null for corrupt JSON
      (fileOps.readFile as jest.Mock<any>).mockResolvedValue('not valid json {{{');

      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['system']);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['baseline.yaml']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('Baseline'));

      // Cold start should detect corrupt index and rebuild
      await layer.scan();

      // The write from rebuildIndex
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
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 9999)],
      ]));

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
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]));

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
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/baseline.yaml', makeMeta('system/baseline.yaml', 1000)],
      ]));

      await layer.scan();
      expect(layer.getPathByName('Baseline')).toBe('system/baseline.yaml');

      layer.clear();

      expect(layer.getPathByName('Baseline')).toBeUndefined();

      // Summaries should be empty without a new scan
      // getAutoLoadEntries is pure in-memory, no scan trigger
      expect(layer.getAutoLoadEntries()).toEqual([]);
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
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['system', 'adapters']);

      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.endsWith('adapters')) throw enoent;
        if (dir.endsWith('system')) return ['core.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['system/core.yaml', makeMeta('system/core.yaml', 1000)],
      ]));
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
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-01-19', '2026-01-26']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01-19') || dir.includes('2026-01-26')) return ['session-notes.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-01-19/session-notes.yaml', makeMeta('2026-01-19/session-notes.yaml', 1000)],
        ['2026-01-26/session-notes.yaml', makeMeta('2026-01-26/session-notes.yaml', 2000)],
      ]));

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('session-notes'));

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('session-notes');
      // Should keep the most recently modified copy
      expect(summaries[0].mtimeMs).toBe(2000);
    });

    it('should keep most recently modified copy when same name has different mtimes', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-01-10', '2026-01-20', '2026-01-30']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01')) return ['prefs.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-01-10/prefs.yaml', makeMeta('2026-01-10/prefs.yaml', 100)],
        ['2026-01-20/prefs.yaml', makeMeta('2026-01-20/prefs.yaml', 300)],
        ['2026-01-30/prefs.yaml', makeMeta('2026-01-30/prefs.yaml', 200)],
      ]));

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('prefs'));

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].mtimeMs).toBe(300);
      expect(summaries[0].filePath).toBe('2026-01-20/prefs.yaml');
    });

    it('should deduplicate case-insensitively', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-01-01', '2026-01-02']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-01-01')) return ['notes.yaml'];
        if (dir.includes('2026-01-02')) return ['notes2.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-01-01/notes.yaml', makeMeta('2026-01-01/notes.yaml', 1000)],
        ['2026-01-02/notes2.yaml', makeMeta('2026-01-02/notes2.yaml', 2000)],
      ]));

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
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-04-01', '2026-04-02']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-04-01')) return ['cafe-a.yaml'];
        if (dir.includes('2026-04-02')) return ['cafe-b.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-04-01/cafe-a.yaml', makeMeta('2026-04-01/cafe-a.yaml', 1000)],
        ['2026-04-02/cafe-b.yaml', makeMeta('2026-04-02/cafe-b.yaml', 2000)],
      ]));

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
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-02-01', '2026-02-15']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-02')) return ['log.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-02-01/log.yaml', makeMeta('2026-02-01/log.yaml', 1000)],
        ['2026-02-15/log.yaml', makeMeta('2026-02-15/log.yaml', 2000)],
      ]));

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('log'));

      await layer.scan();

      const paths = await layer.getIndexedPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe('2026-02-15/log.yaml');
    });

    it('should handle empty arrays without errors', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue([]);
      (backend.listFiles as jest.Mock<any>).mockResolvedValue([]);
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map());

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(0);

      const paths = await layer.getIndexedPaths();
      expect(paths).toHaveLength(0);
    });

    it('should not deduplicate distinct memory names', async () => {
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-03-01']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-03-01')) return ['alpha.yaml', 'beta.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-03-01/alpha.yaml', makeMeta('2026-03-01/alpha.yaml', 1000)],
        ['2026-03-01/beta.yaml', makeMeta('2026-03-01/beta.yaml', 2000)],
      ]));

      (backend.readFile as jest.Mock<any>).mockImplementation(async (absPath: string) => {
        if (absPath.includes('alpha')) return makeYaml('alpha');
        return makeYaml('beta');
      });

      await layer.scan();

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(2);
    });

    it('should sort date folders chronologically so newest copy wins in MetadataIndex', async () => {
      // Date folders returned in random order
      (fileOps.listDirectory as jest.Mock<any>).mockResolvedValue(['2026-03-15', '2026-01-01', '2026-02-10']);

      (backend.listFiles as jest.Mock<any>).mockImplementation(async (dir: string) => {
        if (dir.includes('2026-')) return ['context.yaml'];
        return [];
      });

      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['2026-01-01/context.yaml', makeMeta('2026-01-01/context.yaml', 100)],
        ['2026-02-10/context.yaml', makeMeta('2026-02-10/context.yaml', 200)],
        ['2026-03-15/context.yaml', makeMeta('2026-03-15/context.yaml', 300)],
      ]));

      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeYaml('context'));

      await layer.scan();

      // getPathByName should point to newest (last-scanned = newest date folder)
      const resolvedPath = layer.getPathByName('context');
      expect(resolvedPath).toBe('2026-03-15/context.yaml');
    });
  });
});
