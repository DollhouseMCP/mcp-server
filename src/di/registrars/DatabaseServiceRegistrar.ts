/**
 * DatabaseServiceRegistrar
 *
 * Owns the DI wiring that only applies when the database storage backend is
 * active (`DOLLHOUSE_STORAGE_BACKEND=database`). Extracted from Container.ts
 * as the first step of the registrar decomposition — see the Pre-Phase-5
 * Cleanup section of `docs/UNIFIED-PATH-FORWARD.md`.
 *
 * Responsibilities:
 * - Bootstrap the database connection and registers the core DB services
 *   (`DatabaseConnection`, `DatabaseInstance`, `BootstrappedUserId`,
 *   `CurrentUserId`, `UserIdResolver`) with the container.
 * - Re-register `StdioSession` with the bootstrapped DB UUID so SessionContext
 *   carries a UUID identity in DB mode (instead of the DOLLHOUSE_USER literal).
 * - Expose `resolveDatabaseDeps(container)` for element-manager factories that
 *   want optional DB deps spread into their options — returns `{}` when the
 *   database isn't active, so the spread is a no-op.
 *
 * What stays in Container (deliberately, for now):
 * - The per-session state-store factories in `registerServices()` that branch
 *   on `hasRegistration('DatabaseInstance')` — they have both DB and file
 *   variants and decoupling them is a separate follow-up.
 * - The `createServerForHttpSession()` DB-mode branch — same reason.
 *
 * Nothing in this file is imported when DB mode is off. Container.ts imports
 * the class but only calls into it when `env.DOLLHOUSE_STORAGE_BACKEND ===
 * 'database'`, so the DB dependency graph stays opt-in.
 *
 * @module di/registrars/DatabaseServiceRegistrar
 */

import { env } from '../../config/env.js';
import { createStdioSession } from '../../context/StdioSession.js';
import type { ContextTracker } from '../../security/encryption/ContextTracker.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { UserIdResolver } from '../../database/UserContext.js';

import type { DiContainerFacade } from '../DiContainerFacade.js';

// Re-export for callers that import from this module.
export type { DiContainerFacade };

/**
 * Optional DB deps spread into element-manager constructors. Returns an empty
 * object when DB mode is inactive so callers can use `...resolveDatabaseDeps()`
 * without a flag check.
 */
export interface OptionalDatabaseDeps {
  databaseInstance?: DatabaseInstance;
  getCurrentUserId?: UserIdResolver;
  createDatabaseStorageLayer?: (
    db: DatabaseInstance,
    getUserId: UserIdResolver,
    elementType: string,
  ) => import('../../storage/IStorageLayer.js').IStorageLayer;
}

