/**
 * Authentication Provider Factory
 *
 * Creates the appropriate IAuthProvider based on environment configuration.
 * Returns null when auth is disabled (the default).
 *
 * Provider selection:
 *   DOLLHOUSE_AUTH_PROVIDER=local  → LocalDevAuthProvider (self-signed JWTs)
 *   DOLLHOUSE_AUTH_PROVIDER=oidc   → OidcAuthProvider (external IdP)
 *
 * @module auth/AuthProviderFactory
 */

import * as path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import type { IAuthProvider } from './IAuthProvider.js';

export interface AuthConfig {
  enabled: boolean;
  provider: 'local' | 'oidc';
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  localKeyFile?: string;
  localDefaultSub?: string;
}

function resolveDefaultKeyFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'auth-keypair.json');
}

/**
 * Create an auth provider from configuration.
 * Returns null when auth is disabled.
 */
export async function createAuthProvider(config: AuthConfig): Promise<IAuthProvider | null> {
  if (!config.enabled) {
    logger.info('[AuthProviderFactory] Authentication disabled');
    return null;
  }

  if (config.provider === 'oidc') {
    if (!config.issuer) {
      throw new Error('DOLLHOUSE_AUTH_ISSUER is required when DOLLHOUSE_AUTH_PROVIDER=oidc');
    }
    if (!config.audience) {
      throw new Error('DOLLHOUSE_AUTH_AUDIENCE is required when DOLLHOUSE_AUTH_PROVIDER=oidc');
    }

    const { OidcAuthProvider } = await import('./OidcAuthProvider.js');
    return new OidcAuthProvider({
      issuer: config.issuer,
      audience: config.audience,
      jwksUri: config.jwksUri,
    });
  }

  // Default: local dev provider
  const keyFilePath = config.localKeyFile || resolveDefaultKeyFilePath();
  const { LocalDevAuthProvider } = await import('./LocalDevAuthProvider.js');
  const provider = new LocalDevAuthProvider({ keyFilePath });

  // Auto-generate a startup token for convenience
  const defaultSub = config.localDefaultSub || getDefaultSub();
  try {
    const token = await provider.issue(defaultSub, { ttlSeconds: 86400 });
    logger.info(`[AuthProviderFactory] Local dev auth enabled. Default token for '${defaultSub}':`);
    // Print to stderr so it's visible in the terminal but not captured by MCP stdio
    process.stderr.write(
      `\n[DollhouseMCP Auth] Token for '${defaultSub}' (24h TTL):\n` +
      `  ${token}\n\n` +
      `Use in MCP client config:\n` +
      `  "headers": { "Authorization": "Bearer ${token}" }\n\n`,
    );
  } catch (err) {
    logger.warn('[AuthProviderFactory] Failed to generate startup token', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return provider;
}

function getDefaultSub(): string {
  const envUser = process.env.DOLLHOUSE_USER?.trim();
  if (envUser) return envUser;
  try {
    return os.userInfo().username || 'local-user';
  } catch {
    return 'local-user';
  }
}
