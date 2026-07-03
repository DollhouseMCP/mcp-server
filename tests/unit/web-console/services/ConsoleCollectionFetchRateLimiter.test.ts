import { describe, expect, it, jest } from '@jest/globals';

import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import type { IRateLimitStore } from '../../../../src/auth/embedded-as/storage/IRateLimitStore.js';
import {
  ConsoleCollectionFetchRateLimitDependencyError,
  ConsoleCollectionFetchRateLimiter,
} from '../../../../src/web-console/services/rate-limit/ConsoleCollectionFetchRateLimiter.js';

jest.mock('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn(),
  },
}));

const SESSION_LIMIT = 30;
const KEY = Buffer.alloc(32, 1);
const TEST_IP = '198.51.100.7';
// InMemoryRateLimitStore expires entries against the REAL clock, so the
// injected test clock must be anchored to Date.now() or every write is
// already expired on the next read.
const START = new Date(Date.now());

function sessionHash(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

function createLimiter(now: () => Date, store: IRateLimitStore = new InMemoryRateLimitStore()) {
  return new ConsoleCollectionFetchRateLimiter({ store, selectorHmacKey: KEY, now });
}

describe('ConsoleCollectionFetchRateLimiter', () => {
  it('allows requests under the session budget', async () => {
    const limiter = createLimiter(() => START);
    for (let i = 0; i < SESSION_LIMIT; i++) {
      const result = await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBeNull();
    }
  });

  it('denies the request past the session budget with a Retry-After hint', async () => {
    const limiter = createLimiter(() => START);
    for (let i = 0; i < SESSION_LIMIT; i++) {
      await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
    }
    const denied = await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
    expect(denied.allowed).toBe(false);
    expect(denied.exceededScopes).toEqual(['session']);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('isolates budgets per session', async () => {
    const limiter = createLimiter(() => START);
    for (let i = 0; i <= SESSION_LIMIT; i++) {
      await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
    }
    const otherSession = await limiter.consume({ consoleSessionIdHash: sessionHash(2), ip: TEST_IP });
    expect(otherSession.allowed).toBe(true);
  });

  it('resets the budget after the window elapses', async () => {
    let now = START;
    const limiter = createLimiter(() => now);
    for (let i = 0; i <= SESSION_LIMIT; i++) {
      await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
    }
    now = new Date(START.getTime() + 61_000);
    const afterWindow = await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
    expect(afterWindow.allowed).toBe(true);
  });

  it('wraps store failures in a dependency error', async () => {
    const failingStore: IRateLimitStore = {
      update: () => Promise.reject(new Error('store offline')),
    } as unknown as IRateLimitStore;
    const limiter = createLimiter(() => START, failingStore);
    await expect(
      limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP }),
    ).rejects.toThrow(ConsoleCollectionFetchRateLimitDependencyError);
  });

  it('rejects a malformed session hash', async () => {
    const limiter = createLimiter(() => START);
    await expect(
      limiter.consume({ consoleSessionIdHash: Buffer.alloc(8, 1), ip: TEST_IP }),
    ).rejects.toThrow(/consoleSessionIdHash/);
  });
});
