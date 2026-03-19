/**
 * Unit tests for LRU Cache deterministic TTL cleanup
 *
 * Phase 3: Validates that TTL cleanup fires deterministically based on
 * nextExpiryTimestamp rather than probabilistically (old 10% random check).
 */

import { LRUCache } from '../../../src/cache/LRUCache.js';

describe('LRUCache Deterministic TTL', () => {
  describe('cleanup with ttlMs = 0 (no TTL)', () => {
    it('should never run cleanup when ttlMs is 0', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
        ttlMs: 0,
      });

      // Add entries
      cache.set('a', 'value-a');
      cache.set('b', 'value-b');

      // cleanup() returns 0 when TTL is disabled
      expect(cache.cleanup()).toBe(0);
      expect(cache.size).toBe(2);
    });
  });

  describe('cleanup fires exactly when an entry expires', () => {
    it('should not clean entries that have not expired', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
        ttlMs: 60000, // 1 minute
      });

      cache.set('a', 'value-a');
      cache.set('b', 'value-b');

      // No entries should be expired yet
      expect(cache.cleanup()).toBe(0);
      expect(cache.size).toBe(2);
    });

    it('should clean entries that have expired', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
        ttlMs: 100, // 100ms TTL
      });

      // Use Date.now mocking to control time
      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set('a', 'value-a');
        currentTime += 50; // 50ms later
        cache.set('b', 'value-b');

        // No entries expired yet
        expect(cache.cleanup()).toBe(0);
        expect(cache.size).toBe(2);

        // Advance past first entry's expiry
        currentTime += 60; // now at +110ms from 'a', +60ms from 'b'
        expect(cache.cleanup()).toBe(1); // 'a' expired
        expect(cache.size).toBe(1);
        expect(cache.get('b')).toBe('value-b');

        // Advance past second entry's expiry
        currentTime += 50; // now at +110ms from 'b'
        expect(cache.cleanup()).toBe(1); // 'b' expired
        expect(cache.size).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });

    it('should trigger cleanup deterministically during evictIfNecessary', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        ttlMs: 100, // 100ms TTL
      });

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        // Set an entry
        cache.set('old', 'old-value');

        // Advance past expiry
        currentTime += 200;

        // set() triggers evictIfNecessary() which should deterministically
        // clean expired entries now that we've passed nextExpiryTimestamp
        cache.set('new', 'new-value');

        // 'old' should have been cleaned up, only 'new' remains
        expect(cache.size).toBe(1);
        expect(cache.get('old')).toBeUndefined();
        expect(cache.get('new')).toBe('new-value');
      } finally {
        Date.now = originalNow;
      }
    });

    it('should not trigger premature cleanup before expiry', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        ttlMs: 1000, // 1s TTL
      });

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set('a', 'value-a');

        // Advance time but NOT past expiry
        currentTime += 500;

        // Adding a new entry should NOT clean 'a'
        cache.set('b', 'value-b');
        expect(cache.size).toBe(2);
        expect(cache.get('a')).toBe('value-a');
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('multiple entries with staggered timestamps', () => {
    it('should clean up entries in expiry order', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        ttlMs: 100, // 100ms TTL
      });

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set('first', 'v1');
        currentTime += 30;
        cache.set('second', 'v2');
        currentTime += 30;
        cache.set('third', 'v3');

        // At +60ms: nothing expired (oldest is 60ms old, TTL is 100ms)
        expect(cache.cleanup()).toBe(0);
        expect(cache.size).toBe(3);

        // At +105ms: 'first' expired (105ms old)
        currentTime += 45;
        expect(cache.cleanup()).toBe(1);
        expect(cache.size).toBe(2);

        // At +135ms: 'second' expired (105ms old)
        currentTime += 30;
        expect(cache.cleanup()).toBe(1);
        expect(cache.size).toBe(1);

        // At +165ms: 'third' expired (105ms old)
        currentTime += 30;
        expect(cache.cleanup()).toBe(1);
        expect(cache.size).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('nextExpiryTimestamp resets on clear()', () => {
    it('should not trigger cleanup after clear() until new entries expire', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        ttlMs: 100,
      });

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        cache.set('a', 'value-a');

        // Clear resets nextExpiryTimestamp to Infinity
        cache.clear();
        expect(cache.size).toBe(0);

        // Advance past what would have been the old expiry
        currentTime += 200;

        // New entry should not be cleaned up prematurely
        cache.set('b', 'value-b');
        expect(cache.size).toBe(1);
        expect(cache.get('b')).toBe('value-b');

        // But it should expire after its own TTL
        currentTime += 150;
        expect(cache.cleanup()).toBe(1);
        expect(cache.size).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('getName()', () => {
    it('should return the constructor name', () => {
      const cache = new LRUCache<string>({
        name: 'test-cache',
        maxSize: 10,
      });
      expect(cache.getName()).toBe('test-cache');
    });

    it('should return "unnamed" when no name provided', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
      });
      expect(cache.getName()).toBe('unnamed');
    });
  });

  describe('getMemoryUsageBytes()', () => {
    it('should be consistent with getMemoryUsageMB()', () => {
      const cache = new LRUCache<string>({
        maxSize: 100,
        maxMemoryMB: 10,
      });

      cache.set('a', 'hello world');
      cache.set('b', 'another value');

      const bytes = cache.getMemoryUsageBytes();
      const mb = cache.getMemoryUsageMB();

      // bytes / (1024 * 1024) should equal mb
      expect(Math.abs(bytes / (1024 * 1024) - mb)).toBeLessThan(0.0001);
    });

    it('should return 0 for empty cache', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
      });
      expect(cache.getMemoryUsageBytes()).toBe(0);
    });

    it('should increase after adding entries', () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
      });

      const before = cache.getMemoryUsageBytes();
      cache.set('key', 'a long string value for testing');
      const after = cache.getMemoryUsageBytes();

      expect(after).toBeGreaterThan(before);
    });
  });
});
