/**
 * Sign-in allowlist gate.
 *
 * Shared decision function called by every auth method (GitHub OAuth
 * callback, magic-link consume, local-password invite redeem) after the
 * method has verified the user's identity but before the account is
 * upserted. Returns `{ allowed: true }` or `{ allowed: false, reason }`.
 *
 * Decision rules (in order — first match wins):
 *
 *   1. Bootstrap admin always passes. The pre-claimed admin identity
 *      cannot be locked out even with `REQUIRED=true` and an empty
 *      allowlist. Without this safety rail, an operator who sets
 *      REQUIRED=true with an empty list would lock themselves out on
 *      first sign-in.
 *
 *   2. If the supplied identity matches any allowlist entry → PASS.
 *
 *   3. If `REQUIRED=true` and no match → DENY. The operator has
 *      explicitly opted into the strict mode; absence of a match means
 *      the user isn't authorized.
 *
 *   4. If `REQUIRED=false` and the allowlist is empty → PASS. Back-compat
 *      for deployments that never configure an allowlist — the gate is
 *      effectively off. (The startup warning in AuthProviderFactory
 *      nudges operators toward setting REQUIRED=true for non-loopback
 *      deploys with social methods.)
 *
 *   5. Otherwise (REQUIRED=false, list populated, no match) → DENY. The
 *      operator clearly intended a gate; the user just isn't on it.
 *
 * On denial, emits an `auth.allowlist_denied` event to the audit log.
 * Callers should surface a clean "access denied" response to the user
 * (friendly HTML for browser flows; structured error for API flows).
 *
 * @module auth/embedded-as/allowlistGate
 */

import { logger } from '../../utils/logger.js';
import type {
  AuthAllowlistEntry,
  AllowlistMatchValues,
  IAuthStorageLayer,
} from './storage/IAuthStorageLayer.js';
import { isBootstrapAdminFor } from './bootstrapAdmin.js';

/** Caller-supplied identity values to match against the allowlist. */
export interface AllowlistGateIdentity {
  /** Verified sub (e.g. `github_42`, `local_alice`, `magic-link_<hash>`). Used for audit + bootstrap-admin check. */
  sub: string;
  /** Method id that triggered the gate. Used for the bootstrap-admin method check + audit. */
  method: 'github' | 'magic-link' | 'local-password';
  /** Verified primary email (lowercased before match). */
  email?: string;
  /** GitHub login (lowercased before match). Only applies to the github method. */
  githubUsername?: string;
  /** GitHub numeric id as a string. Only applies to the github method. */
  githubId?: string;
  /** External provider sub for the audit row (e.g. GitHub numeric id, email hash). */
  externalSub?: string;
  /** Provider name for the audit row ('github', 'local', 'magic-link'). */
  provider?: string;
}

/** Gate outcome. Caller picks the response shape (HTML / JSON / next step). */
export type AllowlistGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface AllowlistGateOptions {
  /** Storage backend that holds the allowlist + bootstrap state + audit log. */
  storage: IAuthStorageLayer;
  /**
   * Optional sign-in allowlist authority. When omitted, the legacy
   * IAuthStorageLayer allowlist remains authoritative.
   */
  authority?: SignInAllowlistAuthority | undefined;
  /** `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED` env value. */
  required: boolean;
}

export interface SignInAllowlistAuthority {
  matchesIdentity(values: AllowlistMatchValues): Promise<boolean>;
  hasAnyEntries(): Promise<boolean>;
  listEntries(): Promise<AuthAllowlistEntry[]>;
}

/**
 * Read-path adapter for AS sign-in cutover only.
 *
 * This intentionally overrides allowlist reads while leaving all other
 * IAuthStorageLayer behavior on the wrapped storage. Do not pass the wrapped
 * object to allowlist administration/write paths: writes would still go to the
 * legacy storage while sign-in reads come from the injected authority.
 */
export function withSignInAllowlistAuthority(
  storage: IAuthStorageLayer,
  authority: SignInAllowlistAuthority,
): IAuthStorageLayer {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'allowlistMatchesIdentity') return authority.matchesIdentity.bind(authority);
      if (property === 'allowlistList') return authority.listEntries.bind(authority);
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Check whether the supplied identity is allowed to complete sign-in.
 * On denial, the function also writes the `auth.allowlist_denied` audit
 * event before returning — callers don't need to.
 */
