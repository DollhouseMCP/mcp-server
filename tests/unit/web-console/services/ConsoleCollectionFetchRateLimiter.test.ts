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
const DEPLOYMENT_LIMIT = 300;
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

  it('does not charge the shared deployment budget for session-rejected requests', async () => {
    const limiter = createLimiter(() => START);
    // A single session floods far past the deployment limit. Only its first 30
    // are allowed; the rest are session-rejected and must NOT reach GitHub, so
    // they must not consume the deployment budget.
    for (let i = 0; i < DEPLOYMENT_LIMIT + 50; i++) {
      const result = await limiter.consume({ consoleSessionIdHash: sessionHash(1), ip: TEST_IP });
      if (i >= SESSION_LIMIT) {
        expect(result.exceededScopes).toEqual(['session']);
      }
    }
    // A different session must still be served — the deployment budget was only
    // charged for this session's 30 allowed requests, nowhere near 300.
    const otherSession = await limiter.consume({ consoleSessionIdHash: sessionHash(9), ip: TEST_IP });
    expect(otherSession.allowed).toBe(true);
    expect(otherSession.exceededScopes).toEqual([]);
  });

  it('trips the deployment scope when allowed requests across sessions exceed the budget', async () => {
    const limiter = createLimiter(() => START);
    // Spread allowed requests across many sessions so no single session budget
    // trips; the shared deployment budget must still cap the aggregate.
    let denied: Awaited<ReturnType<typeof limiter.consume>> | null = null;
    for (let session = 0; session < DEPLOYMENT_LIMIT + 5 && !denied; session++) {
      const result = await limiter.consume({ consoleSessionIdHash: sessionHash(session % 200), ip: TEST_IP });
      if (!result.allowed) denied = result;
    }
    // With distinct sessions each spending 1, the deployment budget (300) trips
    // before any per-session budget (30) does.
    expect(denied).not.toBeNull();
    expect(denied?.exceededScopes).toEqual(['deployment']);
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
