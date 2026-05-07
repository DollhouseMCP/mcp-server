/**
 * GithubSocialMethod
 *
 * Stage B auth method: OAuth 2.0 authorization-code flow against GitHub.
 * Reuses the existing DOLLHOUSE_GITHUB_CLIENT_ID (the GitHub OAuth app
 * already registered for the device-flow collection install path); the
 * §8.1 flow adds a callback URL to that same app and requests a minimal
 * scope set distinct from the device flow.
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
 *      identity fetch, then drives provider.interactionFinished out-of-band.
 *
 * @module auth/embedded-as/methods/GithubSocialMethod
 */

import type { Router } from 'express';
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
  /** GitHub OAuth app client ID. Reuses DOLLHOUSE_GITHUB_CLIENT_ID. */
  clientId: string;
  /**
   * GitHub OAuth app client secret. From DOLLHOUSE_GITHUB_CLIENT_SECRET.
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
  | { kind: 'error'; reason: string };

export class GithubSocialMethod implements IAuthMethod {
  readonly id = 'github' as const;
  readonly displayName = 'GitHub';

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubSocialMethodOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async beginInteraction(ctx: InteractionContext): Promise<InteractionStep> {
    // Use the interactionId itself as the OAuth state. It is unguessable
    // and unique per authorization request; we verify it round-trips on the
    // callback. No extra storage write needed.
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.callbackUrl);
    url.searchParams.set('scope', MIN_AUTHCODE_SCOPES.join(' '));
    url.searchParams.set('state', ctx.interactionId);
    return { kind: 'redirect', url: url.toString() };
  }

  /**
   * Not used in the social flow — the GitHub callback route drives completion
   * directly via processCallback(). If POST /interaction/:uid is hit while a
   * GitHub interaction is in flight, it's an error condition (the user
   * shouldn't have a consent form to submit).
   */
  async completeInteraction(
    _ctx: InteractionContext,
    _input: InteractionInput,
  ): Promise<InteractionResult> {
    return {
      kind: 'denied',
      reason: 'GitHub social does not use the consent POST path; complete via /auth/social/github/callback.',
    };
  }

  /**
   * Re-validates the cached account on every token issue (oidc-provider
   * calls this on findAccount). Pure DB read — does NOT hit GitHub's API.
   * The fresh email_verified check (must-fix #20) happens at login time
   * inside processCallback(); this method serves the cached attributes.
   *
   * Defense-in-depth: when the account's lastAuthAt is older than the
   * configured TTL (default 7 days) we return `null` rather than a
   * degraded account. oidc-provider treats that as "account not found"
   * and refuses the in-flight refresh, forcing the client to redirect
   * back through /authorize — which re-runs processCallback and
   * re-validates email_verified against current GitHub state.
   *
   * The earlier shape (return account with emailVerified=false) was
   * theater for refresh-token clients: most simply accept the degraded
   * id_token and keep refreshing, never re-prompting. Returning null
   * actually terminates the session.
   */
  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (!sub.startsWith(`${GITHUB_PROVIDER}_`)) return null;
    const externalSub = sub.slice(`${GITHUB_PROVIDER}_`.length);
    const account = await this.options.storage.findAccountByExternalId(GITHUB_PROVIDER, externalSub);
    if (!account) return null;

    const ttl = this.options.emailVerifiedCacheTtlMs ?? DEFAULT_EMAIL_VERIFIED_TTL_MS;
    const stale = ttl > 0
      && (!account.lastAuthAt || (Date.now() - account.lastAuthAt) > ttl);
    if (stale) return null;

    return {
      sub: account.sub,
      displayName: account.displayName,
      email: account.email,
      emailVerified: account.emailVerified,
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
          const code = typeof req.query.code === 'string' ? req.query.code : '';
          const state = typeof req.query.state === 'string' ? req.query.state : '';
          if (!code || !state) {
            res.status(400).json({ error: 'github_callback_failed', error_description: 'missing code or state' });
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
            res.status(400).json({ error: 'github_callback_failed', error_description: result.reason });
            return;
          }
          // Restore the request URL to the interaction so oidc-provider's
          // interactionDetails reads the correct interaction record.
          req.url = `/interaction/${result.interactionId}`;
          const details = await provider.interactionDetails(req, res);
          await finishInteractionWithIdentity(req, res, provider, details, result.identity.sub, deps.storage);
        } catch (err) {
          next(err);
        }
      })();
    });
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
    };

    // must-fix #21: emit identity-change audit if the email mapping moved.
    const existing = await this.options.storage.findAccountByExternalId(
      GITHUB_PROVIDER,
      String(profile.id),
    );
    if (existing && existing.email && existing.email !== profile.verifiedPrimaryEmail) {
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
    // login that happens to have the same numeric tail.
    const bootstrap = await this.options.storage.getBootstrapState();
    const isBootstrapAdmin = bootstrap.completed
      && bootstrap.adminSub === identity.sub
      && bootstrap.adminMethod === 'github';

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
      ...(isBootstrapAdmin ? { roles: ['admin'] } : {}),
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
    let response: Response;
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
    let userResp: Response;
    try {
      userResp = await this.fetchImpl(GITHUB_API_USER_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
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

    let emailsResp: Response;
    try {
      emailsResp = await this.fetchImpl(GITHUB_API_EMAILS_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
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
      // Don't store the full /user/emails array on rawProfile: it
      // contains non-primary, non-verified addresses which are PII and
      // contradict IAuthStorageLayer's documented "safe to include in
      // audit-event payloads and operator dumps" contract for this
      // field. Keep just the /user payload + the chosen email.
      raw: { user, verifiedPrimaryEmail: verifiedPrimary.email },
    };
  }
}
