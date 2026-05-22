/**
 * LocalAccountMethod
 *
 * Stage C auth method: username + argon2id-hashed password. First-credential
 * delivery uses the inviteTokens flow (must-fix #17) — operator runs
 * `dollhouse-create-user`, gets a one-time URL, hand-delivers; user
 * sets their own password on first visit. Operator never sees a password.
 *
 * Login attempts go through LocalLoginRateLimiter (must-fix #16):
 * per-account exponential backoff after 5 failures, per-IP lockout after 20.
 *
 * Both the invite-acceptance flow AND the login flow are served on the
 * same /interaction/:uid endpoint — the render-html step branches on
 * whether an `invite=` query parameter is present. This was originally
 * a workaround for single-method-per-AS, kept after Phase 2 multi-
 * method shipped because the two sub-flows belong on the same form for
 * the user (one URL, no extra hop).
 *
 * @module auth/embedded-as/methods/LocalAccountMethod
 */

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
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
import type { IAuthStorageLayer, StoredAccount } from '../storage/IAuthStorageLayer.js';
import type { InviteTokenStore } from '../inviteTokens.js';
import type { LocalLoginRateLimiter } from '../rateLimit.js';
import { isBootstrapAdminFor } from '../bootstrapAdmin.js';
import { checkAllowlistGate, renderAllowlistDeniedPage } from '../allowlistGate.js';

const LOCAL_PROVIDER = 'local';
/** Single error reason returned to users; precise causes go to logs only. */
const GENERIC_INVITE_INVALID = 'this invite is no longer valid';
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP 2024 recommendation
  timeCost: 2,
  parallelism: 1,
};
/**
 * Cap password byte length before argon2.hash. argon2's CPU cost is set
 * by ARGON2_OPTIONS, but the pre-hash buffering is linear in input size
 * — a multi-MB password ties the event loop for hundreds of ms.
 * 1024 chars is well above any realistic passphrase + symbol budget.
 * Body parsers cap requests at 4KB; this is defense-in-depth in case a
 * future endpoint loosens that.
 */
const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_LENGTH = 12;

/**
 * Lazy-initialised reference hash for the unknown-account login path.
 *
 * Without it `argon2.verify` on a malformed hash string throws in
 * microseconds, while a real verify takes ~30 ms — leaking
 * username existence via timing (CWE-208). Generating a real argon2
 * hash here ensures the unknown-account branch pays the same cost as
 * the wrong-password branch.
 *
 * Cached as a promise so we pay the ~30 ms hash cost once per process,
 * not once per failed login. The random input is never used for
 * verification — verify always fails — so its value is irrelevant.
 */
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = argon2.hash(
      randomBytes(16).toString('hex'),
      ARGON2_OPTIONS,
    );
  }
  return dummyPasswordHashPromise;
}

