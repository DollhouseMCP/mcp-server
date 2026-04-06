/**
 * Shared helpers for console auth route handlers (TOTP + token management).
 *
 * Extracted to eliminate duplication between totpRoutes.ts and tokenRoutes.ts.
 * Both routers need the same error-mapping, structured-error-response, and
 * body-field-extraction logic.
 *
 * @since v2.1.0 — Issue #1795
 */

import type { Response } from 'express';
import type { TotpErrorCode } from '../console/consoleToken.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

/**
 * Maps a store error code to the appropriate HTTP status.
 * Centralized so all console auth endpoints return consistent status codes
 * for the same failure class. The `satisfies never` exhaustiveness check
 * ensures new TotpErrorCode values get mapped at compile time.
 */
export function httpStatusForStoreError(code: TotpErrorCode): number {
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
 * a machine-readable code. Shape is stable so the CLI and Security tab UI
 * can branch on `code` instead of string-matching the message.
 */
export function sendStoreError(
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
 * is missing / not a string. Normalization blocks homograph, bidi, and
 * zero-width abuse before the value reaches downstream parsers (TOTP codes,
 * otpauth URI labels, pending-id lookups).
 */
export function getNormalizedStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const val = (body as Record<string, unknown>)[field];
  if (typeof val !== 'string') return null;
  return UnicodeValidator.normalize(val).normalizedContent;
}
