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
import type { IAuthProvider } from '../../auth/IAuthProvider.js';
import type { DatabaseInstance } from '../../database/connection.js';

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

    const { createAuthProvider } = await import('../../auth/AuthProviderFactory.js');
    const { createUnifiedAuthMiddleware } = await import('../../auth/authMiddleware.js');
    const { createSigningKeyStore } = await import('../../storage/signingKeys/createSigningKeyStore.js');

    // Pull DatabaseInstance from the container if it has one. Required
    // when DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres; the Postgres backend's
    // factory throws without it. DatabaseServiceRegistrar runs before
    // AuthServiceRegistrar in Container bootstrap, so when DB-mode is
    // configured the registration is present. Filesystem and in-memory
    // backends ignore the value.
    const database = container.hasRegistration('SystemDatabaseInstance')
      ? container.resolve<DatabaseInstance>('SystemDatabaseInstance')
      : container.hasRegistration('DatabaseInstance')
      ? container.resolve<DatabaseInstance>('DatabaseInstance')
      : undefined;

    // Phase 4.5 / Phase F: register the SigningKeyStore so EmbeddedAuthorizationServer
    // can consume it (Phase I). Selection mirrors the auth K/V backend selector
    // (DOLLHOUSE_AUTH_STORAGE_BACKEND), since signing keys are AS-internal
    // infrastructure paired with auth_kv. Today nothing reads
    // 'SigningKeyStore' from the container — Phase I will wire
    // EmbeddedAuthorizationServer through createAuthProvider's option
    // surface. Registering early keeps Phase I a localized change.
    const signingKeyStore = await createSigningKeyStore({ database });
    container.register('SigningKeyStore', () => signingKeyStore);

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
    }

    // Phase I: forward the store into createAuthProvider so
    // EmbeddedAuthorizationServer's load + rotate paths route through it.
    // When DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem (or unset), this is
    // a filesystem-backed store; the AS still routes through it (one file
    // backend instead of file-direct in persistKeys/cookieSecret), so the
    // dual-mode behavior is uniform across deployments.

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
      methods: env.DOLLHOUSE_AUTH_METHODS as import('../../auth/AuthProviderFactory.js').AuthConfig['methods'],
      database,
      // Cycle 19 / security-#6: opt-in OIDC-bridge typ enforcement.
      oidcRequireAccessTokenTyp: env.DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP,
      // Phase 4.5: signing key store (filesystem or postgres backend
      // selected per DOLLHOUSE_AUTH_STORAGE_BACKEND inside the factory).
      signingKeyStore,
    });

    if (!provider) return;

    container.register('AuthProvider', () => provider);

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
}

function hasProtectedResourceMetadata(provider: IAuthProvider): provider is ProtectedResourceMetadataProvider {
  return typeof (provider as { getProtectedResourceMetadataUrl?: unknown }).getProtectedResourceMetadataUrl === 'function';
}
