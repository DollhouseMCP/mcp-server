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
import type { IRateLimitStore } from './embedded-as/storage/IRateLimitStore.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { PerformanceMonitor } from '../utils/PerformanceMonitor.js';
import { instrumentAuthMethod } from './embedded-as/instrumentAuthMethod.js';
import { instrumentAuthProvider } from './instrumentAuthProvider.js';

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
  /**
   * Drizzle DatabaseInstance, required when
   * `DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres`. Forwarded to
   * `createAuthStorage` so the Postgres backend can be instantiated.
   * The DI registrar pulls this from the container; tests pass undefined
   * unless they specifically exercise the Postgres backend.
   */
  database?: DatabaseInstance;
  /**
   * Cycle 19 / security-#6: opt-in RFC 9068 `typ: at+jwt` enforcement on
   * incoming OIDC-bridge tokens. Default false (compat with IdPs that
   * don't stamp typ). Forwarded to `OidcAuthProvider`.
   */
  oidcRequireAccessTokenTyp?: boolean;
  /**
   * Phase 4.5: optional injected ISigningKeyStore. When present (DB mode
   * with the store registered by AuthServiceRegistrar), JWKS + cookie
   * keys persist via the store instead of the legacy filesystem path.
   * Forwarded to EmbeddedAuthorizationServer; ignored by other providers.
   */
  signingKeyStore?: import('../storage/signingKeys/ISigningKeyStore.js').ISigningKeyStore;
  /** Shared auth rate-limit state store. Required for multi-replica Postgres deployments. */
  rateLimitStore?: IRateLimitStore;
  /**
   * Optional PerformanceMonitor for instrumenting auth-flow timing.
   * When present, each method's beginInteraction / completeInteraction /
   * findAccount calls record into `recordAuthOp` so operators can see
   * per-method latency in /healthz. When absent, calls run uninstrumented.
   */
  performanceMonitor?: PerformanceMonitor;
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
    logAuthDisabled(config.provider);
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
    return instrumentAuthProvider(await createOidcProvider(config), config.performanceMonitor);
  }
  if (config.provider === 'embedded') {
    return instrumentAuthProvider(await createEmbeddedProvider(config, methods), config.performanceMonitor);
  }
  return instrumentAuthProvider(await createLocalDevProvider(config), config.performanceMonitor);
}

/**
 * Cycle-16 fix: a configured non-default provider (oidc/embedded) with auth
 * disabled is almost certainly an operator misconfig — they wired up the AS
 * but forgot DOLLHOUSE_AUTH_ENABLED=true, so the MCP endpoint accepts
 * unauthenticated traffic and the OAuth setup is silently bypassed. Log
 * loudly enough that this surfaces in the operator's startup output.
 */
function logAuthDisabled(provider: AuthConfig['provider']): void {
  if (provider === 'embedded' || provider === 'oidc') {
    logger.warn(
      `[AuthProviderFactory] DOLLHOUSE_AUTH_PROVIDER=${provider} is ` +
      `configured but DOLLHOUSE_AUTH_ENABLED is false. The MCP endpoint will ` +
      `accept unauthenticated traffic. Set DOLLHOUSE_AUTH_ENABLED=true to ` +
      `enforce token authentication, or unset DOLLHOUSE_AUTH_PROVIDER if you ` +
      `intend to run without authentication.`,
    );
    return;
  }
  logger.info('[AuthProviderFactory] Authentication disabled');
}

async function createOidcProvider(config: AuthConfig): Promise<IAuthProvider> {
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
    requireAccessTokenTyp: config.oidcRequireAccessTokenTyp,
  });
}

