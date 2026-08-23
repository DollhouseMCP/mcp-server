import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import type { CollectionItem } from '../../../src/cache/CollectionCache.js';
import { CollectionCache } from '../../../src/cache/CollectionCache.js';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';
import { InMemorySharedCacheStore } from '../../../src/storage/sharedCache/InMemorySharedCacheStore.js';

/**
 * Unit tests for CollectionCache - pure logic tests
 *
 * These tests verify the core logic of CollectionCache without real filesystem
 * operations. For filesystem integration tests, see
 * tests/integration/cache/CollectionCache.integration.test.ts
 *
 * Tests cover:
 * - Constructor initialization
 * - TTL constant values
 * - Search term normalization logic
 * - Shared-cache-store backend (backend-honesty seam)
 */

const BROWSE_CACHE_KEY = 'collection-browse-cache';
const NORMALIZED_PERSONA = 'test persona';

// Minimal file-operations stub — the logic tests below never touch the
// filesystem path, so the methods only need to exist.
function createFileOperationsStub(): IFileOperationsService {
  return {
    readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: () => Promise.resolve(),
    deleteFile: () => Promise.resolve(),
    createDirectory: () => Promise.resolve(),
  } as unknown as IFileOperationsService;
}

const SAMPLE_ITEMS: CollectionItem[] = [
  { name: 'test-persona.md', path: 'library/personas/test-persona.md', sha: 'abc123' },
  { name: 'skill-example.md', path: 'library/skills/skill-example.md', sha: 'def456' },
];

describe('CollectionCache', () => {
  let cache: CollectionCache;
  let testBaseDir: string;
  let fileOperations: IFileOperationsService;

  beforeEach(() => {
    // Setup test directory path (not created on filesystem)
    testBaseDir = path.join(os.tmpdir(), 'test-collection-cache-' + Date.now());
    fileOperations = createFileOperationsStub();
    cache = new CollectionCache(fileOperations, testBaseDir);
  });

  describe('constructor', () => {
    it('should initialize with default base directory', () => {
      const defaultCache = new CollectionCache(fileOperations);
      expect(defaultCache).toBeInstanceOf(CollectionCache);
    });

    it('should initialize with custom base directory', () => {
      const customCache = new CollectionCache(fileOperations, '/custom/path');
      expect(customCache).toBeInstanceOf(CollectionCache);
      expect(customCache.getCacheFilePath()).toBe(
        path.join('/custom/path', '.dollhousemcp', 'cache', 'collection-cache.json')
      );
    });

    it('should use an exact canonical cache directory without nesting it again', () => {
      const canonicalCache = new CollectionCache({
        fileOperations,
        cacheDir: '/canonical/cache',
      });

      expect(canonicalCache.getCacheFilePath()).toBe(
        path.join('/canonical/cache', 'collection-cache.json')
      );
    });
  });

  describe('TTL behavior', () => {
    it('should use 24-hour TTL', () => {
      const ttl = (cache as any).CACHE_TTL_MS;
      expect(ttl).toBe(24 * 60 * 60 * 1000); // 24 hours in milliseconds
    });
  });

  describe('normalizeSearchTerm', () => {
    it('should normalize search terms correctly', () => {
      // Access private method through type assertion
      const normalizeMethod = (cache as any).normalizeSearchTerm.bind(cache);

      expect(normalizeMethod('test-persona')).toBe(NORMALIZED_PERSONA);
      expect(normalizeMethod('Test_Persona')).toBe(NORMALIZED_PERSONA);
      expect(normalizeMethod('TEST PERSONA')).toBe(NORMALIZED_PERSONA);
      expect(normalizeMethod('test-persona.md')).toBe(NORMALIZED_PERSONA);
      expect(normalizeMethod('  test-persona  ')).toBe(NORMALIZED_PERSONA);
      expect(normalizeMethod('test---persona___name')).toBe('test persona name');
    });

    it('should handle edge cases', () => {
      const normalizeMethod = (cache as any).normalizeSearchTerm.bind(cache);

      expect(normalizeMethod('')).toBe('');
      expect(normalizeMethod('   ')).toBe('');
      expect(normalizeMethod('a')).toBe('a');
      expect(normalizeMethod('a.md')).toBe('a');
    });
  });

  describe('shared cache store backend (backend honesty)', () => {
    let store: InMemorySharedCacheStore;
    let sharedCache: CollectionCache;

    beforeEach(() => {
      store = new InMemorySharedCacheStore();
      // fileOperations that FAIL loudly — proves the shared-store path never
      // falls back to the filesystem when a store is injected.
      const failMessage = 'filesystem must not be touched in shared-store mode';
      const fail = () => Promise.reject(new Error(failMessage));
      const failingFileOps = {
        readFile: fail,
        writeFile: fail,
        deleteFile: fail,
        createDirectory: fail,
      } as unknown as IFileOperationsService;
      sharedCache = new CollectionCache(failingFileOps, testBaseDir, store);
    });

    it('round-trips items through the store without touching the filesystem', async () => {
      await sharedCache.saveCache(SAMPLE_ITEMS, 'etag-1');
      const loaded = await sharedCache.loadCache();

      if (!loaded) throw new Error('expected a cache entry');
      expect(loaded.items).toHaveLength(2);
      expect(loaded.items.map(i => i.name)).toEqual(['test-persona.md', 'skill-example.md']);
      expect(loaded.etag).toBe('etag-1');
    });

    it('writes to the store under the dedicated browse-cache key', async () => {
      await sharedCache.saveCache(SAMPLE_ITEMS);
      const raw = await store.get(BROWSE_CACHE_KEY);
      if (!raw) throw new Error('expected a stored entry');
      expect((raw.payload as { items: CollectionItem[] }).items).toHaveLength(2);
    });

    it('returns null when the store has no entry', async () => {
      expect(await sharedCache.loadCache()).toBeNull();
    });

    it('treats an expired store entry as a miss', async () => {
      await store.set({
        cacheKey: BROWSE_CACHE_KEY,
        payload: { items: SAMPLE_ITEMS },
        expiresAt: Date.now() - 1000, // already expired
      });
      expect(await sharedCache.loadCache()).toBeNull();
    });

    it('clearCache deletes the store entry', async () => {
      await sharedCache.saveCache(SAMPLE_ITEMS);
      await sharedCache.clearCache();
      expect(await store.get(BROWSE_CACHE_KEY)).toBeNull();
    });

    it('searchCache filters store-backed items', async () => {
      await sharedCache.saveCache(SAMPLE_ITEMS);
      const results = await sharedCache.searchCache('persona');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('test-persona.md');
    });
  });
});
