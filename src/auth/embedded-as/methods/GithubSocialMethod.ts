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

import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';
import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import {
  GITHUB_API_EMAILS_URL,
  GITHUB_API_USER_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  MIN_AUTHCODE_SCOPES,
} from './githubScopes.js';

const GITHUB_PROVIDER = 'github';

export interface GithubSocialMethodOptions {
  /** GitHub OAuth app client ID. Reuses DOLLHOUSE_GITHUB_CLIENT_ID. */
  clientId: string;
  /** GitHub OAuth app client secret. From DOLLHOUSE_GITHUB_CLIENT_SECRET. */
  clientSecret: string;
  /** Absolute callback URL registered on the GitHub OAuth app. */
  callbackUrl: string;
  /** Storage for account upserts and identity-change audit. */
  storage: IAuthStorageLayer;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
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
   */
  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (!sub.startsWith(`${GITHUB_PROVIDER}_`)) return null;
    const externalSub = sub.slice(`${GITHUB_PROVIDER}_`.length);
    const account = await this.options.storage.findAccountByExternalId(GITHUB_PROVIDER, externalSub);
    if (!account) return null;
    return {
      sub: account.sub,
      displayName: account.displayName,
      email: account.email,
      emailVerified: account.emailVerified,
    };
  }

  /**
   * Called by EmbeddedAuthorizationServer's /auth/social/github/callback
   * handler. Exchanges the GitHub code for a token, fetches the verified
   * primary email, persists the account, and returns the identity for the
   * caller to drive provider.interactionFinished with.
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
      await this.options.storage.recordIdentityEvent({
        type: 'auth.social.identity_changed',
        sub: identity.sub,
        provider: GITHUB_PROVIDER,
        externalSub: String(profile.id),
        details: {
          previousEmail: existing.email,
          newEmail: profile.verifiedPrimaryEmail,
        },
        timestamp: Date.now(),
      });
    }

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

  private async exchangeCodeForToken(code: string): Promise<string | null> {
    const response = await this.fetchImpl(GITHUB_TOKEN_URL, {
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
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string; error?: string };
    return body.access_token ?? null;
  }

  private async fetchProfile(
    accessToken: string,
  ): Promise<GithubProfile | { error: string }> {
    const userResp = await this.fetchImpl(GITHUB_API_USER_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!userResp.ok) return { error: 'github user fetch failed' };
    const user = (await userResp.json()) as { id: number; login: string; name: string | null };

    const emailsResp = await this.fetchImpl(GITHUB_API_EMAILS_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!emailsResp.ok) return { error: 'github emails fetch failed' };
    const emails = (await emailsResp.json()) as Array<{
      email: string;
      verified: boolean;
      primary: boolean;
    }>;
    const verifiedPrimary = emails.find(e => e.verified && e.primary);
    if (!verifiedPrimary) {
      return { error: 'github account has no verified primary email' };
    }

    return {
      id: user.id,
      login: user.login,
      name: user.name,
      verifiedPrimaryEmail: verifiedPrimary.email,
      raw: { user, emails },
    };
  }
}
