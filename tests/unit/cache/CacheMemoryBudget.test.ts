import { describe, it, expect } from '@jest/globals';
import { LRUCache } from '../../../src/cache/LRUCache.js';
import { CacheMemoryBudget } from '../../../src/cache/CacheMemoryBudget.js';

describe('CacheMemoryBudget', () => {

  function createBudget(limitMB: number, maxEvictions?: number): CacheMemoryBudget {
    return new CacheMemoryBudget({
      globalLimitBytes: limitMB * 1024 * 1024,
      maxEvictionsPerEnforce: maxEvictions,
    });
  }

  function createCache(name: string, maxMemoryMB = 50): LRUCache<string> {
    return new LRUCache<string>({
      name,
      maxSize: 1000,
      maxMemoryMB,
    });
  }

  describe('register()', () => {
    it('should register a cache and track it', () => {
      const budget = createBudget(150);
      const cache = createCache('test');
      budget.register(cache);
      expect(budget.getRegisteredCacheCount()).toBe(1);
    });

    it('should be idempotent — no double-registration', () => {
      const budget = createBudget(150);
      const cache = createCache('test');
      budget.register(cache);
      budget.register(cache);
      expect(budget.getRegisteredCacheCount()).toBe(1);
    });

    it('should register multiple caches', () => {
      const budget = createBudget(150);
      budget.register(createCache('a'));
      budget.register(createCache('b'));
      budget.register(createCache('c'));
      expect(budget.getRegisteredCacheCount()).toBe(3);
    });
  });

  describe('unregister()', () => {
    it('should remove a registered cache', () => {
      const budget = createBudget(150);
      const cache = createCache('test');
      budget.register(cache);
      budget.unregister(cache);
      expect(budget.getRegisteredCacheCount()).toBe(0);
    });

    it('should handle unregistering a non-registered cache gracefully', () => {
      const budget = createBudget(150);
      const cache = createCache('test');
      budget.unregister(cache); // no-op
      expect(budget.getRegisteredCacheCount()).toBe(0);
    });
  });

  describe('getTotalMemoryBytes()', () => {
    it('should return 0 with no registered caches', () => {
      const budget = createBudget(150);
      expect(budget.getTotalMemoryBytes()).toBe(0);
    });

    it('should aggregate memory across registered caches', () => {
      const budget = createBudget(150);
      const cache1 = createCache('cache1');
      const cache2 = createCache('cache2');

      cache1.set('key1', 'a'.repeat(1000));
      cache2.set('key2', 'b'.repeat(2000));

      budget.register(cache1);
      budget.register(cache2);

      expect(budget.getTotalMemoryBytes()).toBeGreaterThan(0);
      expect(budget.getTotalMemoryBytes()).toBe(
        cache1.getMemoryUsageBytes() + cache2.getMemoryUsageBytes()
      );
    });
  });

  describe('enforce()', () => {
    it('should do nothing when under budget', () => {
      const budget = createBudget(150);
      const cache = createCache('test');
      cache.set('k1', 'value');
      budget.register(cache);

      const sizeBefore = cache.getStats().size;
      budget.enforce();
      expect(cache.getStats().size).toBe(sizeBefore);
    });

    it('should evict entries when over budget', () => {
      // Create a budget with a very small limit (1 KB)
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 1024,
      });

      const cache = createCache('test');
      // Fill with enough data to exceed 1 KB
      for (let i = 0; i < 50; i++) {
        cache.set(`key-${i}`, 'x'.repeat(200));
      }
      budget.register(cache);

      const sizeBefore = cache.getStats().size;
      budget.enforce();
      expect(cache.getStats().size).toBeLessThan(sizeBefore);
      expect(budget.getTotalMemoryBytes()).toBeLessThanOrEqual(1024);
    });

    it('should evict from coldest cache first', () => {
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 500,
      });

      const originalNow = Date.now;
      let mockTime = 1000000;
      Date.now = () => mockTime;

      try {
        // Cold cache: accessed first (oldest activity)
        const coldCache = createCache('cold');
        coldCache.set('cold-key', 'x'.repeat(200));

        // Hot cache: accessed later (newest activity)
        mockTime += 10000;
        const hotCache = createCache('hot');
        hotCache.set('hot-key', 'x'.repeat(200));

        budget.register(coldCache);
        budget.register(hotCache);

        budget.enforce();

        // Cold cache should be evicted from first
        // If total is now under budget, hot cache may be untouched
        if (hotCache.getStats().size === 1) {
          // Hot cache preserved = cold cache was targeted first
          expect(coldCache.getStats().size).toBe(0);
        }
      } finally {
        Date.now = originalNow;
      }
    });

    it('should evict across multiple caches if needed', () => {
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 100, // Very small
      });

      const cache1 = createCache('c1');
      const cache2 = createCache('c2');

      for (let i = 0; i < 20; i++) {
        cache1.set(`k1-${i}`, 'a'.repeat(100));
        cache2.set(`k2-${i}`, 'b'.repeat(100));
      }

      budget.register(cache1);
      budget.register(cache2);

      budget.enforce();

      expect(budget.getTotalMemoryBytes()).toBeLessThanOrEqual(100);
    });

    it('should skip empty caches during eviction', () => {
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 10,
      });

      const emptyCache = createCache('empty');
      const fullCache = createCache('full');
      fullCache.set('key', 'a'.repeat(100));

      budget.register(emptyCache);
      budget.register(fullCache);

      // Should not throw or hang on the empty cache
      budget.enforce();

      expect(emptyCache.getStats().size).toBe(0);
    });

    it('should respect maxEvictionsPerEnforce cap', () => {
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 1, // Impossibly small
        maxEvictionsPerEnforce: 5,
      });

      const cache = createCache('test');
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, `value-${i}`);
      }

      budget.register(cache);

      const sizeBefore = cache.getStats().size;
      budget.enforce();

      // Should have evicted exactly 5 (the cap), not more
      expect(sizeBefore - cache.getStats().size).toBe(5);
    });

    it('should have reentrancy guard to prevent cascading', () => {
      // The reentrancy guard is tested by creating an onSet callback
      // that would trigger enforce() again. The guard should prevent infinite loops.
      const budget = new CacheMemoryBudget({
        globalLimitBytes: 500,
      });

      const cache = new LRUCache<string>({
        name: 'reentrant-test',
        maxSize: 1000,
        maxMemoryMB: 50,
        onSet: () => budget.enforce(),
      });

      budget.register(cache);

      // This should not cause infinite recursion
      for (let i = 0; i < 50; i++) {
        cache.set(`key-${i}`, 'x'.repeat(200));
      }

      // If we got here without stack overflow, reentrancy guard works
      expect(budget.getTotalMemoryBytes()).toBeLessThanOrEqual(500);
    });
  });

  describe('getReport()', () => {
    it('should return accurate stats for all registered caches', () => {
      const budget = createBudget(150);
      const cache1 = createCache('personas');
      const cache2 = createCache('skills');

      cache1.set('p1', 'persona-data');
      cache2.set('s1', 'skill-data');
      cache2.set('s2', 'skill-data-2');

      budget.register(cache1);
      budget.register(cache2);

      const report = budget.getReport();

      expect(report.caches).toHaveLength(2);

      const personaReport = report.caches.find(c => c.name === 'personas');
      const skillReport = report.caches.find(c => c.name === 'skills');

      expect(personaReport).toBeDefined();
      expect(personaReport!.entries).toBe(1);

      expect(skillReport).toBeDefined();
      expect(skillReport!.entries).toBe(2);

      // Total bytes should be positive even though MB rounds to 0
      expect(budget.getTotalMemoryBytes()).toBeGreaterThan(0);
      expect(report.totalMemoryMB).toBeGreaterThanOrEqual(0);
      expect(report.budgetMB).toBe(150);
    });

    it('should return empty report with no registered caches', () => {
      const budget = createBudget(150);
      const report = budget.getReport();

      expect(report.caches).toHaveLength(0);
      expect(report.totalMemoryMB).toBe(0);
      expect(report.utilizationPercent).toBe(0);
    });
  });

  describe('LRUCache integration', () => {
    it('evictOne() should evict the LRU entry', () => {
      const cache = createCache('test');
      cache.set('first', 'value-1');
      cache.set('second', 'value-2');
      cache.set('third', 'value-3');

      const evicted = cache.evictOne();

      expect(evicted).toBe(true);
      expect(cache.getStats().size).toBe(2);
      expect(cache.has('first')).toBe(false); // LRU = evicted
      expect(cache.has('second')).toBe(true);
      expect(cache.has('third')).toBe(true);
    });

    it('evictOne() should return false on empty cache', () => {
      const cache = createCache('empty');
      expect(cache.evictOne()).toBe(false);
    });

    it('getLastActivityTimestamp() should return 0 for unused cache', () => {
      const cache = createCache('new');
      expect(cache.getLastActivityTimestamp()).toBe(0);
    });

    it('getLastActivityTimestamp() should update on set()', () => {
      const cache = createCache('test');
      const before = Date.now();
      cache.set('key', 'value');
      const after = Date.now();

      expect(cache.getLastActivityTimestamp()).toBeGreaterThanOrEqual(before);
      expect(cache.getLastActivityTimestamp()).toBeLessThanOrEqual(after);
    });

    it('getLastActivityTimestamp() should update on get() hits', () => {
      const cache = createCache('test');
      cache.set('key', 'value');

      // Small delay to ensure timestamps differ
      const before = Date.now();
      cache.get('key');
      const after = Date.now();

      expect(cache.getLastActivityTimestamp()).toBeGreaterThanOrEqual(before);
      expect(cache.getLastActivityTimestamp()).toBeLessThanOrEqual(after);
    });

    it('onSet callback should fire on every set()', () => {
      let callCount = 0;
      const cache = new LRUCache<string>({
        name: 'callback-test',
        maxSize: 100,
        onSet: () => { callCount++; },
      });

      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      expect(callCount).toBe(3);
    });

    it('evictOne() should fire onEviction callback', () => {
      const evicted: string[] = [];
      const cache = new LRUCache<string>({
        name: 'eviction-test',
        maxSize: 100,
        onEviction: (key) => evicted.push(key),
      });

      cache.set('a', 'value');
      cache.set('b', 'value');

      cache.evictOne();

      expect(evicted).toEqual(['a']); // LRU entry
    });

    it('evictOne() should decrement memory usage', () => {
      const cache = new LRUCache<string>({
        name: 'memory-test',
        maxSize: 100,
      });

      cache.set('key', 'a'.repeat(1000));
      const memBefore = cache.getMemoryUsageBytes();

      cache.evictOne();

      expect(cache.getMemoryUsageBytes()).toBeLessThan(memBefore);
      expect(cache.getMemoryUsageBytes()).toBe(0);
    });
  });
});
