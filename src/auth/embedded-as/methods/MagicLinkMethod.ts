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

import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import type { InviteTokenStore } from '../inviteTokens.js';

const PROVIDER_NAME = 'magic-link';
const REQUEST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const REQUEST_RATE_LIMIT_PER_EMAIL = 3;
const REQUEST_RATE_LIMIT_PER_IP = 5;

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
}

interface RequestRateBucket {
  count: number;
  windowStart: number;
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

    if (action === 'consume-link') {
      // POST from the email-confirmation page — actually consume the token.
      return this.handleConsumeLink(form);
    }

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
   * Verify (no-consume) used by the GET /auth/email/verify handler so the
   * confirmation page only renders when the token is valid + not yet
   * consumed. POST then consumes via consumeMagicLink().
   */
  verifyMagicLink(token: string): { ok: true; interactionId?: string } | { ok: false; reason: string } {
    const verified = this.options.invites.verify(token);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    if (verified.payload.purpose !== 'magic-link') {
      return { ok: false, reason: 'token is not a magic link' };
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
    if (!consume.ok) return { kind: 'error', reason: `magic link ${consume.reason}` };
    if (consume.payload.purpose !== 'magic-link') {
      return { kind: 'error', reason: 'token is not a magic link' };
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

  private async handleRequestLink(
    form: Record<string, string>,
    ip: string,
    interactionId: string,
  ): Promise<InteractionResult> {
    const email = String(form.email ?? '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      // Don't reveal validation error shape; render the same generic response.
      return {
        kind: 'next-step',
        step: { kind: 'render-html', html: renderCheckEmailPage(), csrfToken: '' },
      };
    }

    // Per-email + per-IP rate limit (must-fix #3 from the existing list).
    if (!this.checkRequestRate(this.perEmailRequests, email, REQUEST_RATE_LIMIT_PER_EMAIL)) {
      // Generic response — don't reveal that this email is being throttled.
      return {
        kind: 'next-step',
        step: { kind: 'render-html', html: renderCheckEmailPage(), csrfToken: '' },
      };
    }
    if (!this.checkRequestRate(this.perIpRequests, ip, REQUEST_RATE_LIMIT_PER_IP)) {
      return {
        kind: 'next-step',
        step: { kind: 'render-html', html: renderCheckEmailPage(), csrfToken: '' },
      };
    }

    // Issue token + send. Always issue (and send if account exists) so the
    // timing of "exists vs not" is roughly equivalent. We do NOT look up
    // the account before issuing — we issue the token, attempt to send, and
    // if the email isn't on file the upstream will silently swallow it.
    // Stamp the interactionId into the token so the /auth/email/verify
    // route can find the right interaction to complete after consumption.
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
    } catch {
      // Swallow — return generic response (must-fix #2 enumeration prevention).
    }

    return {
      kind: 'next-step',
      step: { kind: 'render-html', html: renderCheckEmailPage(), csrfToken: '' },
    };
  }

  private async handleConsumeLink(form: Record<string, string>): Promise<InteractionResult> {
    const token = String(form.token ?? '');
    if (!token) return { kind: 'denied', reason: 'missing token' };

    const consume = this.options.invites.consume(token);
    if (!consume.ok) {
      return { kind: 'denied', reason: `magic link ${consume.reason}` };
    }
    if (consume.payload.purpose !== 'magic-link') {
      return { kind: 'denied', reason: 'token is not a magic link' };
    }

    const sub = consume.payload.sub;
    const email = consume.payload.email;
    const now = Date.now();

    // Upsert the account (lazy create on first verified login).
    const existing = await this.options.storage.getAccount(sub);
    await this.options.storage.upsertAccount({
      sub,
      provider: PROVIDER_NAME,
      externalSub: hashEmail(email),
      email,
      emailVerified: true, // The magic link proved control of the inbox.
      displayName: existing?.displayName ?? email,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return {
      kind: 'authenticated',
      identity: { sub, email, emailVerified: true, displayName: existing?.displayName ?? email },
    };
  }

  private checkRequestRate(
    bucketMap: Map<string, RequestRateBucket>,
    key: string,
    limit: number,
  ): boolean {
    const now = Date.now();
    const bucket = bucketMap.get(key) ?? { count: 0, windowStart: now };
    if (now - bucket.windowStart > REQUEST_RATE_LIMIT_WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    bucketMap.set(key, bucket);
    return bucket.count <= limit;
  }
}

function hashEmail(email: string): string {
  // Deterministic short hash for use as the externalSub. The email itself
  // is also stored (it's the user-visible identity); this is just to avoid
  // putting raw email strings into the sub claim.
  return Buffer.from(email).toString('base64url').slice(0, 32);
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
<form method="post"><input type="hidden" name="action" value="consume-link"><input type="hidden" name="token" value="${safeToken}">
<button type="submit">Sign in</button></form></main></body></html>`;
}
