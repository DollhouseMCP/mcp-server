/**
 * StorageServiceRegistrar
 *
 * Wires the Phase 4.5 storage layers — operator config, user config, and
 * shared cache — into the DI container. Selects the backend per
 * `DOLLHOUSE_STORAGE_BACKEND`; resolves `DatabaseInstance` from the
 * container when in DB mode (DatabaseServiceRegistrar must have run
 * first).
 *
 * Signing keys live in `AuthServiceRegistrar` instead, paired with the
 * rest of the AS infrastructure (separate env-var selector
 * `DOLLHOUSE_AUTH_STORAGE_BACKEND`).
 *
 * **Async** because the store factories return Promises (lazy postgres
 * import). Container.preparePortfolio() invokes this between
 * `DatabaseServiceRegistrar` (so `DatabaseInstance` is resolvable) and
 * any consumer that needs the stores.
 *
 * Registers a 1-hour periodic sweeper for `SharedCacheStore.sweepExpired`
 * via `LifecycleService.registerPeriodicTask`.
 *
 * @module di/registrars/StorageServiceRegistrar
 */

import { logger } from '../../utils/logger.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';
import type { DatabaseInstance } from '../../database/connection.js';

export class StorageServiceRegistrar {
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<void> {
    // Lazy imports so a deployment that never resolves these stores doesn't
    // pay the module-evaluation cost. Mirrors AuthServiceRegistrar's pattern.
    const { createOperatorConfigStore } = await import('../../storage/operatorConfig/createOperatorConfigStore.js');
    const { createUserConfigStore } = await import('../../storage/userConfig/createUserConfigStore.js');
    const { createSharedCacheStore } = await import('../../storage/sharedCache/createSharedCacheStore.js');

    // Required when DOLLHOUSE_STORAGE_BACKEND=database; the Postgres
    // implementations throw without a `DatabaseInstance`. Filesystem and
    // in-memory backends ignore the value. DatabaseServiceRegistrar runs
    // before this in Container bootstrap, so the registration is present
    // in DB mode.
    const database = container.hasRegistration('DatabaseInstance')
      ? container.resolve<DatabaseInstance>('DatabaseInstance')
      : undefined;
    const fileOperations = container.hasRegistration('FileOperationsService')
      ? container.resolve<import('../../services/FileOperationsService.js').IFileOperationsService>('FileOperationsService')
      : undefined;

    const [operatorConfig, userConfig, sharedCache] = await Promise.all([
      createOperatorConfigStore({ database }),
      createUserConfigStore({ database, fileOperations }),
      createSharedCacheStore({ database }),
    ]);

    container.register('OperatorConfigStore', () => operatorConfig);
    container.register('UserConfigStore', () => userConfig);
    container.register('SharedCacheStore', () => sharedCache);

    // Phase 4.5 / Phase J: sweep expired shared-cache entries hourly.
    // Filesystem + in-memory implementations no-op when nothing's expired;
    // postgres deletes any rows where expires_at < NOW(). Without this,
    // collection-index entries (and any future cached blobs) linger
    // indefinitely after their TTL.
    if (container.hasRegistration('LifecycleService')) {
      const lifecycle = container.resolve<{
        registerPeriodicTask(intervalMs: number, fn: () => Promise<void>, label: string): unknown;
      }>('LifecycleService');
      const ONE_HOUR_MS = 60 * 60 * 1000;
      lifecycle.registerPeriodicTask(
        ONE_HOUR_MS,
        async () => {
          const removed = await sharedCache.sweepExpired();
          if (removed > 0) {
            logger.debug(`[StorageServiceRegistrar] Swept ${removed} expired shared-cache entries`);
          }
        },
        'sharedCache.sweepExpired',
      );
    }

    logger.info('[StorageServiceRegistrar] Phase 4.5 stores registered', {
      backend: database ? 'postgres' : 'filesystem-or-memory',
    });
  }
}
