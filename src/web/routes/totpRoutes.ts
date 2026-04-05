/**
 * TOTP (authenticator) enrollment HTTP routes — Phase 2 of #1780 (#1794).
 *
 * Provides:
 * - GET    /api/console/totp/status        — enrollment state (no secrets)
 * - POST   /api/console/totp/enroll/begin  — generate secret, return QR + otpauth URI
 * - POST   /api/console/totp/enroll/confirm — verify code, persist, return backup codes (once)
 * - POST   /api/console/totp/disable       — verify code, clear enrollment
 *
 * Security model:
 * - All endpoints require a valid existing console token. The caller must
 *   prove they already hold the token before they can enroll a second
 *   factor — otherwise an attacker with local port access could pre-enroll
 *   their own authenticator and lock the legitimate user out.
 * - Enforcement happens via an always-on `createAuthMiddleware` instance
 *   mounted at the top of this router, independent of the global
 *   DOLLHOUSE_WEB_AUTH_ENABLED flag.
 * - Backup codes are returned in plaintext exactly once (confirm response)
 *   and only their sha256 hashes are retained by the store.
 * - A sliding-window rate limit throttles confirm/disable attempts on a
 *   per-IP basis so a bad actor with a live session can't brute-force a
 *   TOTP window by flooding requests.
 *
 * @since v2.1.0 — Issue #1794
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import QRCode from 'qrcode';
import type { ConsoleTokenStore } from '../console/consoleToken.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';

/** JSON body size limit — TOTP requests are tiny, cap hard. */
const BODY_LIMIT = '1kb';

/**
 * Default rate limit for code-verification endpoints: 10 attempts per minute.
 * TOTP codes are 6 digits (1-in-10^6 guess rate) and the ±30s window gives
 * an attacker up to 3 valid codes per minute. 10 attempts caps brute-force
 * success probability per minute at ~3e-5 even before network latency.
 *
 * The limiter is global (not per-IP) because the server binds to 127.0.0.1
 * only — every request comes from the same loopback address, so keying on
 * IP would collapse to a single bucket anyway.
 *
 * Tests construct a fresh router per `buildApp`, which yields a fresh
 * limiter, so no cross-test pollution.
 */
const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Safely extract a string field from an unknown request body and NFC-normalize
 * it (DMCP-SEC-004). Returns null if the body is not an object or the field
 * is missing / not a string. Normalization blocks homograph, bidi, and
 * zero-width abuse before the value reaches downstream parsers (TOTP codes,
 * otpauth URI labels, pending-id lookups).
 */
function getNormalizedStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const val = (body as Record<string, unknown>)[field];
  if (typeof val !== 'string') return null;
  return UnicodeValidator.normalize(val).normalizedContent;
}

/**
 * Render an otpauth URI as an SVG data URL suitable for direct embedding
 * in an <img src> or background-image. Separated into a helper so the
 * request handler stays readable.
 */
async function renderQrDataUrl(otpauthUri: string): Promise<string> {
  // errorCorrectionLevel 'M' is the default and balances size vs robustness.
  // We emit SVG (not PNG) because it scales to any container size and is
  // smaller on the wire for this particular payload.
  const svg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1 });
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Options for the TOTP routes factory.
 */
export interface TotpRoutesOptions {
  store: ConsoleTokenStore;
  /** Maximum code-verification attempts per window. Default: 10. */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds. Default: 60_000 (1 minute). */
  rateLimitWindowMs?: number;
}

/**
 * Build the Express router exposing TOTP endpoints. The returned router
 * should be mounted at `/api/console/totp`; the caller does not need to
 * add additional auth middleware — this router enforces its own auth
 * regardless of the global feature flag.
 */
export function createTotpRoutes(options: TotpRoutesOptions): Router {
  const { store } = options;
  const router = Router();
  const jsonParser = express.json({ limit: BODY_LIMIT, type: 'application/json' });
  // Fresh limiter per router instance — keeps tests isolated and lets
  // different mount points have independent budgets if we ever mount twice.
  const confirmLimiter = new SlidingWindowRateLimiter(
    options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  // Always-on auth — the global feature flag does not apply here. Even
  // during Phase 1 rollout (flag off), the TOTP endpoints must verify that
  // the caller already holds the console token before letting them enroll
  // a second factor. Otherwise an attacker with local port access could
  // enroll their own authenticator and lock the real user out.
  const auth = createAuthMiddleware({
    store,
    enabled: true,
    label: 'totp',
  });
  router.use(auth);

  /** GET /status — enrollment state (no secret material). */
  router.get('/status', (_req: Request, res: Response) => {
    res.json(store.getTotpStatus());
  });

  /** POST /enroll/begin — generate pending secret, return QR + URI. */
  router.post('/enroll/begin', jsonParser, async (req: Request, res: Response) => {
    // Optional label override — lets the UI label the authenticator entry
    // differently if the user has renamed the console token.
    const label = getNormalizedStringField(req.body, 'label') ?? undefined;
    try {
      const begin = store.beginTotpEnrollment(label);
      const qrSvgDataUrl = await renderQrDataUrl(begin.otpauthUri);
      res.json({
        pendingId: begin.pendingId,
        secret: begin.secret,
        otpauthUri: begin.otpauthUri,
        qrSvgDataUrl,
        expiresAt: begin.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Enrollment could not be started';
      logger.debug(`[TOTP] begin failed: ${message}`);
      res.status(409).json({ error: message });
    }
  });

  /** POST /enroll/confirm — verify code, persist, return backup codes (once). */
  router.post('/enroll/confirm', jsonParser, async (req: Request, res: Response) => {
    if (!confirmLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many confirmation attempts — slow down' });
      return;
    }
    const pendingId = getNormalizedStringField(req.body, 'pendingId');
    const code = getNormalizedStringField(req.body, 'code');
    if (!pendingId || !code) {
      res.status(400).json({ error: 'pendingId and code are required' });
      return;
    }
    try {
      const result = await store.confirmTotpEnrollment(pendingId, code);
      res.json({
        enrolled: true,
        enrolledAt: result.enrolledAt,
        backupCodes: result.backupCodes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Confirmation failed';
      logger.debug(`[TOTP] confirm failed: ${message}`);
      res.status(400).json({ error: message });
    }
  });

  /** POST /disable — verify code, clear enrollment. */
  router.post('/disable', jsonParser, async (req: Request, res: Response) => {
    if (!confirmLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many disable attempts — slow down' });
      return;
    }
    const code = getNormalizedStringField(req.body, 'code');
    if (!code) {
      res.status(400).json({ error: 'code is required' });
      return;
    }
    try {
      await store.disableTotp(code);
      res.json({ enrolled: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Disable failed';
      logger.debug(`[TOTP] disable failed: ${message}`);
      res.status(400).json({ error: message });
    }
  });

  return router;
}
