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
import { Memory } from '../../elements/memories/Memory.js';
import { createStdioSession } from '../../context/StdioSession.js';
import type { ContextTracker } from '../../security/encryption/ContextTracker.js';
import type { PathService } from '../../paths/PathService.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { SessionIdResolver, UserIdResolver } from '../../database/UserContext.js';

import type { SessionActivationRegistry } from '../../state/SessionActivationState.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export type { DiContainerFacade } from '../DiContainerFacade.js';

interface DatabaseConnectionLifecycleOwner {
  close(): void | Promise<void>;
}

/**
 * Register and materialize the connection wrappers that own database pools.
 * Container disposal only sees resolved singleton instances, so both distinct
 * owners must be resolved while a shared owner must be resolved only once.
 */
export function registerDatabaseConnectionLifecycleOwners(
  container: DiContainerFacade,
  applicationConnection: DatabaseConnectionLifecycleOwner,
  systemConnection: DatabaseConnectionLifecycleOwner,
): void {
  container.register('DatabaseConnection', () => applicationConnection);
  container.resolve('DatabaseConnection');
  container.register('SystemDatabaseConnection', () => systemConnection);
  if (systemConnection !== applicationConnection) {
    container.resolve('SystemDatabaseConnection');
  }
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

    const systemConnection = env.DOLLHOUSE_DATABASE_ADMIN_URL
      ? createDatabaseConnection({
          connectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL,
          poolSize: Math.min(env.DOLLHOUSE_DATABASE_POOL_SIZE, 2),
          ssl: env.DOLLHOUSE_DATABASE_SSL,
        })
      : result.connection;
    registerDatabaseConnectionLifecycleOwners(container, result.connection, systemConnection);
    // Drizzle instances (resolved by stores and storage layers)
    container.register('DatabaseInstance', () => result.db);
    container.register('SystemDatabaseInstance', () => systemConnection.db);
    // Verify production database readiness over the APP connection (result.db),
    // not the admin/system connection. The expectedCurrentUser check exists to
    // prove the runtime queries as the least-privilege, NOBYPASSRLS role so RLS
    // is actually enforced; running it on the admin connection would always see
    // the superuser and make that assertion meaningless.
    await this.registerWebConsoleProductionDatabaseReadiness(container, result.db);

    // Storage layer factory + state store classes — loaded here (async context)
    // so drizzle-orm stays out of the static import graph entirely. File-mode
    // code and tests never import these modules.
    const { DatabaseStorageLayerFactory } = await import('../../storage/DatabaseStorageLayerFactory.js');
    const { DatabaseActivationStateStore } = await import('../../state/DatabaseActivationStateStore.js');
    const { DatabaseConfirmationStore } = await import('../../state/DatabaseConfirmationStore.js');
    const { DatabaseChallengeStore } = await import('../../state/DatabaseChallengeStore.js');
    const { DatabaseAgentStateStore } = await import('../../storage/DatabaseAgentStateStore.js');
    const { findRecordedRuntimePresenceWithTx } = await import(
      '../../web-console/services/runtime/PostgresRuntimeSessionControlStore.js'
    );

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
      return createUserIdResolver(tracker, registry, env.DOLLHOUSE_DATABASE_MEMORY_GUARDED);
    }, { override: true });
    container.register('SessionIdResolver', () => {
      const tracker = container.resolve<ContextTracker>('ContextTracker');
      return createSessionIdResolver(tracker);
    });

    // Override the file-mode StorageLayerFactory with the DB-backed variant.
    // Resolved AFTER UserIdResolver is registered so the factory captures
    // the DB-specific resolver (not the PathsServiceRegistrar fallback).
    const userIdResolver = container.resolve<UserIdResolver>('UserIdResolver');
    const sessionIdResolver = container.resolve<SessionIdResolver>('SessionIdResolver');
    const { DatabaseTenantMemoryRegistry } = await import('../../storage/DatabaseTenantMemoryRegistry.js');
    const { requireDatabaseMemoryStartupAdmission } = await import('../../storage/DatabaseMemoryStartupAdmission.js');
    if (env.DOLLHOUSE_DATABASE_MEMORY_GUARDED && !container.hasRegistration('DatabaseTenantMemoryRegistry')) {
      const tracker = container.resolve<ContextTracker>('ContextTracker');
      const registry = new DatabaseTenantMemoryRegistry({
        db: result.db, getEffectiveTenant: userIdResolver,
        createManagerDeps: (factory, resolver) => container.resolve<import('./ElementManagerServiceRegistrar.js').DatabaseMemoryManagerDepsFactory>(
          'DatabaseMemoryManagerDepsFactory')(factory, resolver),
        getAttribution: () => {
          const session = tracker.requireSessionContext('Durable memory attribution');
          return { contextRoot: container.resolve<PathService>('PathService').getUserPortfolioDir(userIdResolver()),
            sessionId: session.sessionId, transport: session.transport };
        },
      });
      container.register('DatabaseTenantMemoryRegistry', () => registry);
      container.resolve('DatabaseTenantMemoryRegistry');
    }
    const memoryRegistry = container.hasRegistration('DatabaseTenantMemoryRegistry')
      ? container.resolve<unknown>('DatabaseTenantMemoryRegistry') : undefined;
    if (memoryRegistry !== undefined && (!(memoryRegistry instanceof DatabaseTenantMemoryRegistry) ||
      !memoryRegistry.matchesDatabase(result.db))) {
      throw new Error('Database tenant memory composition must bind the actual application database');
    }
    // Before startup admission awaits or console/background exposure. The
    // process cannot inherit another container's unattributed static owner.
    if (memoryRegistry) Memory.refuseUnattributedAccess();
    // Always execute, including configuration-off. An RLS-filtered app query
    // cannot prove that another served tenant has no durable protected mode.
    await requireDatabaseMemoryStartupAdmission(result.db, systemConnection.db, memoryRegistry !== undefined);
    if (memoryRegistry) {
      const { DatabaseMemoryAccountDeletionBoundary } = await import('../../storage/DatabaseMemoryAccountDeletionBoundary.js');
      const boundary = new DatabaseMemoryAccountDeletionBoundary(systemConnection.db);
      container.register('DatabaseMemoryAccountDeletionBoundary', () => boundary);
      container.resolve('DatabaseMemoryAccountDeletionBoundary');
    }
    const { DatabaseMemoryModeEnforcingStorageLayerFactory } = await import(
      '../../storage/DatabaseMemoryModeEnforcingStorageLayerFactory.js'
    );
    container.register(
      'StorageLayerFactory',
      () => memoryRegistry
        ? new DatabaseMemoryModeEnforcingStorageLayerFactory(result.db, userIdResolver)
        : new DatabaseStorageLayerFactory(result.db, userIdResolver),
      { override: true },
    );
    container.register(
      'AgentStateStore',
      () => new DatabaseAgentStateStore(
        result.db,
        userIdResolver,
        sessionIdResolver,
        async (sessionId, userId, tx) => {
          if (!env.DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED) {
            return 'unknown';
          }
          const presence = await findRecordedRuntimePresenceWithTx(tx, sessionId);
          if (presence?.userId !== userId) {
            return 'unknown';
          }
          return presence.status === 'active' && presence.leaseUntil > new Date()
            ? 'active'
            : 'inactive';
        },
        systemConnection.db,
      ),
      { override: true },
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
    }), { override: true });
  }

  /** Cold startup only. No request handler receives this privileged boot method. */
  public async qualifyRegisteredMemoryTenants(container: DiContainerFacade): Promise<void> {
    if (!container.hasRegistration('DatabaseTenantMemoryRegistry')) return;
    const { sql } = await import('drizzle-orm');
    const { withSystemContext } = await import('../../database/admin.js');
    const { DatabaseTenantMemoryRegistry } = await import('../../storage/DatabaseTenantMemoryRegistry.js');
    const { qualifyDatabaseMemoryTenant } = await import('../../storage/DatabaseMemoryTenantQualification.js');
    const { requireDatabaseMemoryStartupAdmission } = await import('../../storage/DatabaseMemoryStartupAdmission.js');
    const registry = container.resolve<InstanceType<typeof DatabaseTenantMemoryRegistry>>('DatabaseTenantMemoryRegistry');
    const appDb = container.resolve<DatabaseInstance>('DatabaseInstance');
    const systemDb = container.resolve<DatabaseInstance>('SystemDatabaseInstance');
    if (!(registry instanceof DatabaseTenantMemoryRegistry) || !registry.matchesDatabase(appDb)) {
      throw new Error('Boot memory registry must bind the actual application database');
    }
    const tracker = container.resolve<ContextTracker>('ContextTracker');
    let last: string | null = null;
    try {
      for (;;) {
        // Settle the bounded mode page before acquiring either pool for the
        // owner qualifier. This remains safe when each pool has size one.
        // Cold all-replica mode/writer exclusion is independently required;
        // this page loop is not a hot promotion or cross-tenant snapshot fence.
        const page = await withSystemContext(systemDb, async tx => {
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
          return tx.execute(sql`SELECT user_id::text AS tenant FROM public.memory_backend_modes
            WHERE backend='database' AND mode IN ('guarded','read_only')
              AND (${last}::uuid IS NULL OR user_id > ${last}::uuid) ORDER BY user_id LIMIT 100`);
        });
        if (!page.length) break;
        if (page.length > 100) throw new Error('Invalid protected tenant boot page');
        for (const row of page) {
          const tenant = row.tenant;
          if (typeof tenant !== 'string' || last !== null && tenant <= last) throw new Error('Invalid tenant boot order');
          const session = Object.freeze({ userId: tenant, sessionId: `memory-boot-${tenant}`, tenantId: null,
            transport: 'stdio' as const, createdAt: Date.now() });
          await tracker.runAsync(tracker.createSessionContext('background-task', session), async () => {
            const capture = registry.capture(tenant);
            const manager = await registry.resolve(capture);
            const checkpoint = () => registry.assertCurrent(capture);
            await registry.qualify(capture, async identity => {
              checkpoint();
              if (identity.tenant !== tenant || identity.backend !== 'database') throw new Error('Memory boot identity changed');
              await qualifyDatabaseMemoryTenant({ appDb, systemDb, tenant, manager, checkpoint });
              checkpoint();
            });
          });
          last = tenant;
        }
      }
      // Unknown/malformed or mismatched database state still refuses startup.
      // Newly observed protected slots remain closed; no on-request adoption.
      await requireDatabaseMemoryStartupAdmission(appDb, systemDb, true);
    } catch (cause) { registry.close(); throw cause; }
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
