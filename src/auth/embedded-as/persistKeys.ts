/**
 * persistKeys
 *
 * Loads or generates the embedded AS signing keypair (ES256 / P-256).
 * Persists the JWK at mode 0600 in a config dir. Used by
 * EmbeddedAuthorizationServer to seed oidc-provider's `jwks` config.
 *
 * Design notes:
 *   - The same on-disk format the dev's hand-rolled provider used, so
 *     existing operators with a key file keep their kid + key material
 *     across the C4 cutover.
 *   - oidc-provider expects a JSON Web Keyset object ({ keys: [...] }).
 *     loadOrGenerateSigningJwks returns the full keyset including the
 *     private key portion as required by oidc-provider for signing.
 *
 * @module auth/embedded-as/persistKeys
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';

const ALGORITHM = 'ES256';

interface StoredKeyPair {
  kid: string;
  privateKey: JWK;
  publicKey: JWK;
  generatedAt: string;
}

export interface SigningKeyset {
  /** Full JWKS-compatible object passed to oidc-provider's `jwks` config. */
  jwks: { keys: JWK[] };
  /** The active key id (matches the kid in jwks.keys[0]). */
  kid: string;
}

/**
 * Resolves to `<run-dir>/oauth-signing-key.json`. The run directory is
 * platform-correct (XDG / Library / LOCALAPPDATA) and respects
 * `DOLLHOUSE_RUN_DIR` / `DOLLHOUSE_HOME_DIR` env overrides via the central
 * resolver — no hardcoded `~/.dollhouse/` paths.
 */
export function defaultKeyFilePath(legacyRoot?: string): string {
  return path.join(
    resolveDataDirectory('run', legacyRoot ? { legacyRoot } : {}),
    'oauth-signing-key.json',
  );
}

/**
 * Load the persisted keypair if present; generate and persist a new one
 * otherwise. Returns the keyset shape oidc-provider expects.
 */
export async function loadOrGenerateSigningJwks(keyFilePath: string): Promise<SigningKeyset> {
  try {
    const raw = await fs.readFile(keyFilePath, 'utf-8');
    const stored = JSON.parse(raw) as StoredKeyPair;
    if (stored.kid && stored.privateKey && stored.publicKey) {
      logger.info(`[persistKeys] Loaded signing key from ${keyFilePath}`);
      return {
        kid: stored.kid,
        jwks: { keys: [{ ...stored.privateKey, kid: stored.kid, alg: ALGORITHM, use: 'sig' }] },
      };
    }
    // File exists but is structurally wrong (missing required fields).
    // Treat as corrupt and regenerate; log so operators see the event.
    logger.warn(`[persistKeys] key file at ${keyFilePath} is missing required fields; regenerating. ` +
      `All previously-issued tokens will fail validation.`);
  } catch (err) {
    // Cycle-16 fix: only fall through to generation on ENOENT or
    // SyntaxError (corrupt JSON). Other errors (EACCES, EISDIR) mean
    // the file probably exists but is unreadable — silently generating
    // a new key invalidates every previously-issued access token with
    // no operator signal beyond an info log.
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof SyntaxError) {
      logger.warn(`[persistKeys] key file at ${keyFilePath} is corrupt JSON; regenerating. ` +
        `All previously-issued tokens will fail validation.`,
        { error: err.message });
    } else if (code !== 'ENOENT') {
      throw err;
    }
  }

  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const kid = `dh-${randomUUID()}`;
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  const stored: StoredKeyPair = {
    kid,
    privateKey: { ...privateJwk, kid, alg: ALGORITHM },
    publicKey: { ...publicJwk, kid, alg: ALGORITHM, use: 'sig' },
    generatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(keyFilePath), { recursive: true });
  await fs.writeFile(keyFilePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  logger.info(`[persistKeys] Generated new signing key at ${keyFilePath}`);

  return {
    kid,
    jwks: { keys: [{ ...stored.privateKey }] },
  };
}

/**
 * Delete the persisted signing keyfile so the next
 * `loadOrGenerateSigningJwks` call mints a fresh keypair under a new
 * kid. Used by the mode-switch invalidation path (must-fix #14): when
 * the AS detects its operating mode has changed, JWT access tokens
 * issued under the OLD kid become unverifiable on the next boot
 * because their kid no longer resolves in the JWKS — completing the
 * "prior tokens must stop working" contract that was previously only
 * partially enforced (K/V state was cleared + cookie secret rotated,
 * but stateless JWTs kept verifying until natural exp).
 */
export async function rotateSigningKey(keyFilePath: string): Promise<void> {
  try {
    await fs.unlink(keyFilePath);
    logger.warn(`[persistKeys] Rotated signing key — old kid invalidated; next load will mint fresh`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Already absent — nothing to rotate. Next load mints fresh anyway.
  }
}
