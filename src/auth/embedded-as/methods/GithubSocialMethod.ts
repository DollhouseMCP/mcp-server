/**
 * GithubSocialMethod
 *
 * Stage B auth method: OAuth 2.0 authorization-code flow against GitHub.
 * Configured via DOLLHOUSE_AUTH_GITHUB_CLIENT_ID + _CLIENT_SECRET — a
 * dedicated GitHub OAuth app registered as a web-flow application with
 * a callback URL pointing at /auth/social/github/callback. Distinct
 * from the legacy DOLLHOUSE_GITHUB_CLIENT_ID used by the portfolio-sync
 * device flow (cycle-17 split). AuthProviderFactory falls back to the
 * legacy var pair with a deprecation warning if the new pair is unset.
 *
 * Identity contract (per docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1):
 *   - Account key is `github_<numeric_id>` (must-fix #18) — never the
 *     email string. Survives username/email changes.
 *   - Auto-link refuses unverified primary emails (must-fix #19): we
 *     hit /user/emails and require an entry with verified=true && primary=true.
 *   - emailVerified is re-validated on every login (must-fix #20).
 *   - Email mapping changes between consecutive logins emit
 *     `auth.social.identity_changed` (must-fix #21).
 *
 * Flow:
 *   1. beginInteraction returns a redirect to GitHub's /authorize URL with
 *      state=<interactionId>.
 *   2. User authorizes on github.com.
 *   3. GitHub redirects to our /auth/social/github/callback?code=..&state=..
 *      handler, which calls processCallback() to do the OAuth exchange and
 *      identity fetch, then renders hosted OAuth-client consent before
 *      provider.interactionFinished can issue an authorization code.
 *
 * @module auth/embedded-as/methods/GithubSocialMethod
 */

import type { Request, Response, Router } from 'express';
import { sendAuthError } from '../browserErrorPage.js';
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
import { beginAdminStepUpProof, isAdminStepUpRequest, renderClientConsentForIdentity } from '../InteractionRouter.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import { checkAllowlistGate, renderAllowlistDeniedPage, type SignInAllowlistAuthority } from '../allowlistGate.js';
import {
  GITHUB_API_EMAILS_URL,
  GITHUB_API_USER_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  MIN_AUTHCODE_SCOPES,
} from './githubScopes.js';

const GITHUB_PROVIDER = 'github';

/**
 * Cached `emailVerified` claim is treated as stale after this window. We
 * cannot actually re-call /user/emails on every findAccount because that
 * would require persisting the GitHub access token (out of scope and a
 * larger attack surface). Instead, we downgrade the cached value to
 * false once the cache is older than this TTL — downstream consumers
 * that depend on email_verified will trigger a fresh sign-in, which
 * runs processCallback and re-validates email_verified for real.
 *
 * 7 days balances UX (most users re-auth more often anyway) against the
 * window during which a user could un-verify the email at GitHub
 * without us noticing.
 */
const DEFAULT_EMAIL_VERIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GithubSocialMethodOptions {
  /** GitHub OAuth app client ID. Sourced from DOLLHOUSE_AUTH_GITHUB_CLIENT_ID (legacy DOLLHOUSE_GITHUB_CLIENT_ID also accepted). */
  clientId: string;
  /**
   * GitHub OAuth app client secret. Sourced from DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET (legacy DOLLHOUSE_GITHUB_CLIENT_SECRET also accepted).
   * Read once at construction; rotating the secret requires an AS
   * restart. A hot-rotation hook would need a config-watch path that
   * isn't §8.1 scope.
   */
  clientSecret: string;
  /** Absolute callback URL registered on the GitHub OAuth app. */
  callbackUrl: string;
  /** Storage for account upserts and identity-change audit. */
  storage: IAuthStorageLayer;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Override the staleness window for the cached `emailVerified` claim.
   * Defaults to 7 days. A value of 0 disables the downgrade.
   */
  emailVerifiedCacheTtlMs?: number;
  /**
   * Sign-in allowlist enforcement mode. Mirrors
   * `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED`. When `true`, an empty allowlist
   * means "bootstrap admin only". When `false` (default), an empty
   * allowlist means "no gate" (back-compat). The bootstrap admin always
   * passes regardless. Resolved at construction so tests can override.
   */
  allowlistRequired?: boolean;
  /** Optional replacement sign-in allowlist authority for hosted console cutover. */
  signInAllowlistAuthority?: SignInAllowlistAuthority;
}

interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  verifiedPrimaryEmail: string;
  raw: Record<string, unknown>;
}

export type GithubCallbackResult =
  | { kind: 'ok'; interactionId: string; identity: AuthenticatedIdentity }
  | { kind: 'denied'; reason: string }
  | { kind: 'error'; reason: string };

export class GithubSocialMethod implements IAuthMethod {
  readonly id = 'github' as const;
  readonly displayName = 'GitHub';

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubSocialMethodOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  beginInteraction(ctx: InteractionContext): Promise<InteractionStep> {
    // Use the interactionId itself as the OAuth state. It is unguessable
    // and unique per authorization request; we verify it round-trips on the
    // callback. No extra storage write needed.
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.callbackUrl);
    url.searchParams.set('scope', MIN_AUTHCODE_SCOPES.join(' '));
    url.searchParams.set('state', ctx.interactionId);
    return Promise.resolve({ kind: 'redirect', url: url.toString() });
  }

  /**
   * Not used in the social flow — the GitHub callback route drives completion
   * directly via processCallback(). If POST /interaction/:uid is hit while a
   * GitHub interaction is in flight, it's an error condition (the user
   * shouldn't have a consent form to submit).
   */
  completeInteraction(
    _ctx: InteractionContext,
    _input: InteractionInput,
  ): Promise<InteractionResult> {
    return Promise.resolve({
      kind: 'denied',
      reason: 'GitHub social does not use the consent POST path; complete via /auth/social/github/callback.',
    });
  }

  /**
   * Re-validates the cached account on every token issue (oidc-provider
   * calls this on findAccount). Pure DB read — does NOT hit GitHub's API.
   * The fresh email_verified check (must-fix #20) happens at login time
   * inside processCallback(); this method serves the cached attributes.
   *
   * Round 5 / H6: when `lastAuthAt` is older than the configured TTL
   * (default 7 days) we DOWNGRADE the cached `emailVerified` claim to
   * false rather than rejecting the account outright. The earlier
   * "return null on stale" shape had the right intent (force re-auth
   * to re-validate against GitHub) but the wrong blast radius:
   *
   *   - oidc-provider calls findAccount on every refresh-token redeem,
   *     not just at login. A null return aborts the redeem path
   *     entirely with no useful diagnostic for the client and silently
   *     drops `roles` + `auth_time` from any in-flight token issuance.
   *     For an admin who's been idle 8 days, the next refresh comes
   *     back without their admin claim — orthogonal failure.
   *
   *   - The actual concern is the stale `email_verified` cache. By
   *     returning the account with `emailVerified: false`, downstream
   *     can make scope-aware decisions: scopes that don't depend on
   *     a verified email (e.g. `openid` alone) keep working;
   *     verified-email-gated scopes can be denied or step-up'd.
   *     `roles` and `auth_time` propagate normally.
   *
   * `null` is still returned when the account doesn't exist at all —
   * that's a different shape (no row, no claims).
   */
  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (!sub.startsWith(`${GITHUB_PROVIDER}_`)) return null;
    const externalSub = sub.slice(`${GITHUB_PROVIDER}_`.length);
    const account = await this.options.storage.findAccountByExternalId(GITHUB_PROVIDER, externalSub);
    if (!account) return null;

    const ttl = this.options.emailVerifiedCacheTtlMs ?? DEFAULT_EMAIL_VERIFIED_TTL_MS;
    const stale = ttl > 0
      && (!account.lastAuthAt || (Date.now() - account.lastAuthAt) > ttl);

    if (stale) {
      // Round 5 review fixup (LOW backend observability): a
      // downgraded email_verified looks identical to a user
      // legitimately having an unverified GitHub email. Operators
      // investigating "why is email_verified false on this token"
      // need a signal to distinguish stale-cache from genuine
      // unverified. Debug-level so it doesn't flood normal logs.
      logger.debug('[GithubSocialMethod] emailVerified downgraded due to stale cache', {
        sub: account.sub,
        lastAuthAt: account.lastAuthAt,
        staleDeltaMs: account.lastAuthAt ? Date.now() - account.lastAuthAt : null,
        ttlMs: ttl,
      });
    }

    return {
      sub: account.sub,
      displayName: account.displayName,
      email: account.email,
      // Downgrade the cached email_verified claim when the cache is
      // older than the TTL window. Roles + lastAuthAt-derived
      // auth_time continue to flow through extraTokenClaims.
      emailVerified: stale ? false : account.emailVerified,
    };
  }

  /**
   * Mounts GET /auth/social/github/callback. The interaction-cookie binding
   * + interactionFinished orchestration moves here from the AS — the AS no
   * longer needs to know GitHub-specific routes exist.
   */
  contributeRoutes(router: Router, deps: ContributeRoutesDeps): void {
    router.get('/auth/social/github/callback', (req, res, next) => {
      void (async () => {
        try {
          await this.handleCallbackRequest(req, res, deps);
        } catch (err) {
          logger.error('[GithubSocialMethod] /auth/social/github/callback failed', {
            url: req.url,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          next(err);
        }
      })();
    });
  }

  /**
   * Drives the GitHub OAuth callback: validates the query params, verifies
   * the interaction-cookie binding, exchanges the code, and routes the
   * resulting identity through step-up or normal consent. Extracted from
   * the route handler so the request-level try/catch stays thin.
   */
  private async handleCallbackRequest(
    req: Request,
    res: Response,
    deps: ContributeRoutesDeps,
  ): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      sendAuthError(res, req, 400, 'github_callback_failed', 'missing code or state');
      return;
    }

    // Verify cookie binding FIRST, BEFORE exchanging the GitHub
    // one-time code (Phase 9 L1 / Q8). Earlier shape called
    // processCallback first — which contacted GitHub's /token
    // endpoint, burning the one-time code, and called
    // upsertAccount/recordIdentityEvent — and only then verified
    // the interaction-cookie binding. An attacker who captured
    // `code` + `state` without the legitimate user's cookie could
    // therefore mutate audit state and burn the user's GitHub
    // code before the binding check rejected the flow.
    //
    // `state` IS the interactionId by construction (see
    // beginInteraction); we use it to look up the cookie binding
    // without paying any upstream-side-effect cost.
    const { provider, cookieKeys } = await deps.ensureInitialized();
    const binding = verifyInteractionCookieMatches(req, state, cookieKeys);
    if (!binding.ok) {
      res.status(400).type('html').send(renderInteractionBindingError('GitHub sign-in'));
      return;
    }

    const result = await this.processCallback({ code, state });
    if (result.kind === 'error') {
      sendAuthError(res, req, 400, 'github_callback_failed', result.reason);
      return;
    }
    if (result.kind === 'denied') {
      // Sign-in allowlist denied this identity. The audit event was
      // already emitted inside the gate. Render a friendly HTML
      // page (matching the rest of the AS's UX) instead of a raw
      // 403 JSON blob.
      res.status(403).type('html').send(renderAllowlistDeniedPage());
      return;
    }
    // Restore the request URL to the interaction so oidc-provider's
    // interactionDetails reads the correct interaction record.
    req.url = `/interaction/${result.interactionId}`;
    const details = await provider.interactionDetails(req, res);
    // Admin step-up: a GitHub-backed step-up re-authenticates here, but
    // elevation requires an OTP factor proof. Route to the TOTP challenge
    // instead of finishing as a normal login — otherwise the issued token
    // carries amr=['github'] (no otp) and the BFF rejects the step-up.
    if (deps.adminStepUp && isAdminStepUpRequest(details)) {
      logger.info('[GithubSocialMethod] admin step-up: routing github callback to TOTP challenge', {
        uid: details.uid,
        prompt: typeof details.prompt.name === 'string' ? details.prompt.name : undefined,
      });
      await beginAdminStepUpProof(req, res, deps.storage, details, result.identity, deps.adminStepUp);
      return;
    }
    // Normal login: route through the client-consent screen, which finishes
    // the interaction once the user approves.
    await renderClientConsentForIdentity(
      res,
      provider,
      details,
      result.identity.sub,
      deps.storage,
      deps.defaultResource,
      {
        sub: result.identity.sub,
        displayName: result.identity.displayName,
        email: result.identity.email,
        provider: GITHUB_PROVIDER,
        providerUsername: typeof result.identity.raw?.githubUsername === 'string'
          ? result.identity.raw.githubUsername
          : undefined,
      },
    );
  }

  /**
   * Called by the github callback handler (registered via contributeRoutes).
   * Exchanges the GitHub code for a token, fetches the verified primary
   * email, persists the account, and returns the identity for the caller
   * to drive provider.interactionFinished with.
   */
  async processCallback(input: { code: string; state: string }): Promise<GithubCallbackResult> {
    if (!input.code || !input.state) {
      return { kind: 'error', reason: 'missing code or state' };
    }

    const accessToken = await this.exchangeCodeForToken(input.code);
    if (!accessToken) {
      return { kind: 'error', reason: 'github token exchange failed' };
    }

    const profile = await this.fetchProfile(accessToken);
    if ('error' in profile) {
      return { kind: 'error', reason: profile.error };
    }

    const identity: AuthenticatedIdentity = {
      sub: `${GITHUB_PROVIDER}_${profile.id}`,
      displayName: profile.name ?? profile.login,
      email: profile.verifiedPrimaryEmail,
      emailVerified: true, // We only got here if the verified-primary lookup succeeded.
      raw: { githubUsername: profile.login },
    };

    // Sign-in allowlist gate. Runs BEFORE any account write so a denied
    // sign-in leaves no persistent state (no account row, no grant-revoke
    // side effects, no identity-change audit). Bootstrap admin always
    // passes via checkAllowlistGate's rule 1.
    const gate = await checkAllowlistGate(
      {
        sub: identity.sub,
        method: 'github',
        email: profile.verifiedPrimaryEmail,
        githubUsername: profile.login,
        githubId: String(profile.id),
        provider: GITHUB_PROVIDER,
        externalSub: String(profile.id),
      },
      {
        storage: this.options.storage,
        authority: this.options.signInAllowlistAuthority,
        required: this.options.allowlistRequired ?? false,
      },
    );
    if (!gate.allowed) {
      return { kind: 'denied', reason: gate.reason };
    }

    // must-fix #21: emit identity-change audit if the email mapping moved.
    const existing = await this.options.storage.findAccountByExternalId(
      GITHUB_PROVIDER,
      String(profile.id),
    );
    if (existing?.email && existing.email !== profile.verifiedPrimaryEmail) {
      // H14: when the upstream identity-to-email mapping moves, revoke
      // any active grants for this sub. Without this, refresh tokens
      // issued before the change keep working until natural TTL expiry
      // (30 days), letting an attacker who took over the upstream
      // account ride existing sessions long after the rebind. The
      // genericRevokeByGrantId flow deletes every K/V entry referencing
      // each grantId — Sessions, AccessTokens, RefreshTokens, etc.
      const grants = await this.options.storage.findGrantsByAccountId(identity.sub);
      let revoked = 0;
      for (const grantId of grants) {
        if (this.options.storage.genericRevokeByGrantId) {
          await this.options.storage.genericRevokeByGrantId(grantId);
          revoked += 1;
        }
      }
      await this.options.storage.recordIdentityEvent({
        type: 'auth.social.identity_changed',
        sub: identity.sub,
        provider: GITHUB_PROVIDER,
        externalSub: String(profile.id),
        details: {
          previousEmail: existing.email,
          newEmail: profile.verifiedPrimaryEmail,
          grantsRevoked: revoked,
        },
        timestamp: Date.now(),
      });
    }

    // Bootstrap admin claim (must-fix #22): the admin-bootstrap CLI
    // pre-claimed this GitHub identity (`github_<id>`) before the gate
    // opened. Admin role is set ONLY when this sub matches AND the
    // pre-claim names github as the method — guards against a magic-
    // link bootstrap admin getting accidentally promoted via a github
    // login that happens to have the same numeric tail. Round 5 / H5 —
    // see bootstrapAdmin.ts for the upsert/setRoles split.
    // Admin is provisioned per-user in `user_admin_roles` by the bootstrap CLI
    // (linked on first login), not stamped onto the auth account.
    const now = Date.now();
    await this.options.storage.upsertAccount({
      sub: identity.sub,
      provider: GITHUB_PROVIDER,
      externalSub: String(profile.id),
      email: profile.verifiedPrimaryEmail,
      emailVerified: true,
      displayName: identity.displayName,
      rawProfile: profile.raw,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return { kind: 'ok', interactionId: input.state, identity };
  }

  /**
   * Wrap network failures (DNS, connection refused, timeout) and JSON
   * parse failures (GitHub returning HTML on a 5xx) into the structured
   * `null` return path. Without this guard the unhandled rejection
   * bubbles through processCallback into the AS callback handler's
   * generic 500, losing the diagnostic.
   */
  private async exchangeCodeForToken(code: string): Promise<string | null> {
    let response: globalThis.Response;
    try {
      response = await this.fetchImpl(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code,
          redirect_uri: this.options.callbackUrl,
        }),
        // Cycle-16 fix: GitHub partial outages (token endpoint accepts
        // connections but responds slowly) used to wedge the callback
        // handler. Cap at 15s — well above the 99p of GitHub's normal
        // response time but short enough that an outage doesn't
        // exhaust the event loop with hung fetches.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn('[GithubSocialMethod] token exchange network error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!response.ok) return null;
    let body: { access_token?: string; error?: string };
    try {
      body = (await response.json()) as { access_token?: string; error?: string };
    } catch (err) {
      logger.warn('[GithubSocialMethod] token exchange returned non-JSON body', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return body.access_token ?? null;
  }

  /**
   * Same wrap pattern as exchangeCodeForToken. Two GitHub API calls
   * (`/user`, `/user/emails`); either can fail with a network error or
   * return malformed JSON. Each is caught into a structured `{ error }`
   * return.
   */
  private async fetchProfile(
    accessToken: string,
  ): Promise<GithubProfile | { error: string }> {
    let userResp: globalThis.Response;
    try {
      userResp = await this.fetchImpl(GITHUB_API_USER_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn('[GithubSocialMethod] /user network error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: 'github user fetch failed' };
    }
    if (!userResp.ok) return { error: 'github user fetch failed' };
    let user: { id: number; login: string; name: string | null };
    try {
      user = (await userResp.json()) as { id: number; login: string; name: string | null };
    } catch {
      return { error: 'github user fetch failed' };
    }

    let emailsResp: globalThis.Response;
    try {
      emailsResp = await this.fetchImpl(GITHUB_API_EMAILS_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn('[GithubSocialMethod] /user/emails network error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: 'github emails fetch failed' };
    }
    if (!emailsResp.ok) return { error: 'github emails fetch failed' };
    let emails: Array<{ email: string; verified: boolean; primary: boolean }>;
    try {
      emails = (await emailsResp.json()) as Array<{
        email: string;
        verified: boolean;
        primary: boolean;
      }>;
    } catch {
      return { error: 'github emails fetch failed' };
    }
    const verifiedPrimary = emails.find(e => e.verified && e.primary);
    if (!verifiedPrimary) {
      return { error: 'github account has no verified primary email' };
    }

    return {
      id: user.id,
      login: user.login,
      name: user.name,
      verifiedPrimaryEmail: verifiedPrimary.email,
      // Cycle 19 / security-#3: explicit projection of /user payload
      // into rawProfile. The TypeScript cast at line ~433 narrows the
      // STATIC type but does NOT remove fields from the parsed JSON
      // at runtime. GitHub's /user response carries email, bio,
      // company, location, created_at, twitter_username, blog,
      // gravatar_id, etc. — PII that contradicts IAuthStorageLayer's
      // "safe to include in audit-event payloads and operator dumps"
      // contract. Same drift class as the Phase 7 /user/emails PII
      // trim — fix shape is identical: project explicitly rather than
      // trust the cast.
      raw: {
        user: { id: user.id, login: user.login, name: user.name },
        verifiedPrimaryEmail: verifiedPrimary.email,
      },
    };
  }
}
