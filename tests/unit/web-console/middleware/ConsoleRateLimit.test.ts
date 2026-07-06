import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import { createConsoleRateLimitMiddleware } from '../../../../src/web-console/middleware/ConsoleRateLimit.js';
import {
  ConsoleCollectionFetchRateLimitDependencyError,
  type ConsoleCollectionFetchRateLimiter,
  type ConsoleCollectionFetchRateLimitResult,
} from '../../../../src/web-console/services/rate-limit/ConsoleCollectionFetchRateLimiter.js';
import type { ConsoleRequest, ConsoleRouteDefinition } from '../../../../src/web-console/platform/ConsolePlatformTypes.js';

const RESET_AT = new Date('2026-07-03T12:01:00.000Z');
const TEST_IP = '198.51.100.7';

function collectionRoute(rateLimit?: ConsoleRouteDefinition['rateLimit']): ConsoleRouteDefinition {
  return {
    method: 'GET',
    path: '/api/v1/collection/elements',
    audience: 'self',
    requiredCapability: 'console:self',
    ownership: 'authenticated_user',
    elevation: 'none',
    privacyClass: 'public_catalog',
    idempotency: 'not_applicable',
    rateLimit,
    handler: () => ({ status: 200 }),
  };
}

function consoleRequest(): ConsoleRequest {
  return {
    ip: TEST_IP,
    params: {},
    query: {},
    headers: {},
    consoleContext: {
      correlationId: '3e0a4c1e-6f5b-4a52-9d5f-59a1c1de0b11',
      receivedAt: new Date('2026-07-03T12:00:00.000Z'),
    },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      authSub: 'github_user-7',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
  } as unknown as ConsoleRequest;
}

interface FakeResponse extends Response {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly jsonBody: unknown;
}

function fakeResponse(): FakeResponse {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    jsonBody: undefined as unknown,
    headersSent: false,
  };
  const res = {
    get statusCode() { return state.statusCode; },
    get headers() { return state.headers; },
    get jsonBody() { return state.jsonBody; },
    get headersSent() { return state.headersSent; },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    type() { return res; },
    json(body: unknown) {
      state.jsonBody = body;
      state.headersSent = true;
      return res;
    },
  };
  return res as unknown as FakeResponse;
}

function limiterReturning(result: ConsoleCollectionFetchRateLimitResult): ConsoleCollectionFetchRateLimiter {
  return { consume: () => Promise.resolve(result) } as unknown as ConsoleCollectionFetchRateLimiter;
}

async function run(
  middleware: ReturnType<typeof createConsoleRateLimitMiddleware>,
  req: ConsoleRequest,
  res: FakeResponse,
): Promise<{ nextError: unknown; nextCalled: boolean }> {
  return await new Promise(resolve => {
    let settled = false;
    const finish = (value: { nextError: unknown; nextCalled: boolean }) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const originalJson = res.json.bind(res);
    (res as { json: (body: unknown) => unknown }).json = (body: unknown) => {
      const out = originalJson(body);
      queueMicrotask(() => finish({ nextError: undefined, nextCalled: false }));
      return out;
    };
    middleware(req, res, (error?: unknown) => finish({ nextError: error, nextCalled: true }));
  });
}

describe('createConsoleRateLimitMiddleware (collection_fetch)', () => {
  it('passes allowed requests through to next()', async () => {
    const middleware = createConsoleRateLimitMiddleware(collectionRoute('collection_fetch'), {
      collectionFetchRateLimiter: limiterReturning({
        allowed: true,
        windowResetsAt: RESET_AT,
        retryAfterSeconds: null,
        exceededScopes: [],
      }),
    });
    const outcome = await run(middleware, consoleRequest(), fakeResponse());
    expect(outcome.nextCalled).toBe(true);
    expect(outcome.nextError).toBeUndefined();
  });

  it('sends 429 with Retry-After when the budget is exceeded', async () => {
    const middleware = createConsoleRateLimitMiddleware(collectionRoute('collection_fetch'), {
      collectionFetchRateLimiter: limiterReturning({
        allowed: false,
        windowResetsAt: RESET_AT,
        retryAfterSeconds: 42,
        exceededScopes: ['session'],
      }),
    });
    const res = fakeResponse();
    const outcome = await run(middleware, consoleRequest(), res);
    expect(outcome.nextCalled).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('42');
    expect(res.jsonBody).toMatchObject({
      code: 'rate_limited',
      exceeded_scopes: ['session'],
    });
  });

  it('sends 503 when the rate-limit store is unavailable', async () => {
    const failingLimiter = {
      consume: () => Promise.reject(new ConsoleCollectionFetchRateLimitDependencyError('store offline')),
    } as unknown as ConsoleCollectionFetchRateLimiter;
    const middleware = createConsoleRateLimitMiddleware(collectionRoute('collection_fetch'), {
      collectionFetchRateLimiter: failingLimiter,
    });
    const res = fakeResponse();
    const outcome = await run(middleware, consoleRequest(), res);
    expect(outcome.nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toMatchObject({ code: 'service_unavailable' });
  });

  it('fails at construction when the limiter is missing', () => {
    expect(() => createConsoleRateLimitMiddleware(collectionRoute('collection_fetch'), {}))
      .toThrow(/collection fetch rate limiter/);
  });

  it('is a no-op for routes without a rate-limit policy', () => {
    const middleware = createConsoleRateLimitMiddleware(collectionRoute(), {});
    const next = jest.fn();
    middleware(consoleRequest(), fakeResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
