/**
 * modeFingerprint
 *
 * Implements must-fix #14 (mode-switch invalidation). At startup the AS
 * computes a fingerprint of its operating mode (provider, configured
 * methods, issuer URL, JWKS primary kid, cookie signing key) and
 * compares to the last-persisted fingerprint. When the fingerprint
 * changes, all previously-issued tokens are presumed invalid: an
 * operator who flipped DOLLHOUSE_AUTH_PROVIDER, swapped
 * DOLLHOUSE_AUTH_METHODS, or rotated keys should not have prior tokens
 * keep working. The AS clears OAuth-state K/V models and forces a fresh
 * cookie signing secret on the next request.
 *
 * The fingerprint itself is the SHA-256 of a JSON-serialized canonical
 * form of the inputs. Methods are sorted so order doesn't matter; the
 * cookie key is hashed (not stored raw) so the persisted fingerprint
 * is safe to log + persist.
 *
 * @module auth/embedded-as/modeFingerprint
 */

import { createHash } from 'node:crypto';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export const FINGERPRINT_MODEL = 'AuthModeFingerprint';
export const FINGERPRINT_KEY = 'current';

/** OAuth-state K/V models that get wiped on mode change. */
export const OAUTH_STATE_MODELS: readonly string[] = [
  'Session',
  'Grant',
  'AuthorizationCode',
  'AccessToken',
  'RefreshToken',
  'Interaction',
  'InteractionCsrf',
  'InteractionMethodChoice',
  'PushedAuthorizationRequest',
  'BackchannelAuthenticationRequest',
  // Cycle-16 fix: oidc-provider's PKCE replay-detection records are
  // tied to the prior signing key + issuer. Surviving them across a
  // mode-switch lets a previously-replayed code_verifier evade
  // replay detection in the new mode.
  'ReplayDetection',
];

export interface ModeFingerprintInputs {
  /** AuthConfig.provider (e.g. 'embedded' | 'oidc' | 'local'). */
  provider: string;
  /** Configured method ids; sorted by the fingerprint function. */
  methodIds: readonly string[];
  /** Canonical issuer URL the AS publishes. */
  issuer: string;
  /** Primary signing kid from the JWKS keyset. */
  primaryKid: string;
  /**
   * Primary cookie signing key (raw value). Hashed before inclusion in
   * the fingerprint so the persisted record is safe — a leak of the
   * fingerprint cannot recover the cookie key.
   */
  primaryCookieKey: string;
}

export function computeFingerprint(inputs: ModeFingerprintInputs): string {
  // Explicit codepoint comparison, NOT `localeCompare`. The fingerprint must be
  // stable across hosts and operating-system locales — a deploy on a host with
  // `LC_COLLATE=en_US.UTF-8` and a replica with `LC_COLLATE=C` would otherwise
  // compute different fingerprints for the same logical mode, triggering
  // spurious mode-switch invalidation. Sonar's S2871 (suggest `localeCompare`)
  // is the wrong fix here. NOSONAR
  const sortedMethods = [...inputs.methodIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cookieKeyHash = createHash('sha256')
    .update(inputs.primaryCookieKey)
    .digest('base64url');
  const canonical = JSON.stringify({
    p: inputs.provider,
    m: sortedMethods,
    i: inputs.issuer,
    k: inputs.primaryKid,
    c: cookieKeyHash,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

export interface CheckModeFingerprintResult {
  /** True when the persisted fingerprint differed from the current one. */
  changed: boolean;
  /** True when no fingerprint was persisted yet (first run, or post-clear). */
  firstRun: boolean;
  /** The previous fingerprint, when there was one. */
  previous?: string;
  /** The current fingerprint, always set. */
  current: string;
}

/**
 * Compare the current mode fingerprint to the persisted one. Returns
 * metadata describing the comparison. Does NOT persist on the
 * `changed: true` path — the caller MUST run the invalidation
 * (clearGenericByModels, rotate cookie secret, rotate signing key)
 * BEFORE calling `persistModeFingerprint` to record the new fingerprint.
 *
 * Why split the read and the write: a crash between fingerprint
 * persistence and OAuth-state clear leaves stale tokens valid against
 * the new mode (the next boot sees the new fingerprint, computes the
 * same fingerprint, decides nothing changed, and never clears). Clear
 * first, then persist — on a crash mid-sequence the next boot
 * recomputes `changed: true` and re-runs the (idempotent) clear.
 */
export async function checkModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
): Promise<CheckModeFingerprintResult> {
  const current = computeFingerprint(inputs);
  const stored = (await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)) as
    | { fingerprint?: string }
    | null;
  const previous = stored?.fingerprint;

  if (!previous) {
    return { changed: false, firstRun: true, current };
  }

  if (previous === current) {
    return { changed: false, firstRun: false, previous, current };
  }

  return { changed: true, firstRun: false, previous, current };
}

/**
 * Persist the current mode fingerprint. Caller MUST run all
 * invalidation work first; this is the last step in the sequence so
 * a crash mid-sequence is safe (next boot recomputes `changed: true`
 * and re-runs the idempotent invalidation).
 */
export async function persistModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
): Promise<void> {
  const current = computeFingerprint(inputs);
  await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, { fingerprint: current });
}

