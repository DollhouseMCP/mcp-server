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

import type { Router } from 'express';
import type { AuthMethodId } from './AuthMethodFactory.js';
import type { OidcProviderForInteractions } from './InteractionRouter.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

/**
 * The identity returned by a successful interaction (or by findAccount on
 * a known sub). For social methods, `sub` is keyed `${provider}_${external_sub}`
 * (must-fix #18 — never email-keyed). The underscore separator satisfies the
 * project-wide userId regex `/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/` so the sub
 * can flow through HttpSession/UserIdentity validation as a userId.
 * `emailVerified` must reflect the upstream provider's current state at this
 * moment, not historical truth.
 */
export interface AuthenticatedIdentity {
  /** Stable account key. Format: 'local_<username>' | 'github_<numeric_id>' | etc. */
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
  /**
   * Client IP as Express resolved it (req.ip). Used by methods for per-IP
   * rate limiting and audit. Optional — when omitted, methods see
   * 'unknown' and treat the call as having no resolvable client address.
   *
   * Behind a proxy / tunnel, the operator must configure
   * `app.set('trust proxy', ...)` so Express returns the real client IP
   * from X-Forwarded-For instead of the proxy's address.
   */
  ip?: string;
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

/**
 * Runtime injected when EmbeddedAuthorizationServer wires a method's
 * standalone routes (callbacks, invite-redemption pages, etc.). Methods
 * import the helper functions they need (`finishInteractionWithIdentity`,
 * `verifyInteractionCookieMatches`) directly; deps carry runtime state
 * the AS owns.
 */
export interface ContributeRoutesDeps {
  storage: IAuthStorageLayer;
  /**
   * Resolves to the initialized oidc-provider instance the AS owns.
   * Methods call this lazily inside route handlers (not at registration
   * time) because init is asynchronous and runs after createRouter.
   */
  ensureInitialized: () => Promise<{ provider: OidcProviderForInteractions }>;
}

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
   * upstream verification revoked) OR when the sub is owned by a
   * different method (so EmbeddedAuthorizationServer can iterate the
   * method list and take the first non-null match).
   */
  findAccount(sub: string): Promise<AuthenticatedIdentity | null>;

  /**
   * Optional. Methods that own standalone HTTP routes outside the
   * /interaction/:uid flow (e.g. social-callback, invite-redemption,
   * magic-link-verify) implement this to register them on the AS router.
   *
   * Why this exists: prior to multi-method support, the AS used a chain
   * of `instanceof` checks to mount each method's standalone routes
   * conditionally. That coupled the AS to every concrete method class.
   * Methods now own their own routes, and the AS just iterates and
   * dispatches — closing the IAuthMethod contract drift the architect
   * flagged at "5 instanceof checks in createRouter".
   */
  contributeRoutes?(router: Router, deps: ContributeRoutesDeps): void;
}