export class DatabaseServiceRegistrar {
  /**
   * Run the DB bootstrap and register core DB services with the container.
   *
   * Must be called during startup (before any manager that needs DB resolution
   * is first resolved). `Container.preparePortfolio()` is the current caller.
   *
   * @throws If `DOLLHOUSE_DATABASE_URL` is not set (required in DB mode).
   * @throws If database bootstrap itself fails — caller decides whether to
   *         retry, log, or abort.
   */
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<void> {
    if (!env.DOLLHOUSE_DATABASE_URL) {
      throw new Error(
        'DOLLHOUSE_STORAGE_BACKEND=database requires DOLLHOUSE_DATABASE_URL to be set',
      );
    }

    // Dynamic imports — drizzle-orm stays out of the static module graph
    // so file-mode deployments and tests never load it.
    const { bootstrapDatabase } = await import('../../database/bootstrap.js');
    const { createUserIdResolver } = await import('../../database/UserContext.js');

    const result = await bootstrapDatabase({
      connectionUrl: env.DOLLHOUSE_DATABASE_URL,
      adminConnectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL,
      poolSize: env.DOLLHOUSE_DATABASE_POOL_SIZE,
      ssl: env.DOLLHOUSE_DATABASE_SSL,
    });

    // Connection object (has .close() — picked up by Container.dispose() automatically)
    container.register('DatabaseConnection', () => result.connection);
    // Drizzle instance (resolved by stores and storage layers)
    container.register('DatabaseInstance', () => result.db);

    // Storage layer + state store factories — loaded here (async context) so
    // drizzle-orm stays out of the static import graph entirely. File-mode
    // code and tests never import these modules.
    const { DatabaseStorageLayer } = await import('../../storage/DatabaseStorageLayer.js');
    const { DatabaseMemoryStorageLayer } = await import('../../storage/DatabaseMemoryStorageLayer.js');
    const { DatabaseActivationStateStore } = await import('../../state/DatabaseActivationStateStore.js');
    const { DatabaseConfirmationStore } = await import('../../state/DatabaseConfirmationStore.js');
    const { DatabaseChallengeStore } = await import('../../state/DatabaseChallengeStore.js');

    container.register('DatabaseStorageLayerFactory', () =>
      (db: DatabaseInstance, getUserId: UserIdResolver, elementType: string) => {
        if (elementType === 'memories') {
          return new DatabaseMemoryStorageLayer(db, getUserId);
        }
        return new DatabaseStorageLayer(db, getUserId, elementType);
      }
    );
    container.register('DatabaseActivationStateStoreClass', () => DatabaseActivationStateStore);
    container.register('DatabaseConfirmationStoreClass', () => DatabaseConfirmationStore);
    container.register('DatabaseChallengeStoreClass', () => DatabaseChallengeStore);

    // The bootstrapped DB UUID is the identity every session binds to by default.
    // Per-session scoping is enforced by ContextTracker/AsyncLocalStorage: stdio
    // sessions and single-tenant HTTP sessions both carry this UUID as their
    // SessionContext.userId. When multi-tenant auth lands, HTTP sessions
    // override it at session creation time. Either way, storage layers read the
    // userId out of the active session context per call, NOT from a singleton.
    container.register('BootstrappedUserId', () => result.userId);

    // 'CurrentUserId' still exists for legacy per-session constructors
    // (ActivationStore/ConfirmationStore/ChallengeStore) that are resolved at
    // startup/session-init time — i.e. OUTSIDE a request scope, where there
    // is no active ContextTracker session yet. For stdio, this is safe because
    // there's only one tenant. For HTTP+DB, each HTTP session resolves it
    // from its own child-container scope at session creation (see
    // createServerForHttpSession) and the bootstrapped UUID is the default
    // until per-request auth identity lands.
    container.register('CurrentUserId', () => result.userId);

    // 'UserIdResolver' is the per-call resolver used by storage layers. It
    // reads from the active ContextTracker session scope, so each MCP tool
    // call sees its own session's userId. stdio has one static session, HTTP
    // has one per connection — the resolver is the same code.
    container.register('UserIdResolver', () => {
      const tracker = container.resolve<ContextTracker>('ContextTracker');
      return createUserIdResolver(tracker);
    });

    // Re-register StdioSession with the bootstrapped DB UUID. registerServices()
    // already set up a fallback factory that checks BootstrappedUserId, but by
    // the time we get here the original factory may have been invoked eagerly
    // (e.g. during ServerSetup construction) and its result cached. Re-
    // registering clears the cached instance so the next resolve picks up the
    // UUID-bearing session. (Container.register() resets `instance: null`.)
    container.register('StdioSession', () => Object.freeze({
      ...createStdioSession(),
      userId: result.userId,
    }));
  }

  /**
   * Resolve database deps for element managers.
   *
   * Returns the DatabaseInstance plus a per-call userId resolver. The resolver
   * reads from ContextTracker's active session context, so each HTTP request's
   * scope supplies its own user identity — no singleton, no tenant bleed.
   *
   * Returns `{}` when database mode is inactive, so spreading into deps is a
   * no-op. Callers don't need to guard with a flag check.
   */
  public static resolveDatabaseDeps(container: DiContainerFacade): OptionalDatabaseDeps {
    if (container.hasRegistration('DatabaseInstance')) {
      return {
        databaseInstance: container.resolve<DatabaseInstance>('DatabaseInstance'),
        getCurrentUserId: container.resolve<UserIdResolver>('UserIdResolver'),
        createDatabaseStorageLayer: container.resolve('DatabaseStorageLayerFactory'),
      };
    }
    return {};
  }
}