export async function checkAllowlistGate(
  identity: AllowlistGateIdentity,
  options: AllowlistGateOptions,
): Promise<AllowlistGateResult> {
  const { storage, required } = options;
  const authority = options.authority ?? legacyStorageAuthority(storage);

  // Rule 1: bootstrap admin always passes.
  if (await isBootstrapAdminFor(storage, identity.sub, identity.method)) {
    return { allowed: true };
  }

  // Rule 2: any-kind match wins.
  const matched = await authority.matchesIdentity({
    email: identity.email,
    githubUsername: identity.githubUsername,
    githubId: identity.githubId,
  });
  if (matched) {
    return { allowed: true };
  }

  // Rule 3: REQUIRED=true with no match → DENY.
  // Rule 4: REQUIRED=false with empty list → PASS (back-compat).
  // Rule 5: REQUIRED=false with populated list but no match → DENY.
  if (!required && !await authority.hasAnyEntries()) {
    // Back-compat: gate is effectively off.
    return { allowed: true };
  }

  // Audit-log the denial before returning.
  await recordDenied(storage, identity);

  return {
    allowed: false,
    reason: required
      ? 'Sign-in allowlist is required and this identity is not on it.'
      : 'This identity is not on the sign-in allowlist.',
  };
}

function legacyStorageAuthority(storage: IAuthStorageLayer): SignInAllowlistAuthority {
  return {
    matchesIdentity: values => storage.allowlistMatchesIdentity(values),
    hasAnyEntries: async () => (await storage.allowlistList()).length > 0,
    listEntries: () => storage.allowlistList(),
  };
}

/**
 * Friendly HTML page rendered when the allowlist gate denies a sign-in.
 *
 * Pinned to the same minimal style used by `renderInteractionBindingError`
 * and the magic-link / invite error pages so denied users get a coherent
 * visual experience across the AS — neither a raw 403 JSON blob nor a
 * generic Express error stack.
 *
 * The message deliberately does NOT echo back the user's email or other
 * identity values. Reasons:
 *   - PII reflection in error pages: a denied attacker who probed with
 *     someone else's email shouldn't see it reflected back.
 *   - Phishing: an attacker who controls the URL could social-engineer
 *     the page text by injecting their own email into the redirect.
 *   - Auditability: the operator's audit log has the full identity; the
 *     user-facing page doesn't need it.
 *
 * `contactNote` is optional operator-supplied text (e.g. "If you believe
 * this is in error, email admin@yourdomain.com"). HTML-escaped on render.
 */
export function renderAllowlistDeniedPage(contactNote?: string): string {
  const note = contactNote
    ? `<p>${contactNote.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Access denied</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:480px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}h1{margin-top:0}</style>
</head><body><main>
<h1>Access denied</h1>
<p>Your sign-in was rejected by this server's access policy.</p>
<p>If you reached this page unexpectedly, the operator may not have added your account to the sign-in allowlist. Contact the deployment's administrator.</p>
${note}
</main></body></html>`;
}

async function recordDenied(storage: IAuthStorageLayer, identity: AllowlistGateIdentity): Promise<void> {
  try {
    // Identity values are PII-bearing. Log them at debug-friendly detail level
    // (operator can see who tried) but not the full raw profile. Email is most
    // useful for operator-side diagnosis ("Mick tried to sign in but isn't on
    // the list"). Build the optional fields incrementally to avoid noisy
    // negated-conditional spreads.
    const details: Record<string, unknown> = { method: identity.method };
    if (identity.email !== undefined) details.email = identity.email;
    if (identity.githubUsername !== undefined) details.githubUsername = identity.githubUsername;

    const event: Parameters<IAuthStorageLayer['recordIdentityEvent']>[0] = {
      type: 'auth.allowlist_denied',
      sub: identity.sub,
      details,
      timestamp: Date.now(),
    };
    if (identity.provider !== undefined) event.provider = identity.provider;
    if (identity.externalSub !== undefined) event.externalSub = identity.externalSub;

    await storage.recordIdentityEvent(event);
  } catch (err) {
    // Audit emission failures must not block the deny path — log and
    // continue. The user still gets denied; the audit gap is the
    // operator's problem to address.
    logger.warn('[allowlistGate] audit event emit failed', {
      error: err instanceof Error ? err.message : String(err),
      method: identity.method,
      sub: identity.sub,
    });
  }
}
