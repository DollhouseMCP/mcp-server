/**
 * ElementManagerServiceRegistrar
 *
 * Owns the DI wiring for all element manager services: the portfolio
 * manager, element-type managers (persona, skill, template, agent,
 * memory, ensemble), import/export, converters, and related services.
 *
 * Responsibilities:
 * - PortfolioManager
 * - PersonaImporter (with circular dep closure)
 * - PersonaManager, InitializationService, PersonaIndicatorService
 * - MigrationManager, BackupService, PolicyExportService
 * - SkillManager, TemplateManager, TemplateRenderer
 * - AgentManager, MemoryManager, EnsembleManager
 * - ElementEventDispatcher
 * - AnthropicToDollhouseConverter, DollhouseToAnthropicConverter
 *
 * @module di/registrars/ElementManagerServiceRegistrar
 */

import * as path from 'node:path';

import { PACKAGE_VERSION } from '../../generated/version.js';
import { getValidatedMaxBackupsPerElement, STORAGE_LAYER_CONFIG } from '../../config/performance-constants.js';
import { PortfolioManager, ElementType } from '../../portfolio/PortfolioManager.js';
import { MigrationManager } from '../../portfolio/MigrationManager.js';
import { PersonaManager } from '../../persona/PersonaManager.js';
import { PersonaImporter } from '../../persona/export-import/index.js';
import { InitializationService } from '../../services/InitializationService.js';
import { PersonaIndicatorService } from '../../services/PersonaIndicatorService.js';
import { BackupService } from '../../services/BackupService.js';
import { PolicyExportService } from '../../services/PolicyExportService.js';
import { SkillManager } from '../../elements/skills/index.js';
import { TemplateManager } from '../../elements/templates/TemplateManager.js';
import { TemplateRenderer } from '../../utils/TemplateRenderer.js';
import { AgentManager } from '../../elements/agents/AgentManager.js';
import { MemoryManager } from '../../elements/memories/MemoryManager.js';
import { EnsembleManager } from '../../elements/ensembles/EnsembleManager.js';
import { ElementEventDispatcher } from '../../events/ElementEventDispatcher.js';
import {
  AnthropicToDollhouseConverter,
  DollhouseToAnthropicConverter,
} from '../../converters/index.js';
import type { IStorageLayerFactory } from '../../storage/IStorageLayerFactory.js';
import type { ElementCRUDHandler } from '../../handlers/ElementCRUDHandler.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';
import type { SessionContainerRegistry } from '../SessionContainerRegistry.js';
import type { DangerZoneBlocker } from '../../elements/agents/types.js';

export class ElementManagerServiceRegistrar {
  public register(container: DiContainerFacade): void {
    container.register('ElementEventDispatcher', () => new ElementEventDispatcher(
      container.resolve('ContextTracker'),
      {
        activeDispatcherProvider: () =>
          container.resolve<SessionContainerRegistry>('SessionContainerRegistry')
            .getActiveContainer()
            ?.resolve<ElementEventDispatcher>('ElementEventDispatcher'),
      },
    ));

    // PORTFOLIO & MANAGERS
    container.register('PortfolioManager', () => {
      // Phase 4.5 follow-up: inject PathService + ContextTracker so
      // getElementDir(type) routes through the per-user resolver when a
      // session context is active. Flat-layout resolvers return the
      // shared base path (byte-identical to legacy behavior). Without
      // these injections — e.g. in standalone CLI / test harnesses that
      // skip PathService registration — PortfolioManager falls back to
      // the legacy flat path.
      const hasPathService = container.hasRegistration('PathService');
      const pathService = hasPathService
        ? container.resolve<import('../../paths/PathService.js').PathService>('PathService')
        : undefined;
      const config = hasPathService
        ? { baseDir: pathService!.resolveDataDir('portfolio-root') }
        : undefined;
      const contextTracker = container.hasRegistration('ContextTracker')
        ? container.resolve<import('../../security/encryption/ContextTracker.js').ContextTracker>('ContextTracker')
        : null;
      return new PortfolioManager(
        container.resolve('FileOperationsService'),
        config,
        { pathService, contextTracker },
      );
    });

    container.register('PersonaImporter', () => {
      const portfolioManager = container.resolve<PortfolioManager>('PortfolioManager');
      const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
      // This is a bit of a hack to break the circular dependency. We resolve PersonaManager inside the provider function.
      const currentUserProvider = () => container.resolve<PersonaManager>('PersonaManager').getCurrentUserForAttribution();
      return new PersonaImporter(
        personasDir,
        currentUserProvider,
        undefined,
        container.resolve('FileOperationsService')
      );
    });

    const resolveActiveOrRoot = <T>(serviceName: string): T => {
      const registry = container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
      const activeContainer = registry.getActiveContainer();
      return (activeContainer ?? container).resolve<T>(serviceName);
    };
    const dangerZoneEnforcerProxy: DangerZoneBlocker = {
      block: (...args) => resolveActiveOrRoot<DangerZoneBlocker>('DangerZoneEnforcer').block(...args),
    };
    const verificationStoreProxy = {
      set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) =>
        resolveActiveOrRoot<{ set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void }>('ChallengeStore')
          .set(id, challenge),
    };
    const backupServiceProvider = () => resolveActiveOrRoot<BackupService>('BackupService');

