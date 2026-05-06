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

    // Pull DatabaseInstance from the container if it has one. Required
    // when DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres; the Postgres backend's
    // factory throws without it. DatabaseServiceRegistrar runs before
    // AuthServiceRegistrar in Container bootstrap, so when DB-mode is
    // configured the registration is present. Filesystem and in-memory
    // backends ignore the value.
    const database = container.hasRegistration('DatabaseInstance')
      ? container.resolve<DatabaseInstance>('DatabaseInstance')
      : undefined;

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
