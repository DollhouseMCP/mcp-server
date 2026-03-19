import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import { CollectionCache } from '../../../src/cache/CollectionCache.js';

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

  beforeEach(() => {
    // Setup test directory path (not created on filesystem)
    testBaseDir = path.join(os.tmpdir(), 'test-collection-cache-' + Date.now());
    cache = new CollectionCache(testBaseDir);
  });

  describe('constructor', () => {
    it('should initialize with default base directory', () => {
      const defaultCache = new CollectionCache();
      expect(defaultCache).toBeInstanceOf(CollectionCache);
    });

    it('should initialize with custom base directory', () => {
      const customCache = new CollectionCache('/custom/path');
      expect(customCache).toBeInstanceOf(CollectionCache);
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
