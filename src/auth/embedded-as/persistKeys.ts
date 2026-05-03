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
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { logger } from '../../utils/logger.js';

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

export function defaultKeyFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'oauth-signing-key.json');
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
  } catch {
    // Fall through to generation.
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
