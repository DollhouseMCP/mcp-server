import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';

import type { IConsoleIdentityResolver } from '../../../web-console/identity/IConsoleIdentityResolver.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import type { IRateLimitStore } from '../storage/IRateLimitStore.js';
import { AdminTotpError, type AdminTotpService } from './AdminTotpService.js';
import {
  adminTotpRateLimitSubject,
  checkAdminTotpRateLimit,
  noteAdminTotpFailure,
  resetAdminTotpRateLimit,
} from './AdminTotpRateLimit.js';

const ROUTE_CSRF_MODEL = 'AdminTotpRouteCsrf';
const ROUTE_CSRF_TTL_SECONDS = 10 * 60;
const ENROLL_CONFIRM_RATE_SCOPE = 'admin_totp_enroll';
const DISABLE_CONFIRM_RATE_SCOPE = 'admin_totp_disable';

export interface AdminTotpInteractionRouteDeps {
  storage: IAuthStorageLayer;
  totpService: Pick<AdminTotpService, 'beginEnrollment' | 'confirmEnrollment' | 'disableWithProof'>;
  identityResolver: IConsoleIdentityResolver;
  rateLimitStore?: IRateLimitStore;
  ensureInitialized: () => Promise<{ provider: TotpSessionProvider }>;
}

export interface TotpSessionProvider {
  Session?: {
    get(ctx: { req: Request; res: Response; secure?: boolean }): Promise<{ accountId?: string }>;
  };
}

export function mountAdminTotpInteractionRoutes(router: Router, deps: AdminTotpInteractionRouteDeps): void {
  const bodyParser = express.urlencoded({ extended: false, limit: '4kb' });

  router.get('/auth/totp/enroll', (req, res, next) => {
    void (async () => {
      const principal = await resolvePrincipal(req, res, deps);
      if (!principal) return;
      const label = typeof req.query.label === 'string' ? req.query.label : 'DollhouseMCP Admin';
      try {
        const enrollment = await deps.totpService.beginEnrollment(principal.userId, label);
        const csrf = await issueRouteCsrf(deps.storage, enrollment.pendingId, principal.userId);
        await deps.storage.recordIdentityEvent({
          type: 'auth.admin_totp.enrollment_started',
          sub: principal.sub,
          details: {},
          timestamp: Date.now(),
        });
        res.type('html').send(renderEnrollmentPage(enrollment.pendingId, enrollment.secretBase32, enrollment.otpauthUri, csrf));
      } catch (err) {
        sendTotpError(res, err);
      }
    })().catch(next);
  });

  router.post('/auth/totp/enroll/confirm', bodyParser, (req, res, next) => {
    void (async () => {
      const principal = await resolvePrincipal(req, res, deps);
      if (!principal) return;
      const pendingId = formValue(req, 'pending_id');
      if (!pendingId || !(await verifyRouteCsrf(deps.storage, pendingId, principal.userId, formValue(req, 'csrf_token')))) {
        res.status(403).json({ error: 'invalid_csrf', error_description: 'CSRF token missing or invalid' });
        return;
      }
      const rateSubject = adminTotpRateLimitSubject(principal.userId, req.ip);
      const rateLimit = await checkAdminTotpRateLimit(deps.rateLimitStore, ENROLL_CONFIRM_RATE_SCOPE, rateSubject);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'rate_limited', error_description: 'too many enrollment confirmation attempts' });
        return;
      }
      try {
        const confirmed = await deps.totpService.confirmEnrollment(principal.userId, pendingId, formValue(req, 'code') ?? '');
        await resetAdminTotpRateLimit(deps.rateLimitStore, ENROLL_CONFIRM_RATE_SCOPE, rateSubject);
        await deps.storage.genericDestroy(ROUTE_CSRF_MODEL, pendingId);
        await deps.storage.recordIdentityEvent({
          type: 'auth.admin_totp.enrolled',
          sub: principal.sub,
          details: { factorId: confirmed.factorId, backupCodeCount: confirmed.backupCodes.length },
          timestamp: confirmed.enrolledAt.getTime(),
        });
        res.type('html').send(renderBackupCodesPage(confirmed.backupCodes));
      } catch (err) {
        if (err instanceof AdminTotpError && err.code === 'invalid_totp_code') {
          await noteAdminTotpFailure(deps.rateLimitStore, ENROLL_CONFIRM_RATE_SCOPE, rateSubject);
        }
        sendTotpError(res, err);
      }
    })().catch(next);
  });

  router.get('/auth/totp/disable', (req, res, next) => {
    void (async () => {
      const principal = await resolvePrincipal(req, res, deps);
      if (!principal) return;
      const disableId = randomBytes(24).toString('base64url');
      const csrf = await issueRouteCsrf(deps.storage, disableId, principal.userId);
      res.type('html').send(renderDisablePage(disableId, csrf, null));
    })().catch(next);
  });

  router.post('/auth/totp/disable/confirm', bodyParser, (req, res, next) => {
    void (async () => {
      const principal = await resolvePrincipal(req, res, deps);
      if (!principal) return;
      const disableId = formValue(req, 'disable_id');
      if (!disableId || !(await verifyRouteCsrf(deps.storage, disableId, principal.userId, formValue(req, 'csrf_token')))) {
        res.status(403).json({ error: 'invalid_csrf', error_description: 'CSRF token missing or invalid' });
        return;
      }
      const rateSubject = adminTotpRateLimitSubject(principal.userId, req.ip);
      const rateLimit = await checkAdminTotpRateLimit(deps.rateLimitStore, DISABLE_CONFIRM_RATE_SCOPE, rateSubject);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'rate_limited', error_description: 'too many disable confirmation attempts' });
        return;
      }
      const disabled = await deps.totpService.disableWithProof(principal.userId, formValue(req, 'code') ?? '');
      if (!disabled.ok) {
        await noteAdminTotpFailure(deps.rateLimitStore, DISABLE_CONFIRM_RATE_SCOPE, rateSubject);
        const csrf = await issueRouteCsrf(deps.storage, disableId, principal.userId);
        res.status(400).type('html').send(renderDisablePage(disableId, csrf, 'Invalid authentication code.'));
        return;
      }
      await resetAdminTotpRateLimit(deps.rateLimitStore, DISABLE_CONFIRM_RATE_SCOPE, rateSubject);
      await deps.storage.genericDestroy(ROUTE_CSRF_MODEL, disableId);
      await deps.storage.recordIdentityEvent({
        type: 'auth.admin_totp.disabled',
        sub: principal.sub,
        details: { method: disabled.method },
        timestamp: disabled.authTime.getTime(),
      });
      res.type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Factor disabled</title></head><body><main><h1>Factor disabled</h1></main></body></html>');
    })().catch(next);
  });
}

