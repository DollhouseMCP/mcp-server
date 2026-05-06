/**
 * cookieSecret
 *
 * Loads or generates the secret used by oidc-provider's `cookies.keys`
 * for keygrip-style cookie signing. This MUST be independent from the
 * JWKS signing key:
 *   - The JWKS `kid` is published at /jwks for clients to verify our
 *     access tokens. It is public.
 *   - oidc-provider's `cookies.keys` are HMAC inputs — anyone who knows
 *     a key can forge any signed cookie the AS issues. They MUST be
 *     private.
 *
 * Earlier code seeded `cookies.keys` from the JWKS kid, which made every
 * cookie forgeable by anyone who could read the JWKS endpoint.
 *
 * @module auth/embedded-as/cookieSecret
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';

/**
 * Resolves to `<run-dir>/cookie-signing-secret.bin`. The run directory is
 * platform-correct (XDG / Library / LOCALAPPDATA) and respects
 * `DOLLHOUSE_RUN_DIR` / `DOLLHOUSE_HOME_DIR` env overrides via the central
 * resolver — no hardcoded `~/.dollhouse/` paths.
 */
export function defaultCookieSecretFilePath(legacyRoot?: string): string {
  return path.join(
    resolveDataDirectory('run', legacyRoot ? { legacyRoot } : {}),
    'cookie-signing-secret.bin',
  );
}

/**
 * Returns the keygrip key array oidc-provider's `cookies.keys` config
 * accepts. **One key only** — see "Rotation" below for why the prior
 * `[primary, primary]` shape was misleading.
 *
 * If the env var `DOLLHOUSE_COOKIE_SIGNING_SECRET` is set (hex-encoded,
 * ≥32 bytes) it overrides the file — useful for multi-instance deploys
 * where every instance needs the same key.
 *
 * **Rotation.** keygrip is structured for rotation: keys.keys[0] signs
 * new cookies; keys.keys[1..] verify legacy cookies during a rolling
 * transition. The earlier implementation returned `[primary, primary]`
 * (the same key in both slots), which advertised rotation support
 * without delivering it — operators following the comment would have
 * been surprised on rotation day. The honest position today is:
 *
 *   - There is exactly one cookie signing key in scope at any time.
 *   - Rotation happens via `rotateCookieSecret()` from the mode-switch
 *     path (must-fix #14): the file is unlinked, the next AS init
 *     regenerates it, and all prior cookies are invalidated atomically.
 *   - Multi-key keygrip (rolling rotation without invalidation) would
 *     require reading N keys from disk + a separate "promote a new key"
 *     CLI; tracked as a follow-up, not §8.1 scope.
 */
export function loadOrGenerateCookieSigningKeys(filePath?: string): [string] {
  const envSecret = process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET?.trim();
  if (envSecret && envSecret.length > 0) {
    const buf = Buffer.from(envSecret, 'hex');
    if (buf.length < 32) {
      throw new Error('DOLLHOUSE_COOKIE_SIGNING_SECRET must decode to at least 32 bytes (hex)');
    }
    return [buf.toString('base64')];
  }

  const target = filePath ?? defaultCookieSecretFilePath();
  try {
    const buf = fs.readFileSync(target);
    if (buf.length >= 32) {
      return [buf.toString('base64')];
    }
    // Operator-deployed file is too short to be safe; replacing it is
    // correct but a silent overwrite would leave them wondering why
    // their configured secret had no effect.
    logger.warn(
      `[cookieSecret] file at ${target} is shorter than 32 bytes; regenerating. ` +
      `Any previous cookies signed with the prior key will be invalidated.`,
    );
  } catch {
    // Missing file is the normal first-run path; fall through silently.
  }

  const fresh = randomBytes(32);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fresh, { mode: 0o600 });
  return [fresh.toString('base64')];
}

/**
 * Force-rotate the cookie signing secret (must-fix #14 mode-switch).
 *
 * Removes the persisted secret file so the next call to
 * `loadOrGenerateCookieSigningKeys` will mint a fresh key. All cookies
 * signed with the prior key become invalid on next request — exactly
 * the desired behavior when the AS detects its operating mode has
 * changed since last run.
 *
 * Idempotent: missing file is not an error. Honors the
 * DOLLHOUSE_COOKIE_SIGNING_SECRET env override by NOT touching the file
 * (an env-supplied secret is the operator's responsibility to rotate).
 */
export function rotateCookieSecret(filePath?: string): void {
  if (process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET?.trim()) return;
  const target = filePath ?? defaultCookieSecretFilePath();
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
