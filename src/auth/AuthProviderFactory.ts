/**
 * Authentication Provider Factory
 *
 * Creates the appropriate IAuthProvider based on environment configuration.
 * Returns null when auth is disabled (the default).
 *
 * Two-level structure (per docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1):
 *   1. Outer: select the auth mode (embedded AS vs OIDC bridge) from
 *      DOLLHOUSE_AUTH_PROVIDER. The legacy 'local' value remains as a
 *      separate dev-token issuer (LocalDevAuthProvider) — it prints a
 *      Bearer token to stderr at startup for non-OAuth clients. It is
 *      not a transitional state; embedded and oidc are the OAuth-shaped
 *      providers, local is the no-OAuth dev shortcut.
 *   2. Inner: a list of IAuthMethod implementations the embedded AS
 *      exposes — any combination of trivial-consent, local-account,
 *      magic-link, github (Phase 2 multi-method shipped).
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
import { resolveDataDirectory } from '../paths/resolveDataDirectory.js';
import type { IAuthProvider } from './IAuthProvider.js';
import {
  AuthMethodFactory,
  createDefaultAuthMethodFactory,
  type AuthMethodId,
} from './embedded-as/AuthMethodFactory.js';
import type { IAuthStorageLayer } from './embedded-as/storage/IAuthStorageLayer.js';

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
  /**
   * Pre-constructed auth storage backend. Tests inject `InMemoryAuthStorageLayer`;
   * production wiring leaves this undefined and lets `createAuthStorage` pick
   * a backend based on `DOLLHOUSE_AUTH_STORAGE_BACKEND` (default: filesystem).
   */
  storage?: IAuthStorageLayer;
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
 * `methods` config; otherwise defaults to ['trivial-consent']. Returns
 * an empty list for the OIDC bridge mode — that path constructs
 * OidcAuthProvider directly (no embedded-AS methods involved).
 */
export function resolveAuthMethods(config: AuthConfig): AuthMethodId[] {
  if (config.provider === 'oidc') {
    return [];
  }
  return config.methods && config.methods.length > 0
    ? config.methods
    : ['trivial-consent'];
}

