import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { normalizeIp } from './rateLimit.js';
import type { IRateLimitStore } from './storage/IRateLimitStore.js';

const TOKEN_RATE_LIMIT_SCOPE = 'oauth-token-endpoint';
const TOKEN_RATE_LIMIT_WINDOW_MS = 60_000;
const TOKEN_RATE_LIMIT_MAX_REQUESTS = 120;

interface TokenRateLimitState {
  readonly count: number;
  readonly windowStartedAt: number;
}

interface TokenRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

export function createTokenEndpointRateLimitMiddleware(
  store: IRateLimitStore,
  now: () => number = Date.now,
): RequestHandler {
  return (req, res, next) => {
    void enforceTokenEndpointRateLimit(store, req, res, next, now);
  };
}

async function enforceTokenEndpointRateLimit(
  store: IRateLimitStore,
  req: Request,
  res: Response,
  next: NextFunction,
  now: () => number,
): Promise<void> {
  try {
    const currentTime = now();
    const key = normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const update = await store.update<TokenRateLimitState, TokenRateLimitDecision>(
      TOKEN_RATE_LIMIT_SCOPE,
      key,
      previous => decideTokenEndpointRateLimit(previous, currentTime),
      {
        expiresAt: currentTime + TOKEN_RATE_LIMIT_WINDOW_MS * 2,
        maxRetries: 5,
      },
    );
    const decision = update.result ?? { allowed: false };
    if (decision.allowed) {
      next();
      return;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({
      error: 'slow_down',
      error_description: 'Too many token endpoint requests',
    });
  } catch (error) {
    next(error);
  }
}

function decideTokenEndpointRateLimit(
  previous: TokenRateLimitState | null,
  now: number,
): { state: TokenRateLimitState; result: TokenRateLimitDecision } {
  if (!previous || now - previous.windowStartedAt >= TOKEN_RATE_LIMIT_WINDOW_MS) {
    return {
      state: { count: 1, windowStartedAt: now },
      result: { allowed: true },
    };
  }
  const retryAfterMs = Math.max(1, TOKEN_RATE_LIMIT_WINDOW_MS - (now - previous.windowStartedAt));
  if (previous.count >= TOKEN_RATE_LIMIT_MAX_REQUESTS) {
    return {
      state: previous,
      result: { allowed: false, retryAfterMs },
    };
  }
  return {
    state: { ...previous, count: previous.count + 1 },
    result: { allowed: true },
  };
}
