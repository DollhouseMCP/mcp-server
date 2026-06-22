/**
 * StorageServiceRegistrar
 *
 * Wires the Phase 4.5 storage layers — operator config, user config, and
 * shared cache — into the DI container. Selects the backend per
 * `DOLLHOUSE_STORAGE_BACKEND`; resolves `DatabaseInstance` and
 * `SystemDatabaseInstance` from the container when in DB mode
 * (DatabaseServiceRegistrar must have run first).
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
import { env } from '../../config/env.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { TOKEN_FILE_NAME } from '../../security/tokenStores/FileTokenStore.js';

export class StorageServiceRegistrar {
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<void> {
    // Lazy imports so a deployment that never resolves these stores doesn't
    // pay the module-evaluation cost. Mirrors AuthServiceRegistrar's pattern.
    const { createOperatorConfigStore } = await import('../../storage/operatorConfig/createOperatorConfigStore.js');
    const { createUserConfigStore } = await import('../../storage/userConfig/createUserConfigStore.js');
    const { createSharedCacheStore } = await import('../../storage/sharedCache/createSharedCacheStore.js');
    const { FileTokenStore } = await import('../../security/tokenStores/FileTokenStore.js');
    const { DatabaseTokenStore } = await import('../../security/tokenStores/DatabaseTokenStore.js');
    const { EnvVarMasterKeyProvider } = await import('../../security/keys/EnvVarMasterKeyProvider.js');

    // Required when DOLLHOUSE_STORAGE_BACKEND=database; the Postgres
    // implementations throw without a `DatabaseInstance`. Filesystem and
    // in-memory backends ignore the value. DatabaseServiceRegistrar runs
    // before this in Container bootstrap, so the registration is present
    // in DB mode.
    const database = container.hasRegistration('DatabaseInstance')
      ? container.resolve<DatabaseInstance>('DatabaseInstance')
      : undefined;
    const systemDatabase = container.hasRegistration('SystemDatabaseInstance')
      ? container.resolve<DatabaseInstance>('SystemDatabaseInstance')
      : database;
    const fileOperations = container.hasRegistration('FileOperationsService')
      ? container.resolve<import('../../services/FileOperationsService.js').IFileOperationsService>('FileOperationsService')
      : undefined;

    const [operatorConfig, userConfig, sharedCache] = await Promise.all([
      createOperatorConfigStore({ database: systemDatabase }),
      createUserConfigStore({ database, fileOperations }),
      createSharedCacheStore({ database: systemDatabase }),
    ]);

    container.register('OperatorConfigStore', () => operatorConfig);
    container.register('UserConfigStore', () => userConfig);
    container.register('SharedCacheStore', () => sharedCache);
    container.register('MasterKeyProvider', () =>
      new EnvVarMasterKeyProvider(env.DOLLHOUSE_MASTER_ENCRYPTION_KEY)
    );
    container.register('TokenStore', () => {
      if (database) {
        return new DatabaseTokenStore(
          database,
          container.resolve('MasterKeyProvider'),
        );
      }
      return new FileTokenStore(
        container.resolve('FileOperationsService'),
        container.resolve('PathService'),
      );
    });

    if (database) {
      container.resolve('MasterKeyProvider');
      await this.detectLegacyFilesystemToken(container);
    }

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

  private async detectLegacyFilesystemToken(container: DiContainerFacade): Promise<void> {
    try {
      if (!container.hasRegistration('PathService') || !container.hasRegistration('BootstrappedUserId')) {
        return;
      }
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const userId = container.resolve<string>('BootstrappedUserId');
      const pathService = container.resolve<import('../../paths/PathService.js').PathService>('PathService');
      const tokenPath = path.join(pathService.getUserAuthDir(userId), TOKEN_FILE_NAME);
      await fs.access(tokenPath);

      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'HIGH',
        source: 'StorageServiceRegistrar.detectLegacyFilesystemToken',
        details: 'Database storage backend is active but an unmigrated filesystem GitHub token exists',
        additionalData: { userId },
      });
      logger.warn('[StorageServiceRegistrar] Unmigrated filesystem GitHub token detected in DB mode', {
        userId,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      logger.debug('[StorageServiceRegistrar] Legacy filesystem token detection skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
