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

    const provider = await createAuthProvider({
      enabled: true,
      provider: env.DOLLHOUSE_AUTH_PROVIDER,
      issuer: env.DOLLHOUSE_AUTH_ISSUER,
      audience: env.DOLLHOUSE_AUTH_AUDIENCE,
      jwksUri: env.DOLLHOUSE_AUTH_JWKS_URI,
      localKeyFile: env.DOLLHOUSE_AUTH_LOCAL_KEY_FILE,
      localDefaultSub: env.DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB,
    });

    if (!provider) return;

    container.register('AuthProvider', () => provider);

    const middleware = createUnifiedAuthMiddleware({
      provider,
      publicPaths: ['/healthz', '/readyz', '/version'],
    });
    container.register('AuthMiddleware', () => middleware);

    logger.info(`[AuthServiceRegistrar] Auth enabled with provider: ${provider.name}`);
  }
}
