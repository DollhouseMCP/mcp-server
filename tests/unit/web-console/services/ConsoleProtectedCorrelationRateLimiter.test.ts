import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import type {
  IRateLimitStore,
  RateLimitEntry,
  RateLimitUpdate,
  RateLimitUpdateOptions,
} from '../../../../src/auth/embedded-as/storage/IRateLimitStore.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  ConsoleProtectedCorrelationRateLimitDependencyError,
  ConsoleProtectedCorrelationRateLimiter,
} from '../../../../src/web-console/services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';
import { ConsoleStoreValidationError } from '../../../../src/web-console/stores/ConsoleStoreValidation.js';

const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const NOW = new Date('2026-05-27T16:00:00.000Z');
const ONE_HOUR_LATER = new Date('2026-05-27T17:00:00.000Z');
const DEFAULT_TEST_IP = `${['', '', 'ffff'].join(':')}:${['203', '0', '113', '10'].join('.')}`;

class PrimedRateLimitStore implements IRateLimitStore {
  constructor(private readonly states: Record<string, unknown>) {}

  async get<TState>(): Promise<RateLimitEntry<TState> | null> {
    await Promise.resolve();
    return null;
  }

  async update<TState, TResult = void>(
    scope: string,
    _key: string,
    compute: (prev: TState | null) => RateLimitUpdate<TState, TResult>,
    _options: RateLimitUpdateOptions = {},
  ): Promise<RateLimitUpdate<TState, TResult>> {
    await Promise.resolve();
    return compute((this.states[scope] as TState | undefined) ?? null);
  }

  async reset(): Promise<void> {
    await Promise.resolve();
  }

  async sweep(): Promise<void> {
    await Promise.resolve();
  }
}

function limiter(store = new InMemoryRateLimitStore(), now = NOW): ConsoleProtectedCorrelationRateLimiter {
  return new ConsoleProtectedCorrelationRateLimiter({
    store,
    selectorHmacKey: Buffer.alloc(32, 3),
    now: () => now,
  });
}

