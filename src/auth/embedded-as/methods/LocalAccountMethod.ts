/**
 * LocalAccountMethod
 *
 * Stage C auth method: username + argon2id-hashed password. First-credential
 * delivery uses the inviteTokens flow (must-fix #17) — operator runs
 * `dollhousemcp create-user`, gets a one-time URL, hand-delivers; user
 * sets their own password on first visit. Operator never sees a password.
 *
 * Login attempts go through LocalLoginRateLimiter (must-fix #16):
 * per-account exponential backoff after 5 failures, per-IP lockout after 20.
 *
 * The single-method-per-AS limitation of §8.1 means LocalAccountMethod
 * exposes both the invite-acceptance flow AND the login flow on the same
 * /interaction/:uid endpoint. The render-html step keys off whether an
 * `invite=` query parameter is present.
 *
 * @module auth/embedded-as/methods/LocalAccountMethod
 */

import argon2 from 'argon2';
import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';
import type { IAuthStorageLayer, StoredAccount } from '../storage/IAuthStorageLayer.js';
import type { InviteTokenStore } from '../inviteTokens.js';
import type { LocalLoginRateLimiter } from '../rateLimit.js';

const LOCAL_PROVIDER = 'local';
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP 2024 recommendation
  timeCost: 2,
  parallelism: 1,
};

export interface LocalAccountMethodOptions {
  storage: IAuthStorageLayer;
  invites: InviteTokenStore;
  rateLimiter: LocalLoginRateLimiter;
}

interface LocalAccountExtras {
  passwordHash?: string;
}

/** A StoredAccount with the local-account password-hash extension on rawProfile. */
type LocalStoredAccount = StoredAccount & { rawProfile?: LocalAccountExtras };

export class LocalAccountMethod implements IAuthMethod {
  readonly id = 'local-password' as const;
  readonly displayName = 'Local Account';

  constructor(private readonly options: LocalAccountMethodOptions) {}

  async beginInteraction(_ctx: InteractionContext): Promise<InteractionStep> {
    // Two render paths key off the OAuth request's resource/state — but
    // simpler: detect an invite token in the URL via the request URL's query.
    // The InteractionRouter's GET handler doesn't pass query through to begin;
    // we render a single page that can handle both invite + login depending
    // on which fields the user fills in.
    return {
      kind: 'render-html',
      html: renderLoginOrInvitePage(),
      csrfToken: '', // InteractionRouter stamps the real token.
    };
  }

  async completeInteraction(
    ctx: InteractionContext,
    input: InteractionInput,
  ): Promise<InteractionResult> {
    const form = input.formBody ?? {};
    const action = String(form.action ?? '');

    if (action === 'set-password') {
      return this.handleSetPassword(form);
    }

    if (action === 'login') {
      return this.handleLogin(form, ctx);
    }

    return { kind: 'denied', reason: 'unknown form action' };
  }

  async findAccount(sub: string): Promise<AuthenticatedIdentity | null> {
    if (!sub.startsWith(`${LOCAL_PROVIDER}_`)) return null;
    const account = await this.options.storage.getAccount(sub);
    if (!account) return null;
    return {
      sub: account.sub,
      displayName: account.displayName,
      email: account.email,
      emailVerified: account.emailVerified,
    };
  }

  /**
   * Issue an invite for `dollhousemcp create-user`. Returns the URL the
   * operator hand-delivers to the user. The token is single-use.
   */
  issueInvite(sub: string, email: string, callbackUrl: string): string {
    const token = this.options.invites.issue({ sub, email, purpose: 'invite' });
    const url = new URL(callbackUrl);
    url.searchParams.set('invite', token);
    return url.toString();
  }

