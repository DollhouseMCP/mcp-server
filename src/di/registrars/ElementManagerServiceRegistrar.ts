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

export class ElementManagerServiceRegistrar {
  public register(container: DiContainerFacade): void {
    container.register('ElementEventDispatcher', () => new ElementEventDispatcher(
      container.resolve('ContextTracker')
    ));

    // PORTFOLIO & MANAGERS
    container.register('PortfolioManager', () => {
      const config = container.hasRegistration('PathService')
        ? { baseDir: container.resolve<import('../../paths/PathService.js').PathService>('PathService').resolveDataDir('portfolio-root') }
        : undefined;
      return new PortfolioManager(container.resolve('FileOperationsService'), config);
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
      container.resolve('FileOperationsService')
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
      eventDispatcher: container.resolve('ElementEventDispatcher'),
      contextTracker: container.resolve('ContextTracker'),
      activationRegistry: container.resolve('SessionActivationRegistry'),
      // Issue #1948: Instance-injected dependencies (replaces static resolvers)
      elementManagerResolver: (name: string) => container.resolve(name) as import('../../elements/agents/AgentManager.js').ResolvedElementManager,
      dangerZoneEnforcer: container.resolve('DangerZoneEnforcer'),
      verificationStore: container.resolve('ChallengeStore'),
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
