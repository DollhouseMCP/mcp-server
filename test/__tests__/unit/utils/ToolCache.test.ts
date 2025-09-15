/**
 * Unit tests for ToolCache implementation
 */

import { ToolCache, ToolDiscoveryCache } from '../../../../src/utils/ToolCache.js';
import { Tool } from "@modelcontextprotocol/sdk/types.js";

describe('ToolCache', () => {

  describe('Generic ToolCache', () => {
    test('should store and retrieve cached values', () => {
      const cache = new ToolCache<string>(10, 1);
      
      cache.set('test-key', 'test-value');
      const retrieved = cache.get('test-key');
      
      expect(retrieved).toBe('test-value');
    });

    test('should return undefined for non-existent keys', () => {
      const cache = new ToolCache<string>(10, 1);
      
      const retrieved = cache.get('non-existent');
      
      expect(retrieved).toBeUndefined();
    });

    test('should expire entries after TTL', () => {
      const cache = new ToolCache<string>(10, 0.001); // 0.001 minutes = 0.06 seconds
      
      cache.set('test-key', 'test-value');
      
      // Wait for expiry
      return new Promise(resolve => {
        setTimeout(() => {
          const retrieved = cache.get('test-key');
          expect(retrieved).toBeUndefined();
          resolve(undefined);
        }, 100); // Wait 100ms, longer than TTL
      });
    });

    test('should enforce memory limits by evicting oldest entries', () => {
      const cache = new ToolCache<string>(2, 1); // Max 2 entries
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3'); // Should evict key1
      
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
      expect(cache.get('key3')).toBe('value3');
    });

    test('should provide accurate cache statistics', () => {
      const cache = new ToolCache<string>(10, 1);
      
      // Initial stats
      let stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
      
      // Miss
      cache.get('non-existent');
      stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0);
      
      // Set and hit
      cache.set('test-key', 'test-value');
      cache.get('test-key');
      stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    test('should handle has() method correctly', () => {
      const cache = new ToolCache<string>(10, 1);
      
      expect(cache.has('test-key')).toBe(false);
      
      cache.set('test-key', 'test-value');
      expect(cache.has('test-key')).toBe(true);
    });

    test('should delete entries correctly', () => {
      const cache = new ToolCache<string>(10, 1);
      
      cache.set('test-key', 'test-value');
      expect(cache.has('test-key')).toBe(true);
      
      const deleted = cache.delete('test-key');
      expect(deleted).toBe(true);
      expect(cache.has('test-key')).toBe(false);
      
      const deletedAgain = cache.delete('test-key');
      expect(deletedAgain).toBe(false);
    });

    test('should clear all entries', () => {
      const cache = new ToolCache<string>(10, 1);
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      
      cache.clear();
      
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.getStats().size).toBe(0);
    });

    test('should cleanup expired entries', () => {
      const cache = new ToolCache<string>(10, 0.001); // Very short TTL
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      
      return new Promise(resolve => {
        setTimeout(() => {
          const cleanedCount = cache.cleanup();
          expect(cleanedCount).toBe(2);
          expect(cache.getStats().size).toBe(0);
          resolve(undefined);
        }, 100);
      });
    });
  });

  describe('ToolDiscoveryCache', () => {
    let mockTools: Tool[];

    beforeEach(() => {
      mockTools = [
        {
          name: 'test-tool-1',
          description: 'Test tool 1',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            }
          }
        },
        {
          name: 'test-tool-2',
          description: 'Test tool 2',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            }
          }
        }
      ];
    });

    test('should cache and retrieve tool list', () => {
      const cache = new ToolDiscoveryCache();
      
      const initialResult = cache.getToolList();
      expect(initialResult).toBeUndefined();
      
      cache.setToolList(mockTools);
      const cachedResult = cache.getToolList();
      
      expect(cachedResult).toEqual(mockTools);
      expect(cachedResult).toHaveLength(2);
    });

    test('should invalidate cached tool list', () => {
      const cache = new ToolDiscoveryCache();
      
      cache.setToolList(mockTools);
      expect(cache.getToolList()).toEqual(mockTools);
      
      cache.invalidateToolList();
      expect(cache.getToolList()).toBeUndefined();
    });

    test('should log performance metrics', () => {
      const cache = new ToolDiscoveryCache();
      
      // This should not throw
      cache.logPerformance();
      
      cache.setToolList(mockTools);
      cache.getToolList();
      
      // This should also not throw and should log some hits
      cache.logPerformance();
    });

    test('should maintain performance under repeated access', () => {
      const cache = new ToolDiscoveryCache();
      cache.setToolList(mockTools);
      
      // Access multiple times to test performance
      const startTime = Date.now();
      for (let i = 0; i < 100; i++) {
        const tools = cache.getToolList();
        expect(tools).toEqual(mockTools);
      }
      const duration = Date.now() - startTime;
      
      // CI environment detection for relaxed thresholds
      const isCI = process.env.CI === 'true';
      const isWindows = process.platform === 'win32';
      // Windows CI needs even more relaxed threshold due to slower filesystem operations
      const performanceThreshold = isCI ? (isWindows ? 75 : 50) : 10; // ms
      
      // Should be very fast (less than 10ms local, 50ms CI for 100 accesses)
      expect(duration).toBeLessThan(performanceThreshold);
      
      const stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0.9); // Should have >90% hit rate
    });

    test('should handle empty tool lists', () => {
      const cache = new ToolDiscoveryCache();
      const emptyTools: Tool[] = [];
      
      cache.setToolList(emptyTools);
      const result = cache.getToolList();
      
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    test('should handle large tool lists efficiently', () => {
      const cache = new ToolDiscoveryCache();
      const largeToolList: Tool[] = [];
      
      // Create 1000 mock tools
      for (let i = 0; i < 1000; i++) {
        largeToolList.push({
          name: `tool-${i}`,
          description: `Tool ${i} for testing`,
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' }
            }
          }
        });
      }
      
      const startTime = Date.now();
      cache.setToolList(largeToolList);
      const setDuration = Date.now() - startTime;
      
      const retrieveStart = Date.now();
      const result = cache.getToolList();
      const retrieveDuration = Date.now() - retrieveStart;
      
      expect(result).toHaveLength(1000);
      
      // CI environment detection for relaxed thresholds
      const isCI = process.env.CI === 'true';
      const setThreshold = isCI ? 50 : 10; // ms
      const retrieveThreshold = isCI ? 5 : 1; // ms
      
      expect(setDuration).toBeLessThan(setThreshold); // Caching should be fast
      expect(retrieveDuration).toBeLessThan(retrieveThreshold); // Retrieval should be very fast
    });
  });

  describe('Performance Requirements', () => {
    test('should meet performance goal of <10ms for cached calls', () => {
      const cache = new ToolDiscoveryCache();
      const tools: Tool[] = Array.from({ length: 50 }, (_, i) => ({
        name: `tool-${i}`,
        description: `Tool ${i}`,
        inputSchema: { type: 'object', properties: {} }
      }));
      
      // Cache the tools
      cache.setToolList(tools);
      
      // Test 10 consecutive retrievals
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        const result = cache.getToolList();
        const duration = performance.now() - start;
        times.push(duration);
        
        expect(result).toHaveLength(50);
      }
      
      const averageTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const maxTime = Math.max(...times);
      
      // CI environment detection for relaxed thresholds
      const isCI = process.env.CI === 'true';
      const isWindows = process.platform === 'win32';
      // Windows CI needs even more relaxed threshold due to slower filesystem operations
      const performanceThreshold = isCI ? (isWindows ? 75 : 50) : 10; // ms
      
      // Performance requirements with CI accommodation
      expect(averageTime).toBeLessThan(performanceThreshold); // <10ms local, <50ms CI average
      expect(maxTime).toBeLessThan(performanceThreshold); // No individual call >10ms local, >50ms CI
    });

    test('should provide significant performance improvement over non-cached calls', () => {
      const cache = new ToolDiscoveryCache();
      const tools: Tool[] = Array.from({ length: 50 }, (_, i) => ({
        name: `tool-${i}`,
        description: `Tool ${i}`,
        inputSchema: { type: 'object', properties: {} }
      }));
      
      // Simulate "expensive" tool discovery (like what the real registry would do)
      const expensiveGetTools = (): Tool[] => {
        // Simulate work with a small delay
        const start = Date.now();
        while (Date.now() - start < 5) { /* busy wait 5ms */ }
        return [...tools]; // Return copy
      };
      
      // Measure non-cached performance
      const nonCachedStart = performance.now();
      const nonCachedResult = expensiveGetTools();
      const nonCachedTime = performance.now() - nonCachedStart;
      
      // Cache the tools
      cache.setToolList(tools);
      
      // Measure cached performance
      const cachedStart = performance.now();
      const cachedResult = cache.getToolList();
      const cachedTime = performance.now() - cachedStart;
      
      expect(nonCachedResult).toHaveLength(50);
      expect(cachedResult).toHaveLength(50);
      expect(nonCachedTime).toBeGreaterThan(4); // Should take at least 4ms

      // CI FIX: Allow threshold to be configured via environment variable
      // This enables CI-specific tuning without code changes
      // Default: 1ms for most platforms, 2ms for Windows
      const isWindows = process.platform === 'win32';
      const defaultThreshold = isWindows ? 2 : 1;
      const cacheThreshold = process.env.TOOLCACHE_THRESHOLD_MS
        ? parseFloat(process.env.TOOLCACHE_THRESHOLD_MS)
        : defaultThreshold;

      expect(cachedTime).toBeLessThan(cacheThreshold); // Configurable threshold
      expect(cachedTime).toBeLessThan(nonCachedTime / 5); // At least 5x improvement
    });
  });
});