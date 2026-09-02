import type { RequestHandler } from 'express';

import type {
  ConsoleProtectedCorrelationRateLimiter,
} from '../services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';
import {
  ConsoleProtectedCorrelationRateLimitDependencyError,
} from '../services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';
import type {
  ConsoleCollectionFetchRateLimiter,
} from '../services/rate-limit/ConsoleCollectionFetchRateLimiter.js';
import {
  ConsoleCollectionFetchRateLimitDependencyError,
} from '../services/rate-limit/ConsoleCollectionFetchRateLimiter.js';
import { requireConsoleAuthentication } from './ConsoleAuthentication.js';
import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type { ConsoleRateLimitPolicy, ConsoleRequest, ConsoleRouteDefinition } from '../platform/ConsolePlatformTypes.js';

export interface ConsoleRateLimitOptions {
  readonly protectedCorrelationRateLimiter?: ConsoleProtectedCorrelationRateLimiter | null;
  readonly collectionFetchRateLimiter?: ConsoleCollectionFetchRateLimiter | null;
}

export function createConsoleRateLimitMiddleware(
  route: ConsoleRouteDefinition,
  options: ConsoleRateLimitOptions,
): RequestHandler {
  const policy: ConsoleRateLimitPolicy = route.rateLimit ?? 'none';
  if (policy === 'none') return (_request, _response, next): void => next();
  const enforce = resolveEnforcer(policy, options);

  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    void (async (): Promise<void> => {
      try {
        await enforce(req, response);
      } catch (error) {
        if (
          error instanceof ConsoleProtectedCorrelationRateLimitDependencyError ||
          error instanceof ConsoleCollectionFetchRateLimitDependencyError
        ) {
          sendProblemResponse(response, {
            status: 503,
            code: 'service_unavailable',
            title: 'Service unavailable',
            detail: 'The rate-limit policy could not be evaluated.',
          }, requireConsoleRequestContext(req).correlationId);
          return;
        }
        next(error);
        return;
      }
      if (response.headersSent) return;
      next();
    })();
  };
}

type RateLimitEnforcer = (
  req: ConsoleRequest,
  response: Parameters<typeof sendProblemResponse>[0],
) => Promise<void>;

function resolveEnforcer(
  policy: Exclude<ConsoleRateLimitPolicy, 'none'>,
  options: ConsoleRateLimitOptions,
): RateLimitEnforcer {
  if (policy === 'collection_fetch') {
    const limiter = options.collectionFetchRateLimiter;
    if (!limiter) {
      throw new Error('collection_fetch route requires a collection fetch rate limiter');
    }
    return (req, response) => enforceCollectionFetch(req, response, limiter);
  }
  const limiter = options.protectedCorrelationRateLimiter;
  if (!limiter) {
    throw new Error('protected_correlation_resolution route requires a protected correlation rate limiter');
  }
  return (req, response) => enforceProtectedCorrelationResolution(req, response, limiter);
}

async function enforceCollectionFetch(
  req: ConsoleRequest,
  response: Parameters<typeof sendProblemResponse>[0],
  limiter: ConsoleCollectionFetchRateLimiter,
): Promise<void> {
  const authentication = requireConsoleAuthentication(req);
  const result = await limiter.consume({
    consoleSessionIdHash: authentication.sessionIdHash,
    ip: req.ip,
  });
  if (result.allowed) return;

  if (result.retryAfterSeconds !== null) {
    response.setHeader('Retry-After', String(result.retryAfterSeconds));
  }
  sendProblemResponse(response, {
    status: 429,
    code: 'rate_limited',
    title: 'Rate limited',
    detail: 'The collection fetch rate limit was exceeded.',
    extensions: {
      window_resets_at: result.windowResetsAt.toISOString(),
      exceeded_scopes: result.exceededScopes,
    },
  }, requireConsoleRequestContext(req).correlationId);
}

async function enforceProtectedCorrelationResolution(
  req: ConsoleRequest,
  response: Parameters<typeof sendProblemResponse>[0],
  limiter: ConsoleProtectedCorrelationRateLimiter | null | undefined,
): Promise<void> {
  if (!limiter) {
    throw new Error('protected correlation rate limiter is unavailable');
  }
  const accountCorrelationId = req.params.account_correlation_id;
  // Express path params are strings for this route; keep the guard for direct middleware tests or future adapters.
  if (typeof accountCorrelationId !== 'string') {
    sendProblemResponse(response, {
      status: 400,
      code: 'invalid_request',
      title: 'Invalid request',
      detail: 'account_correlation_id path parameter is required.',
    }, requireConsoleRequestContext(req).correlationId);
    return;
  }
  const authentication = requireConsoleAuthentication(req);
  const result = await limiter.consume({
    consoleSessionIdHash: authentication.sessionIdHash,
    ip: req.ip,
    accountCorrelationId,
  });
  if (result.allowed) return;

  if (result.retryAfterSeconds !== null) {
    response.setHeader('Retry-After', String(result.retryAfterSeconds));
  }
  sendProblemResponse(response, {
    status: 429,
    code: 'rate_limited',
    title: 'Rate limited',
    detail: 'The protected account-correlation resolution rate limit was exceeded.',
    extensions: {
      attempts_remaining: result.attemptsRemaining,
      window_resets_at: result.windowResetsAt.toISOString(),
      exceeded_scopes: result.exceededScopes,
    },
  }, requireConsoleRequestContext(req).correlationId);
}
