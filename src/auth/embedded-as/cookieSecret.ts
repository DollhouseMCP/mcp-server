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
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';

export function defaultCookieSecretFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'cookie-signing-secret.bin');
}

/**
 * Returns two base64-encoded keys: the active signing key and a previous
 * one for rotation grace. The two are equal at first generation; a future
 * rotation procedure prepends a fresh key and demotes the existing one.
 *
 * If the env var `DOLLHOUSE_COOKIE_SIGNING_SECRET` is set (hex-encoded,
 * ≥32 bytes) it overrides the file — useful for multi-instance deploys
 * where every instance needs the same key.
 */
export function loadOrGenerateCookieSigningKeys(filePath?: string): [string, string] {
  const envSecret = process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET?.trim();
  if (envSecret && envSecret.length > 0) {
    const buf = Buffer.from(envSecret, 'hex');
    if (buf.length < 32) {
      throw new Error('DOLLHOUSE_COOKIE_SIGNING_SECRET must decode to at least 32 bytes (hex)');
    }
    const primary = buf.toString('base64');
    return [primary, primary];
  }

  const target = filePath ?? defaultCookieSecretFilePath();
  try {
    const buf = fs.readFileSync(target);
    if (buf.length >= 32) {
      const primary = buf.toString('base64');
      return [primary, primary];
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
  const primary = fresh.toString('base64');
  return [primary, primary];
}
