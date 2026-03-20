/**
 * Unit tests for EvictingQueue utility
 */

import { describe, it, expect } from '@jest/globals';
import { EvictingQueue } from '../../../src/utils/EvictingQueue.js';

describe('EvictingQueue', () => {
  describe('Construction', () => {
    it('should create with given capacity', () => {
      const q = new EvictingQueue<number>(10);
      expect(q.capacity).toBe(10);
      expect(q.size).toBe(0);
    });

    it('should reject capacity < 1', () => {
      expect(() => new EvictingQueue(0)).toThrow('EvictingQueue capacity must be >= 1');
      expect(() => new EvictingQueue(-1)).toThrow('EvictingQueue capacity must be >= 1');
    });
  });

  describe('push + size', () => {
    it('should accumulate items', () => {
      const q = new EvictingQueue<string>(5);
      q.push('a');
      q.push('b');
      expect(q.size).toBe(2);
    });

    it('should track size correctly', () => {
      const q = new EvictingQueue<number>(3);
      expect(q.size).toBe(0);
      q.push(1);
      expect(q.size).toBe(1);
      q.push(2);
      q.push(3);
      expect(q.size).toBe(3);
    });
  });

  describe('Eviction', () => {
    it('should evict oldest when over capacity', () => {
      const q = new EvictingQueue<number>(3);
      q.push(1);
      q.push(2);
      q.push(3);
      q.push(4); // evicts 1

      expect(q.size).toBe(3);
      expect(q.toArray()).toEqual([2, 3, 4]);
    });

    it('should keep evicting on continued pushes', () => {
      const q = new EvictingQueue<number>(2);
      q.push(1);
      q.push(2);
      q.push(3);
      q.push(4);

      expect(q.size).toBe(2);
      expect(q.toArray()).toEqual([3, 4]);
    });
  });

  describe('toArray', () => {
    it('should return items oldest-to-newest', () => {
      const q = new EvictingQueue<string>(5);
      q.push('first');
      q.push('second');
      q.push('third');

      expect(q.toArray()).toEqual(['first', 'second', 'third']);
    });

    it('should return readonly array', () => {
      const q = new EvictingQueue<number>(5);
      q.push(1);
      const arr = q.toArray();
      // TypeScript enforces readonly at compile time; runtime check:
      expect(Array.isArray(arr)).toBe(true);
    });
  });

  describe('clear', () => {
    it('should empty the queue', () => {
      const q = new EvictingQueue<number>(5);
      q.push(1);
      q.push(2);
      q.clear();

      expect(q.size).toBe(0);
      expect(q.toArray()).toEqual([]);
    });
  });

  describe('reset', () => {
    it('should replace contents', () => {
      const q = new EvictingQueue<number>(5);
      q.push(1);
      q.reset([10, 20, 30]);

      expect(q.size).toBe(3);
      expect(q.toArray()).toEqual([10, 20, 30]);
    });

    it('should respect capacity on reset', () => {
      const q = new EvictingQueue<number>(3);
      q.reset([1, 2, 3, 4, 5]);

      expect(q.size).toBe(3);
      expect(q.toArray()).toEqual([3, 4, 5]); // keeps last 3
    });

    it('should copy input array', () => {
      const q = new EvictingQueue<number>(5);
      const input = [1, 2, 3];
      q.reset(input);
      input.push(99);

      expect(q.toArray()).toEqual([1, 2, 3]); // not affected by mutation
    });
  });

  describe('Iterator', () => {
    it('should support for...of', () => {
      const q = new EvictingQueue<number>(5);
      q.push(10);
      q.push(20);
      q.push(30);

      const collected: number[] = [];
      for (const item of q) {
        collected.push(item);
      }

      expect(collected).toEqual([10, 20, 30]);
    });

    it('should match toArray order', () => {
      const q = new EvictingQueue<string>(3);
      q.push('a');
      q.push('b');
      q.push('c');
      q.push('d'); // evicts 'a'

      const iterated = [...q];
      expect(iterated).toEqual([...q.toArray()]);
    });
  });

  describe('toJSON', () => {
    it('should produce plain array via JSON.stringify', () => {
      const q = new EvictingQueue<number>(5);
      q.push(1);
      q.push(2);

      const json = JSON.stringify(q);
      expect(json).toBe('[1,2]');
    });

    it('should produce independent copy', () => {
      const q = new EvictingQueue<number>(5);
      q.push(1);
      const copy = q.toJSON();
      q.push(2);

      expect(copy).toEqual([1]);
      expect(q.toJSON()).toEqual([1, 2]);
    });
  });

  describe('Edge cases', () => {
    it('should handle capacity of 1', () => {
      const q = new EvictingQueue<string>(1);
      q.push('a');
      expect(q.size).toBe(1);
      expect(q.toArray()).toEqual(['a']);

      q.push('b');
      expect(q.size).toBe(1);
      expect(q.toArray()).toEqual(['b']);
    });

    it('should handle empty queue operations', () => {
      const q = new EvictingQueue<number>(5);
      expect(q.size).toBe(0);
      expect(q.toArray()).toEqual([]);
      expect(q.toJSON()).toEqual([]);
      expect([...q]).toEqual([]);

      q.clear(); // no-op on empty
      expect(q.size).toBe(0);
    });
  });
});
