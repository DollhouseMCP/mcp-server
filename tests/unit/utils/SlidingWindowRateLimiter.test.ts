/**
 * Regression tests for the extracted SlidingWindowRateLimiter utility.
 * Previously duplicated in 3 files; now shared from src/utils/.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SlidingWindowRateLimiter } from '../../../src/utils/SlidingWindowRateLimiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should allow requests up to maxRequests', () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should reject request at maxRequests + 1', () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should evict old timestamps after window expires', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);

    // Advance past the window
    jest.advanceTimersByTime(1001);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should not evict timestamps within the window', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    limiter.tryAcquire();
    limiter.tryAcquire();

    // Advance but stay within window
    jest.advanceTimersByTime(500);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should handle single-request limit', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1000);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    jest.advanceTimersByTime(1001);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should allow full capacity again after window resets', () => {
    const limiter = new SlidingWindowRateLimiter(3, 1000);
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);

    jest.advanceTimersByTime(1001);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });
});