function input(overrides: Partial<Parameters<ConsoleProtectedCorrelationRateLimiter['consume']>[0]> = {}) {
  return {
    consoleSessionIdHash: Buffer.alloc(32, 7),
    ip: DEFAULT_TEST_IP,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  SecurityMonitor.clearAllEventsForTesting();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ConsoleProtectedCorrelationRateLimiter', () => {
  it('allows requests while consuming session, IP, and deployment budgets', async () => {
    const service = limiter();

    const result = await service.consume(input());

    expect(result).toEqual({
      allowed: true,
      attemptsRemaining: 29,
      windowResetsAt: ONE_HOUR_LATER,
      retryAfterSeconds: null,
      exceededScopes: [],
    });
  });

  it('exhausts the per-session protected correlation budget independently', async () => {
    const service = limiter();
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(service.consume(input({ ip: `198.51.100.${attempt + 1}` })))
        .resolves.toMatchObject({ allowed: true });
    }

    await expect(service.consume(input({ ip: '198.51.100.31' }))).resolves.toMatchObject({
      allowed: false,
      attemptsRemaining: 0,
      retryAfterSeconds: 3600,
      exceededScopes: ['session'],
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exhausts the per-IP protected correlation budget independently', async () => {
    const service = limiter();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(service.consume(input({ consoleSessionIdHash: Buffer.alloc(32, attempt + 1) })))
        .resolves.toMatchObject({ allowed: true });
    }

    await expect(service.consume(input({ consoleSessionIdHash: Buffer.alloc(32, 31) }))).resolves.toMatchObject({
      allowed: false,
      attemptsRemaining: 0,
      retryAfterSeconds: 3600,
      exceededScopes: ['ip'],
    });
  });

  it('uses keyed selectors instead of raw session hashes, IPs, or correlation IDs in the store', async () => {
    const store = new InMemoryRateLimitStore();
    const updateSpy = jest.spyOn(store, 'update');
    const service = limiter(store);

    await service.consume(input());

    const keys = updateSpy.mock.calls.map(call => call[1]);
    expect(keys).toHaveLength(3);
    expect(keys).not.toContain(Buffer.alloc(32, 7).toString('hex'));
    expect(keys).not.toContain('203.0.113.10');
    expect(keys).not.toContain(ACCOUNT_CORRELATION_ID);
    expect(new Set(keys).size).toBe(3);
  });

  it('uses deterministic keyed selectors for identical input', async () => {
    const store = new InMemoryRateLimitStore();
    const updateSpy = jest.spyOn(store, 'update');
    const service = limiter(store);

    await service.consume(input());
    const firstKeys = updateSpy.mock.calls.map(call => call[1]);
    updateSpy.mockClear();
    await service.consume(input());

    expect(updateSpy.mock.calls.map(call => call[1])).toEqual(firstKeys);
  });

  it('shares the deployment-wide budget and emits a security event on aggregate exhaustion', async () => {
    const store = new InMemoryRateLimitStore();
    const service = limiter(store);
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

    for (let attempt = 0; attempt < 200; attempt += 1) {
      await service.consume(input({
        consoleSessionIdHash: Buffer.alloc(32, attempt + 1),
        ip: `198.51.100.${attempt + 1}`,
      }));
    }

    const result = await service.consume(input({
      consoleSessionIdHash: Buffer.alloc(32, 250),
      ip: '198.51.100.250',
    }));

    expect(result.allowed).toBe(false);
    expect(result.exceededScopes).toEqual(['deployment']);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RATE_LIMIT_EXCEEDED',
      severity: 'HIGH',
      source: 'web-console',
      additionalData: expect.objectContaining({
        policy: 'protected_correlation_resolution',
        exceededScopes: ['deployment'],
      }),
    }));
    expect(logSpy.mock.calls[0]?.[0].additionalData?.accountCorrelationSelector)
      .not.toBe(ACCOUNT_CORRELATION_ID);
  });

  it('resets the fixed window after the hourly boundary', async () => {
    const store = new InMemoryRateLimitStore();
    const service = new ConsoleProtectedCorrelationRateLimiter({
      store,
      selectorHmacKey: Buffer.alloc(32, 3),
      now: jest.fn()
        .mockReturnValueOnce(NOW)
        .mockReturnValueOnce(new Date('2026-05-27T17:00:01.000Z')) as () => Date,
    });

    await service.consume(input());

    await expect(service.consume(input())).resolves.toMatchObject({
      allowed: true,
      attemptsRemaining: 29,
      windowResetsAt: new Date('2026-05-27T18:00:01.000Z'),
    });
  });

  it('reports min remaining attempts and latest reset across uneven budgets', async () => {
    const store = new PrimedRateLimitStore({
      'console:admin:accounts:correlation-resolution:session': {
        windowStartedAt: new Date('2026-05-27T15:40:00.000Z').getTime(),
        attempts: 5,
      },
      'console:admin:accounts:correlation-resolution:ip': {
        windowStartedAt: new Date('2026-05-27T15:30:00.000Z').getTime(),
        attempts: 29,
      },
      'console:admin:accounts:correlation-resolution:deployment': {
        windowStartedAt: new Date('2026-05-27T15:50:00.000Z').getTime(),
        attempts: 10,
      },
    });

    await expect(limiter(store).consume(input())).resolves.toMatchObject({
      allowed: true,
      attemptsRemaining: 0,
      windowResetsAt: new Date('2026-05-27T16:50:00.000Z'),
      retryAfterSeconds: null,
      exceededScopes: [],
    });
  });

  it('reports multiple exceeded scopes with max retry guidance', async () => {
    const store = new PrimedRateLimitStore({
      'console:admin:accounts:correlation-resolution:session': {
        windowStartedAt: new Date('2026-05-27T15:20:00.000Z').getTime(),
        attempts: 30,
      },
      'console:admin:accounts:correlation-resolution:ip': {
        windowStartedAt: new Date('2026-05-27T15:40:00.000Z').getTime(),
        attempts: 30,
      },
      'console:admin:accounts:correlation-resolution:deployment': {
        windowStartedAt: new Date('2026-05-27T15:50:00.000Z').getTime(),
        attempts: 10,
      },
    });

    await expect(limiter(store).consume(input())).resolves.toMatchObject({
      allowed: false,
      attemptsRemaining: 0,
      windowResetsAt: new Date('2026-05-27T16:50:00.000Z'),
      retryAfterSeconds: 2400,
      exceededScopes: ['session', 'ip'],
    });
  });

  it('collapses null and empty IP values into one unknown bucket', async () => {
    const service = limiter();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(service.consume(input({
        consoleSessionIdHash: Buffer.alloc(32, attempt + 1),
        ip: attempt % 2 === 0 ? null : '',
      }))).resolves.toMatchObject({ allowed: true });
    }

    await expect(service.consume(input({
      consoleSessionIdHash: Buffer.alloc(32, 31),
      ip: '   ',
    }))).resolves.toMatchObject({
      allowed: false,
      exceededScopes: ['ip'],
    });
  });

  it('validates trust-boundary inputs', async () => {
    expect(() => new ConsoleProtectedCorrelationRateLimiter({
      store: new InMemoryRateLimitStore(),
      selectorHmacKey: Buffer.alloc(16, 3),
    })).toThrow(ConsoleStoreValidationError);

    await expect(limiter().consume(input({ consoleSessionIdHash: Buffer.alloc(31, 7) })))
      .rejects.toThrow('consoleSessionIdHash must be a 32-byte keyed hash');
    await expect(limiter().consume(input({ accountCorrelationId: 'alice' })))
      .rejects.toThrow('accountCorrelationId must be a UUID');
  });

  it('fails closed when the shared rate-limit store is unavailable', async () => {
    const store = {
      get: jest.fn(),
      update: jest.fn(() => Promise.reject(new Error('store down'))),
      reset: jest.fn(),
      sweep: jest.fn(),
    };
    const service = limiter(store);

    await expect(service.consume(input()))
      .rejects.toThrow(ConsoleProtectedCorrelationRateLimitDependencyError);
  });
});
