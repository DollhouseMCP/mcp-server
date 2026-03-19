/**
 * Unit tests for ServerSetup tool caching via LRUCache
 *
 * Phase 3: Tests the LRUCache-based tool discovery caching that replaced ToolDiscoveryCache.
 * Tests cache behavior directly using identical configuration (maxSize: 1, ttlMs: 60000).
 */

import { LRUCache } from '../../../src/cache/LRUCache.js';

// Minimal Tool shape for testing (matches @modelcontextprotocol/sdk Tool type)
interface TestTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function createToolCache(): LRUCache<TestTool[]> {
  return new LRUCache<TestTool[]>({
    name: 'tool-discovery',
    maxSize: 1,
    maxMemoryMB: 5,
    ttlMs: 60000,
  });
}

function createMockTools(count: number): TestTool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `Test tool ${i}`,
    inputSchema: { type: 'object', properties: {} },
  }));
}

const CACHE_KEY = 'tool_discovery_list';

describe('ServerSetup Tool Cache (LRUCache-based)', () => {
  describe('cache miss and hit', () => {
    it('should return undefined on cache miss', () => {
      const cache = createToolCache();
      expect(cache.get(CACHE_KEY)).toBeUndefined();
    });

    it('should return cached tools on cache hit', () => {
      const cache = createToolCache();
      const tools = createMockTools(5);

      cache.set(CACHE_KEY, tools);
      const result = cache.get(CACHE_KEY);

      expect(result).toBeDefined();
      expect(result).toHaveLength(5);
      expect(result![0].name).toBe('tool_0');
    });
  });

  describe('TTL expiration', () => {
    it('should clear cached tools after TTL expiration', () => {
      const cache = createToolCache();
      const tools = createMockTools(3);

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set(CACHE_KEY, tools);
        expect(cache.get(CACHE_KEY)).toHaveLength(3);

        // Advance past TTL (60s)
        currentTime += 61000;
        expect(cache.get(CACHE_KEY)).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    it('should return cached tools before TTL expiration', () => {
      const cache = createToolCache();
      const tools = createMockTools(3);

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set(CACHE_KEY, tools);

        // Advance but NOT past TTL
        currentTime += 30000;
        expect(cache.get(CACHE_KEY)).toHaveLength(3);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('invalidation via delete()', () => {
    it('should invalidate cache when delete() is called', () => {
      const cache = createToolCache();
      const tools = createMockTools(5);

      cache.set(CACHE_KEY, tools);
      expect(cache.get(CACHE_KEY)).toHaveLength(5);

      cache.delete(CACHE_KEY);
      expect(cache.get(CACHE_KEY)).toBeUndefined();
    });
  });

  describe('stats tracking', () => {
    it('should track hit and miss counts', () => {
      const cache = createToolCache();
      const tools = createMockTools(3);

      // Miss
      cache.get(CACHE_KEY);

      // Set + hit
      cache.set(CACHE_KEY, tools);
      cache.get(CACHE_KEY);
      cache.get(CACHE_KEY);

      const stats = cache.getStats();
      expect(stats.hitCount).toBe(2);
      expect(stats.missCount).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('should report correct size', () => {
      const cache = createToolCache();
      expect(cache.getStats().size).toBe(0);

      cache.set(CACHE_KEY, createMockTools(3));
      expect(cache.getStats().size).toBe(1); // maxSize: 1, single key
    });
  });

  describe('large tool list', () => {
    it('should cache and retrieve 1000 tools correctly', () => {
      const cache = createToolCache();
      const tools = createMockTools(1000);

      cache.set(CACHE_KEY, tools);
      const result = cache.get(CACHE_KEY);

      expect(result).toHaveLength(1000);
      expect(result![0].name).toBe('tool_0');
      expect(result![999].name).toBe('tool_999');
    });
  });

  describe('empty tool list', () => {
    it('should handle empty tool list correctly', () => {
      const cache = createToolCache();

      cache.set(CACHE_KEY, []);
      const result = cache.get(CACHE_KEY);

      expect(result).toBeDefined();
      expect(result).toHaveLength(0);
    });
  });
});