async function resolvePrincipal(
  req: Request,
  res: Response,
  deps: AdminTotpInteractionRouteDeps,
): Promise<{ userId: string; sub: string } | null> {
  const { provider } = await deps.ensureInitialized();
  const session = provider.Session ? await provider.Session.get({ req, res, secure: req.secure }) : null;
  if (!session?.accountId) {
    res.status(401).json({ error: 'login_required', error_description: 'primary authentication is required' });
    return null;
  }
  const principal = await deps.identityResolver.resolveEnabledPrincipal(session.accountId);
  if (!principal) {
    res.status(401).json({ error: 'login_required', error_description: 'principal is disabled or unknown' });
    return null;
  }
  return { userId: principal.userId, sub: principal.sub };
}

async function issueRouteCsrf(storage: IAuthStorageLayer, id: string, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await storage.genericSet(ROUTE_CSRF_MODEL, id, { token, userId }, ROUTE_CSRF_TTL_SECONDS);
  return token;
}

async function verifyRouteCsrf(
  storage: IAuthStorageLayer,
  id: string,
  userId: string,
  submitted: string | undefined,
): Promise<boolean> {
  const raw = await storage.genericGet(ROUTE_CSRF_MODEL, id);
  if (!submitted || !raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.userId === userId && value.token === submitted;
}

function formValue(req: Request, field: string): string | undefined {
  const value = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' ? value : undefined;
}

function sendTotpError(res: Response, err: unknown): void {
  if (err instanceof AdminTotpError) {
    const status = err.code === 'already_enrolled' ? 409 : 400;
    res.status(status).json({ error: err.code, error_description: err.message });
    return;
  }
  throw err;
}

function renderEnrollmentPage(pendingId: string, secret: string, uri: string, csrf: string): string {
  return page('Enroll administrator authenticator', `
<p><code>${escapeHtml(secret)}</code></p>
<p><a href="${escapeHtmlAttr(uri)}">Open authenticator app</a></p>
<form method="post" action="/auth/totp/enroll/confirm">
<input type="hidden" name="pending_id" value="${escapeHtmlAttr(pendingId)}">
<input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrf)}">
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit">Confirm</button>
</form>`);
}

function renderBackupCodesPage(codes: readonly string[]): string {
  const items = codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join('');
  return page('Recovery codes', `<ol>${items}</ol>`);
}

function renderDisablePage(disableId: string, csrf: string, error: string | null): string {
  const errorHtml = error ? `<p role="alert">${escapeHtml(error)}</p>` : '';
  return page('Disable administrator authenticator', `${errorHtml}
<form method="post" action="/auth/totp/disable/confirm">
<input type="hidden" name="disable_id" value="${escapeHtmlAttr(disableId)}">
<input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrf)}">
<label for="code">Authentication or recovery code</label>
<input id="code" name="code" autocomplete="one-time-code" required>
<button type="submit">Disable</button>
</form>`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:480px;margin:10vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}label,input,button{display:block;width:100%;box-sizing:border-box}input{margin:8px 0 16px;padding:10px}button{padding:12px 16px;background:#185c37;color:white;border:0;border-radius:6px;font-weight:700}code{font-family:ui-monospace,monospace}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}
