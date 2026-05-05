/**
 * MagicLinkMethod
 *
 * Stage C auth method: email-based magic link. User enters their email,
 * server emails a one-time link, user clicks to authenticate. Per the §8.1
 * must-fix list:
 *   - #1 GET shows a "Click to sign in" confirmation page; consumption
 *     happens only on POST. Email pre-fetchers (corporate antivirus,
 *     Outlook etc.) hit GET and don't consume the token.
 *   - #2 account-enumeration prevention: /auth/email/request returns
 *     identical responses (200 + same body, equivalent timing) whether
 *     the email exists or not. Implementation: always claim "if that
 *     email exists, a link was sent" — never reveal account existence.
 *   - #3 per-email + per-IP rate limiting on /auth/email/request (handled
 *     here at the request-handler level, not by LocalLoginRateLimiter
 *     since the threshold semantics differ).
 *   - #10 SMTP STARTTLS-mandatory: enforced at construction by requiring
 *     `requireTLS: true` in the EmailSender contract.
 *
 * The EmailSender interface is pluggable so tests can use an in-memory
 * collector without spinning up SMTP. The `NodemailerEmailSender` factory
 * function builds the production sender; operators configure SMTP via env
 * (DOLLHOUSE_SMTP_HOST/PORT/USER/PASSWORD/FROM).
 *
 * @module auth/embedded-as/methods/MagicLinkMethod
 */