    container.register('PersonaManager', () => new PersonaManager({
      portfolioManager: container.resolve('PortfolioManager'),
      indicatorConfig: container.resolve('IndicatorConfig'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      personaImporter: container.resolve('PersonaImporter'),
      notifier: container.resolve('StateChangeNotifier'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    container.register('InitializationService', () => new InitializationService(
      container.resolve('PersonaManager')
    ));

    container.register('PersonaIndicatorService', () => new PersonaIndicatorService(
      container.resolve('PersonaManager'),
      container.resolve('IndicatorConfig'),
      container.resolve('StateChangeNotifier'),
      container.resolve('ElementEventDispatcher')
    ));

    container.register('MigrationManager', () => new MigrationManager(
      container.resolve('PortfolioManager'),
      container.resolve('FileLockManager'),
      container.resolve('FileOperationsService'),
      // Phase 4.5 follow-up: route the v1→v2 legacy-persona migration
      // through the storage-layer factory so DB-mode upgraders land their
      // migrated personas in Postgres rather than the filesystem.
      container.hasRegistration('StorageLayerFactory')
        ? container.resolve('StorageLayerFactory')
        : undefined,
    ));

    // BACKUP SERVICE (Issue #659: Universal backup for all element types)
    container.register('BackupService', () => new BackupService(
      container.resolve('FileOperationsService'),
      {
        backupRootDir: path.join(container.resolve<PortfolioManager>('PortfolioManager').getBaseDir(), '.backups'),
        maxBackupsPerElement: getValidatedMaxBackupsPerElement(),
        enabled: STORAGE_LAYER_CONFIG.BACKUPS_ENABLED,
      }
    ));

    // POLICY EXPORT SERVICE (Issue #762: Export policies to bridge)
    container.register('PolicyExportService', () => new PolicyExportService({
      getActiveElementsForPolicy: async () => {
        try {
          const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
          return handler.getActiveElementsForPolicy();
        } catch {
          return [];
        }
      },
      getServerVersion: () => PACKAGE_VERSION,
    }));

    // ELEMENT MANAGERS
    container.register('SkillManager', () => new SkillManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    container.register('TemplateManager', () => new TemplateManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    container.register('TemplateRenderer', () => new TemplateRenderer(container.resolve('TemplateManager')));

    container.register('AgentManager', () => new AgentManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      baseDir: container.resolve<PortfolioManager>('PortfolioManager').getBaseDir(),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      // Issue #1948: Instance-injected dependencies (replaces static resolvers)
      elementManagerResolver: (name: string) => container.resolve(name) as import('../../elements/agents/AgentManager.js').ResolvedElementManager,
      dangerZoneEnforcer: dangerZoneEnforcerProxy,
      verificationStore: verificationStoreProxy,
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    container.register('MemoryManager', () => new MemoryManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    container.register('EnsembleManager', () => new EnsembleManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      fileWatchService: container.resolve('FileWatchService'),
      memoryBudget: container.resolve('CacheMemoryBudget'),
      backupService: container.resolve('BackupService'),
      backupServiceProvider,
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      storageLayerFactory: container.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: container.hasRegistration('UserIdResolver') ? container.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: container.hasRegistration('PublicElementDiscovery') ? container.resolve('PublicElementDiscovery') : undefined,
    }));

    // CONVERTERS
    container.register('AnthropicToDollhouseConverter', () => new AnthropicToDollhouseConverter());
    container.register('DollhouseToAnthropicConverter', () => new DollhouseToAnthropicConverter());
  }
}
