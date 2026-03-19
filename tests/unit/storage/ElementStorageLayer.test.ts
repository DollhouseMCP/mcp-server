/**
 * Unit tests for ElementStorageLayer
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

function makeMeta(relPath: string, mtimeMs: number, sizeBytes = 100): StorageItemMetadata {
  return { relativePath: relPath, absolutePath: `/elements/${relPath}`, mtimeMs, sizeBytes };
}

function makeContent(name: string, description = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\nauthor: test\n---\nContent of ${name}`;
}

function createMockBackend(overrides: Partial<IStorageBackend> = {}): IStorageBackend {
  return {
    listFiles: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue(makeMeta('test.md', 1000)),
    statMany: jest.fn<any>().mockResolvedValue(new Map()),
    readFile: jest.fn<any>().mockResolvedValue(makeContent('Test')),
    directoryExists: jest.fn<any>().mockResolvedValue(true),
    ...overrides,
  };
}

const dummyFileOps = {} as FileOperationsService;

describe('ElementStorageLayer', () => {
  let backend: IStorageBackend;
  let layer: ElementStorageLayer;

  beforeEach(() => {
    backend = createMockBackend({
      listFiles: jest.fn<any>().mockResolvedValue(['alpha.md', 'beta.md']),
      statMany: jest.fn<any>().mockResolvedValue(new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
        ['beta.md', makeMeta('beta.md', 2000)],
      ])),
      readFile: jest.fn<any>().mockImplementation((absPath: string) => {
        if (absPath.includes('alpha')) return Promise.resolve(makeContent('Alpha', 'Alpha desc'));
        if (absPath.includes('beta')) return Promise.resolve(makeContent('Beta', 'Beta desc'));
        return Promise.resolve(makeContent('Unknown'));
      }),
    });

    layer = new ElementStorageLayer(dummyFileOps, {
      elementDir: '/elements',
      fileExtension: '.md',
      scanCooldownMs: 100,
      storageBackend: backend,
    });
  });

  describe('cold start scan', () => {
    it('should populate index with all files on first scan', async () => {
      const diff = await layer.scan();

      expect(diff.added).toEqual(['alpha.md', 'beta.md']);
      expect(diff.modified).toEqual([]);
      expect(diff.removed).toEqual([]);

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(2);
      expect(summaries.map(s => s.name).sort()).toEqual(['Alpha', 'Beta']);
    });

    it('should make indexed paths available', async () => {
      const paths = await layer.getIndexedPaths();
      expect(paths.sort()).toEqual(['alpha.md', 'beta.md']);
    });
  });

  describe('cooldown behavior', () => {
    it('should return empty diff within cooldown period', async () => {
      await layer.scan(); // first scan
      const secondDiff = await layer.scan(); // within cooldown

      expect(secondDiff.added).toEqual([]);
      expect(secondDiff.modified).toEqual([]);
      expect(secondDiff.removed).toEqual([]);
      expect(secondDiff.unchanged).toEqual([]);

      // Backend should only have been called once
      expect(backend.listFiles).toHaveBeenCalledTimes(1);
    });

    it('should scan again after cooldown expires', async () => {
      // Use a very short cooldown
      const shortLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        scanCooldownMs: 1,
        storageBackend: backend,
      });

      await shortLayer.scan();

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      await shortLayer.scan();

      expect(backend.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidate', () => {
    it('should force next scan to hit disk', async () => {
      await layer.scan();
      layer.invalidate();
      await layer.scan();

      expect(backend.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent scan deduplication', () => {
    it('should coalesce concurrent scan calls', async () => {
      const [diff1, diff2, diff3] = await Promise.all([
        layer.scan(),
        layer.scan(),
        layer.scan(),
      ]);

      // All three should get the same result
      expect(diff1).toBe(diff2);
      expect(diff2).toBe(diff3);

      // Backend should only be called once
      expect(backend.listFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('change detection', () => {
    it('should detect modified files on second scan', async () => {
      await layer.scan();

      // Simulate time passing + mtime change
      await new Promise(resolve => setTimeout(resolve, 10));
      layer.invalidate();

      // Backend now returns modified mtime for beta
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
        ['beta.md', makeMeta('beta.md', 5000)], // changed mtime
      ]));
      (backend.readFile as jest.Mock<any>).mockImplementation((absPath: string) => {
        if (absPath.includes('alpha')) return Promise.resolve(makeContent('Alpha', 'Alpha desc'));
        if (absPath.includes('beta')) return Promise.resolve(makeContent('Beta Updated', 'New desc'));
        return Promise.resolve(makeContent('Unknown'));
      });

      const diff = await layer.scan();

      expect(diff.unchanged).toEqual(['alpha.md']);
      expect(diff.modified).toEqual(['beta.md']);

      // Index should reflect the updated name
      const summaries = await layer.listSummaries();
      const betaEntry = summaries.find(s => s.filePath === 'beta.md');
      expect(betaEntry?.name).toBe('Beta Updated');
    });

    it('should detect removed files', async () => {
      await layer.scan();

      await new Promise(resolve => setTimeout(resolve, 10));
      layer.invalidate();

      // Only alpha remains
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['alpha.md']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue(new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
      ]));

      const diff = await layer.scan();

      expect(diff.removed).toEqual(['beta.md']);
      expect(diff.unchanged).toEqual(['alpha.md']);

      const paths = await layer.getIndexedPaths();
      expect(paths).toEqual(['alpha.md']);
    });
  });

  describe('notifySaved', () => {
    it('should update index and manifest for saved file', async () => {
      await layer.scan();

      (backend.stat as jest.Mock<any>).mockResolvedValue(makeMeta('new.md', 9000));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeContent('NewElement', 'Fresh'));

      await layer.notifySaved('new.md', '/elements/new.md');

      expect(layer.getPathByName('NewElement')).toBe('new.md');
    });
  });

  describe('notifyDeleted', () => {
    it('should remove entry from index and manifest', async () => {
      await layer.scan();
      expect(layer.getPathByName('Alpha')).toBe('alpha.md');

      layer.notifyDeleted('alpha.md');

      expect(layer.getPathByName('Alpha')).toBeUndefined();
    });
  });

  describe('getPathByName', () => {
    it('should perform case-insensitive lookup', async () => {
      await layer.scan();

      expect(layer.getPathByName('alpha')).toBe('alpha.md');
      expect(layer.getPathByName('ALPHA')).toBe('alpha.md');
      expect(layer.getPathByName('Alpha')).toBe('alpha.md');
    });

    it('should resolve canonical-equivalent Unicode names', async () => {
      const unicodeBackend = createMockBackend({
        listFiles: jest.fn<any>().mockResolvedValue(['cafe.md']),
        statMany: jest.fn<any>().mockResolvedValue(new Map([
          ['cafe.md', makeMeta('cafe.md', 1000)],
        ])),
        readFile: jest.fn<any>().mockResolvedValue(makeContent('Cafe\u0301', 'Unicode test')),
      });

      const unicodeLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        storageBackend: unicodeBackend,
      });

      await unicodeLayer.scan();

      expect(unicodeLayer.getPathByName('Café')).toBe('cafe.md');
    });

    it('should return undefined for unknown name', () => {
      expect(layer.getPathByName('nonexistent')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should reset all state', async () => {
      await layer.scan();
      layer.clear();

      expect(layer.getPathByName('Alpha')).toBeUndefined();

      // Next scan should re-index everything as added
      const diff = await layer.scan();
      expect(diff.added).toEqual(['alpha.md', 'beta.md']);
    });
  });

  describe('parse failure handling', () => {
    it('should skip files that fail to parse without crashing', async () => {
      const badBackend = createMockBackend({
        listFiles: jest.fn<any>().mockResolvedValue(['good.md', 'bad.md']),
        statMany: jest.fn<any>().mockResolvedValue(new Map([
          ['good.md', makeMeta('good.md', 1000)],
          ['bad.md', makeMeta('bad.md', 2000)],
        ])),
        readFile: jest.fn<any>().mockImplementation((absPath: string) => {
          if (absPath.includes('bad')) return Promise.reject(new Error('read error'));
          return Promise.resolve(makeContent('Good'));
        }),
      });

      const badLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        storageBackend: badBackend,
      });

      const diff = await badLayer.scan();

      expect(diff.added).toEqual(['good.md', 'bad.md']);
      // Only good.md should be in the index
      const paths = await badLayer.getIndexedPaths();
      expect(paths).toEqual(['good.md']);
    });
  });

  describe('non-existent directory', () => {
    it('should handle missing directory gracefully', async () => {
      const missingBackend = createMockBackend({
        directoryExists: jest.fn<any>().mockResolvedValue(false),
      });

      const missingLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/missing',
        fileExtension: '.md',
        storageBackend: missingBackend,
      });

      const diff = await missingLayer.scan();

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });
  });
});