import { createHash } from 'node:crypto';
import express, { type Router } from 'express';
import { logger } from '../../../utils/logger.js';
import type {
  AuthenticatedIdentity,
  ContributeRoutesDeps,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';
import { renderInteractionBindingError, verifyInteractionCookieMatches } from '../interactionCookieBinding.js';
import { finishInteractionWithIdentity } from '../InteractionRouter.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import type { InviteTokenStore } from '../inviteTokens.js';

const PROVIDER_NAME = 'magic-link';
const REQUEST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const REQUEST_RATE_LIMIT_PER_EMAIL = 3;
const REQUEST_RATE_LIMIT_PER_IP = 5;
/**
 * Bound the rate-limit Maps to prevent memory-exhaustion DoS via flooding
 * with unique emails / IPs. When a Map grows past the cap we drop the
 * oldest tracked entry — the rate-limited keys (those at-or-past the
 * limit) survive eviction longer because they're touched more recently
 * by repeated incoming requests.
 *
 * 10k matches LocalLoginRateLimiter's MAX_TRACKED_* — same shape, same
 * memory budget. Phase 5 H10 migrates this state to IAuthStorageLayer
 * for multi-instance correctness; until then it's process-local.
 */
const MAX_TRACKED_REQUEST_BUCKETS = 10_000;
/**
 * Floor for /auth/email/request response time (must-fix #2). Total
 * handle time pads up to this floor before returning, so an observer
 * cannot distinguish "email known" vs "email unknown" by response
 * latency. 250ms is well above SMTP RTT variance and comfortably above
 * the rate-limit-rejected (no-send) path's near-zero cost.
 */
const REQUEST_RESPONSE_FLOOR_MS = 250;
/** Single error reason returned to users; precise causes go to logs only. */
const GENERIC_LINK_INVALID = 'this link is no longer valid';

export interface SendMagicLinkInput {
  to: string;
  url: string;
}

/**
 * Pluggable email-sending contract. The default factory wires nodemailer
 * with STARTTLS-mandatory; tests inject an in-memory collector.
 *
 * Implementations MUST require STARTTLS (must-fix #10) — operators using
 * a non-TLS SMTP server should fail startup with a clear error rather than
 * sending magic links over plaintext.
 */
export interface EmailSender {
  /** Send a magic-link email. Throws on send failure. */
  sendMagicLink(input: SendMagicLinkInput): Promise<void>;
}

export interface MagicLinkMethodOptions {
  storage: IAuthStorageLayer;
  invites: InviteTokenStore;
  emailSender: EmailSender;
  /** Absolute URL the magic link should point at. e.g. https://app/auth/email/verify */
  verifyUrl: string;
  /**
   * Override the constant-time response floor (must-fix #2). Defaults to
   * `REQUEST_RESPONSE_FLOOR_MS` (250 ms). Tests dial it down to 0 to keep
   * the suite fast; production should never override.
   */
  requestResponseFloorMs?: number;
}

interface RequestRateBucket {
  count: number;
  windowStart: number;
  /** True after the audit event for this window has been emitted; reset on window-roll. */
  alarmFired: boolean;
}

export class MagicLinkMethod implements IAuthMethod {
  readonly id = 'magic-link' as const;
  readonly displayName = 'Email magic link';

  private readonly perEmailRequests = new Map<string, RequestRateBucket>();
  private readonly perIpRequests = new Map<string, RequestRateBucket>();

  constructor(private readonly options: MagicLinkMethodOptions) {}

  async beginInteraction(_ctx: InteractionContext): Promise<InteractionStep> {
    return { kind: 'render-html', html: renderRequestPage(), csrfToken: '' };
  }

  async completeInteraction(
    ctx: InteractionContext,
    input: InteractionInput,
  ): Promise<InteractionResult> {
    const form = input.formBody ?? {};
    const action = String(form.action ?? '');

    if (action === 'request-link') {
      // POST /interaction/:uid with action=request-link → send the magic link.
      // Returns the same "check your email" page regardless of whether the
      // email exists (must-fix #2).
      return this.handleRequestLink(form, input.ip ?? 'unknown', ctx.interactionId);
    }

    // The 'consume-link' action used to be handled here, but that path
    // never knew the OAuth interactionId. Consumption is now driven by
    // the /auth/email/verify POST route in EmbeddedAuthorizationServer,
    // which calls consumeMagicLink() directly.
    return { kind: 'denied', reason: 'unknown form action' };
  }

  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (!sub.startsWith(`${PROVIDER_NAME}_`)) return null;
    const account = await this.options.storage.getAccount(sub);
    if (!account) return null;
    return {
      sub: account.sub,
      displayName: account.displayName,
      email: account.email,
      emailVerified: account.emailVerified,
    };
  }

  /** GET handler for the email-link landing page (anti-pre-fetch confirmation). */
  renderConfirmationPage(token: string): string {
    return renderConfirmationPage(token);
  }

  /**
   * Mounts the magic-link callback flow:
   *   GET  /auth/email/verify?token=<token>   — anti-pre-fetch confirmation page (must-fix #1)
   *   POST /auth/email/verify                 — consume token + complete OAuth interaction
   *
   * The POST handler restores the original interaction URL and drives
   * provider.interactionFinished after verifying the calling browser
   * holds the same `_interaction` cookie that started the flow.
   */
  contributeRoutes(router: Router, deps: ContributeRoutesDeps): void {
    const bodyParser = express.urlencoded({ extended: false, limit: '4kb' });

    router.get('/auth/email/verify', (req, res, next) => {
      void (async () => {
        try {
          const token = typeof req.query.token === 'string' ? req.query.token : '';
          const verified = this.verifyMagicLink(token);
          if (!verified.ok) {
            res.status(400).type('html').send(renderMagicLinkError(verified.reason));
            return;
          }
          res.type('html').send(this.renderConfirmationPage(token));
        } catch (err) {
          next(err);
        }
      })();
    });

    router.post('/auth/email/verify', bodyParser, (req, res, next) => {
      void (async () => {
        try {
          const body = req.body as Record<string, string> | undefined;
          const token = typeof body?.token === 'string' ? body.token : '';
          const consume = await this.consumeMagicLink(token);
          if (consume.kind === 'error') {
            res.status(400).type('html').send(renderMagicLinkError(consume.reason));
            return;
          }
          if (!consume.interactionId) {
            // Token was issued without an interactionId (CLI-issued, or an
            // older client that didn't stamp it). The user is authenticated
            // but we have no OAuth flow to complete; show a friendly page.
            res.type('html').send(renderMagicLinkSuccessNoInteraction(consume.identity.email ?? ''));
            return;
          }
          // Defense in depth: refuse to drive interactionFinished unless the
          // calling browser holds the same interaction cookie that started
          // the OAuth flow.
          const binding = verifyInteractionCookieMatches(req, consume.interactionId);
          if (!binding.ok) {
            res.status(400).type('html').send(renderInteractionBindingError('magic link'));
            return;
          }
          const { provider } = await deps.ensureInitialized();
          // Restore the request URL to the interaction so oidc-provider's
          // interactionDetails reads the correct interaction record.
          req.url = `/interaction/${consume.interactionId}`;
          const details = await provider.interactionDetails(req, res);
          await finishInteractionWithIdentity(req, res, provider, details, consume.identity.sub, deps.storage);
        } catch (err) {
          next(err);
        }
      })();
    });
  }

  /**
   * Verify (no-consume) used by the GET /auth/email/verify handler so the
   * confirmation page only renders when the token is valid + not yet
   * consumed. POST then consumes via consumeMagicLink().
   *
   * On failure, returns a single generic reason regardless of cause
   * (invalid signature, expired, wrong purpose). Distinguishing those
   * cases would let an attacker probing a captured token confirm whether
   * the token signature was once valid — useful for credential-validation
   * oracles. Operators see the precise reason via logs (not exposed here).
   */
  verifyMagicLink(token: string): { ok: true; interactionId?: string } | { ok: false; reason: string } {
    const verified = this.options.invites.verify(token);
    if (!verified.ok) return { ok: false, reason: GENERIC_LINK_INVALID };
    if (verified.payload.purpose !== 'magic-link') {
      return { ok: false, reason: GENERIC_LINK_INVALID };
    }
    return { ok: true, interactionId: verified.payload.interactionId };
  }

  /**
   * Consume a magic-link token AND upsert the account. Returns the
   * interactionId from the token payload (so the caller can complete the
   * matching oidc-provider interaction) plus the authenticated identity.
   * Used by the /auth/email/verify POST handler.
   */
  async consumeMagicLink(token: string): Promise<
    | { kind: 'ok'; interactionId: string | undefined; identity: AuthenticatedIdentity }
    | { kind: 'error'; reason: string }
  > {
    const consume = this.options.invites.consume(token);
    // Generic error reason regardless of cause — see verifyMagicLink rationale.
    if (!consume.ok) {
      if (consume.reason === 'rate-exceeded') {
        logger.warn('[MagicLinkMethod] magic-link consume refused: rate-exceeded');
        return { kind: 'error', reason: 'server is busy, please try again shortly' };
      }
      return { kind: 'error', reason: GENERIC_LINK_INVALID };
    }
    if (consume.payload.purpose !== 'magic-link') {
      return { kind: 'error', reason: GENERIC_LINK_INVALID };
    }

    const sub = consume.payload.sub;
    const email = consume.payload.email;
    const now = Date.now();

    const existing = await this.options.storage.getAccount(sub);
    await this.options.storage.upsertAccount({
      sub,
      provider: PROVIDER_NAME,
      externalSub: hashEmail(email),
      email,
      emailVerified: true,
      displayName: existing?.displayName ?? email,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return {
      kind: 'ok',
      interactionId: consume.payload.interactionId,
      identity: { sub, email, emailVerified: true, displayName: existing?.displayName ?? email },
    };
  }

  /**
   * Handle POST /auth/email/request.
   *
   * Account-enumeration safety (must-fix #2): the response shape is
   * identical (`renderCheckEmailPage`) regardless of whether the email is
   * known, malformed, or rate-limited. Total handle time is padded to a
   * fixed floor (`REQUEST_RESPONSE_FLOOR_MS`) so an observer cannot
   * distinguish the underlying state by latency. Floor is well above the
   * SMTP RTT variance and above the rate-limit-rejected (no-send) path.
   *
   * Rate limit (must-fix #3): per-email and per-IP bounded buckets — see
   * `noteRequestRate`. State is process-local; multi-instance migration
   * to IAuthStorageLayer is Phase 5 H10.
   */
  private async handleRequestLink(
    form: Record<string, string>,
    ip: string,
    interactionId: string,
  ): Promise<InteractionResult> {
    const startTime = Date.now();
    const generic = (): InteractionResult => ({
      kind: 'next-step',
      step: { kind: 'render-html', html: renderCheckEmailPage(), csrfToken: '' },
    });

    try {
      const email = String(form.email ?? '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return generic();
      }

      // Per-email + per-IP rate limit. `noteRequestRate` is async to leave
      // room for the storage-backed migration in Phase 5; today it's a
      // sync Map operation under an async signature.
      const emailOk = await this.noteRequestRate(this.perEmailRequests, email, REQUEST_RATE_LIMIT_PER_EMAIL, 'email');
      if (!emailOk) return generic();
      const ipOk = await this.noteRequestRate(this.perIpRequests, ip, REQUEST_RATE_LIMIT_PER_IP, 'ip');
      if (!ipOk) return generic();

      // Issue token + send. Always issue and always attempt send so the
      // SMTP code path is taken regardless of whether the email is on
      // file. The user-facing response stays generic on send failure.
      const sub = `${PROVIDER_NAME}_${hashEmail(email)}`;
      const token = this.options.invites.issue({
        sub,
        email,
        purpose: 'magic-link',
        interactionId,
      });
      const url = new URL(this.options.verifyUrl);
      url.searchParams.set('token', token);

      try {
        await this.options.emailSender.sendMagicLink({ to: email, url: url.toString() });
      } catch (err) {
        // The user-facing response stays generic (must-fix #2 enumeration
        // prevention) — but the operator needs to see relay outages, so log
        // server-side. Email is omitted to avoid joining log + audit trails
        // by email; sub is the safer audit handle.
        logger.warn('[MagicLinkMethod] sendMagicLink failed', {
          sub,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return generic();
    } finally {
      // must-fix #2: pad total handle time to a fixed floor so a timing
      // observer can't distinguish "email known + SMTP succeeded" from
      // "email rejected at validation" or "rate-limited (no SMTP)".
      const floor = this.options.requestResponseFloorMs ?? REQUEST_RESPONSE_FLOOR_MS;
      const elapsed = Date.now() - startTime;
      if (floor > 0 && elapsed < floor) {
        await new Promise((resolve) => setTimeout(resolve, floor - elapsed));
      }
    }
  }

  /**
   * Bounded fixed-window rate limiter (must-fix #3).
   *
   * Returns true when the request is allowed, false when the bucket has
   * crossed the limit for its current window. Bucket counter is capped
   * at `limit + 1` so under sustained flood the value stays bounded
   * (no overflow concern, no integer growth).
   *
   * The first request to cross the threshold within a window emits an
   * `auth.magic_link.flood_suspected` audit event so operators can see
   * abuse without being spammed every request. The flag resets on
   * window-roll.
   *
   * Map size is capped at `MAX_TRACKED_REQUEST_BUCKETS`; eviction prefers
   * non-rate-limited entries (count <= limit) before touching active
   * limiters. Mirrors the `LocalLoginRateLimiter` lock-aware bound.
   */
  private async noteRequestRate(
    bucketMap: Map<string, RequestRateBucket>,
    key: string,
    limit: number,
    dimension: 'email' | 'ip',
  ): Promise<boolean> {
    const now = Date.now();
    const bucket = bucketMap.get(key) ?? { count: 0, windowStart: now, alarmFired: false };
    if (now - bucket.windowStart > REQUEST_RATE_LIMIT_WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
      bucket.alarmFired = false;
    }
    if (bucket.count <= limit) bucket.count += 1;
    bucketMap.set(key, bucket);

    this.boundRequestMap(bucketMap, limit);

    if (bucket.count > limit && !bucket.alarmFired) {
      bucket.alarmFired = true;
      await this.options.storage.recordIdentityEvent({
        type: 'auth.magic_link.flood_suspected',
        details: { dimension, limit, windowMs: REQUEST_RATE_LIMIT_WINDOW_MS },
        timestamp: now,
      });
    }

    return bucket.count <= limit;
  }

  /**
   * Cap the rate-limit Map size. Pass 1 evicts entries below the limit
   * (their lockout window has either expired or never fired). Pass 2 is
   * a FIFO fallback only used at sustained saturation; preserving rate-
   * limited entries is the security-meaningful invariant.
   */
  private boundRequestMap(bucketMap: Map<string, RequestRateBucket>, limit: number): void {
    if (bucketMap.size <= MAX_TRACKED_REQUEST_BUCKETS) return;

    for (const [key, rec] of bucketMap) {
      if (bucketMap.size <= MAX_TRACKED_REQUEST_BUCKETS) return;
      if (rec.count <= limit) bucketMap.delete(key);
    }

    while (bucketMap.size > MAX_TRACKED_REQUEST_BUCKETS) {
      const oldest = bucketMap.keys().next().value;
      if (oldest === undefined) break;
      bucketMap.delete(oldest);
    }
  }
}

/**
 * Derive an opaque, irreversible externalSub from the user's email
 * (must-fix #18 — account key is `(provider, external_sub)`, not email).
 *
 * Lowercased + trimmed before hashing so `Alice@Example.com` and
 * `alice@example.com` collide on the same account. SHA-256 then base64url
 * gives 43 chars of entropy — well within the auth_accounts.external_sub
 * VARCHAR(255) limit and far beyond the prior reversible-base64
 * implementation that fit the email itself into 32 chars.
 *
 * Earlier code used `Buffer.from(email).toString('base64url').slice(0, 32)`
 * which was reversible (`Buffer.from(externalSub, 'base64url').toString('utf8')`
 * recovered the email prefix) and collision-prone (any two emails sharing
 * a 24-byte UTF-8 prefix mapped to the same sub).
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('base64url');
}

function renderRequestPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in — DollhouseMCP</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}label{display:block;margin-top:12px;font-size:14px}input{display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:4px;margin-top:4px}button{background:#185c37;color:white;border:0;border-radius:6px;padding:12px 16px;font-weight:700;cursor:pointer;margin-top:16px}</style>
</head><body><main><h1>Sign in</h1><p>Enter your email; we'll send you a one-time link.</p>
<form method="post"><label>Email<input type="email" name="email" required autocomplete="email"></label>
<button type="submit" name="action" value="request-link">Send link</button></form></main></body></html>`;
}

function renderCheckEmailPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Check your email</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main><h1>Check your email</h1><p>If that email is on file, a sign-in link is on its way. Click the link to continue.</p></main></body></html>`;
}

function renderConfirmationPage(token: string): string {
  const safeToken = token.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Confirm sign-in</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}button{background:#185c37;color:white;border:0;border-radius:6px;padding:12px 16px;font-weight:700;cursor:pointer;margin-top:16px}</style>
</head><body><main><h1>Confirm sign-in</h1><p>Click below to complete sign-in.</p>
<form method="post"><input type="hidden" name="token" value="${safeToken}">
<button type="submit">Sign in</button></form></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMagicLinkError(reason: string): string {
  const safe = escapeHtml(reason);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main><h1>Sign-in failed</h1><p>${safe}</p><p>Request a new link from the application.</p></main></body></html>`;
}

function renderMagicLinkSuccessNoInteraction(email: string): string {
  const safe = escapeHtml(email);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed in</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main><h1>Signed in as ${safe}</h1><p>This link wasn't bound to an active sign-in flow. Return to the application to continue.</p></main></body></html>`;
}
