/**
 * Unit tests for EventDeduplicator utility.
 * Verifies time-windowed suppression, cleanup, and LRU eviction.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventDeduplicator } from '../../../src/utils/EventDeduplicator.js';

describe('EventDeduplicator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should not suppress the first occurrence of an event', () => {
    const dedup = new EventDeduplicator(60_000);
    expect(dedup.shouldSuppress('event-a')).toBe(false);
  });

  it('should suppress duplicate events within the window', () => {
    const dedup = new EventDeduplicator(60_000);
    dedup.shouldSuppress('event-a');
    expect(dedup.shouldSuppress('event-a')).toBe(true);
  });

  it('should not suppress different events', () => {
    const dedup = new EventDeduplicator(60_000);
    dedup.shouldSuppress('event-a');
    expect(dedup.shouldSuppress('event-b')).toBe(false);
  });

  it('should allow same event after window expires', () => {
    const dedup = new EventDeduplicator(1000);
    dedup.shouldSuppress('event-a');
    expect(dedup.shouldSuppress('event-a')).toBe(true);

    jest.advanceTimersByTime(1001);
    expect(dedup.shouldSuppress('event-a')).toBe(false);
  });

  it('should not allow same event before window expires', () => {
    const dedup = new EventDeduplicator(1000);
    dedup.shouldSuppress('event-a');

    jest.advanceTimersByTime(500);
    expect(dedup.shouldSuppress('event-a')).toBe(true);
  });

  it('should evict expired entries when over maxSize', () => {
    const dedup = new EventDeduplicator(1000, 3);

    // Fill with 3 entries
    dedup.shouldSuppress('a');
    dedup.shouldSuppress('b');
    dedup.shouldSuppress('c');
    expect(dedup.size).toBe(3);

    // Expire them
    jest.advanceTimersByTime(1001);

    // Adding a 4th triggers cleanup of expired entries
    dedup.shouldSuppress('d');
    expect(dedup.size).toBe(1); // only 'd' remains
  });

  it('should evict oldest entries when all are within window (LRU fallback)', () => {
    const dedup = new EventDeduplicator(60_000, 3);

    dedup.shouldSuppress('a');
    jest.advanceTimersByTime(10);
    dedup.shouldSuppress('b');
    jest.advanceTimersByTime(10);
    dedup.shouldSuppress('c');
    jest.advanceTimersByTime(10);

    // 4th entry exceeds maxSize, all within window — LRU evicts oldest
    dedup.shouldSuppress('d');
    expect(dedup.size).toBe(3); // capped at maxSize

    // 'a' was oldest, should have been evicted — no longer suppressed
    expect(dedup.shouldSuppress('a')).toBe(false);
  });

  it('should clear all entries', () => {
    const dedup = new EventDeduplicator(60_000);
    dedup.shouldSuppress('a');
    dedup.shouldSuppress('b');
    expect(dedup.size).toBe(2);

    dedup.clear();
    expect(dedup.size).toBe(0);

    // Previously suppressed events should now pass
    expect(dedup.shouldSuppress('a')).toBe(false);
  });
});
