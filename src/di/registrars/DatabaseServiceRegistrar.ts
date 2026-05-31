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
import type { SessionIdResolver, UserIdResolver } from '../../database/UserContext.js';

import type { SessionActivationRegistry } from '../../state/SessionActivationState.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export type { DiContainerFacade } from '../DiContainerFacade.js';


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
    const appConnectionUrl = env.DOLLHOUSE_DATABASE_URL;
    if (!appConnectionUrl) {
      throw new Error(
        'DOLLHOUSE_STORAGE_BACKEND=database requires DOLLHOUSE_DATABASE_URL to be set',
      );
    }

    // Dynamic imports — drizzle-orm stays out of the static module graph
    // so file-mode deployments and tests never load it.
    const { bootstrapDatabase } = await import('../../database/bootstrap.js');
    const { createDatabaseConnection } = await import('../../database/connection.js');
    const { createSessionIdResolver, createUserIdResolver } = await import('../../database/UserContext.js');

    const result = await bootstrapDatabase({
      connectionUrl: appConnectionUrl,
      adminConnectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL,
      poolSize: env.DOLLHOUSE_DATABASE_POOL_SIZE,
      ssl: env.DOLLHOUSE_DATABASE_SSL,
    });

    // Connection object (has .close() — picked up by Container.dispose() automatically)
    container.register('DatabaseConnection', () => result.connection);
    // Drizzle instance (resolved by stores and storage layers)
    container.register('DatabaseInstance', () => result.db);

    const systemConnection = env.DOLLHOUSE_DATABASE_ADMIN_URL
      ? createDatabaseConnection({
          connectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL,
          poolSize: Math.min(env.DOLLHOUSE_DATABASE_POOL_SIZE, 2),
          ssl: env.DOLLHOUSE_DATABASE_SSL,
        })
      : result.connection;
    container.register('SystemDatabaseConnection', () => systemConnection);
    container.register('SystemDatabaseInstance', () => systemConnection.db);
    await this.registerWebConsoleProductionDatabaseReadiness(container, systemConnection.db);

    // Storage layer factory + state store classes — loaded here (async context)
    // so drizzle-orm stays out of the static import graph entirely. File-mode
    // code and tests never import these modules.
    const { DatabaseStorageLayerFactory } = await import('../../storage/DatabaseStorageLayerFactory.js');
    const { DatabaseActivationStateStore } = await import('../../state/DatabaseActivationStateStore.js');
    const { DatabaseConfirmationStore } = await import('../../state/DatabaseConfirmationStore.js');
    const { DatabaseChallengeStore } = await import('../../state/DatabaseChallengeStore.js');
    const { DatabaseAgentStateStore } = await import('../../storage/DatabaseAgentStateStore.js');

    container.register('DatabaseActivationStateStoreClass', () => DatabaseActivationStateStore);
    container.register('DatabaseConfirmationStoreClass', () => DatabaseConfirmationStore);
    container.register('DatabaseChallengeStoreClass', () => DatabaseChallengeStore);

    // The bootstrapped DB UUID is the identity every session binds to by default.
    container.register('BootstrappedUserId', () => result.userId);

    // 'CurrentUserId' still exists for legacy per-session constructors
    // (ActivationStore/ConfirmationStore/ChallengeStore) that are resolved at
    // startup/session-init time — outside a request scope where there is no
    // active ContextTracker session yet.
    container.register('CurrentUserId', () => result.userId);

    // 'UserIdResolver' — the per-call resolver used by storage layers. Reads
    // from ContextTracker's active session scope, with a per-session override
    // from set_user_identity (dbUserId on SessionActivationState). Must be
    // registered BEFORE the StorageLayerFactory override below resolves it.
    container.register('UserIdResolver', () => {
      const tracker = container.resolve<ContextTracker>('ContextTracker');
      const registry = container.hasRegistration('SessionActivationRegistry')
        ? container.resolve<SessionActivationRegistry>('SessionActivationRegistry')
        : undefined;
      return createUserIdResolver(tracker, registry);
    });
    container.register('SessionIdResolver', () => {
      const tracker = container.resolve<ContextTracker>('ContextTracker');
      return createSessionIdResolver(tracker);
    });

    // Override the file-mode StorageLayerFactory with the DB-backed variant.
    // Resolved AFTER UserIdResolver is registered so the factory captures
    // the DB-specific resolver (not the PathsServiceRegistrar fallback).
    const userIdResolver = container.resolve<UserIdResolver>('UserIdResolver');
    const sessionIdResolver = container.resolve<SessionIdResolver>('SessionIdResolver');
    container.register('StorageLayerFactory', () =>
      new DatabaseStorageLayerFactory(result.db, userIdResolver)
    );
    container.register('AgentStateStore', () =>
      new DatabaseAgentStateStore(result.db, userIdResolver, sessionIdResolver)
    );

    // UserIdentityService — resolves usernames to DB UUIDs on demand.
    // Used by IdentityHandler when set_user_identity is called in DB mode.
    const { UserIdentityService } = await import('../../services/UserIdentityService.js');
    container.register('UserIdentityService', () => new UserIdentityService({
      db: result.db,
      adminConnectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL,
      appConnectionUrl,
      ssl: env.DOLLHOUSE_DATABASE_SSL,
    }));

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

  private async registerWebConsoleProductionDatabaseReadiness(
    container: DiContainerFacade,
    db: DatabaseInstance,
  ): Promise<void> {
    if (!env.DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME) return;

    const {
      createPostgresProductionDatabaseReadiness,
      resolveWebConsoleProductionDatabaseVerificationFromEnv,
    } = await import('../../web-console/WebConsoleProductionDatabaseReadiness.js');
    const verification = resolveWebConsoleProductionDatabaseVerificationFromEnv(env);
    if (!verification) return;

    container.register('WebConsoleProductionDatabaseReadiness', () =>
      createPostgresProductionDatabaseReadiness({
        db,
        ...verification,
      })
    );
  }

}
