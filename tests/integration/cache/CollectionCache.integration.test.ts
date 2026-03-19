import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CollectionCache, CollectionItem, CollectionCacheEntry } from '../../../src/cache/CollectionCache.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';

/**
 * Integration tests for CollectionCache - filesystem operations
 *
 * These tests use real filesystem operations with temporary directories
 * to verify actual I/O behavior. This approach is more reliable than
 * mocking fs/promises in ESM and tests the real risk surface.
 */

// Mock only the logger (application module, not fs)
jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  }
}));

describe('CollectionCache Integration Tests', () => {
  let cache: CollectionCache;
  let testBaseDir: string;
  let testCacheDir: string;
  let testCacheFile: string;

  const mockItems: CollectionItem[] = [
    {
      name: 'test-persona.md',
      path: 'personas/test-persona.md',
      sha: 'abc123',
      content: 'Test persona content',
      last_modified: '2023-01-01T00:00:00Z'
    },
    {
      name: 'another-persona.md',
      path: 'personas/another-persona.md',
      sha: 'def456',
      content: 'Another test persona',
      last_modified: '2023-01-02T00:00:00Z'
    },
    {
      name: 'skill-example.md',
      path: 'skills/skill-example.md',
      sha: 'ghi789',
      content: 'Test skill content',
      last_modified: '2023-01-03T00:00:00Z'
    }
  ];

  const validCacheEntry: CollectionCacheEntry = {
    items: mockItems,
    timestamp: Date.now() - 1000, // 1 second ago (not expired)
    etag: 'test-etag'
  };

  beforeEach(async () => {
    // Create a real temporary directory for each test
    testBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-collection-cache-'));
    testCacheDir = path.join(testBaseDir, '.dollhousemcp', 'cache');
    testCacheFile = path.join(testCacheDir, 'collection-cache.json');

    // Create real file operations service for integration tests
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);

    cache = new CollectionCache(fileOperations, testBaseDir);
  });

  afterEach(async () => {
    // Clean up the temporary directory
    try {
      await fs.rm(testBaseDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe('loadCache', () => {
    it('should load valid cache from file', async () => {
      // Write cache file to real filesystem
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');

      const result = await cache.loadCache();

      expect(result).toEqual(validCacheEntry);
    });

    it('should return null for expired cache', async () => {
      const expiredCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago (expired)
        etag: 'expired-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(expiredCacheEntry), 'utf8');

      const result = await cache.loadCache();

      expect(result).toBeNull();
    });

    it('should return null for non-existent cache file', async () => {
      const result = await cache.loadCache();
      expect(result).toBeNull();
    });

    it('should return null and log error for other file system errors', async () => {
      // Skip in self-hosted Docker environments (root user ignores file permissions)
      if (process.env.SELF_HOSTED_DOCKER === 'true') {
        return;
      }

      // Create cache dir but make it unreadable
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');
      await fs.chmod(testCacheFile, 0o000);

      const result = await cache.loadCache();

      expect(result).toBeNull();

      // Restore permissions for cleanup
      await fs.chmod(testCacheFile, 0o644);
    });

    it('should return null for invalid JSON', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, 'invalid json', 'utf8');

      const result = await cache.loadCache();

      expect(result).toBeNull();
    });

    it('should reject cache file paths with path traversal attempts', async () => {
      // Create file operations for malicious cache test
      const fileLockManager = new FileLockManager();
      const fileOperations = new FileOperationsService(fileLockManager);
      const maliciousCache = new CollectionCache(fileOperations, '../../../malicious');
      const result = await maliciousCache.loadCache();
      expect(result).toBeNull();
    });

    it('should reject cache file paths with null bytes', async () => {
      (cache as any).cacheFile = '/test/path\x00/cache.json';
      const result = await cache.loadCache();
      expect(result).toBeNull();
    });

    it('should validate TTL boundary conditions', async () => {
      // Use timestamp just AFTER the boundary to account for test execution time
      const boundaryTimestamp = Date.now() - (24 * 60 * 60 * 1000) + 100;
      const boundaryCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: boundaryTimestamp,
        etag: 'boundary-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(boundaryCacheEntry), 'utf8');

      const result = await cache.loadCache();
      // Note: Uses > not >= in CollectionCache.ts:80, so just after boundary is still valid
      expect(result).toEqual(boundaryCacheEntry);
    });

    it('should validate just within TTL', async () => {
      const withinTtlTimestamp = Date.now() - (24 * 60 * 60 * 1000 - 1000);
      const withinTtlCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: withinTtlTimestamp,
        etag: 'within-ttl-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(withinTtlCacheEntry), 'utf8');

      const result = await cache.loadCache();
      expect(result).toEqual(withinTtlCacheEntry);
    });
  });

  describe('saveCache', () => {
    it('should save cache successfully', async () => {
      await cache.saveCache(mockItems, 'test-etag');

      // Verify file was created
      const fileExists = await fs.access(testCacheFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      // Verify content
      const content = await fs.readFile(testCacheFile, 'utf8');
      const savedData = JSON.parse(content);
      expect(savedData.items).toEqual(mockItems);
      expect(savedData.etag).toBe('test-etag');
    });

    it('should save cache without etag', async () => {
      await cache.saveCache(mockItems);

      const content = await fs.readFile(testCacheFile, 'utf8');
      const savedData = JSON.parse(content);
      expect(savedData.etag).toBeUndefined();
    });

    it('should include timestamp in saved cache', async () => {
      const beforeTime = Date.now();
      await cache.saveCache(mockItems, 'test-etag');
      const afterTime = Date.now();

      const content = await fs.readFile(testCacheFile, 'utf8');
      const savedData = JSON.parse(content);
      expect(savedData.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(savedData.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should handle directory creation errors gracefully', async () => {
      // Make base dir unwritable
      await fs.chmod(testBaseDir, 0o444);

      await cache.saveCache(mockItems, 'test-etag');
      // Should not throw - errors are handled gracefully

      // Restore permissions for cleanup
      await fs.chmod(testBaseDir, 0o755);
    });

    it('should handle write errors gracefully', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      // Create cache file as read-only
      await fs.writeFile(testCacheFile, '{}', 'utf8');
      await fs.chmod(testCacheFile, 0o444);

      await cache.saveCache(mockItems, 'test-etag');
      // Should not throw - errors are handled gracefully

      // Restore permissions for cleanup
      await fs.chmod(testCacheFile, 0o644);
    });

    it('should format JSON with proper indentation', async () => {
      await cache.saveCache(mockItems, 'test-etag');

      const content = await fs.readFile(testCacheFile, 'utf8');
      expect(content).toContain('  '); // Check for indentation
      expect(content).toContain('\n'); // Check for newlines
    });
  });

  describe('searchCache', () => {
    beforeEach(async () => {
      // Save cache for search tests
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');
    });

    it('should search by filename', async () => {
      const results = await cache.searchCache('test-persona');
      // Note: search uses includes() so 'test persona' matches both items with 'test' or 'persona'
      expect(results).toHaveLength(2); // Matches 'test-persona' and 'another-persona' (contains 'persona')
      expect(results.some(r => r.name === 'test-persona.md')).toBe(true);
    });

    it('should search by path', async () => {
      const results = await cache.searchCache('personas');
      expect(results).toHaveLength(2);
      expect(results.every(item => item.path.includes('personas'))).toBe(true);
    });

    it('should search by content', async () => {
      const results = await cache.searchCache('Another test');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('another-persona.md');
    });

    it('should perform case-insensitive search', async () => {
      const results = await cache.searchCache('TEST-PERSONA');
      // Note: normalized to 'test persona' which matches items containing 'persona'
      expect(results).toHaveLength(2); // Matches 'test-persona' and 'another-persona'
      expect(results.some(r => r.name === 'test-persona.md')).toBe(true);
    });

    it('should handle search with normalization', async () => {
      const results = await cache.searchCache('test persona');
      // Note: 'test persona' matches items containing 'persona'
      expect(results).toHaveLength(2); // Matches both persona files
      expect(results.some(r => r.name === 'test-persona.md')).toBe(true);
    });

    it('should return empty array when cache is not available', async () => {
      // Remove cache file
      await fs.unlink(testCacheFile);

      const results = await cache.searchCache('test');
      expect(results).toEqual([]);
    });

    it('should return empty array for no matches', async () => {
      const results = await cache.searchCache('nonexistent');
      expect(results).toEqual([]);
    });

    it('should handle empty search query', async () => {
      const results = await cache.searchCache('');
      // Note: empty string matches everything via includes('')
      expect(results).toHaveLength(mockItems.length);
    });

    it('should search items without content property', async () => {
      const itemsWithoutContent = mockItems.map(item => ({ ...item, content: undefined }));
      const cacheEntryWithoutContent = { ...validCacheEntry, items: itemsWithoutContent };
      await fs.writeFile(testCacheFile, JSON.stringify(cacheEntryWithoutContent), 'utf8');

      const results = await cache.searchCache('test-persona');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('test-persona.md');
    });

    it('should handle unicode and special characters in search', async () => {
      const unicodeItems: CollectionItem[] = [{
        name: 'émojis-𝓪𝓷𝓭-üñíçödé.md',
        path: 'special/émojis-𝓪𝓷𝓭-üñíçödé.md',
        sha: 'unicode-sha',
        content: 'Content with émojis 🎉 and üñíçödé characters',
        last_modified: '2023-01-01T00:00:00Z'
      }];

      const unicodeCacheEntry: CollectionCacheEntry = {
        items: unicodeItems,
        timestamp: Date.now() - 1000,
        etag: 'unicode-etag'
      };

      await fs.writeFile(testCacheFile, JSON.stringify(unicodeCacheEntry), 'utf8');

      const results = await cache.searchCache('émojis');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('émojis-𝓪𝓷𝓭-üñíçödé.md');
    });
  });

  describe('getItemsByPath', () => {
    beforeEach(async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');
    });

    it('should filter items by path prefix', async () => {
      const results = await cache.getItemsByPath('personas/');
      expect(results).toHaveLength(2);
      expect(results.every(item => item.path.startsWith('personas/'))).toBe(true);
    });

    it('should filter items by exact path prefix', async () => {
      const results = await cache.getItemsByPath('skills/');
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('skills/skill-example.md');
    });

    it('should return empty array for non-matching prefix', async () => {
      const results = await cache.getItemsByPath('nonexistent/');
      expect(results).toEqual([]);
    });

    it('should return empty array when cache is not available', async () => {
      await fs.unlink(testCacheFile);

      const results = await cache.getItemsByPath('personas/');
      expect(results).toEqual([]);
    });

    it('should handle empty path prefix', async () => {
      const results = await cache.getItemsByPath('');
      expect(results).toHaveLength(mockItems.length);
    });
  });

  describe('isCacheValid', () => {
    it('should return true for valid cache', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');

      const isValid = await cache.isCacheValid();
      expect(isValid).toBe(true);
    });

    it('should return false for expired cache', async () => {
      const expiredCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: Date.now() - (25 * 60 * 60 * 1000),
        etag: 'expired-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(expiredCacheEntry), 'utf8');

      const isValid = await cache.isCacheValid();
      expect(isValid).toBe(false);
    });

    it('should return false when cache file does not exist', async () => {
      const isValid = await cache.isCacheValid();
      expect(isValid).toBe(false);
    });

    it('should return false for corrupted cache file', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, 'invalid json', 'utf8');

      const isValid = await cache.isCacheValid();
      expect(isValid).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear cache successfully', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');

      await cache.clearCache();

      const fileExists = await fs.access(testCacheFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it('should handle non-existent file gracefully', async () => {
      await cache.clearCache(); // Should not throw
    });

    it('should handle other file system errors', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');
      // Make file unremovable
      await fs.chmod(testCacheDir, 0o444);

      await cache.clearCache(); // Should not throw

      // Restore permissions for cleanup
      await fs.chmod(testCacheDir, 0o755);
    });
  });

  describe('getCacheStats', () => {
    it('should return stats for valid cache', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');

      const stats = await cache.getCacheStats();
      expect(stats.itemCount).toBe(mockItems.length);
      expect(stats.cacheAge).toBeGreaterThan(0);
      expect(stats.isValid).toBe(true);
    });

    it('should return stats for expired cache', async () => {
      const expiredCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: Date.now() - (25 * 60 * 60 * 1000),
        etag: 'expired-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(expiredCacheEntry), 'utf8');

      const stats = await cache.getCacheStats();
      expect(stats.itemCount).toBe(0);
      expect(stats.cacheAge).toBe(0);
      expect(stats.isValid).toBe(false);
    });

    it('should return default stats when cache does not exist', async () => {
      const stats = await cache.getCacheStats();
      expect(stats.itemCount).toBe(0);
      expect(stats.cacheAge).toBe(0);
      expect(stats.isValid).toBe(false);
    });

    it('should calculate cache age correctly', async () => {
      const testTimestamp = Date.now() - 5000;
      const testCacheEntry: CollectionCacheEntry = {
        items: mockItems,
        timestamp: testTimestamp,
        etag: 'test-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(testCacheEntry), 'utf8');

      const stats = await cache.getCacheStats();
      expect(stats.cacheAge).toBeGreaterThanOrEqual(5000);
      expect(stats.cacheAge).toBeLessThan(10000);
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle extremely large cache files', async () => {
      // Create a large cache (22MB+) to test the 50MB maxSize override
      const largeItems = Array.from({ length: 10000 }, (_, i) => ({
        name: `item-${i}.md`,
        path: `category/item-${i}.md`,
        sha: `sha-${i}`,
        content: `Content for item ${i}`.repeat(100),
        last_modified: new Date().toISOString()
      }));

      const largeCacheEntry: CollectionCacheEntry = {
        items: largeItems,
        timestamp: Date.now() - 1000,
        etag: 'large-cache-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(largeCacheEntry), 'utf8');

      const results = await cache.searchCache('item-123');
      // Note: 'item-123' matches 'item-123', 'item-1234', 'item-1235', etc. (11 matches)
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.name === 'item-123.md')).toBe(true);
    });

    it('should handle malformed cache entries', async () => {
      // Note: Items must have 'name' property or normalizeSearchTerm will crash
      // This test verifies graceful handling of items with missing optional properties
      const malformedCache = {
        items: [{
          name: 'valid-item.md',
          path: 'valid/path.md',
          sha: 'valid-sha'
        }, {
          name: 'incomplete-item.md',
          path: 'incomplete/path.md',
          sha: 'incomplete-sha'
          // Missing 'content' and 'last_modified' - should still work
        }],
        timestamp: Date.now() - 1000
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(malformedCache), 'utf8');

      const result = await cache.loadCache();
      expect(result).not.toBeNull();

      const searchResults = await cache.searchCache('valid');
      expect(searchResults).toHaveLength(1);
    });

    it('should handle concurrent operations', async () => {
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(validCacheEntry), 'utf8');

      const promises = [
        cache.loadCache(),
        cache.searchCache('test'),
        cache.getItemsByPath('personas/'),
        cache.isCacheValid(),
        cache.getCacheStats()
      ];

      const results = await Promise.all(promises);
      expect(results[0]).toEqual(validCacheEntry);
      expect(Array.isArray(results[1])).toBe(true);
      expect(Array.isArray(results[2])).toBe(true);
      expect(typeof results[3]).toBe('boolean');
      expect(typeof results[4]).toBe('object');
    });
  });

  describe('Performance', () => {
    it('should handle search operations efficiently', async () => {
      const largeItems = Array.from({ length: 1000 }, (_, i) => ({
        name: `item-${i}.md`,
        path: `category${i % 10}/item-${i}.md`,
        sha: `sha-${i}`,
        content: `Content for item ${i} with searchable text`,
        last_modified: new Date().toISOString()
      }));

      const largeCacheEntry: CollectionCacheEntry = {
        items: largeItems,
        timestamp: Date.now() - 1000,
        etag: 'perf-test-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(largeCacheEntry), 'utf8');

      const startTime = Date.now();
      const results = await cache.searchCache('item');
      const searchTime = Date.now() - startTime;

      expect(results.length).toBeGreaterThan(0);
      expect(searchTime).toBeLessThan(100);
    });

    it('should handle path filtering efficiently', async () => {
      const largeItems = Array.from({ length: 1000 }, (_, i) => ({
        name: `item-${i}.md`,
        path: `category${i % 5}/item-${i}.md`,
        sha: `sha-${i}`,
        content: `Content for item ${i}`,
        last_modified: new Date().toISOString()
      }));

      const largeCacheEntry: CollectionCacheEntry = {
        items: largeItems,
        timestamp: Date.now() - 1000,
        etag: 'path-filter-etag'
      };

      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(testCacheFile, JSON.stringify(largeCacheEntry), 'utf8');

      const startTime = Date.now();
      const results = await cache.getItemsByPath('category0/');
      const filterTime = Date.now() - startTime;

      expect(results.length).toBe(200);
      expect(filterTime).toBeLessThan(50);
    });
  });
});