  private async handleSetPassword(form: Record<string, string>): Promise<InteractionResult> {
    const inviteToken = String(form.invite ?? '');
    const newPassword = String(form.password ?? '');
    if (!inviteToken || newPassword.length < 12) {
      return {
        kind: 'next-step',
        step: { kind: 'render-html', html: renderError('password must be at least 12 characters'), csrfToken: '' },
      };
    }

    const consume = this.options.invites.consume(inviteToken);
    if (!consume.ok) {
      return { kind: 'denied', reason: `invite token ${consume.reason}` };
    }
    if (consume.payload.purpose !== 'invite') {
      return { kind: 'denied', reason: 'token is not an invite' };
    }

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    const sub = consume.payload.sub;
    const externalSub = sub.replace(/^local_/, '');
    const now = Date.now();

    const existing = await this.options.storage.getAccount(sub);
    const account: LocalStoredAccount = {
      sub,
      provider: LOCAL_PROVIDER,
      externalSub,
      email: consume.payload.email,
      emailVerified: false, // local accounts don't verify email
      displayName: existing?.displayName ?? consume.payload.email,
      rawProfile: { passwordHash },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.options.storage.upsertAccount(account);

    return {
      kind: 'authenticated',
      identity: {
        sub,
        displayName: account.displayName,
        email: account.email,
        emailVerified: false,
      },
    };
  }

  private async handleLogin(
    form: Record<string, string>,
    _ctx: InteractionContext,
  ): Promise<InteractionResult> {
    const username = String(form.username ?? '').trim();
    const password = String(form.password ?? '');
    const ip = String(form.__ip ?? 'unknown'); // InteractionRouter would supply via input.query

    if (!username || !password) {
      return { kind: 'denied', reason: 'missing username or password' };
    }

    const sub = `${LOCAL_PROVIDER}_${username}`;
    const check = this.options.rateLimiter.check(sub, ip);
    if (!check.allowed) {
      return { kind: 'denied', reason: check.reason ?? 'rate limited' };
    }

    const account = (await this.options.storage.getAccount(sub)) as LocalStoredAccount | null;
    const passwordHash = account?.rawProfile?.passwordHash;

    let verified = false;
    if (passwordHash) {
      try {
        verified = await argon2.verify(passwordHash, password);
      } catch {
        verified = false;
      }
    } else {
      // Constant-time-ish: dummy verify to keep timing similar between
      // unknown-account and wrong-password cases.
      try {
        await argon2.verify(
          '$argon2id$v=19$m=19456,t=2,p=1$dummy$dummy',
          password,
        );
      } catch {
        // expected
      }
    }

    if (!verified) {
      await this.options.rateLimiter.noteFailure(sub, ip);
      return { kind: 'denied', reason: 'invalid credentials' };
    }

    await this.options.rateLimiter.noteSuccess(sub, ip);
    return {
      kind: 'authenticated',
      identity: {
        sub,
        displayName: account!.displayName,
        email: account!.email,
        emailVerified: false,
      },
    };
  }
}

function renderLoginOrInvitePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DollhouseMCP — Sign in</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f7f4; color: #181816; }
    main { max-width: 480px; margin: 8vh auto; padding: 32px; background: white; border: 1px solid #d8d6cc; border-radius: 8px; }
    label { display: block; margin-top: 12px; font-size: 14px; }
    input { display: block; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; border-radius: 4px; margin-top: 4px; }
    button { background: #185c37; color: white; border: 0; border-radius: 6px; padding: 12px 16px; font-weight: 700; cursor: pointer; margin-top: 16px; }
    .muted { color: #68675f; font-size: 14px; }
    fieldset { border: 0; padding: 0; margin: 24px 0; }
    legend { font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to DollhouseMCP</h1>

    <form method="post">
      <fieldset>
        <legend>Existing account</legend>
        <label>Username
          <input type="text" name="username" autocomplete="username">
        </label>
        <label>Password
          <input type="password" name="password" autocomplete="current-password">
        </label>
        <button type="submit" name="action" value="login">Sign in</button>
      </fieldset>
    </form>

    <form method="post">
      <fieldset>
        <legend>Invite redemption</legend>
        <p class="muted">Paste the URL the operator gave you and set a password.</p>
        <label>Invite token
          <input type="text" name="invite">
        </label>
        <label>New password (min 12 chars)
          <input type="password" name="password" autocomplete="new-password">
        </label>
        <button type="submit" name="action" value="set-password">Set password</button>
      </fieldset>
    </form>
  </main>
</body>
</html>`;
}

function renderError(message: string): string {
  return `<!doctype html><html><body><main><h1>Error</h1><p>${message
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p></main></body></html>`;
}