async function createEmbeddedProvider(
  config: AuthConfig,
  methods: AuthMethodId[],
): Promise<IAuthProvider> {
  const { EmbeddedAuthorizationServer } = await import('./embedded-as/EmbeddedAuthorizationServer.js');
  const { createAuthStorage } = await import('./embedded-as/storage/createAuthStorage.js');
  const { isLoopbackHost } = await import('./oauth/url.js');
  const { env } = await import('../config/env.js');

  if (methods.includes('trivial-consent')) {
    assertTrivialConsentSafe(config.publicBaseUrl, env.DOLLHOUSE_HTTP_HOST, isLoopbackHost);
  }
  if (!env.DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED) {
    warnAllowlistDisabledForSocial(methods, env.DOLLHOUSE_HTTP_HOST, isLoopbackHost);
  }

  // Storage is the substrate the embedded AS, all methods, and the
  // oidc-provider K/V adapter share. Tests inject InMemoryAuthStorageLayer
  // directly; production resolves the backend via env (default filesystem)
  // and refuses memory storage with durable-data methods unless
  // DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true is explicitly set.
  const storage = config.storage ?? await createAuthStorage({ methods, database: config.database });

  const baseUrl = config.publicBaseUrl
    ?? `http://${env.DOLLHOUSE_HTTP_HOST}:${env.DOLLHOUSE_HTTP_PORT}`;

  const ensureInvites = makeInviteStoreFactory(config, storage);

  // Construct each configured method. Build ALL of them — multi-method
  // deployments (e.g. "GitHub + magic link") expose every method
  // simultaneously and let the LoginChooser pick at /interaction time.
  const builtMethods: import('./embedded-as/IAuthMethod.js').IAuthMethod[] = [];
  for (const id of methods) {
    const raw = await buildAuthMethod(id, { storage, baseUrl, ensureInvites, config });
    // Wrap with PerformanceMonitor instrumentation when one was injected.
    // No-op when monitor is undefined; otherwise records per-method timing
    // for the three IAuthMethod entry points.
    builtMethods.push(instrumentAuthMethod(raw, config.performanceMonitor));
  }

  return new EmbeddedAuthorizationServer({
    publicBaseUrl: config.publicBaseUrl,
    mcpPath: config.mcpPath,
    keyFilePath: config.localKeyFile,
    methods: builtMethods,
    storage,
    // Phase 4.5: forwarded by AuthServiceRegistrar in DB mode; undefined
    // in filesystem mode → EmbeddedAuthorizationServer falls back to the
    // legacy persistKeys / cookieSecret file paths.
    signingKeyStore: config.signingKeyStore,
    rateLimitStore: config.rateLimitStore,
  });
}

type IsLoopbackHostFn = (host: string) => boolean;

/**
 * Read the effective bind host. Prefers process.env over the cached env
 * snapshot because env is parsed at module load — mutations after import
 * (notably in tests) wouldn't be visible otherwise. Default mirrors env.ts.
 */
function readEffectiveBindHost(envDefault: string): string {
  // eslint-disable-next-line no-restricted-syntax -- DMCP-ENV-001 documented exception: test-mutation visibility for trivial-consent + allowlist safety guards; cycle-23 security audit categorized as acceptable raw read
  return process.env.DOLLHOUSE_HTTP_HOST?.trim() || envDefault;
}

/**
 * must-fix #8: trivial-consent is the zero-config local-dev experience and
 * ONLY safe on a loopback bind with a loopback public URL. A public HTTPS
 * deployment running with no auth method configured would default to
 * trivial-consent — anyone clicking "Approve" would walk away with a token.
 *
 * Both checks: (a) the bind host (where the socket actually binds); (b) the
 * publicBaseUrl hostname (what callers reach the AS as, which can be a
 * public DNS name even when bind is loopback behind a TLS-terminating
 * proxy). Either being non-loopback in trivial-consent mode is a misconfig.
 */
function assertTrivialConsentSafe(
  publicBaseUrl: string | undefined,
  envBindHost: string,
  isLoopbackHost: IsLoopbackHostFn,
): void {
  const bindHost = readEffectiveBindHost(envBindHost);
  if (!isLoopbackHost(bindHost)) {
    throw new Error(
      `trivial-consent auth method refuses to start with non-loopback bind ` +
      `'${bindHost}'. Set DOLLHOUSE_AUTH_METHODS to a real method ` +
      `(github, local-password, magic-link) or bind to localhost / 127.0.0.0/8 / ::1.`,
    );
  }
  if (!publicBaseUrl) return;

  let publicHost: string;
  try {
    publicHost = new URL(publicBaseUrl).hostname;
  } catch {
    throw new Error(
      `trivial-consent auth method cannot validate publicBaseUrl ` +
      `'${publicBaseUrl}' — must be a parseable URL.`,
    );
  }
  if (!isLoopbackHost(publicHost)) {
    throw new Error(
      `trivial-consent auth method refuses to start with non-loopback ` +
      `public URL '${publicBaseUrl}'. A reverse-proxy fronting loopback is ` +
      `still externally reachable; configure a real auth method via ` +
      `DOLLHOUSE_AUTH_METHODS.`,
    );
  }
}