export interface LocalAccountMethodOptions {
  storage: IAuthStorageLayer;
  invites: InviteTokenStore;
  rateLimiter: LocalLoginRateLimiter;
  /**
   * Sign-in allowlist enforcement. Mirrors `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED`.
   * When `true`, an empty allowlist means "bootstrap admin only"; when
   * `false` (default), an empty allowlist means "no gate". Bootstrap admin
   * always passes. The gate fires on invite-redemption (account creation)
   * AND on password login — the latter means even with a valid existing
   * account, an operator can revoke access by removing the user from the
   * allowlist.
   */
  allowlistRequired?: boolean;
}

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
    _ctx: InteractionContext,
    input: InteractionInput,
  ): Promise<InteractionResult> {
    const form = input.formBody ?? {};
    const action = String(form.action ?? '');

    if (action === 'set-password') {
      return this.handleSetPassword(form);
    }

    if (action === 'login') {
      return this.handleLogin(form, input.ip ?? 'unknown');
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
   * Issue an invite for `dollhouse-create-user`. Returns the URL the
   * operator hand-delivers to the user. The token is single-use.
   */
  issueInvite(sub: string, email: string, callbackUrl: string): string {
    const token = this.options.invites.issue({ sub, email, purpose: 'invite' });
    const url = new URL(callbackUrl);
    url.searchParams.set('invite', token);
    return url.toString();
  }

  /**
   * Verify an invite without consuming it. Used by the GET /auth/local/invite
   * handler so the password-set form only renders for valid tokens.
   *
   * Returns a single generic reason on failure (invalid signature, expired,
   * wrong purpose). See MagicLinkMethod.verifyMagicLink for rationale —
   * differentiating these cases would let an attacker confirm token
   * capture via an oracle.
   */
  verifyInvite(token: string):
    | { ok: true; sub: string; email: string }
    | { ok: false; reason: string }
  {
    const verified = this.options.invites.verify(token);
    if (!verified.ok) return { ok: false, reason: GENERIC_INVITE_INVALID };
    if (verified.payload.purpose !== 'invite') {
      return { ok: false, reason: GENERIC_INVITE_INVALID };
    }
    return { ok: true, sub: verified.payload.sub, email: verified.payload.email };
  }

  /**
   * Consume an invite token and create the local account with the user's
   * chosen password. Used by both the POST /interaction/:uid path (when
   * LocalAccountMethod is the active method during an OAuth flow) and the
   * standalone POST /auth/local/invite path (when the user clicks an
   * out-of-band CLI-issued invite URL).
   */
  async consumeInvite(token: string, newPassword: string): Promise<
    | { kind: 'ok'; sub: string; email: string }
    | { kind: 'denied'; reason: string }
    | { kind: 'error'; reason: string }
  > {
    if (!token || newPassword.length < MIN_PASSWORD_LENGTH) {
      return { kind: 'error', reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    // Cycle-17 fix: bound the input to argon2.hash. Same generic error
    // shape as the minimum check so the cap is not a probe-able signal.
    if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
      return { kind: 'error', reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }

    // Step 1 — verify (no consume). Cheap. If the token is invalid /
    // expired we bail before paying the argon2 hash cost.
    const verified = this.options.invites.verify(token);
    if (!verified.ok || verified.payload.purpose !== 'invite') {
      return { kind: 'error', reason: GENERIC_INVITE_INVALID };
    }

    // Step 2 — consume (CAS) BEFORE argon2 hashing. Cycle 19 / security-#1:
    // the previous order (verify → hash → consume) paid the ~30ms argon2
    // cost on every replay of a captured-but-already-consumed invite URL,
    // creating a sustained-CPU-pin DoS surface. Hand-delivered invite URLs
    // can leak (Slack DM forwards, screen-shares, email-forward) and the
    // attacker keeps replaying for the 15-minute TTL. Reordering means
    // replays cost only one DB read + the consumed-jti CAS check.
    //
    // Tradeoff: if argon2 fails AFTER successful consume (process pressure,
    // OOM), the invite is gone and the user must request a fresh one from
    // the operator. The DoS attack surface outweighs the rare-failure UX
    // cost — we'd rather degrade one user's flow than open a CPU-pin
    // primitive to anyone with a captured URL.
    const consume = await this.options.invites.consume(token);
    if (!consume.ok) {
      // rate-exceeded is server-side capacity, not a token problem; log so
      // the operator sees the saturation instead of misreading the user-
      // facing "invite invalid" page as a token issue.
      if (consume.reason === 'rate-exceeded') {
        logger.warn('[LocalAccountMethod] invite consume refused: rate-exceeded');
        return { kind: 'error', reason: 'server is busy, please try again shortly' };
      }
      return { kind: 'error', reason: GENERIC_INVITE_INVALID };
    }
    if (consume.payload.purpose !== 'invite') {
      return { kind: 'error', reason: GENERIC_INVITE_INVALID };
    }

    // Step 3 — hash the password. By this point the invite is consumed
    // and the CAS guarantees no other request can re-enter this path with
    // the same token. Hash failures here cost the user the invite (they
    // request another) but cannot be amplified into a DoS.
    let passwordHash: string;
    try {
      passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    } catch (err) {
      logger.warn('[LocalAccountMethod] argon2 hash failed AFTER invite consume — user must request a fresh invite', {
        error: err instanceof Error ? err.message : String(err),
        sub: consume.payload.sub,
      });
      return { kind: 'error', reason: 'failed to hash password, please request a new invite' };
    }

    const sub = consume.payload.sub;
    const externalSub = sub.replace(/^local_/, '');
    const now = Date.now();

    // Sign-in allowlist gate. Runs AFTER the invite has been consumed
    // (the operator-issued token is the cost of admission to even
    // reach this point) but BEFORE the account is created — a denied
    // invite-redemption leaves no account row. The invite itself is
    // burned in the consume call above; a re-allowlisted user needs a
    // fresh invite. Bootstrap admin always passes via rule 1.
    const gate = await checkAllowlistGate(
      {
        sub,
        method: 'local-password',
        email: consume.payload.email,
        provider: LOCAL_PROVIDER,
        externalSub,
      },
      { storage: this.options.storage, required: this.options.allowlistRequired ?? false },
    );
    if (!gate.allowed) {
      return { kind: 'denied', reason: gate.reason };
    }

    // Bootstrap admin claim (must-fix #22 / spec L923): if the
    // bootstrap-state pre-claim names this sub as the admin, the
    // account being created here gets `roles: ['admin']`. The pre-
    // claim was written by the create-user CLI BEFORE this user
    // received their invite link, so any other identity that somehow
    // redeemed the URL without being the pre-claimed admin would NOT
    // be granted admin (they'd just be a regular account).
    //
    // Round 5 / H5: roles are written via setAccountRoles AFTER
    // upsertAccount rather than spread into the upsert. Spreading
    // `...(isAdmin ? { roles: [...] } : {})` quietly clobbered any
    // previously-assigned roles for non-admin users on every login
    // (full-row replacement + missing field = roles wiped). Splitting
    // the writes preserves whatever roles were on the row before.
    const isBootstrapAdmin = await isBootstrapAdminFor(this.options.storage, sub, 'local-password');

    const existing = await this.options.storage.getAccount(sub);
    const account: StoredAccount = {
      sub,
      provider: LOCAL_PROVIDER,
      externalSub,
      email: consume.payload.email,
      emailVerified: false, // local accounts don't verify email
      displayName: existing?.displayName ?? consume.payload.email,
      // Credentials live on a typed sibling field, NOT inside rawProfile.
      // rawProfile is documented as audit-safe; the password hash is not.
      credentials: { passwordHash },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Preserve any pre-existing roles across upserts; setAccountRoles
      // below applies the admin-role write only when this is the
      // pre-claimed bootstrap admin.
      ...(existing?.roles ? { roles: existing.roles } : {}),
    };
    await this.options.storage.upsertAccount(account);
    if (isBootstrapAdmin) {
      await this.options.storage.setAccountRoles(sub, ['admin']);
    }

    return { kind: 'ok', sub, email: consume.payload.email };
  }

  private async handleSetPassword(form: Record<string, string>): Promise<InteractionResult> {
    const inviteToken = String(form.invite ?? '');
    const newPassword = String(form.password ?? '');
    const result = await this.consumeInvite(inviteToken, newPassword);
    if (result.kind === 'error') {
      // Terminal token errors deny the OAuth flow outright (the token is
      // dead — re-rendering the form would just let the user re-submit the
      // same dead token). Recoverable errors (password too short) re-render
      // the form so the user can fix their input.
      const recoverable = /password must be at least/.test(result.reason);
      if (recoverable) {
        return {
          kind: 'next-step',
          step: { kind: 'render-html', html: renderError(result.reason), csrfToken: '' },
        };
      }
      return { kind: 'denied', reason: result.reason };
    }
    if (result.kind === 'denied') {
      // Allowlist gate denied this identity; audit event already recorded.
      // The OAuth interaction terminates with a denial — the invite token
      // was already consumed in the call above so re-submitting won't work.
      return { kind: 'denied', reason: result.reason };
    }
    return {
      kind: 'authenticated',
      identity: {
        sub: result.sub,
        displayName: result.email,
        email: result.email,
        emailVerified: false,
      },
    };
  }

  /** Used by /auth/local/invite GET to render the password-set form. */
  renderInviteForm(token: string, email: string): string {
    return renderInvitePage(token, email);
  }

  /** Success page rendered by /auth/local/invite POST after the password is set. */
  renderInviteSuccess(email: string): string {
    return renderInviteSuccess(email);
  }

  /**
   * Mounts the standalone CLI-issued invite redemption flow:
   *   GET  /auth/local/invite?invite=<token>   — renders password-set form
   *   POST /auth/local/invite                  — consumes invite, creates account
   *
   * This flow is independent of an active OAuth interaction. After the
   * password is set, the user signs in via their MCP client which starts
   * the normal OAuth flow.
   */
  contributeRoutes(router: Router, _deps: ContributeRoutesDeps): void {
    // Limit POST body to 4 KB so unauthenticated requests can't flood memory.
    const bodyParser = express.urlencoded({ extended: false, limit: '4kb' });

    router.get('/auth/local/invite', (req, res, next) => {
      void (async () => {
        try {
          const token = typeof req.query.invite === 'string' ? req.query.invite : '';
          const verified = this.verifyInvite(token);
          if (!verified.ok) {
            res.status(400).type('html').send(renderInviteError(verified.reason));
            return;
          }
          res.type('html').send(this.renderInviteForm(token, verified.email));
        } catch (err) {
          next(err);
        }
      })();
    });

    router.post('/auth/local/invite', bodyParser, (req, res, next) => {
      void (async () => {
        try {
          const body = req.body as Record<string, string> | undefined;
          const token = typeof body?.invite === 'string' ? body.invite : '';
          const password = typeof body?.password === 'string' ? body.password : '';
          const result = await this.consumeInvite(token, password);
          if (result.kind === 'error') {
            res.status(400).type('html').send(renderInviteError(result.reason));
            return;
          }
          if (result.kind === 'denied') {
            // Allowlist denied the redemption. Render the dedicated
            // denied page (rather than renderInviteError, which reads
            // as "your invite is broken" — the invite was fine; the
            // identity just isn't allowlisted).
            res.status(403).type('html').send(renderAllowlistDeniedPage());
            return;
          }
          res.type('html').send(this.renderInviteSuccess(result.email));
        } catch (err) {
          next(err);
        }
      })();
    });
  }

  private async handleLogin(
    form: Record<string, string>,
    ip: string,
  ): Promise<InteractionResult> {
    // Lowercase + trim so 'Alice' and 'alice' don't get independent rate-limit
    // buckets — otherwise an attacker can bypass the per-account threshold by
    // varying case.
    const username = String(form.username ?? '').trim().toLowerCase();
    const password = String(form.password ?? '');

    if (!username || !password) {
      return { kind: 'denied', reason: 'missing username or password' };
    }
    // Cycle-17 fix: bound the input to argon2.verify. The dummy-hash
    // timing-equalization branch also calls argon2.verify, so we cap
    // BEFORE choosing branches — otherwise an attacker on the
    // unknown-account path can DoS via long input even though they
    // never submit a real password.
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return { kind: 'denied', reason: 'invalid username or password' };
    }

    const sub = `${LOCAL_PROVIDER}_${username}`;
    const check = await this.options.rateLimiter.check(sub, ip);
    if (!check.allowed) {
      return { kind: 'denied', reason: check.reason ?? 'rate limited' };
    }

    const account = await this.options.storage.getAccount(sub);
    const passwordHash = account?.credentials?.passwordHash;

    let verified = false;
    if (passwordHash) {
      try {
        verified = await argon2.verify(passwordHash, password);
      } catch {
        verified = false;
      }
    } else {
      // Constant-time-ish: real argon2.verify against a real hash so the
      // unknown-account path pays the same ~30 ms cost as the
      // wrong-password path. A malformed hash string throws in
      // microseconds and would leak username existence via timing.
      try {
        await argon2.verify(await getDummyPasswordHash(), password);
      } catch {
        // verify returns false on mismatch; throw is the malformed-input
        // path, which we never enter now that the hash is real.
      }
    }

    if (!verified) {
      await this.options.rateLimiter.noteFailure(sub, ip);
      return { kind: 'denied', reason: 'invalid credentials' };
    }

    // Sign-in allowlist gate. Runs AFTER password verification succeeds
    // so we don't leak "this user is on the allowlist" via timing/error
    // to a brute-forcer. An operator who removes a user from the allowlist
    // can lock out future logins even when the credentials still work.
    // Bootstrap admin always passes via rule 1.
    const gate = await checkAllowlistGate(
      {
        sub,
        method: 'local-password',
        email: account?.email,
        provider: LOCAL_PROVIDER,
        externalSub: sub.replace(/^local_/, ''),
      },
      { storage: this.options.storage, required: this.options.allowlistRequired ?? false },
    );
    if (!gate.allowed) {
      // Generic message — don't disclose whether the failure was credentials
      // or allowlist. Audit event was recorded by the gate.
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
  return `<!doctype html><html><body><main><h1>Error</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/**
 * Styled error page for invite-redemption failures (CLI-issued URL clicked
 * after the token expired or was already consumed). Distinct from
 * `renderError` (used inside the OAuth interaction flow for recoverable
 * input errors) — invite errors are terminal and the operator must
 * issue a fresh invite.
 */
function renderInviteError(reason: string): string {
  const safe = escapeHtml(reason);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invite invalid</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main><h1>Invite invalid</h1><p>${safe}</p><p>Ask your operator to issue a new invite.</p></main></body></html>`;
}

function renderInvitePage(token: string, email: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Set up your DollhouseMCP account</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:480px;margin:8vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}label{display:block;margin-top:12px;font-size:14px}input{display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:4px;margin-top:4px}button{background:#185c37;color:white;border:0;border-radius:6px;padding:12px 16px;font-weight:700;cursor:pointer;margin-top:16px}.muted{color:#68675f;font-size:14px}</style>
</head><body><main>
<h1>Set up your account</h1>
<p>Welcome, <strong>${escapeHtml(email)}</strong>. Choose a password (at least 12 characters).</p>
<form method="post">
  <input type="hidden" name="invite" value="${escapeHtmlAttr(token)}">
  <label>New password
    <input type="password" name="password" autocomplete="new-password" required minlength="12">
  </label>
  <button type="submit">Set password</button>
</form>
<p class="muted">After you set your password, you can sign in via Claude Desktop or claude.ai.</p>
</main></body></html>`;
}

function renderInviteSuccess(email: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Account created</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:480px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main>
<h1>Account created</h1>
<p>Your password is set for <strong>${escapeHtml(email)}</strong>.</p>
<p>Connect your MCP client (Claude Desktop, claude.ai, etc.) to this server and sign in
   when prompted using the username your operator gave you.</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll('\'', '&#39;');
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
