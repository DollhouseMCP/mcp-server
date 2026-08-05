import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import { CollectionCache } from '../../../src/cache/CollectionCache.js';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

/**
 * Unit tests for CollectionCache - pure logic tests
 *
 * These tests verify the core logic of CollectionCache without filesystem operations.
 * For filesystem integration tests, see tests/integration/cache/CollectionCache.integration.test.ts
 *
 * Tests cover:
 * - Constructor initialization
 * - TTL constant values
 * - Search term normalization logic
 */

describe('CollectionCache', () => {
  let cache: CollectionCache;
  let testBaseDir: string;
  let originalCacheDir: string | undefined;
  let originalHomeDir: string | undefined;
  const fileOperations = {} as IFileOperationsService;

  beforeEach(() => {
    originalCacheDir = process.env.DOLLHOUSE_CACHE_DIR;
    originalHomeDir = process.env.DOLLHOUSE_HOME_DIR;
    delete process.env.DOLLHOUSE_CACHE_DIR;
    delete process.env.DOLLHOUSE_HOME_DIR;

    // Setup test directory path (not created on filesystem)
    testBaseDir = path.join(os.tmpdir(), 'test-collection-cache-' + Date.now());
    cache = new CollectionCache(fileOperations, testBaseDir);
  });

  afterEach(() => {
    if (originalCacheDir === undefined) {
      delete process.env.DOLLHOUSE_CACHE_DIR;
    } else {
      process.env.DOLLHOUSE_CACHE_DIR = originalCacheDir;
    }

    if (originalHomeDir === undefined) {
      delete process.env.DOLLHOUSE_HOME_DIR;
    } else {
      process.env.DOLLHOUSE_HOME_DIR = originalHomeDir;
    }
  });

  describe('constructor', () => {
    it('should use the configured Dollhouse home instead of the process CWD', () => {
      process.env.DOLLHOUSE_HOME_DIR = '/configured/home';

      const defaultCache = new CollectionCache(fileOperations);

      expect(defaultCache.getCacheFilePath()).toBe(
        path.join('/configured/home', '.dollhouse', 'cache', 'collection-cache.json')
      );
    });

    it('should use an explicit base directory when provided', () => {
      const customCache = new CollectionCache(fileOperations, '/custom/path');

      expect(customCache.getCacheFilePath()).toBe(
        path.join('/custom/path', '.dollhouse', 'cache', 'collection-cache.json')
      );
    });

    it('should honor the exact cache directory override', () => {
      process.env.DOLLHOUSE_CACHE_DIR = '/configured/cache';

      const configuredCache = new CollectionCache(fileOperations, '/ignored/base');

      expect(configuredCache.getCacheFilePath()).toBe(
        path.join('/configured/cache', 'collection-cache.json')
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

      expect(normalizeMethod('test-persona')).toBe('test persona');
      expect(normalizeMethod('Test_Persona')).toBe('test persona');
      expect(normalizeMethod('TEST PERSONA')).toBe('test persona');
      expect(normalizeMethod('test-persona.md')).toBe('test persona');
      expect(normalizeMethod('  test-persona  ')).toBe('test persona');
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
});