/**
 * Sign-in allowlist enforcement warning. When the allowlist is OFF
 * (REQUIRED=false → empty list means "no gate") AND the AS binds to a
 * non-loopback host AND a social method is configured, anyone with a
 * GitHub account / verified email can complete sign-in. Most operators
 * want to gate that; nudge them toward the secure setting.
 *
 * Skip for loopback bind (dev/CI doesn't need the warning) and for
 * method-only deploys that already gate sign-in (local-password is
 * operator-issued-invites-only, so it's safe without an allowlist).
 */
function warnAllowlistDisabledForSocial(
  methods: AuthMethodId[],
  envBindHost: string,
  isLoopbackHost: IsLoopbackHostFn,
): void {
  const hasSocialMethod = methods.includes('github') || methods.includes('magic-link');
  if (!hasSocialMethod) return;
  const bindHost = readEffectiveBindHost(envBindHost);
  if (isLoopbackHost(bindHost)) return;
  logger.warn(
    '[AuthProviderFactory] Sign-in allowlist is disabled (DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=false). ' +
    `With ${methods.filter(m => m === 'github' || m === 'magic-link').join('/')} configured on a non-loopback ` +
    `bind '${bindHost}', anyone who completes the auth method's identity check can sign in. ` +
    'Set DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true to gate sign-in by allowlist (bootstrap admin always passes).',
  );
}

/**
 * Lazy factory for the shared InviteTokenStore used by local-password and
 * magic-link. The two methods must share the same secret so an invite
 * issued by one is verifiable by the other (closes the "two stores"
 * finding — single shared instance, single consumed-set).
 *
 * Storage-backed consumed-jti enforcement (H5): passes the same storage
 * layer the AS uses so single-use survives restart on durable backends.
 */
function makeInviteStoreFactory(
  config: AuthConfig,
  storage: IAuthStorageLayer,
): () => Promise<import('./embedded-as/inviteTokens.js').InviteTokenStore> {
  let shared: import('./embedded-as/inviteTokens.js').InviteTokenStore | undefined;
  return async () => {
    if (shared) return shared;
    const {
      InviteTokenStore,
      loadOrGenerateInviteSecret,
      loadOrGenerateInviteSecretViaStore,
    } = await import('./embedded-as/inviteTokens.js');
    const inviteSecret = config.signingKeyStore
      ? await loadOrGenerateInviteSecretViaStore(config.signingKeyStore)
      : loadOrGenerateInviteSecret();
    shared = new InviteTokenStore(inviteSecret, storage);
    return shared;
  };
}

