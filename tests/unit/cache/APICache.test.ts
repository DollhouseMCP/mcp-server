import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { APICache } from '../../../src/cache/APICache.js';

describe('APICache', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns cached values until TTL expires', () => {
    jest.useFakeTimers();

    const cache = new APICache({ ttlMs: 50 });
    const payload = { ok: true };

    cache.set('key', payload);

    expect(cache.get('key')).toEqual(payload);

    jest.advanceTimersByTime(60);

    expect(cache.get('key')).toBeNull();
  });

  it('evicts least recently used entries when max size is exceeded', () => {
    const cache = new APICache({ maxEntries: 2 });

    cache.set('a', 'first');
    cache.set('b', 'second');

    // Access `a` to ensure it is considered recently used
    expect(cache.get('a')).toBe('first');

    cache.set('c', 'third');

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe('first');
    expect(cache.get('c')).toBe('third');
    expect(cache.size()).toBe(2);
  });

  it('clears all entries via clear()', () => {
    const cache = new APICache();
    cache.set('foo', 'bar');

    expect(cache.size()).toBe(1);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get('foo')).toBeNull();
  });
});
