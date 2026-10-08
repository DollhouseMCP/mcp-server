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
import { DatabaseMemoryBootQualification, type MemoryBootIdentity } from './DatabaseMemoryBootQualification.js';
import { DatabaseMemoryCandidateHandoff, type MemoryHandoffAttribution } from './DatabaseMemoryCandidateHandoff.js';

/** Server-internal dormant composition; never resolved from request fields. */
export type AdmittedDatabaseMemoryManagerFactory = (deps: ElementManagerDeps) => MemoryManager;
export interface DormantDurableMemoryComposition {
  readonly manager: MemoryManager;
  readonly qualify: (inspect: (identity: MemoryBootIdentity) => Promise<void>) => Promise<void>;
  readonly close: () => void;
  readonly inspectRetained: () => ReturnType<DatabaseMemoryCandidateHandoff['inspectRetained']>;
}

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
    return this.createAdmittedComposition(deps).manager;
  }

  /** Candidate preservation/closed boot opt-in. Final protected composition must use the enforcing subclass. */
  createDurableAdmittedMemoryManager(deps: ElementManagerDeps,
    getAttribution: () => MemoryHandoffAttribution): DormantDurableMemoryComposition {
    return this.createAdmittedComposition(deps, getAttribution);
  }

  private createAdmittedComposition(deps: ElementManagerDeps,
    getAttribution?: () => MemoryHandoffAttribution): DormantDurableMemoryComposition {
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
    let handoff: DatabaseMemoryCandidateHandoff;
    const boot = new DatabaseMemoryBootQualification();
    const identity = () => ({ tenant: this.getCurrentUserId(), store: layer, backend: 'database' as const });
    const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: layer }, this.getCurrentUserId,
      () => gate, getAttribution ? () => handoff : undefined,
      getAttribution ? (candidate, token) => layer.assertGuardedReadCandidate(candidate.content, token.locator, candidate.name) : undefined);
    gate = new DatabaseMemoryAdmissionGate(this.db, layer, () => ({
      tenant: this.getCurrentUserId(), backend: 'database', db: this.db,
      store: layer, adapter, enabled: getAttribution ? boot.isQualified(identity()) : true, profile: DATABASE_MEMORY_ADMISSION_PROFILE,
    }));
    if (getAttribution) handoff = new DatabaseMemoryCandidateHandoff(this.db, layer, gate, boot,
      this.getCurrentUserId, getAttribution);
    const manager = new MemoryManager({ ...deps, storageLayerFactory: {
      createForElement: (type, options) => type === ElementType.MEMORY ? layer : this.createForElement(type, options),
    } }, adapter);
    if (getAttribution) layer.bindGuardedReadFidelity((content, locator, name) =>
      manager.assertGuardedReadFidelity(content, locator, name));
    return {
      manager,
      close: () => boot.close(),
      inspectRetained: () => {
        if (!getAttribution) throw new Error('Durable memory handoff is not configured');
        return handoff.inspectRetained();
      },
      qualify: async inspect => {
        if (!getAttribution) throw new Error('Durable memory handoff is not configured');
        await boot.qualify(identity(), async captured => {
          if ((await handoff.inspectRetained()).length) throw new Error('Retained memory outcomes require explicit resolution');
          await inspect(captured);
          if (this.getCurrentUserId() !== captured.tenant) throw new Error('Memory qualification tenant changed');
        });
      },
    };
  }

  createForElement(elementType: string, _fileOptions: FileStorageOptions): IStorageLayer {
    if (elementType === 'memories') {
      return new DatabaseMemoryStorageLayer(this.db, this.getCurrentUserId);
    }
    return new DatabaseStorageLayer(this.db, this.getCurrentUserId, elementType);
  }
}