async function createLocalDevProvider(config: AuthConfig): Promise<IAuthProvider> {
  const keyFilePath = config.localKeyFile || resolveDefaultKeyFilePath();
  const { LocalDevAuthProvider } = await import('./LocalDevAuthProvider.js');
  const provider = new LocalDevAuthProvider({ keyFilePath });

  // Auto-generate a startup token for convenience. Stamp the `mcp` scope
  // explicitly — both LocalDevAuthProvider.validate and the embedded-AS
  // path require `mcp` for the resource-server check. Without it the
  // printed token would fail validation immediately.
  const defaultSub = config.localDefaultSub || getDefaultSub();
  try {
    const token = await provider.issue(defaultSub, { ttlSeconds: 86400, scopes: ['mcp'] });
    logger.info(`[AuthProviderFactory] Local dev auth enabled. Default token for '${defaultSub}':`);
    // Print to stderr so it's visible in the terminal but not captured by MCP stdio.
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
  // eslint-disable-next-line no-restricted-syntax -- DMCP-ENV-001 documented exception: DOLLHOUSE_USER is intentionally not in env.ts schema (identity label, not a secret; integration tests legitimately mutate at runtime per tests/setupEnv.integration.cjs)
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
      // Cycle-17: prefer DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/SECRET
      // (dedicated to the §8.1 user-auth flow). Fall back to the
      // legacy DOLLHOUSE_GITHUB_CLIENT_ID/SECRET (originally introduced
      // for portfolio sync) so existing deployments don't break, and
      // warn so operators know to migrate. The two features have
      // different OAuth-app requirements (portfolio sync needs device
      // flow; §8.1 needs web flow with a registered callback) and
      // separate env vars let operators register distinct apps.
      const newClientId = env.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID;
      const newClientSecret = env.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET;
      const legacyClientId = env.DOLLHOUSE_GITHUB_CLIENT_ID;
      const legacyClientSecret = env.DOLLHOUSE_GITHUB_CLIENT_SECRET;

      const clientId = newClientId ?? legacyClientId;
      const clientSecret = newClientSecret ?? legacyClientSecret;
      if (!clientId || !clientSecret) {
        throw new Error(
          'GitHub social login requires DOLLHOUSE_AUTH_GITHUB_CLIENT_ID and ' +
          'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET (or the legacy ' +
          'DOLLHOUSE_GITHUB_CLIENT_ID / DOLLHOUSE_GITHUB_CLIENT_SECRET). ' +
          'Set both env vars or remove "github" from DOLLHOUSE_AUTH_METHODS.',
        );
      }
      if (!newClientId || !newClientSecret) {
        logger.warn(
          '[AuthProviderFactory] §8.1 GitHub auth is using the legacy ' +
          'DOLLHOUSE_GITHUB_CLIENT_ID/SECRET env vars. Migrate to ' +
          'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/SECRET so the user-auth flow has ' +
          'its own OAuth app, separate from the portfolio-sync feature. ' +
          'The legacy vars will continue to work as a fallback.',
        );
      }
      return new GithubSocialMethod({
        clientId,
        clientSecret,
        callbackUrl: `${baseUrl.replace(/\/$/, '')}/auth/social/github/callback`,
        storage,
        allowlistRequired: env.DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED,
      });
    }

    case 'local-password': {
      const { LocalAccountMethod } = await import('./embedded-as/methods/LocalAccountMethod.js');
      const { LocalLoginRateLimiter } = await import('./embedded-as/rateLimit.js');
      if (!config.rateLimitStore) {
        throw new Error(
          'local-password method requires AuthConfig.rateLimitStore. ' +
          'AuthServiceRegistrar constructs one from DOLLHOUSE_RATE_LIMIT_BACKEND (memory|postgres) — verify the registrar ran before createAuthProvider().',
        );
      }
      const invites = await ensureInvites();
      const rateLimiter = new LocalLoginRateLimiter({
        storage,
        store: config.rateLimitStore,
        storeBackend: env.DOLLHOUSE_RATE_LIMIT_BACKEND,
      });
      return new LocalAccountMethod({
        storage,
        invites,
        rateLimiter,
        allowlistRequired: env.DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED,
      });
    }

    case 'magic-link': {
      const { MagicLinkMethod } = await import('./embedded-as/methods/MagicLinkMethod.js');
      const { NodemailerEmailSender } = await import('./embedded-as/methods/nodemailerEmailSender.js');
      if (!config.rateLimitStore) {
        throw new Error(
          'magic-link method requires AuthConfig.rateLimitStore. ' +
          'AuthServiceRegistrar constructs one from DOLLHOUSE_RATE_LIMIT_BACKEND (memory|postgres) — verify the registrar ran before createAuthProvider().',
        );
      }
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
      return new MagicLinkMethod({
        storage,
        invites,
        emailSender,
        verifyUrl,
        allowlistRequired: env.DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED,
        rateLimitStore: config.rateLimitStore,
      });
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
