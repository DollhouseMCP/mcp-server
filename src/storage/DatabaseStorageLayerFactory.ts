/**
 * DatabaseStorageLayerFactory — database-backed storage layer creation.
 *
 * Creates DatabaseStorageLayer for most element types and
 * DatabaseMemoryStorageLayer for memories (which syncs YAML entries
 * into the memory_entries table). The DB connection and per-call
 * userId resolver are held as instance state, injected at factory
 * construction time by DatabaseServiceRegistrar.
 *
 * This file is DYNAMICALLY IMPORTED by DatabaseServiceRegistrar.
 * It is never statically in the import graph. drizzle-orm stays
 * out of file-mode deployments and tests entirely.
 *
 * @since Step 4.5 Commit 2.5
 */

import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { IStorageLayer } from './IStorageLayer.js';
import type { IStorageLayerFactory, FileStorageOptions } from './IStorageLayerFactory.js';
import { DatabaseStorageLayer } from './DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import type { ElementManagerDeps } from '../elements/base/BaseElementManager.js';
import { ElementType } from '../portfolio/PortfolioManager.js';
import { getValidatedScanCooldown } from '../config/performance-constants.js';
import { MemoryHeadUpdateAdapter } from './MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE } from './DatabaseMemoryAdmissionGate.js';

/** Server-internal dormant composition; never resolved from request fields. */
export type AdmittedDatabaseMemoryManagerFactory = (deps: ElementManagerDeps) => MemoryManager;

export class DatabaseStorageLayerFactory implements IStorageLayerFactory {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly getCurrentUserId: UserIdResolver,
  ) {}

  /**
   * Compose one existing-owner UPDATE manager with the actual gate-owned DB
   * transaction. No production registrar installs this provider automatically.
   * Subclasses must supply their protected layer through createForElement.
   */
  createAdmittedMemoryManager(deps: ElementManagerDeps): MemoryManager {
    if (deps.storageLayerFactory !== this || deps.getCurrentUserId !== this.getCurrentUserId) {
      throw new Error('Admitted memory composition requires the actual database factory and user resolver');
    }
    const layer = this.createForElement(ElementType.MEMORY, {
      elementDir: deps.portfolioManager.getElementDir(ElementType.MEMORY),
      fileExtension: '.yaml', scanCooldownMs: getValidatedScanCooldown(),
    });
    if (!(layer instanceof DatabaseMemoryStorageLayer)) {
      throw new TypeError('Admitted memory composition requires a database memory layer');
    }
    // The adapter resolves this gate only at request time, after construction.
    let gate: DatabaseMemoryAdmissionGate;
    const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: layer }, this.getCurrentUserId, () => gate);
    gate = new DatabaseMemoryAdmissionGate(this.db, layer, () => ({
      tenant: this.getCurrentUserId(), backend: 'database', db: this.db,
      store: layer, adapter, enabled: true, profile: DATABASE_MEMORY_ADMISSION_PROFILE,
    }));
    return new MemoryManager({ ...deps, storageLayerFactory: {
      createForElement: (type, options) => type === ElementType.MEMORY ? layer : this.createForElement(type, options),
    } }, adapter);
  }

  createForElement(elementType: string, _fileOptions: FileStorageOptions): IStorageLayer {
    if (elementType === 'memories') {
      return new DatabaseMemoryStorageLayer(this.db, this.getCurrentUserId);
    }
    return new DatabaseStorageLayer(this.db, this.getCurrentUserId, elementType);
  }
}