function resolveDefaultKeyFilePath(): string {
  // Use the canonical run-dir resolver (XDG / Library / LOCALAPPDATA)
  // rather than hardcoding `~/.dollhouse/run/`. Honors the env-override
  // chain (DOLLHOUSE_RUN_DIR, DOLLHOUSE_HOME_DIR) consistently.
  return path.join(resolveDataDirectory('run'), 'auth-keypair.json');
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
    const { createAuthStorage } = await import('./embedded-as/storage/createAuthStorage.js');
    const { isLoopbackHost } = await import('./oauth/url.js');
    const { env } = await import('../config/env.js');

    // must-fix #8: trivial-consent is the zero-config local-dev experience
    // and ONLY safe on a loopback bind with a loopback public URL. A
    // public HTTPS deployment running with no auth method configured
    // would default to trivial-consent — anyone clicking "Approve" would
    // walk away with a token. Refuse the construction up-front.
    //
    // Both checks: (a) the bind host (where the socket actually binds);
    // (b) the publicBaseUrl hostname (what callers reach the AS as,
    // which can be a public DNS name even when bind is loopback behind
    // a TLS-terminating proxy). Either being non-loopback in trivial-
    // consent mode is a misconfiguration.
    if (methods.includes('trivial-consent')) {
      // Read process.env directly rather than the cached env snapshot —
      // env is parsed at module load, so mutations after import (notably
      // in tests) wouldn't be visible. The default mirrors env.ts.
      const bindHost = process.env.DOLLHOUSE_HTTP_HOST?.trim() || env.DOLLHOUSE_HTTP_HOST;
      if (!isLoopbackHost(bindHost)) {
        throw new Error(
          `trivial-consent auth method refuses to start with non-loopback bind ` +
          `'${bindHost}'. Set DOLLHOUSE_AUTH_METHODS to a real method ` +
          `(github, local-password, magic-link) or bind to localhost / 127.0.0.0/8 / ::1.`,
        );
      }
      if (config.publicBaseUrl) {
        let publicHost: string;
        try {
          publicHost = new URL(config.publicBaseUrl).hostname;
        } catch {
          throw new Error(
            `trivial-consent auth method cannot validate publicBaseUrl ` +
            `'${config.publicBaseUrl}' — must be a parseable URL.`,
          );
        }
        if (!isLoopbackHost(publicHost)) {
          throw new Error(
            `trivial-consent auth method refuses to start with non-loopback ` +
            `public URL '${config.publicBaseUrl}'. A reverse-proxy fronting ` +
            `loopback is still externally reachable; configure a real auth ` +
            `method via DOLLHOUSE_AUTH_METHODS.`,
          );
        }
      }
    }

    // Storage is the substrate the embedded AS, all methods, and the
    // oidc-provider K/V adapter share. Tests inject InMemoryAuthStorageLayer
    // directly; production resolves the backend via env (default filesystem)
    // and refuses memory storage with durable-data methods unless
    // DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true is explicitly set.
    const storage = config.storage ?? await createAuthStorage({ methods });

    const baseUrl = config.publicBaseUrl
      ?? `http://${env.DOLLHOUSE_HTTP_HOST}:${env.DOLLHOUSE_HTTP_PORT}`;

    // Construct each configured method. Build ALL of them — multi-method
    // deployments (e.g. "GitHub + magic link") expose every method
    // simultaneously and let the LoginChooser pick at /interaction time
    // (per spec §8.1 line 912e).
    //
    // Shared resources:
    //   - InviteTokenStore: lazy-built, shared by local-password and
    //     magic-link so that an invite issued by either method is
    //     verifiable by both. Closes the architect's "two stores"
    //     finding (single shared instance, single consumed-set).
    //   - LocalLoginRateLimiter: lazy-built, used only by local-password
    //     today; would extend to other password-bearing methods if added.
    let sharedInvites: import('./embedded-as/inviteTokens.js').InviteTokenStore | undefined;
    const ensureInvites = async () => {
      if (!sharedInvites) {
        const { InviteTokenStore, loadOrGenerateInviteSecret } = await import('./embedded-as/inviteTokens.js');
        sharedInvites = new InviteTokenStore(loadOrGenerateInviteSecret());
      }
      return sharedInvites;
    };

    const builtMethods: import('./embedded-as/IAuthMethod.js').IAuthMethod[] = [];
    for (const id of methods) {
      builtMethods.push(await buildAuthMethod(id, { storage, baseUrl, ensureInvites, config }));
    }

    return new EmbeddedAuthorizationServer({
      publicBaseUrl: config.publicBaseUrl,
      mcpPath: config.mcpPath,
      keyFilePath: config.localKeyFile,
      methods: builtMethods,
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

interface BuildAuthMethodCtx {
  storage: IAuthStorageLayer;
  baseUrl: string;
  ensureInvites: () => Promise<import('./embedded-as/inviteTokens.js').InviteTokenStore>;
  config: AuthConfig;
}

/**
 * Per-method constructor dispatch. Replaces the prior monolithic
 * if/else chain so multi-method deployments build each method in turn
 * without arity-fragility, and so each method's required-config check
 * stays scoped to its own branch.
 */
async function buildAuthMethod(
  id: AuthMethodId,
  ctx: BuildAuthMethodCtx,
): Promise<import('./embedded-as/IAuthMethod.js').IAuthMethod> {
  const { storage, baseUrl, ensureInvites, config } = ctx;
  const { env } = await import('../config/env.js');

  switch (id) {
    case 'github': {
      const { GithubSocialMethod } = await import('./embedded-as/methods/GithubSocialMethod.js');
      const clientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      const clientSecret = env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          'GitHub social login requires DOLLHOUSE_GITHUB_CLIENT_ID and DOLLHOUSE_GITHUB_CLIENT_SECRET. ' +
          'Set both env vars or remove "github" from DOLLHOUSE_AUTH_METHODS.',
        );
      }
      return new GithubSocialMethod({
        clientId,
        clientSecret,
        callbackUrl: `${baseUrl.replace(/\/$/, '')}/auth/social/github/callback`,
        storage,
      });
    }

    case 'local-password': {
      const { LocalAccountMethod } = await import('./embedded-as/methods/LocalAccountMethod.js');
      const { LocalLoginRateLimiter } = await import('./embedded-as/rateLimit.js');
      const invites = await ensureInvites();
      const rateLimiter = new LocalLoginRateLimiter({ storage });
      return new LocalAccountMethod({ storage, invites, rateLimiter });
    }

    case 'magic-link': {
      const { MagicLinkMethod } = await import('./embedded-as/methods/MagicLinkMethod.js');
      const { NodemailerEmailSender } = await import('./embedded-as/methods/nodemailerEmailSender.js');
      if (!env.DOLLHOUSE_SMTP_HOST || !env.DOLLHOUSE_SMTP_USER
        || !env.DOLLHOUSE_SMTP_PASSWORD || !env.DOLLHOUSE_SMTP_FROM) {
        throw new Error(
          'Magic link requires DOLLHOUSE_SMTP_HOST/USER/PASSWORD/FROM. ' +
          'Configure SMTP or pick a different method via DOLLHOUSE_AUTH_METHODS.',
        );
      }
      const emailSender = new NodemailerEmailSender({
        host: env.DOLLHOUSE_SMTP_HOST,
        port: env.DOLLHOUSE_SMTP_PORT,
        user: env.DOLLHOUSE_SMTP_USER,
        password: env.DOLLHOUSE_SMTP_PASSWORD,
        from: env.DOLLHOUSE_SMTP_FROM,
      });
      // must-fix #10: confirm the transporter can connect + STARTTLS-
      // upgrade + authenticate before the AS finishes starting. Failing
      // late (on first user request) leaves operators chasing magic-link
      // emails that silently never arrive.
      await emailSender.verify();
      const invites = await ensureInvites();
      const verifyUrl = `${baseUrl.replace(/\/$/, '')}/auth/email/verify`;
      return new MagicLinkMethod({ storage, invites, emailSender, verifyUrl });
    }

    case 'trivial-consent': {
      const { TrivialConsentMethod } = await import('./embedded-as/methods/TrivialConsentMethod.js');
      // Pass storage so the method can upsert its account row on first
      // approval — required for `auth_time` claim emission (spec L927).
      return new TrivialConsentMethod({
        defaultSubject: config.localDefaultSub,
        storage,
      });
    }
  }
}
