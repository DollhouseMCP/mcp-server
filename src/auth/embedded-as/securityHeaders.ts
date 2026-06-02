/**
 * securityHeaders
 *
 * Middleware that emits the security headers every response from the embedded
 * AS should carry (must-fix #7 + Phase 7 follow-ups):
 *
 *   - `Content-Security-Policy`
 *     Blocks scripts and object/embed content, limits forms and static assets
 *     to this AS, and rejects all framing. Auth pages use inline CSS today, so
 *     the middleware injects a per-response nonce into `<style>` tags rather
 *     than allowing all inline styles.
 *
 *   - `X-Frame-Options: DENY`
 *     Prevents the consent page (and any future login forms) from being
 *     embedded in an attacker-controlled iframe — which would otherwise allow
 *     clickjacking the "Approve Connector" button.
 *
 *   - `Cache-Control: no-store`
 *     Auth pages MUST NOT be cached by intermediaries or browser back-
 *     button history. Without it, the magic-link confirmation page (which
 *     embeds the single-use token in a hidden form input) lingers in
 *     view-source / disk cache; the trivial-consent confirmation page is
 *     similarly sensitive. Pairs with `Pragma: no-cache` for HTTP/1.0
 *     proxies.
 *
 *   - `Referrer-Policy: no-referrer`
 *     The magic-link GET URL contains the token in `?token=`. Browser
 *     extensions, bookmarklets, and outbound links from the auth page
 *     would otherwise leak the URL via Referer headers. `no-referrer`
 *     suppresses Referer entirely on outbound navigation.
 *
 * Mounted on every route the embedded AS exposes — interaction pages,
 * `/auth/*` callbacks, and oidc-provider's own routes.
 *
 * @module auth/embedded-as/securityHeaders
 */

import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const STYLE_TAG_WITHOUT_NONCE = /<style\b(?![^>]*\bnonce=)([^>]*)>/gi;
const FORM_ACTION_EXTRA_ORIGINS_LOCAL = 'dollhouseCspFormActionExtraOrigins';

interface SecurityHeaderLocals {
  [FORM_ACTION_EXTRA_ORIGINS_LOCAL]?: string[];
}

export function buildContentSecurityPolicy(
  styleNonce: string,
  extraFormActionOrigins: readonly string[] = [],
): string {
  const formActionSources = buildFormActionSources(extraFormActionOrigins);
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `form-action ${formActionSources.join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "script-src 'none'",
    `style-src 'self' 'nonce-${styleNonce}'`,
  ].join('; ');
}

export function allowCspFormActionOrigin(res: Response, origin: string): void {
  const normalized = normalizeHttpOrigin(origin);
  if (!normalized) return;

  const locals = res.locals as SecurityHeaderLocals;
  const existing = locals[FORM_ACTION_EXTRA_ORIGINS_LOCAL] ?? [];
  if (existing.includes(normalized)) return;
  locals[FORM_ACTION_EXTRA_ORIGINS_LOCAL] = [...existing, normalized];
}

function createCspNonce(): string {
  return randomBytes(16).toString('base64url');
}

function buildFormActionSources(extraFormActionOrigins: readonly string[]): string[] {
  const sources = ["'self'"];
  const seen = new Set(sources);
  for (const origin of extraFormActionOrigins) {
    const normalized = normalizeHttpOrigin(origin);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    sources.push(normalized);
  }
  return sources;
}

function normalizeHttpOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function getExtraFormActionOrigins(res: Response): readonly string[] {
  const locals = res.locals as SecurityHeaderLocals;
  return locals[FORM_ACTION_EXTRA_ORIGINS_LOCAL] ?? [];
}

function addStyleNonce(body: unknown, styleNonce: string): unknown {
  if (typeof body !== 'string' || !body.includes('<style')) {
    return body;
  }

  return body.replace(STYLE_TAG_WITHOUT_NONCE, `<style nonce="${styleNonce}"$1>`);
}

export function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const styleNonce = createCspNonce();
    const send = res.send.bind(res);
    const setContentSecurityPolicy = (): void => {
      res.setHeader(
        'Content-Security-Policy',
        buildContentSecurityPolicy(styleNonce, getExtraFormActionOrigins(res)),
      );
    };

    res.send = ((body?: unknown): Response => {
      setContentSecurityPolicy();
      return send(addStyleNonce(body, styleNonce));
    }) as Response['send'];

    setContentSecurityPolicy();
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}
