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
 * **TODO (Phase J)**: register periodic-sweeper timers via
 * `LifecycleService.registerPeriodicTask` once that helper exists. For
 * now `shared_cache.expires_at < NOW()` rows accumulate until manually
 * pruned; bounded by operator-driven traffic, not user-driven.
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

    const [operatorConfig, userConfig, sharedCache] = await Promise.all([
      createOperatorConfigStore({ database }),
      createUserConfigStore({ database }),
      createSharedCacheStore({ database }),
    ]);

    container.register('OperatorConfigStore', () => operatorConfig);
    container.register('UserConfigStore', () => userConfig);
    container.register('SharedCacheStore', () => sharedCache);

    logger.info('[StorageServiceRegistrar] Phase 4.5 stores registered', {
      backend: database ? 'postgres' : 'filesystem-or-memory',
    });
  }
}
