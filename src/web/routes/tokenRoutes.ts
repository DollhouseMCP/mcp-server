/**
 * Console token management HTTP routes — #1795.
 *
 * Provides:
 * - POST /api/console/token/rotate — rotate the primary token with TOTP confirmation
 *
 * Security model:
 * - All endpoints require a valid existing console token. Enforcement
 *   happens via an always-on `createAuthMiddleware` instance mounted at the
 *   top of this router, independent of `DOLLHOUSE_WEB_AUTH_ENABLED`.
 * - Rotation additionally requires TOTP confirmation (Pattern B). Pattern A
 *   (OS dialog fallback) is deferred to a follow-up issue.
 * - A sliding-window rate limit throttles rotation attempts so a bad actor
 *   with a live session can't brute-force TOTP codes by flooding rotations.
 *
 * @since v2.1.0 — Issue #1795
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { TotpError, type ConsoleTokenStore, type TotpErrorCode } from '../console/consoleToken.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';

/** JSON body size limit — rotation requests are tiny. */
const BODY_LIMIT = '1kb';

/**
 * Rate limit for the rotation endpoint: 10 attempts per minute.
 * Same rationale as the TOTP enrollment confirm limiter — brute-force
 * success probability stays well below 5e-5/min.
 */
const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Maps a store error code to an HTTP status. Replicates the pattern from
 * totpRoutes.ts so both route files return consistent status codes for the
 * same failure class.
 */
function httpStatusForTokenError(code: TotpErrorCode): number {
  switch (code) {
    case 'ALREADY_ENROLLED':
      return 409;
    case 'NOT_ENROLLED':
    case 'PENDING_NOT_FOUND':
    case 'INVALID_TOTP_CODE':
      return 400;
    case 'TOO_MANY_PENDING':
      return 429;
    case 'TOTP_REQUIRED':
      return 403;
    case 'STORE_NOT_INITIALIZED':
      return 503;
    default: {
      code satisfies never;
      return 400;
    }
  }
}

/**
 * Send a structured error response with both a human-readable message and
 * a machine-readable code. Same shape as the TOTP routes.
 */
function sendTokenError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: message, code });
}

/**
 * Safely extract a string field from an unknown request body and NFC-normalize
 * it (DMCP-SEC-004). Returns null if the body is not an object or the field
 * is missing / not a string.
 */
function getNormalizedStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const val = (body as Record<string, unknown>)[field];
  if (typeof val !== 'string') return null;
  return UnicodeValidator.normalize(val).normalizedContent;
}

/**
 * Options for the token routes factory.
 */
export interface TokenRoutesOptions {
  store: ConsoleTokenStore;
  /** Maximum rotation attempts per window. Default: 10. */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds. Default: 60_000 (1 minute). */
  rateLimitWindowMs?: number;
}

/**
 * Build the Express router exposing token management endpoints. The returned
 * router should be mounted at `/api/console/token`; the caller does not need
 * to add additional auth middleware — this router enforces its own auth
 * regardless of the global feature flag.
 */
export function createTokenRoutes(options: TokenRoutesOptions): Router {
  const { store } = options;
  const router = Router();
  const jsonParser = express.json({ limit: BODY_LIMIT, type: 'application/json' });
  const rateLimitMax = options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const rotateLimiter = new SlidingWindowRateLimiter(rateLimitMax, rateLimitWindowMs);

  // Always-on auth — same pattern as the TOTP router.
  const auth = createAuthMiddleware({
    store,
    enabled: true,
    label: 'token',
  });
  router.use(auth);

  /** POST /rotate — rotate the primary console token with TOTP confirmation. */
  router.post('/rotate', jsonParser, async (req: Request, res: Response) => {
    if (!rotateLimiter.tryAcquire()) {
      sendTokenError(res, 429, 'RATE_LIMITED', 'Too many rotation attempts — slow down');
      return;
    }
    const confirmationCode = getNormalizedStringField(req.body, 'confirmationCode');
    if (!confirmationCode) {
      sendTokenError(res, 400, 'MISSING_FIELDS', 'confirmationCode is required');
      return;
    }
    try {
      const result = await store.rotatePrimary(confirmationCode);
      res.json({
        token: result.token,
        rotatedAt: result.rotatedAt,
        graceUntil: result.graceUntil,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rotation failed';
      logger.debug(`[Token] rotate failed: ${message}`);
      if (err instanceof TotpError) {
        sendTokenError(res, httpStatusForTokenError(err.code), err.code, err.message);
      } else {
        sendTokenError(res, 500, 'INTERNAL', message);
      }
    }
  });

  return router;
}
