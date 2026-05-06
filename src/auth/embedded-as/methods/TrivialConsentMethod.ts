/**
 * TrivialConsentMethod
 *
 * Solo-localhost auth method: zero-config consent for the operator's own
 * machine. On first use, the embedded AS auto-creates a single account
 * derived from the OS user (or DOLLHOUSE_USER), and the consent page is
 * a single-button "Approve Connector" form.
 *
 * Selected when no other auth method is configured AND the bind is
 * loopback (per docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1 mode-inference
 * rules). Replaces the EmbeddedOAuthProvider's hand-rolled consent page
 * carried over from the dev's first stab.
 *
 * @module auth/embedded-as/methods/TrivialConsentMethod
 */

import os from 'node:os';
import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';

const LOCAL_PROVIDER = 'local';

export interface TrivialConsentMethodOptions {
  /** OS-derived identity. Defaults to DOLLHOUSE_USER || os.userInfo().username. */
  defaultSubject?: string;
  /** Display name shown on the consent page. */
  defaultDisplayName?: string;
  /**
   * Storage layer used to stamp `lastAuthAt` on every approval, so the
   * AS's `extraTokenClaims` hook can emit the `auth_time` claim required
   * by spec line 927 ("every issued access token carries auth_time").
   * Optional only because some unit tests construct the method standalone;
   * production wiring through AuthProviderFactory always supplies it.
   */
  storage?: IAuthStorageLayer;
}

export class TrivialConsentMethod implements IAuthMethod {
  readonly id = 'trivial-consent' as const;
  readonly displayName = 'Local Operator';

  private readonly externalSub: string;
  private readonly displayNameForUser: string;
  private readonly storage: IAuthStorageLayer | undefined;

  constructor(options: TrivialConsentMethodOptions = {}) {
    this.externalSub = options.defaultSubject ?? defaultLocalSubject();
    this.displayNameForUser = options.defaultDisplayName ?? this.externalSub;
    this.storage = options.storage;
  }

  /**
   * Stable sub returned in JWTs and used as the IAuthStorageLayer account key.
   * Format `${provider}_${externalSub}` — underscore separator chosen to satisfy
   * the project-wide userId regex `/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/` so the
   * sub flows through HttpSession/UserIdentity validation unchanged.
   */
  get sub(): string {
    return `${LOCAL_PROVIDER}_${this.externalSub}`;
  }

  async beginInteraction(ctx: InteractionContext): Promise<InteractionStep> {
    const csrfToken = ''; // CSRF added at the InteractionRouter level (must-fix #6)
    const html = this.renderConsentPage(ctx, csrfToken);
    return { kind: 'render-html', html, csrfToken };
  }

  async completeInteraction(
    _ctx: InteractionContext,
    _input: InteractionInput,
  ): Promise<InteractionResult> {
    // Trivial consent has no real form fields to validate; clicking
    // "Approve Connector" is the consent. CSRF is verified by the
    // InteractionRouter before calling completeInteraction.
    //
    // Ensure the account row exists so `finishInteractionWithIdentity`
    // can stamp `lastAuthAt` and `extraTokenClaims` can emit `auth_time`
    // (spec line 927). Without this row trivial-consent tokens silently
    // omit the claim, leaving the contract unconditionally violated.
    if (this.storage) {
      const existing = await this.storage.getAccount(this.sub);
      const now = Date.now();
      await this.storage.upsertAccount({
        sub: this.sub,
        provider: LOCAL_PROVIDER,
        externalSub: this.externalSub,
        displayName: this.displayNameForUser,
        emailVerified: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // lastAuthAt left for the router to stamp atomically post-consent.
      });
    }
    return {
      kind: 'authenticated',
      identity: this.makeIdentity(),
    };
  }

  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (sub !== this.sub) return null;
    return this.makeIdentity();
  }

  private makeIdentity(): AuthenticatedIdentity {
    return {
      sub: this.sub,
      displayName: this.displayNameForUser,
      // Trivial consent doesn't verify email — that's social/magic-link.
      emailVerified: false,
    };
  }

  private renderConsentPage(ctx: InteractionContext, csrfToken: string): string {
    const clientLabel = escapeHtml(ctx.clientId);
    const subjectLabel = escapeHtml(this.displayNameForUser);
    const csrfInput = csrfToken
      ? `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DollhouseMCP Connector</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f7f4; color: #181816; }
    main { max-width: 520px; margin: 12vh auto; padding: 32px; background: white; border: 1px solid #d8d6cc; border-radius: 8px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { line-height: 1.5; }
    button { background: #185c37; color: white; border: 0; border-radius: 6px; padding: 12px 16px; font-weight: 700; cursor: pointer; }
    .muted { color: #68675f; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Connect to DollhouseMCP</h1>
    <p>Approve this connector to use DollhouseMCP tools over MCP Streamable HTTP.</p>
    <p class="muted">Operator: ${subjectLabel}</p>
    <p class="muted">Client: ${clientLabel}</p>
    <form method="post">
      ${csrfInput}
      <button type="submit" name="action" value="approve">Approve Connector</button>
    </form>
  </main>
</body>
</html>`;
  }
}

function defaultLocalSubject(): string {
  const envUser = process.env.DOLLHOUSE_USER?.trim();
  if (envUser) return envUser;
  try {
    return os.userInfo().username || 'local-operator';
  } catch {
    return 'local-operator';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
