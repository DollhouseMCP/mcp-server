/**
 * AuthServiceRegistrar
 *
 * Wires the unified authentication module into the DI container.
 * Only loaded when DOLLHOUSE_AUTH_ENABLED=true — the auth module
 * stays out of the import graph for non-auth deployments.
 *
 * Registers:
 * - IAuthProvider: the configured provider (local-dev or OIDC)
 * - AuthMiddleware: Express RequestHandler for both HTTP surfaces
 *
 * @module di/registrars/AuthServiceRegistrar
 */

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';
import type { AuthConfig } from '../../auth/AuthProviderFactory.js';
import type { IAuthProvider } from '../../auth/IAuthProvider.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';
import type { SignInAllowlistAuthority } from '../../auth/embedded-as/allowlistGate.js';
import type { IRateLimitStore } from '../../auth/embedded-as/storage/IRateLimitStore.js';
import type { IAuthStorageLayer } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { AdminTotpService } from '../../auth/embedded-as/totp/AdminTotpService.js';
import type { IConsoleIdentityResolver } from '../../web-console/identity/IConsoleIdentityResolver.js';

interface ProtectedResourceMetadataProvider extends IAuthProvider {
  getProtectedResourceMetadataUrl(): string;
}

export class AuthServiceRegistrar {
  /**
   * Initialize and register auth services.
   * No-ops when auth is disabled.
   */
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<void> {
    if (!env.DOLLHOUSE_AUTH_ENABLED) {
      logger.debug('[AuthServiceRegistrar] Auth disabled — skipping');
      return;
    }

    const { createAuthProvider, resolveAuthMethods } = await import('../../auth/AuthProviderFactory.js');
    const { createUnifiedAuthMiddleware } = await import('../../auth/authMiddleware.js');
    const { createSigningKeyStore } = await import('../../storage/signingKeys/createSigningKeyStore.js');
    const { createAuthStorage } = await import('../../auth/embedded-as/storage/createAuthStorage.js');
    const { InMemoryRateLimitStore } = await import('../../auth/embedded-as/storage/InMemoryRateLimitStore.js');
    const { PostgresRateLimitStore } = await import('../../auth/embedded-as/storage/PostgresRateLimitStore.js');

    // Pull DatabaseInstance from the container if it has one. Required
    // when DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres; the Postgres backend's
    // factory throws without it. DatabaseServiceRegistrar runs before
    // AuthServiceRegistrar in Container bootstrap, so when DB-mode is
    // configured the registration is present. Filesystem and in-memory
    // backends ignore the value.
    let database: DatabaseInstance | undefined;
    if (container.hasRegistration('SystemDatabaseInstance')) {
      database = container.resolve<DatabaseInstance>('SystemDatabaseInstance');
    } else if (container.hasRegistration('DatabaseInstance')) {
      database = container.resolve<DatabaseInstance>('DatabaseInstance');
    }

    // Phase 4.5 / Phase F: register the SigningKeyStore so EmbeddedAuthorizationServer
    // can consume it (Phase I). Selection mirrors the auth K/V backend selector
    // (DOLLHOUSE_AUTH_STORAGE_BACKEND), since signing keys are AS-internal
    // infrastructure paired with auth_kv. Today nothing reads
    // 'SigningKeyStore' from the container — Phase I will wire
    // EmbeddedAuthorizationServer through createAuthProvider's option
    // surface. Registering early keeps Phase I a localized change.
    const signingKeyStore = await createSigningKeyStore({ database });
    container.register('SigningKeyStore', () => signingKeyStore);
    let rateLimitStore: IRateLimitStore;
    if (env.DOLLHOUSE_RATE_LIMIT_BACKEND === 'postgres') {
      if (!database) {
        throw new Error('DOLLHOUSE_RATE_LIMIT_BACKEND=postgres requires a DatabaseInstance');
      }
      rateLimitStore = new PostgresRateLimitStore(database);
    } else {
      rateLimitStore = new InMemoryRateLimitStore();
    }
    container.register('RateLimitStore', () => rateLimitStore);
    const signInAllowlistAuthority = await this.createSignInAllowlistAuthority(database);
    const authMethods = resolveAuthMethods({
      enabled: true,
      provider: env.DOLLHOUSE_AUTH_PROVIDER,
      methods: env.DOLLHOUSE_AUTH_METHODS as AuthConfig['methods'],
    });
    const authStorage = env.DOLLHOUSE_AUTH_PROVIDER === 'embedded'
      ? await createAuthStorage({ methods: authMethods, database })
      : undefined;
    if (authStorage) {
      container.register('AuthStorage', () => authStorage);
    }

    // Phase 4.5 / Phase J: prune rotated signing keys older than 30 days
    // every 6 hours. Without this, audit history accumulates unboundedly —
    // rotated keys are kept for token-validation grace periods and the
    // mode-fingerprint replay window, neither of which needs ≥30 days.
    if (container.hasRegistration('LifecycleService')) {
      const lifecycle = container.resolve<{
        registerPeriodicTask(intervalMs: number, fn: () => Promise<void>, label: string): unknown;
      }>('LifecycleService');
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      lifecycle.registerPeriodicTask(
        SIX_HOURS_MS,
        async () => {
          const removed = await signingKeyStore.pruneRotatedBefore(Date.now() - THIRTY_DAYS_MS);
          if (removed > 0) {
            logger.info(`[AuthServiceRegistrar] Pruned ${removed} rotated signing key(s) older than 30 days`);
          }
        },
        'signingKeyStore.pruneRotatedBefore',
      );
      lifecycle.registerPeriodicTask(
        5 * 60 * 1000,
        async () => {
          await rateLimitStore.sweep();
        },
        'rateLimitStore.sweep',
      );
    }

    // Phase I: forward the store into createAuthProvider so
    // EmbeddedAuthorizationServer's load + rotate paths route through it.
    // When DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem (or unset), this is
    // a filesystem-backed store; the AS still routes through it (one file
    // backend instead of file-direct in persistKeys/cookieSecret), so the
    // dual-mode behavior is uniform across deployments.

    // Web-console admin step-up (TOTP) dependencies. When present, the
    // embedded AS mounts the /auth/totp/* enrollment + step-up routes.
    const adminStepUp = await this.createAdminStepUpDeps(database, authStorage);

    const provider = await createAuthProvider({
      enabled: true,
      provider: env.DOLLHOUSE_AUTH_PROVIDER,
      issuer: env.DOLLHOUSE_AUTH_ISSUER,
      audience: env.DOLLHOUSE_AUTH_AUDIENCE,
      jwksUri: env.DOLLHOUSE_AUTH_JWKS_URI,
      localKeyFile: env.DOLLHOUSE_AUTH_LOCAL_KEY_FILE,
      localDefaultSub: env.DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB,
      publicBaseUrl: env.DOLLHOUSE_PUBLIC_BASE_URL,
      mcpPath: env.DOLLHOUSE_HTTP_MCP_PATH,
      methods: authMethods,
      database,
      storage: authStorage,
      // Cycle 19 / security-#6: opt-in OIDC-bridge typ enforcement.
      oidcRequireAccessTokenTyp: env.DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP,
      // Phase 4.5: signing key store (filesystem or postgres backend
      // selected per DOLLHOUSE_AUTH_STORAGE_BACKEND inside the factory).
      signingKeyStore,
      rateLimitStore,
      adminTotpService: adminStepUp.adminTotpService,
      consoleIdentityResolver: adminStepUp.consoleIdentityResolver,
      signInAllowlistAuthority,
      // PerformanceMonitor for auth-flow timing. Optional — when present,
      // each method's three IAuthMethod entry points (beginInteraction /
      // completeInteraction / findAccount) record per-call duration into
      // recordAuthOp so operators can see latency in /healthz. Resolved
      // from the root container which ObservabilityServiceRegistrar wires.
      performanceMonitor: container.hasRegistration('PerformanceMonitor')
        ? container.resolve<PerformanceMonitor>('PerformanceMonitor')
        : undefined,
    });

    if (!provider) return;

    container.register('AuthProvider', () => provider);
    if (signInAllowlistAuthority) {
      container.register('SignInAllowlistAuthority', () => signInAllowlistAuthority);
      container.register('WebConsoleAccountAllowlistAuthorityCutoverComplete', () => true);
    }

    const middleware = createUnifiedAuthMiddleware({
      provider,
      publicPaths: ['/healthz', '/readyz', '/version'],
      protectedResourceMetadataUrl: hasProtectedResourceMetadata(provider)
        ? provider.getProtectedResourceMetadataUrl()
        : undefined,
    });
    container.register('AuthMiddleware', () => middleware);

    logger.info(`[AuthServiceRegistrar] Auth enabled with provider: ${provider.name}`);
  }

