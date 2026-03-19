/**
 * Unit tests for LRU Cache size estimation
 *
 * Tests all three modes: fast, balanced, accurate
 * Verifies accuracy bounds and edge cases
 */

import { LRUCache, SizeEstimationMode } from '../../../src/cache/LRUCache.js';

describe('LRUCache Size Estimation', () => {
  describe('Fast Mode', () => {
    let cache: LRUCache<any>;

    beforeEach(() => {
      cache = new LRUCache<any>({
        maxSize: 100,
        maxMemoryMB: 10,
        sizeEstimationMode: 'fast'
      });
    });

    it('should estimate primitive types correctly', () => {
      cache.set('null', null);
      cache.set('number', 42);
      cache.set('boolean', true);

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });

    it('should estimate string size based on length', () => {
      const shortString = 'hello';
      const longString = 'A'.repeat(1000);

      cache.set('short', shortString);
      const shortStats = cache.getStats();

      cache.clear();
      cache.set('long', longString);
      const longStats = cache.getStats();

      // Long string should use significantly more memory
      expect(longStats.memoryUsageMB).toBeGreaterThan(shortStats.memoryUsageMB * 10);
    });

    it('should estimate array size based on length', () => {
      const smallArray = [1, 2, 3];
      const largeArray = Array(100).fill({ id: 1, name: 'test' });

      cache.set('small', smallArray);
      const smallStats = cache.getStats();

      cache.clear();
      cache.set('large', largeArray);
      const largeStats = cache.getStats();

      // Large array should use more memory
      expect(largeStats.memoryUsageMB).toBeGreaterThan(smallStats.memoryUsageMB);
    });

    it('should estimate object size based on key count', () => {
      const smallObj = { id: 1, name: 'test' };
      const largeObj: any = {};
      for (let i = 0; i < 100; i++) {
        largeObj[`key_${i}`] = `value_${i}`;
      }

      cache.set('small', smallObj);
      const smallStats = cache.getStats();

      cache.clear();
      cache.set('large', largeObj);
      const largeStats = cache.getStats();

      // Large object should use more memory
      expect(largeStats.memoryUsageMB).toBeGreaterThan(smallStats.memoryUsageMB);
    });

    it('should handle nested objects', () => {
      const nested = {
        level1: {
          level2: {
            level3: {
              value: 'deep'
            }
          }
        }
      };

      cache.set('nested', nested);
      const stats = cache.getStats();

      expect(stats.memoryUsageMB).toBeGreaterThan(0);
      expect(stats.size).toBe(1);
    });

    it('should maintain reasonable accuracy within 50-200% bounds', () => {
      const testObj = {
        id: 'test-123',
        name: 'Test Object',
        properties: {
          a: 1,
          b: 2,
          c: 3
        },
        tags: ['tag1', 'tag2', 'tag3']
      };

      cache.set('test', testObj);
      const stats = cache.getStats();
      const estimatedBytes = stats.memoryUsageMB * 1024 * 1024;

      // Approximate actual size using JSON.stringify
      const jsonSize = JSON.stringify(testObj).length * 2 + 64;

      // Should be within 50-200% of actual size
      expect(estimatedBytes).toBeGreaterThanOrEqual(jsonSize * 0.5);
      expect(estimatedBytes).toBeLessThanOrEqual(jsonSize * 2.0);
    });

    it('should be consistent for the same value', () => {
      const value = { id: 1, data: 'test', items: [1, 2, 3] };

      cache.set('key1', value);
      const stats1 = cache.getStats();

      cache.clear();
      cache.set('key2', value);
      const stats2 = cache.getStats();

      expect(stats1.memoryUsageMB).toBe(stats2.memoryUsageMB);
    });
  });

  describe('Balanced Mode', () => {
    let cache: LRUCache<any>;

    beforeEach(() => {
      cache = new LRUCache<any>({
        maxSize: 100,
        maxMemoryMB: 10,
        sizeEstimationMode: 'balanced'
      });
    });

    it('should provide better accuracy than fast mode for arrays', () => {
      const mixedArray = [
        { id: 1, small: 'a' },
        { id: 2, large: 'A'.repeat(1000) },
        { id: 3, medium: 'test' }
      ];

      const fastCache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      const balancedCache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'balanced'
      });

      fastCache.set('test', mixedArray);
      balancedCache.set('test', mixedArray);

      const fastSize = fastCache.getStats().memoryUsageMB;
      const balancedSize = balancedCache.getStats().memoryUsageMB;

      // Balanced should be different from fast (sampling should affect estimate)
      expect(Math.abs(fastSize - balancedSize)).toBeGreaterThan(0);
    });

    it('should sample large objects for estimation', () => {
      const largeObj: any = {};
      for (let i = 0; i < 50; i++) {
        largeObj[`key_${i}`] = `value_${i}`;
      }

      cache.set('large', largeObj);
      const stats = cache.getStats();

      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });

    it('should handle empty arrays and objects', () => {
      cache.set('empty-array', []);
      cache.set('empty-object', {});

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });
  });

  describe('Accurate Mode', () => {
    let cache: LRUCache<any>;

    beforeEach(() => {
      cache = new LRUCache<any>({
        maxSize: 100,
        maxMemoryMB: 10,
        sizeEstimationMode: 'accurate'
      });
    });

    it('should use JSON.stringify for object sizing', () => {
      const obj = {
        id: 'test',
        data: { nested: true },
        items: [1, 2, 3]
      };

      cache.set('test', obj);
      const stats = cache.getStats();
      const estimatedBytes = stats.memoryUsageMB * 1024 * 1024;

      // Should be very close to JSON.stringify size
      const jsonSize = JSON.stringify(obj).length * 2 + 64;
      const errorPercent = Math.abs((estimatedBytes - jsonSize) / jsonSize) * 100;

      expect(errorPercent).toBeLessThan(20); // Within 20% accuracy
    });

    it('should recursively calculate array sizes', () => {
      const array = [
        { id: 1, name: 'item1' },
        { id: 2, name: 'item2' },
        { id: 3, name: 'item3' }
      ];

      cache.set('array', array);
      const stats = cache.getStats();

      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });
  });

  describe('Mode Comparison', () => {
    it('should maintain cache behavior across all modes', () => {
      const testData = [
        { key: 'item1', value: { id: 1, data: 'test1' } },
        { key: 'item2', value: { id: 2, data: 'test2' } },
        { key: 'item3', value: { id: 3, data: 'test3' } }
      ];

      const modes: SizeEstimationMode[] = ['fast', 'balanced', 'accurate'];

      modes.forEach(mode => {
        const cache = new LRUCache<any>({
          maxSize: 10,
          sizeEstimationMode: mode
        });

        testData.forEach(({ key, value }) => cache.set(key, value));

        // All modes should have same number of items
        expect(cache.getStats().size).toBe(3);

        // All modes should be able to retrieve items
        testData.forEach(({ key, value }) => {
          expect(cache.get(key)).toEqual(value);
        });
      });
    });

    it('should trigger eviction when memory limit exceeded in all modes', () => {
      const modes: SizeEstimationMode[] = ['fast', 'balanced', 'accurate'];

      modes.forEach(mode => {
        const cache = new LRUCache<any>({
          maxSize: 100,
          maxMemoryMB: 0.001, // Very small limit
          sizeEstimationMode: mode
        });

        // Add items until eviction occurs
        for (let i = 0; i < 100; i++) {
          cache.set(`key${i}`, { data: 'A'.repeat(1000) });
        }

        const stats = cache.getStats();

        // Should have evicted some items
        expect(stats.evictionCount).toBeGreaterThan(0);
        expect(stats.size).toBeLessThan(100);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle circular references gracefully in accurate mode', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'accurate'
      });

      const obj: any = { id: 1 };
      obj.self = obj; // Circular reference

      // Should not throw, should fall back to default size
      expect(() => cache.set('circular', obj)).not.toThrow();
    });

    it('should handle very large strings', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      const largeString = 'A'.repeat(1000000); // 1MB string

      cache.set('large', largeString);
      const stats = cache.getStats();

      expect(stats.memoryUsageMB).toBeGreaterThan(1);
    });

    it('should handle undefined and null', () => {
      const modes: SizeEstimationMode[] = ['fast', 'balanced', 'accurate'];

      modes.forEach(mode => {
        const cache = new LRUCache<any>({
          maxSize: 10,
          sizeEstimationMode: mode
        });

        cache.set('null', null);
        cache.set('undefined', undefined);

        const stats = cache.getStats();
        expect(stats.size).toBe(2);
      });
    });

    it('should handle deeply nested structures', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      let deep: any = { value: 'leaf' };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep };
      }

      cache.set('deep', deep);
      const stats = cache.getStats();

      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });

    it('should handle mixed types in arrays', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'balanced'
      });

      const mixedArray = [
        1,
        'string',
        { object: true },
        [1, 2, 3],
        null,
        undefined,
        true,
        3.14
      ];

      cache.set('mixed', mixedArray);
      const stats = cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });
  });

  describe('Default Mode', () => {
    it('should use fast mode as default', () => {
      const cacheWithoutMode = new LRUCache<any>({
        maxSize: 10
      });

      const cacheWithFast = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      const testValue = { id: 1, data: 'test' };

      cacheWithoutMode.set('test', testValue);
      cacheWithFast.set('test', testValue);

      // Should produce same size estimate
      expect(cacheWithoutMode.getStats().memoryUsageMB).toBe(
        cacheWithFast.getStats().memoryUsageMB
      );
    });
  });

  describe('Log Listener', () => {
    afterEach(() => {
      // Clean up static listener between tests
      LRUCache.addLogListener(() => {})();
    });

    it('should call static log listener on eviction', () => {
      const logCalls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      LRUCache.addLogListener((level, message, data) => {
        logCalls.push({ level, message, data });
      });

      const cache = new LRUCache<string>({
        name: 'test-eviction',
        maxSize: 2,
      });

      cache.set('a', 'value-a');
      cache.set('b', 'value-b');
      cache.set('c', 'value-c'); // triggers eviction of 'a'

      const evictEvents = logCalls.filter(c => c.message === 'Evict entry');
      expect(evictEvents.length).toBeGreaterThanOrEqual(1);
      expect(evictEvents[0].level).toBe('debug');
      expect(evictEvents[0].data?.cacheName).toBe('test-eviction');
      expect(evictEvents[0].data?.key).toBe('a');
    });

    it('should include cache name in clear events', () => {
      const logCalls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      LRUCache.addLogListener((level, message, data) => {
        logCalls.push({ level, message, data });
      });

      const cache = new LRUCache<string>({
        name: 'test-clear',
        maxSize: 10,
      });

      cache.set('x', 'y');
      cache.clear();

      const clearEvents = logCalls.filter(c => c.message === 'Clear cache');
      expect(clearEvents).toHaveLength(1);
      expect(clearEvents[0].data?.cacheName).toBe('test-clear');
      expect(clearEvents[0].data?.entriesCleared).toBe(1);
    });

    it('should emit memory limit warning when threshold exceeded', () => {
      const logCalls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      LRUCache.addLogListener((level, message, data) => {
        logCalls.push({ level, message, data });
      });

      const cache = new LRUCache<string>({
        name: 'test-memory',
        maxSize: 100,
        maxMemoryMB: 0.001, // Very small limit
      });

      // Add items until memory eviction triggers
      for (let i = 0; i < 50; i++) {
        cache.set(`key${i}`, 'A'.repeat(100));
      }

      const memoryWarnings = logCalls.filter(c => c.message === 'Memory limit exceeded');
      expect(memoryWarnings.length).toBeGreaterThanOrEqual(1);
      expect(memoryWarnings[0].level).toBe('warn');
      expect(memoryWarnings[0].data?.cacheName).toBe('test-memory');
    });

    it('should receive events from multiple cache instances', () => {
      const logCalls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      LRUCache.addLogListener((level, message, data) => {
        logCalls.push({ level, message, data });
      });

      const cache1 = new LRUCache<string>({ name: 'cache-1', maxSize: 1 });
      const cache2 = new LRUCache<string>({ name: 'cache-2', maxSize: 1 });

      cache1.set('a', 'v1');
      cache1.set('b', 'v2'); // evicts 'a' from cache-1
      cache2.set('x', 'v3');
      cache2.set('y', 'v4'); // evicts 'x' from cache-2

      const evictEvents = logCalls.filter(c => c.message === 'Evict entry');
      const cacheNames = evictEvents.map(e => e.data?.cacheName);
      expect(cacheNames).toContain('cache-1');
      expect(cacheNames).toContain('cache-2');
    });

    it('should stop receiving events after unsubscribe', () => {
      const logCalls: Array<{ level: string; message: string }> = [];
      const unsub = LRUCache.addLogListener((level, message) => {
        logCalls.push({ level, message });
      });

      const cache = new LRUCache<string>({ name: 'test-unsub', maxSize: 10 });
      cache.set('a', 'v1');
      cache.clear();

      const beforeCount = logCalls.length;
      expect(beforeCount).toBeGreaterThan(0);

      unsub();

      cache.set('b', 'v2');
      cache.clear();

      // No new events after unsubscribe
      expect(logCalls.length).toBe(beforeCount);
    });

    it('should default name to "unnamed" when not provided', () => {
      const logCalls: Array<{ data?: Record<string, unknown> }> = [];
      LRUCache.addLogListener((_, __, data) => {
        logCalls.push({ data });
      });

      const cache = new LRUCache<string>({ maxSize: 10 });
      cache.set('a', 'v');
      cache.clear();

      const clearEvent = logCalls.find(c => c.data?.entriesCleared !== undefined);
      expect(clearEvent?.data?.cacheName).toBe('unnamed');
    });
  });

  describe('Memory Tracking', () => {
    it('should track memory correctly when updating values', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      const smallValue = 'small';
      const largeValue = 'A'.repeat(10000);

      cache.set('key', smallValue);
      const smallMemory = cache.getStats().memoryUsageMB;

      cache.set('key', largeValue); // Update with larger value
      const largeMemory = cache.getStats().memoryUsageMB;

      // Large value should use significantly more memory
      expect(largeMemory).toBeGreaterThan(smallMemory * 100);

      cache.set('key', smallValue); // Update back to small
      const finalMemory = cache.getStats().memoryUsageMB;

      expect(finalMemory).toBeLessThan(largeMemory);
      // Should be close to original small memory
      expect(Math.abs(finalMemory - smallMemory) / smallMemory).toBeLessThan(0.1);
    });

    it('should reduce memory when deleting items', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      cache.set('key1', { data: 'A'.repeat(1000) });
      cache.set('key2', { data: 'B'.repeat(1000) });

      const beforeDelete = cache.getStats().memoryUsageMB;

      cache.delete('key1');

      const afterDelete = cache.getStats().memoryUsageMB;

      expect(afterDelete).toBeLessThan(beforeDelete);
    });

    it('should reset memory when clearing cache', () => {
      const cache = new LRUCache<any>({
        maxSize: 10,
        sizeEstimationMode: 'fast'
      });

      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, { data: 'A'.repeat(1000) });
      }

      expect(cache.getStats().memoryUsageMB).toBeGreaterThan(0);

      cache.clear();

      expect(cache.getStats().memoryUsageMB).toBe(0);
      expect(cache.getStats().size).toBe(0);
    });
  });
});
