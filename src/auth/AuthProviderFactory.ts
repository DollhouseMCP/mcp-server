/**
 * Authentication Provider Factory
 *
 * Creates the appropriate IAuthProvider based on environment configuration.
 * Returns null when auth is disabled (the default).
 *
 * Two-level structure (per docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1):
 *   1. Outer: select the auth mode (embedded AS vs OIDC bridge) from
 *      DOLLHOUSE_AUTH_PROVIDER. The legacy 'local' value is treated as
 *      'embedded' for mode purposes; the underlying construction stays
 *      LocalDevAuthProvider until C4 collapses both into the embedded AS.
 *   2. Inner: AuthMethodFactory selects which IAuthMethod implementations
 *      the embedded AS exposes (trivial-consent today; github, local,
 *      magic-link, oidc-bridge as later commits land them).
 *
 * Provider selection:
 *   DOLLHOUSE_AUTH_PROVIDER=local     → LocalDevAuthProvider (dev-only JWT issuer)
 *   DOLLHOUSE_AUTH_PROVIDER=embedded  → EmbeddedOAuthProvider (the embedded AS)
 *   DOLLHOUSE_AUTH_PROVIDER=oidc      → OidcAuthProvider (OIDC bridge mode)
 *
 * @module auth/AuthProviderFactory
 */

import * as path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import type { IAuthProvider } from './IAuthProvider.js';
import {
  AuthMethodFactory,
  createDefaultAuthMethodFactory,
  type AuthMethodId,
} from './embedded-as/AuthMethodFactory.js';

export type AuthProviderMode = 'embedded' | 'oidc-bridge';

export interface AuthConfig {
  enabled: boolean;
  provider: 'local' | 'embedded' | 'oidc';
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  localKeyFile?: string;
  localDefaultSub?: string;
  publicBaseUrl?: string;
  mcpPath?: string;
  /**
   * Auth methods exposed by the embedded AS. Defaults to ['trivial-consent']
   * which preserves the existing solo-localhost behavior. Ignored when
   * provider='oidc' (the OIDC bridge owns identity end-to-end).
   */
  methods?: AuthMethodId[];
  /** Inner factory; defaults to createDefaultAuthMethodFactory(). Tests inject. */
  methodFactory?: AuthMethodFactory;
}

/**
 * Select the outer auth mode from the provider config value.
 * 'local' and 'embedded' both run inside the embedded AS mode; 'oidc'
 * is the bridge mode that delegates to an external IdP.
 */
export function selectAuthMode(provider: AuthConfig['provider']): AuthProviderMode {
  return provider === 'oidc' ? 'oidc-bridge' : 'embedded';
}

/**
 * Resolve the methods list for the embedded AS mode. Honors explicit
 * `methods` config; otherwise defaults to ['trivial-consent'].
 */
export function resolveAuthMethods(config: AuthConfig): AuthMethodId[] {
  if (config.provider === 'oidc') {
    return ['oidc-bridge'];
  }
  return config.methods && config.methods.length > 0
    ? config.methods
    : ['trivial-consent'];
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

  // Validate the requested method set against the inner factory before
  // constructing anything. Catches typos and unregistered methods early.
  const methodFactory = config.methodFactory ?? createDefaultAuthMethodFactory();
  const methods = resolveAuthMethods(config);
  const mode = selectAuthMode(config.provider);
  if (mode === 'embedded') {
    methodFactory.assertAllRegistered(methods);
  }
  logger.info('[AuthProviderFactory] Resolved auth configuration', {
    provider: config.provider,
    mode,
    methods,
  });

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

  if (config.provider === 'embedded') {
    const { EmbeddedAuthorizationServer } = await import('./embedded-as/EmbeddedAuthorizationServer.js');
    const { InMemoryAuthStorageLayer } = await import('./embedded-as/storage/InMemoryAuthStorageLayer.js');
    const { env } = await import('../config/env.js');

    const storage = new InMemoryAuthStorageLayer();

    // Take the first configured method as the active IAuthMethod. Multi-
    // method chooser UI is future work; for §8.1 the AS exposes one method.
    const activeMethodId = methods[0];

    let method;
    if (activeMethodId === 'github') {
      const { GithubSocialMethod } = await import('./embedded-as/methods/GithubSocialMethod.js');
      const clientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      const clientSecret = env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          'GitHub social login requires DOLLHOUSE_GITHUB_CLIENT_ID and DOLLHOUSE_GITHUB_CLIENT_SECRET. ' +
          'Set both env vars or remove "github" from DOLLHOUSE_AUTH_METHODS.',
        );
      }
      const baseUrl = config.publicBaseUrl
        ?? `http://${env.DOLLHOUSE_HTTP_HOST}:${env.DOLLHOUSE_HTTP_PORT}`;
      method = new GithubSocialMethod({
        clientId,
        clientSecret,
        callbackUrl: `${baseUrl.replace(/\/$/, '')}/auth/social/github/callback`,
        storage,
      });
    } else {
      const { TrivialConsentMethod } = await import('./embedded-as/methods/TrivialConsentMethod.js');
      method = new TrivialConsentMethod({ defaultSubject: config.localDefaultSub });
    }

    return new EmbeddedAuthorizationServer({
      publicBaseUrl: config.publicBaseUrl,
      mcpPath: config.mcpPath,
      keyFilePath: config.localKeyFile,
      method,
      storage,
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
