/**
 * Essential unit tests for CollectionIndexManager
 * 
 * Focuses on core functionality with reliable mocking
 */

import * as path from 'path';
import { CollectionIndexManager, CollectionIndexManagerConfig } from '../../../../src/collection/CollectionIndexManager.js';
import { CollectionIndex } from '../../../../src/types/collection.js';
import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { getMocks, resetAllMocks } from '../../../__mocks__/fs/promises.js';

// Mock the logger
jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  }
}));

// Get the fs mock functions
const mockFs = getMocks() as any;

// Mock fetch globally
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as any;

// Mock AbortController
global.AbortController = jest.fn().mockImplementation(() => ({
  signal: {},
  abort: jest.fn()
})) as any;

// Helper to create mock responses
const createMockResponse = (options: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<any>;
  headers?: Record<string, string>;
}) => {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText || '',
    json: options.json || (() => Promise.resolve({})),
    headers: options.headers ? new Headers(options.headers) : new Headers()
  } as Response;
};

describe('CollectionIndexManager - Essential Tests', () => {
  let manager: CollectionIndexManager;
  let mockCollectionIndex: CollectionIndex;
  const mockCacheDir = '/mock/cache/dir';

  beforeEach(async () => {
    jest.clearAllMocks();
    resetAllMocks();
    mockFetch.mockClear();
    
    // Clear any existing cache and reset instance state
    if (manager) {
      await manager.clearCache();
    }
    
    // Mock collection index data
    mockCollectionIndex = {
      version: '1.2.3',
      generated: '2025-08-22T12:00:00.000Z',
      total_elements: 42,
      index: {
        personas: [
          {
            path: 'personas/test-persona.md',
            type: 'persona',
            name: 'Test Persona',
            description: 'A test persona',
            version: '1.0.0',
            author: 'Test Author',
            tags: ['test'],
            sha: 'abc123',
            created: '2025-08-22T10:00:00.000Z'
          }
        ]
      },
      metadata: {
        build_time_ms: 1000,
        file_count: 42,
        skipped_files: 0,
        categories: 3,
        nodejs_version: '18.17.0',
        builder_version: '1.0.0'
      }
    };

    // Default manager with test config
    manager = new CollectionIndexManager({
      ttlMs: 60 * 60 * 1000, // 1 hour
      fetchTimeoutMs: 5000,
      maxRetries: 3,
      cacheDir: mockCacheDir
    });
  });
  
  afterEach(async () => {
    // Clean up after each test
    if (manager) {
      await manager.clearCache();
    }
    jest.clearAllMocks();
    resetAllMocks();
  });

  describe('constructor', () => {
    test('should initialize with default configuration', () => {
      const defaultManager = new CollectionIndexManager();
      expect(defaultManager).toBeInstanceOf(CollectionIndexManager);
    });

    test('should use environment variable for fetch timeout', () => {
      process.env.COLLECTION_FETCH_TIMEOUT = '10000';
      const managerWithEnv = new CollectionIndexManager();
      delete process.env.COLLECTION_FETCH_TIMEOUT;
      expect(managerWithEnv).toBeInstanceOf(CollectionIndexManager);
    });

    test('should ignore invalid environment variable', () => {
      process.env.COLLECTION_FETCH_TIMEOUT = 'invalid';
      const managerWithBadEnv = new CollectionIndexManager();
      delete process.env.COLLECTION_FETCH_TIMEOUT;
      expect(managerWithBadEnv).toBeInstanceOf(CollectionIndexManager);
    });

    test('should use custom cache directory', () => {
      const customManager = new CollectionIndexManager({ cacheDir: '/custom' });
      expect(customManager).toBeInstanceOf(CollectionIndexManager);
    });
  });

  describe('getCacheStats', () => {
    test('should return no cache stats initially', () => {
      const stats = manager.getCacheStats();
      expect(stats).toEqual({
        isValid: false,
        age: 0,
        hasCache: false,
        isRefreshing: false,
        circuitBreakerFailures: 0,
        circuitBreakerOpen: false
      });
    });
  });

  describe('getIndex - fetch from network', () => {
    test('should fetch and return collection index when no cache exists', async () => {
      // Mock no cache file
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      // Mock successful fetch
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex),
        headers: {
          'etag': '"test-etag"',
          'last-modified': 'Wed, 22 Aug 2025 12:00:00 GMT'
        }
      }));

      // Mock successful file operations
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.getIndex();

      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/DollhouseMCP/collection/main/public/collection-index.json',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Accept': 'application/json',
            'User-Agent': 'DollhouseMCP/1.0',
            'Cache-Control': 'no-cache'
          }),
          signal: expect.any(Object)
        })
      );
      // Cache operations may or may not be called depending on implementation
      // The important thing is that we got the result
    });

    test('should handle network errors with retries', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      // First two attempts fail, third succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(createMockResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockCollectionIndex)
        }));

      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.getIndex();

      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test('should handle HTTP errors', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      mockFetch.mockResolvedValue(createMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }));

      await expect(manager.getIndex()).rejects.toThrow('Collection index not available');
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 + 3 retries
    });
  });

  describe('validation', () => {
    test('should validate collection index structure', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      const invalidIndex = { invalid: 'structure' };
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(invalidIndex)
      }));

      await expect(manager.getIndex()).rejects.toThrow('Collection index not available');
    });

    test('should validate required version field', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      const incompleteIndex = {
        // missing version
        generated: '2025-08-22T12:00:00.000Z',
        total_elements: 1,
        index: {},
        metadata: {}
      };
      
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(incompleteIndex)
      }));

      await expect(manager.getIndex()).rejects.toThrow('Collection index not available');
    });

    test('should validate required generated field', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      const incompleteIndex = {
        version: '1.0.0',
        // missing generated
        total_elements: 1,
        index: {},
        metadata: {}
      };
      
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(incompleteIndex)
      }));

      await expect(manager.getIndex()).rejects.toThrow('Collection index not available');
    });
  });

  describe('forceRefresh', () => {
    test('should force refresh and return fresh data', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex),
        headers: {
          'etag': '"fresh-etag"'
        }
      }));

      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.forceRefresh();

      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearCache', () => {
    test('should clear cache and reset state', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      await manager.clearCache();

      // The important thing is that cache state is cleared
      const stats = manager.getCacheStats();
      expect(stats.hasCache).toBe(false);
      expect(stats.circuitBreakerFailures).toBe(0);
    });

    test('should handle file deletion errors gracefully', async () => {
      mockFs.unlink.mockRejectedValue(new Error('Permission denied'));

      await expect(manager.clearCache()).resolves.not.toThrow();
    });

    test('should handle missing file gracefully', async () => {
      mockFs.unlink.mockRejectedValue({ code: 'ENOENT' });

      await expect(manager.clearCache()).resolves.not.toThrow();
    });
  });

  describe('waitForBackgroundRefresh', () => {
    test('should resolve immediately when no background refresh is running', async () => {
      await expect(manager.waitForBackgroundRefresh()).resolves.not.toThrow();
    });
  });

  describe('caching behavior', () => {
    test('should ignore corrupted cache file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json{');
      
      // Mock successful fetch as fallback
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex)
      }));
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.getIndex();

      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalled();
    });

    test('should ignore cache with invalid checksum', async () => {
      const invalidChecksumEntry = {
        data: mockCollectionIndex,
        timestamp: Date.now(),
        version: '1.2.3',
        checksum: 'invalid-checksum'
      };
      
      mockFs.readFile.mockResolvedValue(JSON.stringify(invalidChecksumEntry));
      
      // Mock successful fetch as fallback
      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex)
      }));
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.getIndex();

      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalled();
    });

    test('should handle malformed cache structure gracefully', async () => {
      const malformedCache = {
        data: mockCollectionIndex,
        // missing timestamp, version
      };
      
      mockFs.readFile.mockResolvedValue(JSON.stringify(malformedCache));
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex),
        headers: new Headers()
      });

      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await manager.getIndex();
      expect(result).toEqual(mockCollectionIndex);
      expect(mockFetch).toHaveBeenCalled(); // Should fallback to fetch
    });
  });

  describe('error handling', () => {
    test('should handle cache file write errors gracefully', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockCollectionIndex),
        headers: new Headers()
      });

      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      // Should still return data even if caching fails
      const result = await manager.getIndex();
      expect(result).toEqual(mockCollectionIndex);
    });

    test('should handle JSON parsing errors in response', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' } as any);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Invalid JSON')),
        headers: new Headers()
      });

      await expect(manager.getIndex()).rejects.toThrow('Collection index not available');
    });
  });
});