/**
 * SharedPoolServiceRegistrar
 *
 * Owns DI wiring for the shared-pool module. Gated on the
 * `DOLLHOUSE_SHARED_POOL_ENABLED` feature flag — when the flag is off
 * (default), this registrar is a no-op and no shared-pool services are
 * registered. The rest of the system behaves identically to pre-4.6.
 *
 * When enabled, registers:
 * - `SharedPoolConfig` — resolved configuration
 * - `ProvenanceStore` — backend-appropriate implementation (DB or file)
 * - `ContentHashVerifier` — hash computation + provenance comparison
 * - `SharedPoolInstaller` — admin-elevated write path
 * - `DeploymentSeedLoader` — bootstrap-time seed ingestion
 * - `ForkOnEditStrategy` — pre-edit hook for shared elements
 * - `PublicElementDiscovery` — file-mode include_public augmentation
 *
 * Service implementations are dynamically imported to keep the
 * shared-pool module out of the static import graph when disabled.
 *
 * @module collection/shared-pool/SharedPoolServiceRegistrar
 */

import { logger } from '../../utils/logger.js';
import type { DiContainerFacade } from '../../di/DiContainerFacade.js';
import {
  isSharedPoolEnabled,
  resolveSharedPoolConfig,
  type SharedPoolConfiguration,
} from './SharedPoolConfig.js';

export class SharedPoolServiceRegistrar {
  /**
   * Register shared-pool services if the feature flag is on.
   *
   * Must be called during startup, after PathsServiceRegistrar and
   * (optionally) DatabaseServiceRegistrar have run — this registrar
   * depends on `PathService` and (in DB mode) `DatabaseInstance`.
   *
   * @returns `true` if services were registered, `false` if the flag
   *          was off and the registrar was a no-op.
   */
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<boolean> {
    if (!isSharedPoolEnabled()) {
      logger.debug('[SharedPoolServiceRegistrar] Feature flag off — skipping registration');
      return false;
    }

    const config = resolveSharedPoolConfig();

    logger.info('[SharedPoolServiceRegistrar] Shared pool enabled — registering services', {
      collectionUrl: config.collectionUrl ?? '(default)',
      allowlistHosts: config.collectionAllowlist.length,
      sharedPoolDir: config.sharedPoolDir ?? '(default)',
    });

    container.register<SharedPoolConfiguration>('SharedPoolConfig', () => config);

    // In DB mode, ensure the SYSTEM user row exists. The migration
    // (0008) creates it, but this is a safety net for deployments
    // that haven't run migrations yet or had the row deleted.
    if (container.hasRegistration('DatabaseInstance')) {
      const { SystemUserProvisioner } = await import('./SystemUserProvisioner.js');
      const db = container.resolve<import('../../database/connection.js').DatabaseInstance>('DatabaseInstance');
      const provisioner = new SystemUserProvisioner(db);
      await provisioner.ensure();
      container.register('SystemUserProvisioner', () => provisioner);
    }

    // Provenance store — backend-selected at registration time.
    // DB mode: DatabaseProvenanceStore (dynamic import keeps drizzle out of file-mode).
    // File mode: FileProvenanceStore (reads from shared/.provenance/).
    if (container.hasRegistration('DatabaseInstance')) {
      const { DatabaseProvenanceStore } = await import('./DatabaseProvenanceStore.js');
      const db = container.resolve<import('../../database/connection.js').DatabaseInstance>('DatabaseInstance');
      container.register('ProvenanceStore', () => new DatabaseProvenanceStore(db));
    } else {
      const { FileProvenanceStore } = await import('./FileProvenanceStore.js');
      const { resolveDataDirectory } = await import('../../paths/resolveDataDirectory.js');
      const provenanceDir = resolveDataDirectory('shared-provenance');
      container.register('ProvenanceStore', () => new FileProvenanceStore(provenanceDir));
    }

    // ContentHashVerifier — delegates to the ProvenanceStore registered above.
    const { ContentHashVerifier } = await import('./ContentHashVerifier.js');
    container.register('ContentHashVerifier', () => {
      const store = container.resolve<import('./IProvenanceStore.js').IProvenanceStore>('ProvenanceStore');
      return new ContentHashVerifier(store);
    });

    // SharedPoolInstaller — the admin-elevated write path.
    // Write strategy is backend-selected; installer itself is backend-agnostic.
    const { SharedPoolInstaller, FileSharedPoolWriteStrategy, DatabaseSharedPoolWriteStrategy } =
      await import('./SharedPoolInstaller.js');

    if (container.hasRegistration('DatabaseInstance')) {
      const dbForInstaller = container.resolve<import('../../database/connection.js').DatabaseInstance>('DatabaseInstance');
      container.register('SharedPoolInstaller', () => {
        const store = container.resolve<import('./IProvenanceStore.js').IProvenanceStore>('ProvenanceStore');
        return new SharedPoolInstaller(store, new DatabaseSharedPoolWriteStrategy(dbForInstaller));
      });
    } else {
      const { resolveDataDirectory } = await import('../../paths/resolveDataDirectory.js');
      const sharedPoolDir = config.sharedPoolDir ?? resolveDataDirectory('shared-pool');
      container.register('SharedPoolInstaller', () => {
        const store = container.resolve<import('./IProvenanceStore.js').IProvenanceStore>('ProvenanceStore');
        return new SharedPoolInstaller(store, new FileSharedPoolWriteStrategy(sharedPoolDir));
      });
    }

    // DeploymentSeedLoader — scans seed directory at startup.
    const { DeploymentSeedLoader } = await import('./DeploymentSeedLoader.js');
    const { resolveDataDirectory: resolveSeedDir } = await import('../../paths/resolveDataDirectory.js');
    const seedDir = config.sharedPoolDir ?? resolveSeedDir('shared-pool');
    container.register('DeploymentSeedLoader', () => {
      const installerForSeed = container.resolve<import('./ISharedPoolInstaller.js').ISharedPoolInstaller>('SharedPoolInstaller');
      const storeForSeed = container.resolve<import('./IProvenanceStore.js').IProvenanceStore>('ProvenanceStore');
      return new DeploymentSeedLoader(seedDir, installerForSeed, storeForSeed);
    });

    // Shared pool directory — used by ForkOnEditStrategy and PublicElementDiscovery.
    // Declared before either registration so the closure captures an initialized binding.
    const { resolveDataDirectory: resolveSharedDir } = await import('../../paths/resolveDataDirectory.js');
    const sharedDir = config.sharedPoolDir ?? resolveSharedDir('shared-pool');

    const { ForkOnEditStrategy } = await import('./ForkOnEditStrategy.js');
    container.register('ForkOnEditStrategy', () => {
      const storeForFork = container.resolve<import('./IProvenanceStore.js').IProvenanceStore>('ProvenanceStore');
      return new ForkOnEditStrategy(storeForFork, sharedDir);
    });

    const { PublicElementDiscovery } = await import('./PublicElementDiscovery.js');
    container.register('PublicElementDiscovery', () => new PublicElementDiscovery(sharedDir));

    logger.info('[SharedPoolServiceRegistrar] All shared-pool services registered');
    return true;
  }
}
