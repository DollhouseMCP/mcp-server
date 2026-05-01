/**
 * IAuthMethod
 *
 * Contract that auth method modules implement (trivial-consent, GitHub
 * social, local-password, magic-link, OIDC bridge). EmbeddedAuthorizationServer
 * (C4) consumes IAuthMethod via constructor injection so each method is a
 * drop-in replacement; the AS itself never knows what method is active.
 *
 * Design notes:
 *   - This file does NOT import oidc-provider types. The InteractionRouter
 *     (C4) translates between IAuthMethod and oidc-provider's interaction
 *     model — keeping the library boundary inside src/auth/embedded-as/.
 *   - findAccount() is separate from completeInteraction() because
 *     oidc-provider calls findAccount on every token issue and id_token
 *     claim assembly, not just at login. This is where must-fix #20
 *     (re-validate email_verified each login) lives for social methods.
 *
 * @module auth/embedded-as/IAuthMethod
 */

import type { AuthMethodId } from './AuthMethodFactory.js';

/**
 * The identity returned by a successful interaction (or by findAccount on
 * a known sub). For social methods, `sub` is keyed `${provider}:${external_sub}`
 * (must-fix #18 — never email-keyed). `emailVerified` must reflect the
 * upstream provider's current state at this moment, not historical truth.
 */
export interface AuthenticatedIdentity {
  /** Stable account key. Format: 'local:<uuid>' | 'github:<numeric_id>' | etc. */
  sub: string;
  displayName?: string;
  email?: string;
  emailVerified: boolean;
  /** Full upstream profile blob for audit. Never used for claim assembly. */
  raw?: Record<string, unknown>;
}

/** Context passed to a method when an interaction begins. */
export interface InteractionContext {
  /** oidc-provider's interaction uid; opaque to the method. */
  interactionId: string;
  /** The OAuth client requesting authorization. */
  clientId: string;
  /** Scopes requested in this authorization request. */
  requestedScopes: string[];
  /** Original request URL — useful for social-callback return-to construction. */
  requestUrl: string;
}

/** Form/query input passed to completeInteraction by the host route. */
export interface InteractionInput {
  formBody?: Record<string, string>;
  query?: Record<string, string>;
  /** Verified by the host route before the method's completeInteraction runs. */
  csrfToken?: string;
}

/**
 * What the method asks the host route to do next:
 *   - render-html: the method built a page to show the user (consent, login form)
 *   - redirect:    bounce the browser somewhere (e.g. to GitHub for OAuth)
 */
export type InteractionStep =
  | { kind: 'render-html'; html: string; csrfToken: string }
  | { kind: 'redirect'; url: string };

/**
 * What completeInteraction returns:
 *   - authenticated: identity is known; host emits provider.interactionFinished
 *   - next-step:     more user interaction required (e.g. magic link sent)
 *   - denied:        explicit denial; host shows an error and aborts the flow
 */
export type InteractionResult =
  | { kind: 'authenticated'; identity: AuthenticatedIdentity }
  | { kind: 'next-step'; step: InteractionStep }
  | { kind: 'denied'; reason: string };

export interface IAuthMethod {
  readonly id: AuthMethodId;
  /** Human-readable name for chooser UI / consent screen ("Sign in with GitHub"). */
  readonly displayName: string;

  /**
   * Called when the interaction route GET /interaction/:uid is hit. The
   * method renders a consent/login HTML page or instructs the host to
   * redirect the browser (e.g. to GitHub's authorize URL).
   */
  beginInteraction(ctx: InteractionContext): Promise<InteractionStep>;

  /**
   * Called when the interaction route POST/callback is hit. Resolves to
   * an authenticated identity, a next step (e.g. magic-link sent → check
   * your email), or a denial.
   */
  completeInteraction(
    ctx: InteractionContext,
    input: InteractionInput,
  ): Promise<InteractionResult>;

  /**
   * Called by oidc-provider's findAccount config callback every time a
   * token is issued or refreshed. Returns the current identity for `sub`,
   * re-validating verification state on each call (must-fix #20).
   * Returns null when the account is no longer valid (deleted, suspended,
   * upstream verification revoked).
   */
  findAccount(sub: string): Promise<AuthenticatedIdentity | null>;
}
