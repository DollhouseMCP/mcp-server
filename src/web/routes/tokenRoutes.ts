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
import { TotpError, type ConsoleTokenStore } from '../console/consoleToken.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { httpStatusForStoreError, sendStoreError, getNormalizedStringField } from './consoleRouteHelpers.js';
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

  /** GET /info — token metadata + TOTP status for the Security tab UI (#1791). */
  router.get('/info', (_req: Request, res: Response) => {
    const masked = store.listMasked();
    const totpStatus = store.getTotpStatus();
    res.json({
      tokens: masked,
      totp: totpStatus,
      filePath: store.getFilePath(),
    });
  });

  /** POST /rotate — rotate the primary console token with TOTP confirmation. */
  router.post('/rotate', jsonParser, async (req: Request, res: Response) => {
    if (!rotateLimiter.tryAcquire()) {
      sendStoreError(res, 429, 'RATE_LIMITED', 'Too many rotation attempts — slow down');
      return;
    }
    const confirmationCode = getNormalizedStringField(req.body, 'confirmationCode');
    if (!confirmationCode) {
      sendStoreError(res, 400, 'MISSING_FIELDS', 'confirmationCode is required');
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
        sendStoreError(res, httpStatusForStoreError(err.code), err.code, err.message);
      } else {
        sendStoreError(res, 500, 'INTERNAL', message);
      }
    }
  });

  return router;
}
