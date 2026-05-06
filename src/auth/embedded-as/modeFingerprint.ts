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
  const sortedMethods = [...inputs.methodIds].sort();
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
 * Read the persisted fingerprint, compare to the current one, and write
 * the current one back. Returns metadata describing the comparison.
 *
 * The caller is responsible for acting on `changed === true` —
 * typically by calling `storage.clearGenericByModels(OAUTH_STATE_MODELS)`
 * and rotating the cookie signing secret.
 */
export async function checkAndPersistModeFingerprint(
  storage: IAuthStorageLayer,
  inputs: ModeFingerprintInputs,
): Promise<CheckModeFingerprintResult> {
  const current = computeFingerprint(inputs);
  const stored = (await storage.genericGet(FINGERPRINT_MODEL, FINGERPRINT_KEY)) as
    | { fingerprint?: string }
    | null;
  const previous = stored?.fingerprint;

  if (!previous) {
    await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, { fingerprint: current });
    return { changed: false, firstRun: true, current };
  }

  if (previous === current) {
    return { changed: false, firstRun: false, previous, current };
  }

  await storage.genericSet(FINGERPRINT_MODEL, FINGERPRINT_KEY, { fingerprint: current });
  return { changed: true, firstRun: false, previous, current };
}