  private async createSignInAllowlistAuthority(
    database: DatabaseInstance | undefined,
  ): Promise<SignInAllowlistAuthority | undefined> {
    if (!database || env.DOLLHOUSE_AUTH_PROVIDER !== 'embedded' || env.DOLLHOUSE_AUTH_STORAGE_BACKEND !== 'postgres') {
      return undefined;
    }
    const { PostgresConsoleAccountAllowlistStore } = await import(
      '../../web-console/stores/PostgresConsoleAccountAllowlistStore.js'
    );
    const { ConsoleAccountAllowlistSignInAuthority } = await import(
      '../../web-console/services/account-allowlist/ConsoleAccountAllowlistSignInAuthority.js'
    );
    return new ConsoleAccountAllowlistSignInAuthority(
      new PostgresConsoleAccountAllowlistStore(database),
    );
  }

  /**
   * Construct the web-console admin step-up (TOTP) dependencies so the embedded
   * AS mounts the /auth/totp/* enrollment + step-up interaction routes. Requires
   * embedded provider + DB mode (Postgres factor/identity stores) + the
   * web-console secret-encryption key (factor secrets share that key with the
   * console, so the key id/material must match DOLLHOUSE_WEB_CONSOLE_SECRET_*).
   * Returns empty when any prerequisite is absent → routes stay unmounted.
   */
  private async createAdminStepUpDeps(
    database: DatabaseInstance | undefined,
    authStorage: IAuthStorageLayer | undefined,
  ): Promise<{ adminTotpService?: AdminTotpService; consoleIdentityResolver?: IConsoleIdentityResolver }> {
    if (env.DOLLHOUSE_AUTH_PROVIDER !== 'embedded' || !database || !authStorage) return {};
    const encryptionKey = env.DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      logger.debug(
        '[AuthServiceRegistrar] DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY unset — ' +
        'admin TOTP step-up routes will not mount',
      );
      return {};
    }
    const { AdminTotpService } = await import('../../auth/embedded-as/totp/AdminTotpService.js');
    const { PostgresConsoleFactorStore } = await import('../../web-console/stores/PostgresConsoleFactorStore.js');
    const { PostgresConsoleIdentityResolver } = await import('../../web-console/identity/PostgresConsoleIdentityResolver.js');
    const { AeadSecretEncryptionService } = await import('../../web-console/security/SecretEncryption.js');
    const retainedDecryptKeys = parseRetiredSecretKeys(
      env.DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEYS_RETIRED,
    );
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: env.DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID,
      key: Buffer.from(encryptionKey, 'base64'),
    }, retainedDecryptKeys);
    logger.info('[AuthServiceRegistrar] Admin TOTP step-up routes enabled (embedded AS, DB mode)');
    return {
      adminTotpService: new AdminTotpService({
        authStorage,
        factorStore: new PostgresConsoleFactorStore(database),
        secretEncryption,
      }),
      consoleIdentityResolver: new PostgresConsoleIdentityResolver(database),
    };
  }
}

/**
 * Parse `keyId=base64,keyId2=base64` into retained decrypt keys. These let the
 * active secret-encryption key rotate without orphaning ciphertext encrypted
 * under a prior key (the keyId embedded in each record selects the right key).
 * Throws on a malformed entry rather than silently dropping a decrypt key.
 */
function parseRetiredSecretKeys(raw: string | undefined): { keyId: string; key: Buffer }[] {
  if (!raw) return [];
  return raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0).map(entry => {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(
        `DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEYS_RETIRED entry '${entry}' must be 'keyId=base64key'`,
      );
    }
    return {
      keyId: entry.slice(0, eq).trim(),
      key: Buffer.from(entry.slice(eq + 1).trim(), 'base64'),
    };
  });
}

function hasProtectedResourceMetadata(provider: IAuthProvider): provider is ProtectedResourceMetadataProvider {
  return typeof (provider as { getProtectedResourceMetadataUrl?: unknown }).getProtectedResourceMetadataUrl === 'function';
}
