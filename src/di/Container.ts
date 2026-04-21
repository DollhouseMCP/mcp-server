import os from "os";
import * as path from "path";
import { PACKAGE_VERSION } from "../generated/version.js";
import { SecurityMonitor } from "../security/securityMonitor.js";
import { CircuitBreakerState } from "../elements/agents/resilienceEvaluator.js";
import { ResilienceMetricsTracker } from "../elements/agents/resilienceMetrics.js";
import { VerbTriggerManager } from "../portfolio/VerbTriggerManager.js";
import { RelationshipManager } from "../portfolio/RelationshipManager.js";
import { NLPScoringManager } from "../portfolio/NLPScoringManager.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { loadIndicatorConfig } from "../config/indicator-config.js";
import { env } from "../config/env.js";
import { APICache, CollectionCache, CollectionIndexCache, CacheMemoryBudget } from "../cache/index.js";
import { getValidatedGlobalCacheMemoryBytes, getValidatedMaxBackupsPerElement, getValidatedIndexDebounce, STORAGE_LAYER_CONFIG } from "../config/performance-constants.js";
import { BackupService } from "../services/BackupService.js";
import {
  GitHubClient,
  CollectionBrowser,
  CollectionIndexManager,
  CollectionSearch,
  PersonaDetails,
  ElementInstaller,
} from "../collection/index.js";
import { GitHubAuthManager } from "../auth/GitHubAuthManager.js";
import { PortfolioManager, ElementType } from "../portfolio/PortfolioManager.js";
import { MigrationManager } from "../portfolio/MigrationManager.js";
import { EnhancedIndexManager } from "../portfolio/EnhancedIndexManager.js";
import { EnhancedIndexHandler } from "../handlers/EnhancedIndexHandler.js";
import { MCPAQLHandler, type HandlerRegistry } from "../handlers/mcp-aql/MCPAQLHandler.js";
import { Gatekeeper } from "../handlers/mcp-aql/Gatekeeper.js";
import { GatekeeperSession } from "../handlers/mcp-aql/GatekeeperSession.js";
import { SkillManager } from "../elements/skills/index.js";
import { TemplateManager } from "../elements/templates/TemplateManager.js";
import { TemplateRenderer } from "../utils/TemplateRenderer.js";
import { AgentManager } from "../elements/agents/AgentManager.js";
import { Memory } from "../elements/memories/Memory.js";
import { MemoryManager } from "../elements/memories/MemoryManager.js";
import { WebSSELogSink } from "../web/sinks/WebSSELogSink.js";
import { WebSSEMetricsSink } from "../web/sinks/WebSSEMetricsSink.js";
import { EnsembleManager } from "../elements/ensembles/EnsembleManager.js";
import { PersonaExporter, PersonaImporter } from "../persona/export-import/index.js";
import { PersonaManager } from "../persona/PersonaManager.js";
import { PersonaHandler } from "../handlers/PersonaHandler.js";
import { ElementCRUDHandler } from "../handlers/ElementCRUDHandler.js";
import { CollectionHandler } from "../handlers/CollectionHandler.js";
import { PortfolioHandler } from "../handlers/PortfolioHandler.js";
import { PortfolioPullHandler } from "../handlers/PortfolioPullHandler.js";
import { GitHubAuthHandler } from "../handlers/GitHubAuthHandler.js";
import { DisplayConfigHandler } from "../handlers/DisplayConfigHandler.js";
import { IdentityHandler } from "../handlers/IdentityHandler.js";
import { ConfigHandler } from "../handlers/ConfigHandler.js";
import { SyncHandler } from "../handlers/SyncHandlerV2.js";
import { ToolRegistry } from "../handlers/ToolRegistry.js";
import { ServerSetup } from "../server/index.js";
import { ServerStartup } from "../server/startup.js";
import { PathValidator } from "../security/pathValidator.js";
import { logger } from "../utils/logger.js";
import { ErrorHandler } from "../utils/ErrorHandler.js";
import { UnifiedIndexManager } from "../portfolio/UnifiedIndexManager.js";
import { PortfolioIndexManager } from "../portfolio/PortfolioIndexManager.js";
import { SubmitToPortfolioTool } from "../tools/portfolio/submitToPortfolioTool.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { PortfolioRepoManager } from "../portfolio/PortfolioRepoManager.js";
import { PortfolioSyncManager } from "../portfolio/PortfolioSyncManager.js";
import { getPortfolioRepositoryName } from "../config/portfolioConfig.js";
import { GitHubPortfolioIndexer } from "../portfolio/GitHubPortfolioIndexer.js";
import { IndexConfigManager } from "../portfolio/config/IndexConfig.js";
import { PortfolioSyncComparer } from "../sync/PortfolioSyncComparer.js";
import { PortfolioDownloader } from "../sync/PortfolioDownloader.js";
import { PerformanceMonitor } from "../utils/PerformanceMonitor.js";
import { BuildInfoService } from "../services/BuildInfoService.js";
import { InitializationService } from "../services/InitializationService.js";
import { PersonaIndicatorService } from "../services/PersonaIndicatorService.js";
import { FileLockManager } from '../security/fileLockManager.js';
import { StateChangeNotifier } from "../services/StateChangeNotifier.js";
import { SerializationService } from "../services/SerializationService.js";
import { FileWatchService } from "../services/FileWatchService.js";
import { MetadataService } from "../services/MetadataService.js";
import { FileOperationsService } from "../services/FileOperationsService.js";
import { ValidationRegistry } from "../services/validation/ValidationRegistry.js";
import { TriggerValidationService } from "../services/validation/TriggerValidationService.js";
import { ValidationService } from "../services/validation/ValidationService.js";
import { GitHubRateLimiter } from "../utils/GitHubRateLimiter.js";
import { AnthropicToDollhouseConverter, DollhouseToAnthropicConverter } from "../converters/index.js";
import { DangerZoneEnforcer } from "../security/DangerZoneEnforcer.js";
import type { IActivationStateStore } from "../state/IActivationStateStore.js";
import { VerificationNotifier } from "../services/VerificationNotifier.js";
import { FileActivationStateStore } from "../state/FileActivationStateStore.js";
import { FileConfirmationStore } from "../state/FileConfirmationStore.js";
import { InMemoryChallengeStore } from "../state/InMemoryChallengeStore.js";
import type { DatabaseActivationStateStore } from "../state/DatabaseActivationStateStore.js";
import type { DatabaseConfirmationStore } from "../state/DatabaseConfirmationStore.js";
import type { DatabaseChallengeStore } from "../state/DatabaseChallengeStore.js";
import type { IConfirmationStore } from "../state/IConfirmationStore.js";
import type { DatabaseInstance } from "../database/connection.js";
import { DatabaseServiceRegistrar } from "./registrars/DatabaseServiceRegistrar.js";
import { PathsServiceRegistrar } from "./registrars/PathsServiceRegistrar.js";
// SharedPoolServiceRegistrar is dynamically imported in preparePortfolio()
// to keep the shared-pool module out of the static import graph. Deleting
// src/collection/shared-pool/ does not break compilation.
import { FileStorageLayerFactory, defaultMemoryFileFilter } from "../storage/FileStorageLayerFactory.js";
import type { IStorageLayerFactory } from "../storage/IStorageLayerFactory.js";
import { validateUserId } from "../paths/validateUserId.js";
import { SessionActivationRegistry } from "../state/SessionActivationState.js";
import { SessionContainer } from "./SessionContainer.js";
import { PatternEncryptor } from "../security/encryption/PatternEncryptor.js";
import { PatternDecryptor } from "../security/encryption/PatternDecryptor.js";
import { ContextTracker } from "../security/encryption/ContextTracker.js";
import { createStdioSession } from "../context/StdioSession.js";
import type { SessionResolver } from "../context/SessionContext.js";
import { PatternExtractor } from "../security/validation/PatternExtractor.js";
import { BackgroundValidator } from "../security/validation/BackgroundValidator.js";
import { SecurityTelemetry } from "../security/telemetry/SecurityTelemetry.js";
import { ContentValidator } from "../security/contentValidator.js";
import { OperationalTelemetry } from "../telemetry/OperationalTelemetry.js";
import { StartupTimer } from "../telemetry/StartupTimer.js";
import { DefaultEnhancedIndexHelpers } from "../portfolio/enhanced-index/EnhancedIndexHelpers.js";
import { ElementDefinitionBuilder } from "../portfolio/enhanced-index/ElementDefinitionBuilder.js";
import { ActionTriggerExtractor } from "../portfolio/enhanced-index/ActionTriggerExtractor.js";
import { TriggerMetricsTracker } from "../portfolio/enhanced-index/TriggerMetricsTracker.js";
import { SemanticRelationshipService } from "../portfolio/enhanced-index/SemanticRelationshipService.js";
import { ElementEventDispatcher } from '../events/ElementEventDispatcher.js';
import { TokenManager } from "../security/tokenManager.js";
import type { UnifiedConsoleResult } from "../web/console/UnifiedConsole.js";
import {
  PaginationService,
  FilterService,
  SortService,
  ElementQueryService,
} from '../services/query/index.js';
import { RetentionPolicyService, MemoryRetentionStrategy } from '../services/RetentionPolicyService.js';
import { PolicyExportService } from '../services/PolicyExportService.js';
import { LogManager, buildLogManagerConfig } from '../logging/LogManager.js';
import { FileLogSink } from '../logging/sinks/FileLogSink.js';
import { MemoryLogSink } from '../logging/sinks/MemoryLogSink.js';
import { PlainTextFormatter } from '../logging/formatters/PlainTextFormatter.js';
import { JsonlFormatter } from '../logging/formatters/JsonlFormatter.js';
import { wireLogHooks, getTriggerMetricsLogListener } from '../logging/LogHooks.js';
import { MetricsManager } from '../metrics/MetricsManager.js';
import { MemoryMetricsSink } from '../metrics/sinks/MemoryMetricsSink.js';
import { buildMetricsManagerConfig } from '../metrics/types.js';
import {
  PerformanceMonitorCollector,
  LRUCacheCollector,
  SecurityMonitorCollector,
  SecurityTelemetryCollector,
  FileLockManagerCollector,
  DefaultElementProviderCollector,
  TriggerMetricsTrackerCollector,
  OperationalTelemetryCollector,
  OperationMetricsCollector,
  GatekeeperMetricsCollector,
} from '../metrics/collectors/index.js';
import { OperationMetricsTracker } from '../metrics/OperationMetricsTracker.js';
import { GatekeeperMetricsTracker } from '../metrics/GatekeeperMetricsTracker.js';

// State is owned by PersonaManager and services

export interface HandlerBundle {
  personaHandler: PersonaHandler;
  elementCrudHandler: ElementCRUDHandler;
  collectionHandler: CollectionHandler;
  portfolioHandler: PortfolioHandler;
  githubAuthHandler: GitHubAuthHandler;
  displayConfigHandler: DisplayConfigHandler;
  identityHandler: IdentityHandler;
  configHandler: ConfigHandler;
  syncHandler: SyncHandler;
  toolRegistry: ToolRegistry;
  enhancedIndexHandler: EnhancedIndexHandler;
  mcpAqlHandler: MCPAQLHandler;
}

/**
 * Type-safe service record for dependency injection container
 *
 * FIX: Replaced 'any' types with proper generics to ensure type safety
 * Previously: Used 'any' which allowed unsafe casts and runtime errors
 * Now: Uses generic T with 'unknown' fallback for compile-time type checking
 *
 * @template T The service type (defaults to unknown for maximum safety)
 */
interface ServiceRecord<T = unknown> {
  factory: () => T;
  instance: T | null;
  singleton: boolean;
}

export class DollhouseContainer {
  private services = new Map<string, ServiceRecord>();
  private personasDir: string | null = null;
  /** Issue #706: Set to true once completeDeferredSetup() resolves. */
  public deferredSetupComplete = false;

  /**
   * @param lifecycleService - Optional LifecycleService instance (created before the
   *   container in index.ts because error handlers must be installed before any async work).
   *   Registered in the container so it's resolvable via DI like any other service.
   */
  constructor(lifecycleService?: import('../lifecycle/LifecycleService.js').LifecycleService) {
    // FIX: DMCP-SEC-006 - Audit DI container initialization
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'DollhouseContainer.constructor',
      details: 'Dependency injection container initializing'
    });
    this.registerServices();
    // Issue #1948: Register LifecycleService in DI if provided
    if (lifecycleService) {
      this.register('LifecycleService', () => lifecycleService);
    }
  }

  /**
   * Register a service with the DI container
   *
   * FIX: Added explicit type parameter for type safety
   * The factory is stored as () => unknown internally to allow heterogeneous storage,
   * but the type T is preserved for resolve() calls
   *
   * @template T The service type
   * @param name Unique service identifier
   * @param factory Factory function that creates the service instance
   * @param options Configuration options (singleton behavior)
   */
  public register<T>(name: string, factory: () => T, options: { singleton?: boolean } = { singleton: true }): void {
    // FIX: DMCP-SEC-006 - Audit service registration
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'DollhouseContainer.register',
      details: `Service registered: ${name}`,
      additionalData: { serviceName: name, singleton: options.singleton ?? true }
    });
    this.services.set(name, {
      factory: factory as () => unknown,
      instance: null,
      singleton: options.singleton ?? true
    });
  }

  /**
   * Resolve a service from the DI container
   *
   * FIX: Type safety improved with explicit casting and validation
   * The 'as T' cast is safe because:
   * 1. Services are registered with typed factories
   * 2. The service name acts as a type discriminator
   * 3. Incorrect usage will be caught at the registration site
   *
   * @template T The expected service type
   * @param name Service identifier
   * @returns The service instance
   * @throws Error if service is not registered
   */
  /**
   * Check whether a service has been registered (without resolving it).
   */
  public hasRegistration(name: string): boolean {
    return this.services.has(name);
  }


  public resolve<T>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      // FIX: DMCP-SEC-006 - Audit service resolution failures
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOAD_FAILED',
        severity: 'MEDIUM',
        source: 'DollhouseContainer.resolve',
        details: `Service not registered: ${name}`,
        additionalData: { serviceName: name }
      });
      throw new Error(`Service not registered: ${name}`);
    }

    if (service.singleton) {
      if (!service.instance) {
        service.instance = service.factory();
        // FIX: DMCP-SEC-006 - Audit singleton instantiation
        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_CREATED',
          severity: 'LOW',
          source: 'DollhouseContainer.resolve',
          details: `Singleton instantiated: ${name}`,
          additionalData: { serviceName: name }
        });
      }
      return service.instance as T;
    }

    return service.factory() as T;
  }

  private registerServices(): void {


    // Issue #706: Startup timing instrumentation
    this.register('StartupTimer', () => new StartupTimer());

    // CORE & CACHING
    this.register('CacheMemoryBudget', () => new CacheMemoryBudget({
      globalLimitBytes: getValidatedGlobalCacheMemoryBytes(),
    }));
    this.register('APICache', () => new APICache());
    this.register('CollectionCache', () => new CollectionCache(
      this.resolve('FileOperationsService'),
      this.hasRegistration('PathService')
        ? this.resolve<import('../paths/PathService.js').PathService>('PathService').resolveDataDir('cache')
        : undefined,
    ));
    this.register('RateLimitTracker', () => new Map<string, number[]>());
    this.register('FileLockManager', () => new FileLockManager());
    this.register('FileOperationsService', () => new FileOperationsService(this.resolve('FileLockManager')));
    this.register<IStorageLayerFactory>('StorageLayerFactory', () => new FileStorageLayerFactory(
      this.resolve('FileOperationsService'),
      { indexDebounceMs: getValidatedIndexDebounce(), fileFilter: defaultMemoryFileFilter },
    ));
    this.register('ConfigManager', () => new ConfigManager(
      this.resolve('FileOperationsService'),
      os,
      this.hasRegistration('PathService')
        ? this.resolve<import('../paths/PathService.js').PathService>('PathService').resolveDataDir('config')
        : undefined,
    ));
    // Issue #51: Generic retention policy service with strategy pattern
    this.register('RetentionPolicyService', () => {
      const service = new RetentionPolicyService(this.resolve('ConfigManager'));
      // Register memory retention strategy (first of potentially 50+ element types)
      service.registerStrategy(new MemoryRetentionStrategy());
      return service;
    });
    this.register('IndexConfigManager', () => new IndexConfigManager());
    this.register('IndicatorConfig', () => loadIndicatorConfig());
    this.register('StateChangeNotifier', () => new StateChangeNotifier());
    this.register('GitHubRateLimiter', () => new GitHubRateLimiter(
      this.resolve('TokenManager')
    ));
    this.register('ElementEventDispatcher', () => new ElementEventDispatcher(
      this.resolve('ContextTracker')
    ));
    this.register('MCPLogger', () => logger);
    // SecurityMonitor: DI-managed instance wired into the static facade.
    // Eagerly resolved to replace the fallback before handlers start logging.
    this.register('SecurityMonitor', () => {
      const instance = new SecurityMonitor();
      SecurityMonitor.setInstance(instance);
      return instance;
    });
    this.resolve('SecurityMonitor');
    // Resilience: DI-managed instances (moved from module-level singletons)
    this.register('CircuitBreakerState', () => new CircuitBreakerState());
    this.register('ResilienceMetricsTracker', () => new ResilienceMetricsTracker());

    this.register('PersonaImporter', () => {
      const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');
      const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
      // This is a bit of a hack to break the circular dependency. We resolve PersonaManager inside the provider function.
      const currentUserProvider = () => this.resolve<PersonaManager>('PersonaManager').getCurrentUserForAttribution();
      return new PersonaImporter(
        personasDir,
        currentUserProvider,
        undefined,
        this.resolve('FileOperationsService')
      );
    });

    // GITHUB & COLLECTION
    // GitHubClient's SSRF allowlist is extended by DOLLHOUSE_COLLECTION_ALLOWLIST
    // when the shared pool is enabled. The default hosts (api.github.com,
    // raw.githubusercontent.com) are always included.
    this.register('GitHubClient', () => new GitHubClient(
      this.resolve('APICache'),
      this.resolve('RateLimitTracker'),
      this.resolve('TokenManager'),
      env.DOLLHOUSE_COLLECTION_ALLOWLIST ?? undefined,
    ));
    this.register('GitHubAuthManager', () => new GitHubAuthManager(
      this.resolve('APICache'),
      this.resolve('ConfigManager'),
      this.resolve('TokenManager')
    ));
    // CollectionIndexManager's index URL is overridable via DOLLHOUSE_COLLECTION_URL.
    this.register('CollectionIndexManager', () => new CollectionIndexManager({
      fileOperations: this.resolve('FileOperationsService'),
      indexUrl: env.DOLLHOUSE_COLLECTION_URL,
    }));
    this.register('CollectionBrowser', () => new CollectionBrowser(this.resolve('GitHubClient'), this.resolve('CollectionCache'), this.resolve('CollectionIndexManager')));
    this.register('CollectionSearch', () => new CollectionSearch(
      this.resolve('GitHubClient'),
      this.resolve('CollectionCache'),
      this.resolve('CollectionIndexCache')
    ));
    this.register('PersonaDetails', () => new PersonaDetails(this.resolve('GitHubClient')));

    // PORTFOLIO & MANAGERS
    this.register('PortfolioManager', () => {
      const config = this.hasRegistration('PathService')
        ? { baseDir: this.resolve<import('../paths/PathService.js').PathService>('PathService').resolveDataDir('portfolio-root') }
        : undefined;
      return new PortfolioManager(this.resolve('FileOperationsService'), config);
    });
    this.register('PersonaManager', () => new PersonaManager({
      portfolioManager: this.resolve('PortfolioManager'),
      indicatorConfig: this.resolve('IndicatorConfig'),
      fileLockManager: this.resolve('FileLockManager'),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      personaImporter: this.resolve('PersonaImporter'),
      notifier: this.resolve('StateChangeNotifier'),
      contextTracker: this.resolve('ContextTracker'),
      activationRegistry: this.resolve('SessionActivationRegistry'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    this.register('InitializationService', () => new InitializationService(
      this.resolve('PersonaManager')
    ));
    this.register('PersonaIndicatorService', () => new PersonaIndicatorService(
      this.resolve('PersonaManager'),
      this.resolve('IndicatorConfig'),
      this.resolve('StateChangeNotifier'),
      this.resolve('ElementEventDispatcher')
    ));
    this.register('MigrationManager', () => new MigrationManager(this.resolve('PortfolioManager'), this.resolve('FileLockManager'), this.resolve('FileOperationsService')));
    this.register('ElementInstaller', () => new ElementInstaller(this.resolve('GitHubClient'), {
      portfolioManager: this.resolve('PortfolioManager'),
      unifiedIndexManager: this.resolve('UnifiedIndexManager'),
      fileOperations: this.resolve('FileOperationsService'),
      sharedPoolInstaller: this.hasRegistration('SharedPoolInstaller')
        ? this.resolve('SharedPoolInstaller')
        : undefined,
    }));
    this.register('PortfolioRepoManager', () => new PortfolioRepoManager(
      this.resolve('TokenManager'),
      getPortfolioRepositoryName()
    ));
    this.register('GitHubPortfolioIndexer', () => new GitHubPortfolioIndexer(
      this.resolve('PortfolioRepoManager')
    ));
    
    // SERVICES
    this.register('SerializationService', () => new SerializationService());
    this.register('MetadataService', () => new MetadataService());
    this.register('TriggerValidationService', () => new TriggerValidationService());
    this.register('ValidationService', () => new ValidationService());
    this.register('FileWatchService', () => new FileWatchService());
    this.register('ValidationRegistry', () => new ValidationRegistry(
      this.resolve('ValidationService'),
      this.resolve('TriggerValidationService'),
      this.resolve('MetadataService')
    ));

    // LOGGING
    this.register('LogManager', () => {
      const config = buildLogManagerConfig(env);
      const manager = new LogManager(config);

      // Phase 2: FileLogSink
      const formatter = config.logFormat === 'jsonl'
        ? new JsonlFormatter()
        : new PlainTextFormatter();
      const fileSink = new FileLogSink({
        logDir: config.logDir,
        formatter,
        maxFileSize: config.fileMaxSize,
        retentionDays: config.retentionDays,
        securityRetentionDays: config.securityRetentionDays,
        maxDirSizeBytes: config.maxDirSizeBytes,
        maxFilesPerCategory: config.maxFilesPerCategory,
      });
      manager.registerSink(fileSink);
      fileSink.startCleanupTimer();

      // Phase 3: MemoryLogSink
      const memorySink = new MemoryLogSink({
        appCapacity: config.memoryAppCapacity,
        securityCapacity: config.memorySecurityCapacity,
        perfCapacity: config.memoryPerfCapacity,
        telemetryCapacity: config.memoryTelemetryCapacity,
      });
      manager.registerSink(memorySink);

      this.register('MemoryLogSink', () => memorySink);

      // Startup marker — first entry in every server session
      manager.log({
        id: manager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'application',
        level: 'info',
        source: 'DollhouseMCP',
        message: `DollhouseMCP v${PACKAGE_VERSION} starting`,
        data: {
          version: PACKAGE_VERSION,
          logLevel: config.logLevel,
          logFormat: config.logFormat,
          console: env.DOLLHOUSE_WEB_CONSOLE
            ? `http://dollhouse.localhost:${env.DOLLHOUSE_WEB_CONSOLE_PORT}`
            : 'disabled',
        },
      });

      return manager;
    });

    // METRICS COLLECTION
    // MemoryMetricsSink is registered separately (not as a side effect inside
    // MetricsManager's factory) so it's available in the container regardless
    // of MetricsManager resolution order.
    const metricsConfig = buildMetricsManagerConfig(env);
    if (metricsConfig.enabled) {
      const memoryMetricsSink = new MemoryMetricsSink(metricsConfig.memorySnapshotCapacity);
      this.register('MemoryMetricsSink', () => memoryMetricsSink);

      this.register('MetricsManager', () => {
        const manager = new MetricsManager(metricsConfig, logger);
        manager.registerSink(memoryMetricsSink);
        return manager;
      });
    }

    // TELEMETRY
    this.register('OperationalTelemetry', () => new OperationalTelemetry(
      this.resolve('FileOperationsService'),
      this.hasRegistration('PathService')
        ? this.resolve<import('../paths/PathService.js').PathService>('PathService').resolveDataDir('state')
        : undefined,
    ));

    // BACKUP SERVICE (Issue #659: Universal backup for all element types)
    this.register('BackupService', () => new BackupService(
      this.resolve('FileOperationsService'),
      {
        backupRootDir: path.join(this.resolve<PortfolioManager>('PortfolioManager').getBaseDir(), '.backups'),
        maxBackupsPerElement: getValidatedMaxBackupsPerElement(),
        enabled: STORAGE_LAYER_CONFIG.BACKUPS_ENABLED,
      }
    ));

    // POLICY EXPORT SERVICE (Issue #762: Export policies to bridge)
    this.register('PolicyExportService', () => new PolicyExportService({
      getActiveElementsForPolicy: async () => {
        try {
          const handler = this.resolve<ElementCRUDHandler>('ElementCRUDHandler');
          return handler.getActiveElementsForPolicy();
        } catch {
          return [];
        }
      },
      getServerVersion: () => PACKAGE_VERSION,
    }));

    // ELEMENT MANAGERS
    this.register('SkillManager', () => new SkillManager({
      portfolioManager: this.resolve('PortfolioManager'),
      fileLockManager: this.resolve('FileLockManager'),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      contextTracker: this.resolve('ContextTracker'),
      activationRegistry: this.resolve('SessionActivationRegistry'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    this.register('TemplateManager', () => new TemplateManager({
      portfolioManager: this.resolve('PortfolioManager'),
      fileLockManager: this.resolve('FileLockManager'),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    this.register('TemplateRenderer', () => new TemplateRenderer(this.resolve('TemplateManager')));
    this.register('AgentManager', () => new AgentManager({
      portfolioManager: this.resolve('PortfolioManager'),
      fileLockManager: this.resolve('FileLockManager'),
      baseDir: this.resolve<PortfolioManager>('PortfolioManager').getBaseDir(),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      contextTracker: this.resolve('ContextTracker'),
      activationRegistry: this.resolve('SessionActivationRegistry'),
      // Issue #1948: Instance-injected dependencies (replaces static resolvers)
      elementManagerResolver: (name: string) => this.resolve(name) as import('../elements/agents/AgentManager.js').ResolvedElementManager,
      dangerZoneEnforcer: this.resolve('DangerZoneEnforcer'),
      verificationStore: this.resolve('ChallengeStore'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    this.register('MemoryManager', () => new MemoryManager({
      portfolioManager: this.resolve('PortfolioManager'),
      fileLockManager: this.resolve('FileLockManager'),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      contextTracker: this.resolve('ContextTracker'),
      activationRegistry: this.resolve('SessionActivationRegistry'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    this.register('EnsembleManager', () => new EnsembleManager({
      portfolioManager: this.resolve('PortfolioManager'),
      fileLockManager: this.resolve('FileLockManager'),
      fileOperationsService: this.resolve('FileOperationsService'),
      validationRegistry: this.resolve('ValidationRegistry'),
      serializationService: this.resolve('SerializationService'),
      metadataService: this.resolve('MetadataService'),
      fileWatchService: this.resolve('FileWatchService'),
      memoryBudget: this.resolve('CacheMemoryBudget'),
      backupService: this.resolve('BackupService'),
      eventDispatcher: this.resolve('ElementEventDispatcher'),
      contextTracker: this.resolve('ContextTracker'),
      activationRegistry: this.resolve('SessionActivationRegistry'),
      storageLayerFactory: this.resolve<IStorageLayerFactory>('StorageLayerFactory'),
      getCurrentUserId: this.hasRegistration('UserIdResolver') ? this.resolve('UserIdResolver') : undefined,
      publicElementDiscovery: this.hasRegistration('PublicElementDiscovery') ? this.resolve('PublicElementDiscovery') : undefined,
    }));
    // Issue #1948: Memory wiring deferred to preparePortfolio() / completeSinkSetup()
    // to avoid eager resolution during constructor (breaks test containers).

    // QUERY SERVICES (Issue #38: Pagination, filtering, sorting)
    // These services are element-agnostic and can be used with any element type
    this.register('PaginationService', () => new PaginationService());
    this.register('FilterService', () => new FilterService());
    this.register('SortService', () => new SortService());
    this.register('ElementQueryService', () => new ElementQueryService(
      this.resolve<PaginationService>('PaginationService'),
      this.resolve<FilterService>('FilterService'),
      this.resolve<SortService>('SortService')
    ));

    // CONVERTERS
    this.register('AnthropicToDollhouseConverter', () => new AnthropicToDollhouseConverter());
    this.register('DollhouseToAnthropicConverter', () => new DollhouseToAnthropicConverter());

    // SECURITY SERVICES
    // Issue #1948: PathValidator as DI-managed singleton (replaces static class state)
    this.register('PathValidator', () => {
      const personasDir = this.resolve<PortfolioManager>('PortfolioManager')
        .getElementDir(ElementType.PERSONA);
      const instance = new PathValidator(personasDir);
      PathValidator.setRootInstance(instance);
      return instance;
    });
    // Issue #402: DangerZoneEnforcer as DI-managed singleton (replaces module-level singleton)
    this.register('DangerZoneEnforcer', () => new DangerZoneEnforcer(
      this.resolve('FileOperationsService')
    ));
    // Shared stdio session — single source of truth for session identity.
    // In file-mode and when no DB is bootstrapped, `createStdioSession()` uses
    // DOLLHOUSE_USER / OS username. When database mode is active,
    // `preparePortfolio()` re-registers this service with the bootstrapped DB
    // UUID as userId so SessionContext carries an RLS-valid identity. That
    // re-registration is the single source of truth for DB mode — do not add
    // a BootstrappedUserId check here, which would duplicate the mechanism.
    this.register('StdioSession', () => createStdioSession());
    // Issue #1946: Session activation registry — maps sessionId → SessionActivationState
    this.register('SessionActivationRegistry', () => {
      const session = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      return new SessionActivationRegistry(session.sessionId);
    });
    // Issue #598, #1945, #1886: Per-session state stores — database or file-backed.
    // hasRegistration check is inside each lambda so it evaluates at resolution time,
    // allowing DatabaseInstance to be registered after the container is constructed
    // (e.g., by HTTP transport lazy bootstrap).
    this.register('ActivationStore', () => {
      const session = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      if (this.hasRegistration('DatabaseInstance')) {
        const db = this.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = this.resolve<string>('CurrentUserId');
        const DbStore = this.resolve<typeof DatabaseActivationStateStore>('DatabaseActivationStateStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new FileActivationStateStore(
        this.resolve('FileOperationsService'),
        undefined,
        session.sessionId
      );
    });

    this.register('ConfirmationStore', () => {
      const session = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      if (this.hasRegistration('DatabaseInstance')) {
        const db = this.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = this.resolve<string>('CurrentUserId');
        const DbStore = this.resolve<typeof DatabaseConfirmationStore>('DatabaseConfirmationStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new FileConfirmationStore(
        this.resolve('FileOperationsService'),
        undefined,
        session.sessionId
      );
    });

    // Issue #142: ChallengeStore for danger zone challenge codes (server-side)
    // Issue #1945: Wrapped in IChallengeStore interface for backend swappability
    this.register('ChallengeStore', () => {
      if (this.hasRegistration('DatabaseInstance')) {
        const session = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
        const db = this.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = this.resolve<string>('CurrentUserId');
        const DbStore = this.resolve<typeof DatabaseChallengeStore>('DatabaseChallengeStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new InMemoryChallengeStore();
    });
    // Backward-compat alias — existing code resolves 'VerificationStore'
    this.register('VerificationStore', () => this.resolve('ChallengeStore'));
    // Issue #522: Non-blocking OS dialog notifier for verification codes
    this.register('VerificationNotifier', () => new VerificationNotifier());
    this.register('TokenManager', () => new TokenManager(
      this.resolve('FileOperationsService')
    ));
    this.register('PatternEncryptor', () => new PatternEncryptor());
    this.register('ContextTracker', () => new ContextTracker());
    // Issue #1946: Make MetadataService session-aware for correct user attribution
    this.resolve<MetadataService>('MetadataService').configureSessionAwareness(
      this.resolve<ContextTracker>('ContextTracker'),
      this.resolve<SessionActivationRegistry>('SessionActivationRegistry'),
    );
    this.register('PatternDecryptor', () => new PatternDecryptor(
      this.resolve('PatternEncryptor'),
      this.resolve('ContextTracker')
    ));
    this.register('PatternExtractor', () => new PatternExtractor(
      this.resolve('PatternEncryptor')
    ));
    this.register('BackgroundValidator', () => new BackgroundValidator(
      this.resolve('PatternExtractor'),
      this.resolve('MemoryManager')
    ));
    this.register('SecurityTelemetry', () => new SecurityTelemetry());
    ContentValidator.configureTelemetryResolver(() => this.resolve('SecurityTelemetry'));

    // NLP & INDEXING
    this.register('NLPScoringManager', () => {
        const indexConfigManager = this.resolve<IndexConfigManager>('IndexConfigManager');
        const config = indexConfigManager.getConfig();
        return new NLPScoringManager({
            cacheExpiry: config.nlp.cacheExpiryMinutes * 60 * 1000,
            minTokenLength: config.nlp.minTokenLength,
            entropyBands: config.nlp.entropyBands,
            jaccardThresholds: config.nlp.jaccardThresholds
        }, indexConfigManager);
    });
    this.register('VerbTriggerManager', () => {
        const indexConfigManager = this.resolve<IndexConfigManager>('IndexConfigManager');
        const config = indexConfigManager.getConfig();
        return new VerbTriggerManager({
            confidenceThreshold: config.verbs.confidenceThreshold,
            maxElementsPerVerb: config.verbs.maxElementsPerVerb,
            includeSynonyms: config.verbs.includeSynonyms
        });
    });
    this.register('RelationshipManager', () => {
        const indexConfigManager = this.resolve<IndexConfigManager>('IndexConfigManager');
        const config = indexConfigManager.getConfig();
        return new RelationshipManager({
            config: {
                minConfidence: config.performance.similarityThreshold,
                enableAutoDiscovery: true
            },
            indexConfigManager,
            verbTriggerManager: this.resolve('VerbTriggerManager'),
            nlpScoring: this.resolve('NLPScoringManager'),
        });
    });
    this.register('PortfolioIndexManager', () => new PortfolioIndexManager(this.resolve('IndexConfigManager'), this.resolve('PortfolioManager'), this.resolve('FileOperationsService')));
    this.register('EnhancedIndexHelpers', () => new DefaultEnhancedIndexHelpers(
      new ElementDefinitionBuilder(),
      new SemanticRelationshipService({
        nlpScoring: this.resolve('NLPScoringManager'),
        relationshipManager: this.resolve('RelationshipManager')
      }),
      (context) => new ActionTriggerExtractor(context),
      (options) => {
        const tracker = new TriggerMetricsTracker(options);
        try {
          tracker.addLogListener(getTriggerMetricsLogListener(
            this.resolve('LogManager'),
            this.resolve('ContextTracker')
          ));
        } catch { /* LogManager not yet registered */ }
        return tracker;
      }
    ));
    this.register('EnhancedIndexManager', () => new EnhancedIndexManager(
        this.resolve('IndexConfigManager'),
        this.resolve('ConfigManager'),
        this.resolve('PortfolioIndexManager'),
        this.resolve('NLPScoringManager'),
        this.resolve('VerbTriggerManager'),
        this.resolve('RelationshipManager'),
        this.resolve('EnhancedIndexHelpers'),
        this.resolve('FileOperationsService')
    ));
    this.register('CollectionIndexCache', () => new CollectionIndexCache(
        this.resolve('GitHubClient'),
        process.cwd(),
        this.resolve('PerformanceMonitor'),
        this.resolve('FileOperationsService')
    ));
    this.register('UnifiedIndexManager', () => new UnifiedIndexManager({
        portfolioIndexManager: this.resolve('PortfolioIndexManager'),
        githubIndexer: this.resolve('GitHubPortfolioIndexer'),
        collectionIndexCache: this.resolve('CollectionIndexCache'),
        githubClient: this.resolve('GitHubClient'),
        apiCache: this.resolve('APICache'),
        rateLimitTracker: this.resolve('RateLimitTracker'),
        performanceMonitor: this.resolve('PerformanceMonitor'),
        fileOperations: this.resolve('FileOperationsService')
    }));

    this.register('PortfolioSyncComparer', () => new PortfolioSyncComparer());
    this.register('PortfolioDownloader', () => new PortfolioDownloader());

    // SYNC & TOOLS
    this.register('PortfolioPullHandler', () => new PortfolioPullHandler({
        portfolioManager: this.resolve('PortfolioManager'),
        indexManager: this.resolve('PortfolioIndexManager'),
        githubIndexer: this.resolve('GitHubPortfolioIndexer'),
        portfolioRepoManager: this.resolve('PortfolioRepoManager'),
        syncComparer: this.resolve('PortfolioSyncComparer'),
        downloader: this.resolve('PortfolioDownloader'),
        fileOperations: this.resolve('FileOperationsService'),
        tokenManager: this.resolve('TokenManager'),
    }));
    this.register('SubmitToPortfolioTool', () => new SubmitToPortfolioTool(this.resolve('APICache'), {
        authManager: this.resolve('GitHubAuthManager'),
        portfolioManager: this.resolve('PortfolioManager'),
        portfolioIndexManager: this.resolve('PortfolioIndexManager'),
        portfolioRepoManager: this.resolve('PortfolioRepoManager'),
        rateLimiter: this.resolve('GitHubRateLimiter'),
        fileOperations: this.resolve('FileOperationsService'),
        tokenManager: this.resolve('TokenManager')
    }));
    this.register('PortfolioSyncManager', () => new PortfolioSyncManager({
        configManager: this.resolve('ConfigManager'),
        portfolioManager: this.resolve('PortfolioManager'),
        portfolioRepoManager: this.resolve('PortfolioRepoManager'),
        indexer: this.resolve('GitHubPortfolioIndexer'),
        fileOperations: this.resolve('FileOperationsService'),
        tokenManager: this.resolve('TokenManager')
    }));

    // SERVER
    this.register('ServerSetup', () => {
      const stdioSession = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      const sessionResolver: SessionResolver = () => stdioSession;
      return new ServerSetup(
        this.resolve<ContextTracker>('ContextTracker'),
        sessionResolver,
      );
    });
    this.register('ServerStartup', () => new ServerStartup(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve('ConfigManager'),
      this.resolve('MigrationManager'),
      this.resolve('MemoryManager'),
      this.resolve('OperationalTelemetry')
    ));
    this.register('BuildInfoService', () => {
      const service = new BuildInfoService(this.resolve('FileOperationsService'));
      // Issue #706: Wire startup instrumentation
      service.setStartupTimer(this.resolve<StartupTimer>('StartupTimer'));
      service.setDeferredSetupChecker(() => this.deferredSetupComplete);
      return service;
    });
    this.register('PerformanceMonitor', () => {
      const monitor = new PerformanceMonitor();
      monitor.startMonitoring();
      return monitor;
    });

    this.register('OperationMetricsTracker', () => new OperationMetricsTracker(), { singleton: true });
    this.register('GatekeeperMetricsTracker', () => new GatekeeperMetricsTracker(), { singleton: true });
  }

  public getPersonasDir(): string | null {
    return this.personasDir;
  }

  /**
   * Prepare portfolio — critical path only.
   *
   * Issue #706: Split from the original monolithic preparePortfolio().
   * Only work required before MCP connect() runs here. Non-critical work
   * (memory auto-load, activation restore, log hooks, danger zone init)
   * is deferred to completeDeferredSetup() which runs post-connect.
   */
  public async preparePortfolio(): Promise<void> {
    // Path services must bootstrap before any manager resolution so
    // PathService is available for PortfolioManager and downstream.
    await new PathsServiceRegistrar().bootstrapAndRegister(this);

    // Bootstrap database connection when storage backend is 'database'.
    // Must happen before any manager resolution so DatabaseInstance is available.
    // All DB-specific wiring lives in DatabaseServiceRegistrar — Container stays
    // out of the bootstrap/registration details.
    if (env.DOLLHOUSE_STORAGE_BACKEND === 'database') {
      await new DatabaseServiceRegistrar().bootstrapAndRegister(this);
    }

    // Shared pool services — feature-flag gated (default: off).
    // Must run after PathsServiceRegistrar and DatabaseServiceRegistrar
    // so PathService and (optionally) DatabaseInstance are available.
    const { SharedPoolServiceRegistrar } = await import('../collection/shared-pool/SharedPoolServiceRegistrar.js');
    await new SharedPoolServiceRegistrar().bootstrapAndRegister(this);

    // Run deployment seed loader if the shared pool is enabled.
    // Idempotent — safe on every startup. Runs after the registrar so
    // SharedPoolInstaller and ProvenanceStore are available.
    if (this.hasRegistration('DeploymentSeedLoader')) {
      try {
        const seedLoader = this.resolve<{ loadSeeds(): Promise<unknown> }>('DeploymentSeedLoader');
        await seedLoader.loadSeeds();
      } catch (err) {
        logger.warn('[Container] Deployment seed loading failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Issue #1948: Wire Memory service refs (deferred from registerServices to avoid eager resolution)
    try {
      const mm = this.resolve<MemoryManager>('MemoryManager');
      mm.setRetentionPolicyService(this.resolve('RetentionPolicyService'));
      Memory.setRootMemoryManager(mm as { list(): Promise<import('../elements/memories/Memory.js').Memory[]>; save(memory: import('../elements/memories/Memory.js').Memory, filePath?: string): Promise<void> });
    } catch {
      // Not available in test containers — safe to skip
    }

    const timer = this.resolve<StartupTimer>('StartupTimer');
    const startTime = Date.now();
    const migrationManager = this.resolve<MigrationManager>('MigrationManager');
    const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');

    // --- config_checks (critical) ---
    timer.startPhase('config_checks', true);

    // PERFORMANCE OPTIMIZATION: Run independent checks in parallel (40-60% faster startup)
    // Use Promise.allSettled to capture all check results, even if one fails
    const results = await Promise.allSettled([
      migrationManager.needsMigration(),
      portfolioManager.exists()
    ]);

    // Extract results and collect any errors
    const checkErrors: Array<{ check: string; error: Error }> = [];

    let needsMigration = false;
    if (results[0].status === 'fulfilled') {
      needsMigration = results[0].value;
    } else {
      checkErrors.push({
        check: 'migration',
        error: results[0].reason instanceof Error ? results[0].reason : new Error(String(results[0].reason))
      });
    }

    let portfolioExists = false;
    if (results[1].status === 'fulfilled') {
      portfolioExists = results[1].value;
    } else {
      checkErrors.push({
        check: 'portfolio',
        error: results[1].reason instanceof Error ? results[1].reason : new Error(String(results[1].reason))
      });
    }

    // If both checks failed, throw comprehensive error
    if (checkErrors.length === 2) {
      const errorMessages = checkErrors.map(e => `${e.check}: ${e.error.message}`).join('; ');
      throw new Error(`Portfolio preparation failed - all checks failed: ${errorMessages}`);
    }

    // If only one check failed, log warning but continue
    if (checkErrors.length === 1) {
      logger.warn(`Portfolio check failed but continuing: ${checkErrors[0].check} - ${checkErrors[0].error.message}`);
    }

    timer.endPhase('config_checks');

    // --- migration (critical, conditional) ---
    if (needsMigration) {
      timer.startPhase('migration', true);
      logger.info("Legacy personas detected. Starting migration...");
      const result = await migrationManager.migrate({ backup: true });

      if (result.success) {
        logger.info(`Successfully migrated ${result.migratedCount} personas`);
        if (result.backedUp && result.backupPath) {
          logger.info(`Backup created at: ${result.backupPath}`);
        }
      } else {
        logger.error("Migration completed with errors:");
        result.errors.forEach((err) => logger.error(`  - ${err}`));
      }
      timer.endPhase('migration');
    }

    // --- portfolio_init (critical, conditional) ---
    if (!portfolioExists) {
      timer.startPhase('portfolio_init', true);
      logger.info("Creating portfolio directory structure...");
      await portfolioManager.initialize();
      timer.endPhase('portfolio_init');
    }

    // PERFORMANCE OPTIMIZATION: Initialize collection cache in background (non-blocking)
    // This is safe because collection cache is not critical for startup
    this.initializeCollectionCache().catch(err =>
      logger.warn('Background collection cache initialization failed (will retry on demand)', err)
    );

    this.personasDir = portfolioManager.getElementDir(ElementType.PERSONA);

    // --- config_manager (critical) ---
    timer.startPhase('config_manager', true);
    const configManager = this.resolve<ConfigManager>('ConfigManager');
    await configManager.initialize();
    timer.endPhase('config_manager');

    const elapsedTime = Date.now() - startTime;
    logger.info(`[Startup] Critical portfolio path completed in ${elapsedTime}ms (personas directory: ${this.personasDir})`);
  }

  /**
   * Complete non-critical setup after MCP connect().
   *
   * Issue #706: These operations were previously in preparePortfolio() but are
   * non-fatal and can safely run after the server is accepting connections.
   * This shrinks the critical path by 1000-3700ms.
   */
  public async completeDeferredSetup(): Promise<void> {
    const timer = this.resolve<StartupTimer>('StartupTimer');

    // Issue #706: Test hook — inject artificial delay to simulate slow deferred setup.
    // Only active when DOLLHOUSE_TEST_DEFERRED_DELAY_MS is set (integration tests).
    const testDelay = parseInt(process.env.DOLLHOUSE_TEST_DEFERRED_DELAY_MS || '0', 10);
    if (testDelay > 0) {
      logger.info(`[Startup] Test delay injected: ${testDelay}ms`);
      await new Promise(resolve => setTimeout(resolve, testDelay));
    }

    await this.completeSinkSetup(timer);
    await this.completeConsoleSetup(timer);

    this.deferredSetupComplete = true;

    const report = timer.getReport();
    logger.info(
      `[Startup] Deferred setup completed in ${report.deferredMs}ms ` +
      `(total startup: ${report.totalMs}ms, critical: ${report.criticalPathMs}ms)`
    );
  }

  /**
   * Wire sinks, hooks, collectors, and security — everything EXCEPT
   * the web console leader election and permission server.
   *
   * Called by completeDeferredSetup() in MCP stdio mode, and directly
   * by the --web standalone path which IS the server (#1866).
   *
   * Phase 4: this runs OUTSIDE any MCP tool-call's session scope (deferred
   * post-connect work). Storage layers resolve `this.userId` from the active
   * ContextTracker session, so without a scope they'd throw. Wrap the whole
   * deferred batch in the stdio session's context so autoload, seed install,
   * and activation restore all see a valid user identity in DB mode.
   */
  public async completeSinkSetup(timer?: StartupTimer): Promise<void> {
    const tracker = this.resolve<ContextTracker>('ContextTracker');
    const stdioSession = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
    const context = tracker.createSessionContext('background-task', stdioSession, {
      source: 'completeSinkSetup',
    });
    await tracker.runAsync(context, async () => {
      await this.deferredMemoryAutoload(timer);
      await this.deferredActivationRestore(timer);
      await this.deferredPolicyExport();
      await this.deferredLogHooks(timer);
      await this.deferredMetricsCollectors(timer);
      await this.deferredDangerZoneInit(timer);
      await this.deferredPatternEncryption(timer);
      await this.deferredBackgroundValidator(timer);
    });
  }

  /**
   * Leader election, web console server, and permission server.
   * Only called in MCP stdio mode — --web standalone mode IS the server (#1866).
   */
  public async completeConsoleSetup(timer?: StartupTimer): Promise<void> {
    // Sweep stale port files from prior sessions before any port operations (#1856).
    // Runs unconditionally — stale files accumulate regardless of DOLLHOUSE_WEB_CONSOLE.
    try {
      const { sweepStalePortFiles } = await import('../web/portDiscovery.js');
      await sweepStalePortFiles();
    } catch { /* sweep failure is non-fatal */ }

    const consoleResult = await this.deferredWebConsole(timer);
    await this.deferredPermissionServer(consoleResult, timer);
  }

  private async deferredMemoryAutoload(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('memory_autoload', false);
    try {
      const configManager = this.resolve<ConfigManager>('ConfigManager');
      const config = configManager.getConfig();

      if (config.autoLoad.enabled) {
        const memoryManager = this.resolve<MemoryManager>('MemoryManager');
        const autoLoadResult = await memoryManager.loadAndActivateAutoLoadMemories();

        if (autoLoadResult.errors.length > 0) {
          logger.warn(
            `[Container] Auto-load completed with ${autoLoadResult.errors.length} error(s):`,
            autoLoadResult.errors
          );
        }

        logger.info(
          `[Container] Auto-loaded ${autoLoadResult.loaded} memories ` +
          `(~${autoLoadResult.totalTokens} tokens), ${autoLoadResult.skipped} skipped`
        );
      } else {
        logger.debug('[Container] Auto-load memories disabled in configuration');
      }
    } catch (error) {
      logger.error('[Container] Memory auto-load failed:', error);
    }
    timer?.endPhase('memory_autoload');
  }

  private async deferredActivationRestore(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('activation_restore', false);

    // Issue #1946: Pre-register the stdio session in the activation registry
    // so managers resolve the correct session's Sets during restoration.
    // Also attach the ActivationStore so ElementCRUDHandler persists to the right session.
    try {
      const registry = this.resolve<SessionActivationRegistry>('SessionActivationRegistry');
      const stdioSession = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      const state = registry.getOrCreate(stdioSession.sessionId);
      state.activationStore = this.resolve<IActivationStateStore>('ActivationStore');
    } catch (error) {
      logger.warn('[Container] Failed to pre-register stdio session in activation registry:', error);
    }

    try {
      const activationStore = this.resolve<IActivationStateStore>('ActivationStore');
      await activationStore.initialize();

      if (activationStore.isEnabled()) {
        await this.restoreActivations(activationStore);
      }
    } catch (error) {
      logger.warn('[Container] Activation state restoration failed:', error);
    }

    // Issue #1947: Register per-session GatekeeperSession for stdio with persistence
    try {
      const cStore = this.resolve<IConfirmationStore>('ConfirmationStore');
      const gatekeeper = this.resolve<Gatekeeper>('gatekeeper');
      const stdioSess = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      const stdioGkSession = new GatekeeperSession(undefined, 100, undefined, cStore, stdioSess.sessionId);
      await stdioGkSession.initialize(); // Restores persisted confirmations from disk
      gatekeeper.registerSession(stdioSess.sessionId, stdioGkSession);
    } catch (error) {
      logger.warn('[Container] Gatekeeper session registration failed:', error);
    }

    timer?.endPhase('activation_restore');
  }

  private async deferredPolicyExport(): Promise<void> {
    try {
      const policyExportService = this.resolve<PolicyExportService>('PolicyExportService');
      await policyExportService.exportPolicies();
    } catch (error) {
      logger.debug('[Container] Policy export skipped:', error);
    }
  }

  private async deferredLogHooks(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('log_hooks', false);
    try {
      const logManager = this.resolve<LogManager>('LogManager');
      const logCleanups = wireLogHooks(logManager, this);
      this.register('_logHookCleanups', () => logCleanups);
    } catch (error) {
      logger.warn('[Container] Failed to wire log hooks:', error);
    }
    timer?.endPhase('log_hooks');
  }

  private async deferredMetricsCollectors(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('metrics_collectors', false);
    try {
      const metricsManager = this.resolve<MetricsManager>('MetricsManager');
      this.wireMetricsCollectors(metricsManager);
      metricsManager.start();
      logger.info('[Container] Metrics collection started');
    } catch (error) {
      logger.warn('[Container] Metrics wiring skipped:', error);
    }
    timer?.endPhase('metrics_collectors');
  }

  /** Try to resolve a service, returning undefined if not registered */
  private tryResolve<T>(name: string): T | undefined {
    try { return this.resolve<T>(name); } catch { return undefined; }
  }

  /** Wire SSE broadcast sinks for the web console */
  private wireSSEBroadcasts(
    webResult: import('../web/server.js').WebServerResult,
    metricsSink: MemoryMetricsSink | undefined,
  ): void {
    if (webResult.logBroadcast) {
      const logManager = this.resolve<LogManager>('LogManager');
      logManager.registerSink(new WebSSELogSink(webResult.logBroadcast));
    }
    if (webResult.metricsOnSnapshot && metricsSink) {
      const metricsManager = this.tryResolve<MetricsManager>('MetricsManager');
      if (metricsManager) {
        metricsManager.registerSink(new WebSSEMetricsSink(webResult.metricsOnSnapshot));
      }
    }
  }

  private async deferredWebConsole(timer?: StartupTimer): Promise<UnifiedConsoleResult | null> {
    timer?.startPhase('web_console', false);
    try {
      if (!env.DOLLHOUSE_WEB_CONSOLE) return null;

      const activationStore = this.resolve<IActivationStateStore>('ActivationStore');
      const sessionId = activationStore.getSessionId();
      const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');
      const memorySink = this.resolve<MemoryLogSink>('MemoryLogSink');
      const metricsSink = this.tryResolve<MemoryMetricsSink>('MemoryMetricsSink');
      const mcpAqlHandler = this.tryResolve<MCPAQLHandler>('mcpAqlHandler');
      const logManager = this.resolve<LogManager>('LogManager');

      // Resolve console port: config file → env var → default (#1840)
      const configManager = this.resolve<ConfigManager>('ConfigManager');
      const configPort = configManager.getSetting<number>('console.port');

      const { startUnifiedConsole } = await import('../web/console/UnifiedConsole.js');
      const result = await startUnifiedConsole({
        sessionId,
        portfolioDir: portfolioManager.getBaseDir(),
        memorySink,
        metricsSink,
        mcpAqlHandler,
        registerLogSink: (sink) => logManager.registerSink(sink),
        wireSSEBroadcasts: (webResult, mSink) => this.wireSSEBroadcasts(webResult, mSink),
        port: configPort,
      });

      logger.info(`[Container] Web console started as ${result.role}`);
      return result;
    } catch (error) {
      logger.warn('[Container] Web console startup failed:', error);
      return null;
    } finally {
      timer?.endPhase('web_console');
    }
  }

  private async deferredPermissionServer(consoleResult: UnifiedConsoleResult | null, timer?: StartupTimer): Promise<void> {
    timer?.startPhase('permission_server', false);
    try {
      if (!env.DOLLHOUSE_PERMISSION_SERVER) {
        logger.debug('[Container] Permission server disabled via DOLLHOUSE_PERMISSION_SERVER=false');
        return;
      }

      if (!env.DOLLHOUSE_WEB_CONSOLE) {
        logger.debug('[Container] Permission server skipped — web console is disabled');
        return;
      }

      // Permission routes are already mounted on the unified web console.
      // We just need to write the active leader port so the PreToolUse hook
      // script reaches the same console instance that owns the live audit feed.
      const port = consoleResult?.role === 'leader'
        ? consoleResult.port
        : consoleResult?.election.leaderInfo.port;

      if (!port) {
        logger.debug('[Container] Permission server skipped — no active web console port available');
        return;
      }

      const startMs = Date.now();

      const { writePortFile, registerPortCleanup } = await import('../auto-dollhouse/portDiscovery.js');
      logger.debug(`[Container] Writing permission server port file for port ${port}`);
      await writePortFile(port);
      registerPortCleanup();
      logger.debug(`[Container] Port cleanup handlers registered`);

      const elapsedMs = Date.now() - startMs;
      logger.info(`[Container] Permission server port file written (port ${port}, ${elapsedMs}ms)`);
    } catch (error) {
      logger.warn('[Container] Permission server startup failed:', error);
    }
    timer?.endPhase('permission_server');
  }

  private async deferredDangerZoneInit(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('danger_zone_init', false);
    try {
      const dangerZoneEnforcer = this.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      await dangerZoneEnforcer.initialize();
    } catch (error) {
      logger.warn('[Container] DangerZoneEnforcer initialization failed:', error);
    }
    timer?.endPhase('danger_zone_init');
  }

  private async deferredPatternEncryption(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('pattern_encryption', false);
    try {
      const patternEncryptor = this.resolve('PatternEncryptor') as PatternEncryptor;
      await patternEncryptor.initialize();
      logger.info("Pattern encryption initialized");
    } catch (error) {
      logger.warn('[Container] Pattern encryption initialization failed:', error);
    }
    timer?.endPhase('pattern_encryption');
  }

  private async deferredBackgroundValidator(timer?: StartupTimer): Promise<void> {
    timer?.startPhase('background_validator', false);
    try {
      const backgroundValidator = this.resolve('BackgroundValidator') as any;
      backgroundValidator.start();
      logger.info("Background validator started for memory security");
    } catch (error) {
      logger.warn('[Container] Background validator start failed:', error);
    }
    timer?.endPhase('background_validator');
  }

  /**
   * Restore per-session activation state from the activation store.
   * Called during preparePortfolio() after auto-load memories.
   *
   * Issue #598: Each element type is restored independently.
   * Missing elements (deleted since last session) are skipped and pruned.
   * Auto-loaded memories are deduplicated (not activated twice).
   */
  private async restoreActivations(store: IActivationStateStore): Promise<void> {
    const personaManager = this.resolve<PersonaManager>('PersonaManager');
    const skillManager = this.resolve<SkillManager>('SkillManager');
    const agentManager = this.resolve<AgentManager>('AgentManager');
    const memoryManager = this.resolve<MemoryManager>('MemoryManager');
    const ensembleManager = this.resolve<EnsembleManager>('EnsembleManager');

    let restoredCount = 0;
    let skippedCount = 0;

    const restoreType = async (
      elementType: string,
      activateFn: (activation: import('../state/IActivationStateStore.js').PersistedActivation) => Promise<{ success: boolean }>,
      skip?: Set<string>,
    ): Promise<void> => {
      for (const activation of store.getActivations(elementType)) {
        if (skip?.has(activation.name)) {
          logger.debug(`[Container] ${elementType} '${activation.name}' already active (auto-loaded), skipping`);
          continue;
        }
        try {
          const result = await activateFn(activation);
          if (result.success) {
            restoredCount++;
          } else {
            logger.debug(`[Container] Pruning missing ${elementType} '${activation.name}'`);
            store.removeStaleActivation(elementType, activation.name);
            skippedCount++;
          }
        } catch {
          logger.debug(`[Container] Skipping failed ${elementType} '${activation.name}'`);
          store.removeStaleActivation(elementType, activation.name);
          skippedCount++;
        }
      }
    };

    // Personas use filename if available (Issue #843)
    await restoreType('persona', (a) => personaManager.activatePersona(a.filename || a.name));
    await restoreType('skill', (a) => skillManager.activateSkill(a.name));
    await restoreType('agent', (a) => agentManager.activateAgent(a.name));

    // Memories: dedup against auto-loaded ones
    const activeMemories = await memoryManager.getActiveMemories();
    const activeMemoryNames = new Set(activeMemories.map(m => m.metadata.name));
    await restoreType('memory', (a) => memoryManager.activateMemory(a.name), activeMemoryNames);

    await restoreType('ensemble', (a) => ensembleManager.activateEnsemble(a.name));

    if (restoredCount > 0 || skippedCount > 0) {
      logger.info(
        `[Container] Restored ${restoredCount} element(s), skipped ${skippedCount} stale for session '${store.getSessionId()}'`
      );
    }
  }

  /**
   * Bootstrap all handlers without registering MCP tools.
   * Used by web-only mode (--web) to get MCPAQLHandler without an MCP Server.
   * Issue #796: Split DI container bootstrap from transport connect.
   */
  public async bootstrapHandlers(): Promise<HandlerBundle> {
    if (!this.personasDir) {
      throw new Error("Persona directory not initialized. Call preparePortfolio() first.");
    }

    // Issue #1948: PathValidator initialized via DI (instance-based, no static mutation)
    // Resolving here ensures it's created with the correct personasDir
    this.resolve<PathValidator>('PathValidator');

    const indicatorService = this.resolve<PersonaIndicatorService>('PersonaIndicatorService');
    const personaManager = this.resolve<PersonaManager>('PersonaManager');
    const initService = this.resolve<InitializationService>('InitializationService');
    const personaExporter = new PersonaExporter(() => personaManager.getCurrentUserForAttribution());
    const personaImporter = new PersonaImporter(this.personasDir, () => personaManager.getCurrentUserForAttribution());

    // Create state accessor for PersonaHandler
    const activePersonaAccessor = {
      get: () => personaManager.getActivePersona()?.filename || null,
      set: (value: string | null) => {
        if (value) {
          // Issue #843: activatePersona is now async but this setter is synchronous.
          // Known limitation: under concurrent sessions, this fire-and-forget races on
          // shared PersonaManager state. Scoped DI gives each session its own PersonaManager.
          // Fire-and-forget — PersonaHandler does its own lookup before calling set().
          // Log at error level since activation failures here indicate stale state.
          personaManager.activatePersona(value).catch(err =>
            logger.error(`[Container] Persona activation failed for "${value}" — state accessor may be stale:`, err)
          );
        } else {
          personaManager.deactivatePersona();
        }
      }
    };

    const personaHandler = new PersonaHandler(
      personaManager,
      personaExporter,
      personaImporter,
      initService,
      indicatorService,
      activePersonaAccessor
    );

    await personaManager.reload();

    const elementCrudHandler = new ElementCRUDHandler(
      this.resolve('SkillManager'),
      this.resolve('TemplateManager'),
      this.resolve('TemplateRenderer'),
      this.resolve('AgentManager'),
      this.resolve('MemoryManager'),
      this.resolve('EnsembleManager'),
      personaManager,
      this.resolve('PortfolioManager'),
      initService,
      indicatorService,
      this.resolve('FileOperationsService'),
      this.resolve('ElementQueryService'),
      this.resolve('ValidationRegistry'),
      this.resolve<IActivationStateStore>('ActivationStore'),
      this.resolve('BackupService'),
      this.resolve('PolicyExportService'),
      this.resolve('SessionActivationRegistry'),
      this.resolve('ContextTracker'),
      this.hasRegistration('ForkOnEditStrategy') ? this.resolve('ForkOnEditStrategy') : undefined,
    );
    // Register for lazy resolution by PolicyExportService
    this.register('ElementCRUDHandler', () => elementCrudHandler);

    // MCPAQLHandler created later after all handlers are instantiated
    // See below after enhancedIndexHandler creation

    const collectionHandler = new CollectionHandler(
      this.resolve('CollectionBrowser'),
      this.resolve('CollectionSearch'),
      this.resolve('PersonaDetails'),
      this.resolve('ElementInstaller'),
      this.resolve('CollectionCache'),
      this.resolve('PortfolioManager'),
      this.resolve('APICache'),
      personaManager, // Use the resolved PersonaManager
      this.resolve('SubmitToPortfolioTool'),
      this.resolve('UnifiedIndexManager'),
      this.resolve('InitializationService'),
      this.resolve('PersonaIndicatorService'),
      this.resolve('FileOperationsService')
    );

    // Wire auto-submit check now that CollectionHandler exists.
    // SubmitToPortfolioTool was registered before CollectionHandler was constructed,
    // so the callback is set post-construction to close the wiring gap.
    this.resolve<SubmitToPortfolioTool>('SubmitToPortfolioTool')
      .setAutoSubmitCheck(() => collectionHandler.isAutoSubmitEnabled());

    const portfolioHandler = new PortfolioHandler(
      this.resolve('GitHubAuthManager'),
      this.resolve('PortfolioManager'),
      this.resolve('PortfolioPullHandler'),
      this.resolve('PortfolioIndexManager'),
      this.resolve('UnifiedIndexManager'),
      initService,
      indicatorService,
      this.resolve('ConfigManager'),
      this.resolve('FileOperationsService'),
      this.resolve('TokenManager'),
      this.resolve('PortfolioRepoManager'),
      collectionHandler
    );

    const githubAuthHandler = new GitHubAuthHandler(
      this.resolve('GitHubAuthManager'),
      this.resolve('ConfigManager'),
      initService,
      indicatorService,
      this.resolve('FileOperationsService')
    );

    const displayConfigHandler = new DisplayConfigHandler(
      personaManager,
      initService,
      indicatorService
    );

    const identityHandler = new IdentityHandler(
      personaManager,
      initService,
      indicatorService,
      this.resolve('ContextTracker')
    );

    const configHandler = new ConfigHandler(
      this.resolve('ConfigManager'),
      initService,
      indicatorService
    );
    const syncHandler = new SyncHandler(
      this.resolve('PortfolioSyncManager'),
      this.resolve('ConfigManager'),
      indicatorService
    );

    const enhancedIndexHandler = new EnhancedIndexHandler(
      this.resolve('EnhancedIndexManager'),
      indicatorService
    );

    // Issue #452: Create Gatekeeper policy engine instance
    // Issue #679: allowElementPolicyOverrides wired from env (DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES)
    // Issue #1947: Gatekeeper with per-session resolution via ContextTracker
    const stdioSession = this.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
    const gatekeeper = new Gatekeeper(undefined, {
      enableAuditLogging: true,
      requireDangerZoneVerification: true,
      allowElementPolicyOverrides: env.DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES,
    }, this.resolve<ContextTracker>('ContextTracker'), stdioSession.sessionId);

    // Create MCPAQLHandler with all available handlers for full operation coverage (Issue #241)
    // Issue #301: Pass ContextTracker for request correlation metadata
    // Issue #402: Pass DangerZoneEnforcer via HandlerRegistry
    // Build handler registry, then add lazy metricsSink getter.
    // MemoryMetricsSink is registered during deferredSetup (after MetricsManager.start()),
    // so it isn't available at handler construction time — resolve on first access instead.
    const handlerDeps: HandlerRegistry = {
      elementCRUD: elementCrudHandler,
      memoryManager: this.resolve('MemoryManager'),
      agentManager: this.resolve('AgentManager'),
      templateRenderer: this.resolve('TemplateRenderer'),
      elementQueryService: this.resolve('ElementQueryService'),
      // MCP-AQL extension handlers (Issue #241)
      collectionHandler,
      portfolioHandler,
      authHandler: githubAuthHandler,
      configHandler,
      enhancedIndexHandler,
      personaHandler,
      syncHandler,
      buildInfoService: this.resolve('BuildInfoService'),
      cacheMemoryBudget: this.resolve('CacheMemoryBudget'),
      gatekeeper,  // Issue #452: Policy engine for enforce()
      dangerZoneEnforcer: this.resolve('DangerZoneEnforcer'),
      verificationStore: this.resolve('ChallengeStore'),  // Issue #142, #1945: Verification codes via IChallengeStore
      verificationNotifier: this.resolve('VerificationNotifier'),  // Issue #522: OS dialog for codes
      memorySink: this.resolve<MemoryLogSink>('MemoryLogSink'),  // Issue #528: CRUDE-routed query_logs
      performanceMonitor: this.resolve<PerformanceMonitor>('PerformanceMonitor'),
      operationMetricsTracker: this.resolve<OperationMetricsTracker>('OperationMetricsTracker'),
      gatekeeperMetricsTracker: this.resolve<GatekeeperMetricsTracker>('GatekeeperMetricsTracker'),
      circuitBreaker: this.resolve<CircuitBreakerState>('CircuitBreakerState'),
      resilienceMetrics: this.resolve<ResilienceMetricsTracker>('ResilienceMetricsTracker'),
    };
    Object.defineProperty(handlerDeps, 'metricsSink', {
      get: () => { try { return this.resolve<MemoryMetricsSink>('MemoryMetricsSink'); } catch { return undefined; } },
      configurable: true,
      enumerable: true,
    });
    const mcpAqlHandler = new MCPAQLHandler(handlerDeps, this.resolve<ContextTracker>('ContextTracker'));

    // Register mcpAqlHandler as a singleton for test access
    this.register('mcpAqlHandler', () => mcpAqlHandler, { singleton: true });
    this.register('gatekeeper', () => gatekeeper, { singleton: true });

    return {
      personaHandler,
      elementCrudHandler,
      collectionHandler,
      portfolioHandler,
      githubAuthHandler,
      displayConfigHandler,
      identityHandler,
      configHandler,
      syncHandler,
      toolRegistry: undefined as unknown as ToolRegistry, // No tool registry in bootstrap-only mode
      enhancedIndexHandler,
      mcpAqlHandler,
    };
  }

  /**
   * Create all handlers with dependency injection and register MCP tools.
   * @param server - MCP Server instance for tool registration
   */
  public async createHandlers(server: Server): Promise<HandlerBundle> {
    const bundle = await this.bootstrapHandlers();

    const toolRegistry = new ToolRegistry(server);
    const interfaceMode = env.MCP_INTERFACE_MODE;
    logger.info(`MCP Interface Mode: ${interfaceMode}`);

    this.registerToolsOnRegistry(toolRegistry, bundle, interfaceMode);

    // Log token statistics (Issue #237 enhancement)
    this.logToolTokenStats(toolRegistry, interfaceMode, bundle.mcpAqlHandler, {
      personaHandler: bundle.personaHandler,
      elementCrudHandler: bundle.elementCrudHandler,
      collectionHandler: bundle.collectionHandler,
      portfolioHandler: bundle.portfolioHandler,
      githubAuthHandler: bundle.githubAuthHandler,
      configHandler: bundle.configHandler,
      syncHandler: bundle.syncHandler,
      enhancedIndexHandler: bundle.enhancedIndexHandler,
    });

    this.resolve<ServerSetup>('ServerSetup').setupServer(server, toolRegistry, bundle.elementCrudHandler);

    return {
      ...bundle,
      toolRegistry,
    };
  }

  // ── Shared-container HTTP session support (Phase 2) ────────────────────────

  /** Cached handler bundle bootstrapped once for HTTP mode. */
  private httpHandlerBundle: HandlerBundle | null = null;

  /**
   * Bootstrap handlers once for HTTP mode and cache the bundle.
   * Called at server startup before any HTTP session is created.
   *
   * This is the HTTP equivalent of createHandlers(), but without creating
   * a ToolRegistry or Server — those are per-session (see createServerForHttpSession).
   */
  public async bootstrapHttpHandlers(): Promise<HandlerBundle> {
    this.httpHandlerBundle ??= await this.bootstrapHandlers();
    return this.httpHandlerBundle;
  }

  /**
   * Create a per-session MCP Server wired to the shared handler bundle.
   *
   * Each HTTP session gets its own Server (SDK requirement), ToolRegistry,
   * and ServerSetup with a session-specific SessionResolver. Handlers are
   * shared across sessions — they are stateless or session-aware (Phase 2 prereqs).
   *
   * Phase 3: Per-session ActivationStore. Currently all HTTP sessions
   * share the container's global activation state.
   *
   * @param sessionContext - Frozen SessionContext created by createHttpSession()
   * @returns Per-session Server instance plus a dispose callback
   */
  public async createServerForHttpSession(sessionContext: Readonly<import('../context/SessionContext.js').SessionContext>): Promise<{
    server: Server;
    dispose: () => Promise<void>;
  }> {
    if (!this.httpHandlerBundle) {
      throw new Error(
        'HTTP handler bundle not initialized. Call bootstrapHttpHandlers() before creating sessions.'
      );
    }

    const bundle = this.httpHandlerBundle;
    const contextTracker = this.resolve<ContextTracker>('ContextTracker');
    const sid = sessionContext.sessionId;

    // Issue #1948: Create a child container for this session's scoped services
    const child = new SessionContainer(this, sid);

    // ── Per-user path resolution for this session ────────────────────
    // Resolve the active user's directories once per session creation.
    // These are used to scope file-mode stores and the session-scoped
    // PathValidator to this user's subtree.
    const userPathResolver = this.resolve<import('../paths/IUserPathResolver.js').IUserPathResolver>('UserPathResolver');
    const httpUserId = validateUserId(sessionContext.userId);
    const userStateDir = userPathResolver.getUserStateDir(httpUserId);
    const userAuthDir = userPathResolver.getUserAuthDir(httpUserId);
    const userBackupsDir = userPathResolver.getUserBackupsDir(httpUserId);
    const userSecurityDir = userPathResolver.getUserSecurityDir(httpUserId);
    const userPortfolioDir = userPathResolver.getUserPortfolioDir(httpUserId);

    // ── Session-scoped PathValidator ────────────────────────────────
    // Restricts this session's file operations to the user's subtree.
    // The root PathValidator (used by stdio) is permissive; HTTP sessions
    // get a locked-down instance that only allows writes inside the
    // user's dirs and reads from user dirs + shared pool.
    const sharedPoolDir = this.hasRegistration('PathService')
      ? this.resolve<import('../paths/PathService.js').PathService>('PathService').resolveDataDir('shared-pool')
      : undefined;
    child.register('PathValidator', () => new PathValidator({
      writeDirs: [userPortfolioDir, userStateDir, userAuthDir, userBackupsDir, userSecurityDir],
      readOnlyDirs: sharedPoolDir ? [sharedPoolDir] : [],
    }));

    // ── Per-session persistence stores ──────────────────────────────
    // HTTP sessions are ephemeral — ActivationStore.initialize() is
    // intentionally NOT called here. Activation state starts fresh per
    // connection. File-mode stores receive the user's state dir;
    // DB-mode stores are scoped via RLS on userId.
    if (this.hasRegistration('DatabaseInstance')) {
      const db = this.resolve<DatabaseInstance>('DatabaseInstance');
      const DbActivation = this.resolve<typeof DatabaseActivationStateStore>('DatabaseActivationStateStoreClass');
      const DbConfirmation = this.resolve<typeof DatabaseConfirmationStore>('DatabaseConfirmationStoreClass');
      child.register('ActivationStore', () =>
        new DbActivation(db, httpUserId, sid));
      child.register('ConfirmationStore', () =>
        new DbConfirmation(db, httpUserId, sid));
      child.register('GatekeeperSession', () =>
        new GatekeeperSession(undefined, 100, undefined, child.resolve('ConfirmationStore'), sid));
    } else {
      child.register('ActivationStore', () =>
        new FileActivationStateStore(this.resolve('FileOperationsService'), userStateDir, sid));
      child.register('ConfirmationStore', () =>
        new FileConfirmationStore(this.resolve('FileOperationsService'), userStateDir, sid));
      child.register('GatekeeperSession', () =>
        new GatekeeperSession(undefined, 100, undefined, child.resolve('ConfirmationStore'), sid));
    }

    // ── Per-user service overrides (Group B) ──────────────────────────
    // TokenManager, BackupService, and DangerZoneEnforcer are root-scoped
    // for stdio (single user). HTTP sessions override them with per-user
    // instances so auth tokens, backups, and security blocks are isolated.
    child.register('TokenManager', () => new TokenManager(
      this.resolve('FileOperationsService'), userAuthDir
    ));
    child.register('BackupService', () => new BackupService(
      this.resolve('FileOperationsService'),
      {
        backupRootDir: userBackupsDir,
        maxBackupsPerElement: getValidatedMaxBackupsPerElement(),
        enabled: STORAGE_LAYER_CONFIG.BACKUPS_ENABLED,
      }
    ));
    child.register('DangerZoneEnforcer', () => new DangerZoneEnforcer(
      this.resolve('FileOperationsService'), userSecurityDir
    ));

    // Bridge: attach per-session activation store to the activation registry
    const activationRegistry = this.resolve<SessionActivationRegistry>('SessionActivationRegistry');
    const httpSessionState = activationRegistry.getOrCreate(sid);
    httpSessionState.activationStore = child.resolve<IActivationStateStore>('ActivationStore');

    // Bridge: register per-session GatekeeperSession with the shared Gatekeeper
    const gatekeeper = this.resolve<Gatekeeper>('gatekeeper');
    const httpGkSession = child.resolve<GatekeeperSession>('GatekeeperSession');
    try {
      await httpGkSession.initialize();
    } catch (initError) {
      logger.warn('[HTTP Session] GatekeeperSession initialization failed — starting fresh', {
        error: initError instanceof Error ? initError.message : String(initError),
      });
    }
    gatekeeper.registerSession(sid, httpGkSession);

    // Per-session Server, ServerSetup, ToolRegistry — registered in child container
    const capabilities: Record<string, Record<string, unknown>> = { tools: {} };
    try {
      const configManager = this.resolve<ConfigManager>('ConfigManager');
      const resourcesConfig = configManager.getSetting<Record<string, unknown>>('elements.enhanced_index.resources');
      if (resourcesConfig?.advertise_resources === true) {
        capabilities.resources = {};
      }
    } catch (configError) {
      logger.debug('[HTTP Session] Config not available for resources capability, using safe default', {
        error: configError instanceof Error ? configError.message : String(configError),
      });
    }

    child.register('Server', () => new Server(
      { name: 'dollhousemcp', version: PACKAGE_VERSION },
      { capabilities }
    ));
    child.register('SessionResolver', () => (() => sessionContext) as SessionResolver);
    child.register('ServerSetup', () => new ServerSetup(contextTracker, child.resolve<SessionResolver>('SessionResolver')));
    child.register('ToolRegistry', () => {
      const registry = new ToolRegistry(child.resolve<Server>('Server'));
      this.registerToolsOnRegistry(registry, bundle, env.MCP_INTERFACE_MODE);
      return registry;
    });

    // Wire up: setup server with tools
    const server = child.resolve<Server>('Server');
    const toolRegistry = child.resolve<ToolRegistry>('ToolRegistry');
    const serverSetup = child.resolve<ServerSetup>('ServerSetup');
    serverSetup.setupServer(server, toolRegistry, bundle.elementCrudHandler);

    return {
      server,
      dispose: async () => {
        // Issue #1948: Child container disposal handles all session cleanup:
        // - Disposes session-scoped services (stores, GatekeeperSession, Server, etc.)
        // - Cleans up activation registry, Gatekeeper registry, MCPAQLHandler session state
        await child.dispose();
      },
    };
  }

  /**
   * Register tools on a ToolRegistry based on the interface mode.
   * Used by both createHandlers() (stdio) and createServerForHttpSession() (HTTP)
   * to avoid duplicating the tool registration logic.
   */
  private registerToolsOnRegistry(
    toolRegistry: ToolRegistry,
    bundle: HandlerBundle,
    interfaceMode: 'discrete' | 'mcpaql',
  ): void {
    if (interfaceMode === 'discrete') {
      toolRegistry.registerPersonaTools(bundle.personaHandler);
      toolRegistry.registerElementTools(bundle.elementCrudHandler);
      toolRegistry.registerCollectionTools(bundle.collectionHandler);
      toolRegistry.registerPortfolioTools(bundle.portfolioHandler);
      toolRegistry.registerAuthTools(bundle.githubAuthHandler);
      toolRegistry.registerConfigTools({
        handleConfigOperation: (options) =>
          bundle.configHandler.handleConfigOperation(options),
        handleSyncOperation: (options) =>
          bundle.syncHandler.handleSyncOperation(options),
      });
      toolRegistry.registerEnhancedIndexTools(
        bundle.enhancedIndexHandler,
        this.resolve<IndexConfigManager>('IndexConfigManager').getConfig()
      );
      toolRegistry.registerBuildInfoTools(this.resolve('BuildInfoService'));
    } else {
      toolRegistry.registerMCPAQLTools(bundle.mcpAqlHandler);
    }
  }

  /**
   * Log tool token statistics for monitoring and documentation.
   * Shows current mode token count, alternative mode comparison, and savings.
   *
   * This is important for:
   * 1. Documenting actual token savings achieved
   * 2. Monitoring context window usage
   * 3. Supporting future MCP-AQL adapter development
   *
   * Issue #237 enhancement
   */
  private logToolTokenStats(
    toolRegistry: ToolRegistry,
    interfaceMode: 'discrete' | 'mcpaql',
    mcpAqlHandler: MCPAQLHandler,
    discreteHandlers: {
      personaHandler: PersonaHandler;
      elementCrudHandler: ElementCRUDHandler;
      collectionHandler: CollectionHandler;
      portfolioHandler: PortfolioHandler;
      githubAuthHandler: GitHubAuthHandler;
      configHandler: ConfigHandler;
      syncHandler: SyncHandler;
      enhancedIndexHandler: EnhancedIndexHandler;
    }
  ): void {
    const currentTokens = toolRegistry.getToolTokenEstimate();
    const currentToolCount = toolRegistry.getToolCount();

    // Calculate alternative mode tokens for comparison
    let alternativeTokens: number;
    let alternativeToolCount: number;

    if (interfaceMode === 'discrete') {
      // Current is discrete, calculate what mcpaql would be
      const tempRegistry = new ToolRegistry({} as Server);
      tempRegistry.registerMCPAQLTools(mcpAqlHandler);
      alternativeTokens = tempRegistry.getToolTokenEstimate();
      alternativeToolCount = tempRegistry.getToolCount();
    } else {
      // Current is mcpaql, calculate what discrete would be
      const tempRegistry = new ToolRegistry({} as Server);
      tempRegistry.registerPersonaTools(discreteHandlers.personaHandler);
      tempRegistry.registerElementTools(discreteHandlers.elementCrudHandler);
      tempRegistry.registerCollectionTools(discreteHandlers.collectionHandler);
      tempRegistry.registerPortfolioTools(discreteHandlers.portfolioHandler);
      tempRegistry.registerAuthTools(discreteHandlers.githubAuthHandler);
      tempRegistry.registerConfigTools({
        handleConfigOperation: (options) =>
          discreteHandlers.configHandler.handleConfigOperation(options),
        handleSyncOperation: (options) =>
          discreteHandlers.syncHandler.handleSyncOperation(options),
      });
      tempRegistry.registerEnhancedIndexTools(
        discreteHandlers.enhancedIndexHandler,
        this.resolve<IndexConfigManager>('IndexConfigManager').getConfig()
      );
      tempRegistry.registerBuildInfoTools(this.resolve('BuildInfoService'));
      alternativeTokens = tempRegistry.getToolTokenEstimate();
      alternativeToolCount = tempRegistry.getToolCount();
    }

    // Calculate savings (positive = current mode saves tokens)
    const tokenDiff = alternativeTokens - currentTokens;
    const savingsPercent = alternativeTokens > 0
      ? ((tokenDiff / alternativeTokens) * 100).toFixed(1)
      : '0';

    // Log the comparison
    logger.info(
      `Tool Registration Complete: ${currentToolCount} tools, ~${currentTokens.toLocaleString()} tokens`
    );

    if (interfaceMode === 'mcpaql') {
      // Highlight savings when using mcpaql
      logger.info(
        `Token Savings: ${tokenDiff.toLocaleString()} tokens saved (${savingsPercent}%) vs discrete mode (${alternativeToolCount} tools, ~${alternativeTokens.toLocaleString()} tokens)`
      );
    } else {
      // In discrete mode, show what mcpaql would save
      logger.info(
        `Alternative: mcpaql mode would use ${alternativeToolCount} tools, ~${alternativeTokens.toLocaleString()} tokens (${Math.abs(Number(savingsPercent))}% ${tokenDiff < 0 ? 'more' : 'less'})`
      );
    }
  }

  /**
   * Wire all metric collectors into the MetricsManager.
   * Mirrors wireLogHooks() — keeps collector registration out of the constructor.
   */
  private wireMetricsCollectors(metricsManager: MetricsManager): void {
    // PerformanceMonitor (instance)
    try {
      const monitor = this.resolve<import('../utils/PerformanceMonitor.js').PerformanceMonitor>('PerformanceMonitor');
      metricsManager.registerCollector(new PerformanceMonitorCollector(monitor));
    } catch { /* not registered */ }

    // LRUCache instances — API cache + all element manager caches
    const caches = this.collectLruCachesForMetrics();
    if (caches.length > 0) {
      metricsManager.registerCollector(new LRUCacheCollector(caches));
    }

    // SecurityMonitor (static)
    try {
      metricsManager.registerCollector(new SecurityMonitorCollector());
    } catch { /* not available */ }

    // SecurityTelemetry (instance)
    try {
      const telemetry = this.resolve<import('../security/telemetry/SecurityTelemetry.js').SecurityTelemetry>('SecurityTelemetry');
      metricsManager.registerCollector(new SecurityTelemetryCollector(telemetry));
    } catch { /* not registered */ }

    // FileLockManager (instance)
    try {
      const lockManager = this.resolve<import('../security/fileLockManager.js').FileLockManager>('FileLockManager');
      metricsManager.registerCollector(new FileLockManagerCollector(lockManager));
    } catch { /* not registered */ }

    // DefaultElementProvider (static)
    try {
      metricsManager.registerCollector(new DefaultElementProviderCollector());
    } catch { /* not available */ }

    // TriggerMetricsTracker (instance — created inside EnhancedIndexManager factory)
    try {
      const enhancedIndex = this.resolve<import('../portfolio/EnhancedIndexManager.js').EnhancedIndexManager>('EnhancedIndexManager');
      // EnhancedIndexManager exposes tracker via public getter if available
      if ('triggerMetricsTracker' in enhancedIndex) {
        const tracker = (enhancedIndex as any).triggerMetricsTracker;
        if (tracker) {
          metricsManager.registerCollector(new TriggerMetricsTrackerCollector(tracker));
        }
      }
    } catch { /* not registered */ }

    // OperationalTelemetry (instance)
    try {
      const opTelemetry = this.resolve<import('../telemetry/OperationalTelemetry.js').OperationalTelemetry>('OperationalTelemetry');
      metricsManager.registerCollector(new OperationalTelemetryCollector(opTelemetry));
    } catch { /* not registered */ }

    // OperationMetricsTracker (instance)
    try {
      const opTracker = this.resolve<OperationMetricsTracker>('OperationMetricsTracker');
      metricsManager.registerCollector(new OperationMetricsCollector(opTracker));
    } catch { /* not registered */ }

    // GatekeeperMetricsTracker (instance)
    try {
      const gkTracker = this.resolve<GatekeeperMetricsTracker>('GatekeeperMetricsTracker');
      metricsManager.registerCollector(new GatekeeperMetricsCollector(gkTracker));
    } catch { /* not registered */ }
  }

  private collectLruCachesForMetrics(): Array<{ name: string; instance: import('../cache/LRUCache.js').LRUCache<unknown> }> {
    const caches: Array<{ name: string; instance: import('../cache/LRUCache.js').LRUCache<unknown> }> = [];
    try {
      const apiCache = this.resolve<{ getStats(): import('../cache/LRUCache.js').CacheStats }>('APICache');
      caches.push({ name: 'APICache', instance: apiCache as any });
    } catch { /* not available */ }

    const managerNames = [
      'PersonaManager', 'SkillManager', 'AgentManager',
      'MemoryManager', 'EnsembleManager', 'TemplateManager',
    ] as const;
    for (const name of managerNames) {
      try {
        const mgr = this.resolve<import('../elements/base/BaseElementManager.js').BaseElementManager<any>>(name);
        caches.push(...mgr.getMetricsCaches());
      } catch { /* not registered */ }
    }

    return caches;
  }

  public async dispose(): Promise<void> {
    // Close the HTTP server first so the port is freed immediately (#1856)
    try {
      const { shutdownWebServer } = await import('../web/server.js');
      shutdownWebServer();
    } catch { /* web server not started */ }

    // Close MetricsManager before general disposal (flush final snapshot)
    try {
      const metricsManager = this.resolve<MetricsManager>('MetricsManager');
      await metricsManager.close();
    } catch { /* metrics not enabled or not registered */ }

    // Clean up log hooks before disposing services
    try {
      const cleanups = this.resolve<(() => void)[]>('_logHookCleanups');
      cleanups.forEach(fn => fn());
    } catch { /* hooks not yet wired */ }

    const disposalPromises = this.buildDisposalPromises();
    const results = await Promise.allSettled(disposalPromises.map(d => d.promise));
    this.reportDisposalFailures(disposalPromises, results);
  }

  private buildDisposalPromises(): Array<{ name: string; promise: Promise<void> }> {
    const promises: Array<{ name: string; promise: Promise<void> }> = [];
    for (const [name, service] of this.services) {
      if (!service.instance) continue;
      const instance = service.instance as any;
      // Priority: dispose > close > destroy > cleanup
      // dispose: standard DI lifecycle
      // close: stream-like objects (LogManager, MetricsManager)
      // destroy: timer-bearing objects (VerificationStore, ChallengeStore)
      // cleanup: sweep operations (non-destructive)
      if (typeof instance.dispose === 'function') {
        promises.push({ name, promise: Promise.resolve().then(() => instance.dispose()) });
      } else if (typeof instance.close === 'function') {
        promises.push({ name, promise: Promise.resolve().then(() => instance.close()) });
      } else if (typeof instance.destroy === 'function') {
        promises.push({ name, promise: Promise.resolve().then(() => instance.destroy()) });
      } else if (typeof instance.cleanup === 'function') {
        promises.push({ name, promise: Promise.resolve().then(() => instance.cleanup()) });
      }
    }
    return promises;
  }

  private reportDisposalFailures(
    disposalPromises: Array<{ name: string; promise: Promise<void> }>,
    results: PromiseSettledResult<void>[],
  ): void {
    const failures: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const serviceName = disposalPromises[index].name;
        const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        failures.push(serviceName);
        logger.warn(`Failed to dispose service '${serviceName}'`, { error });
      }
    }
    if (failures.length > 0) {
      logger.warn(`Container disposal completed with ${failures.length} failure(s) out of ${disposalPromises.length} services`);
    }
  }

  private async initializeCollectionCache(): Promise<void> {
    try {
      const collectionCache = this.resolve<CollectionCache>('CollectionCache');
      const isCacheValid = await collectionCache.isCacheValid();
      if (!isCacheValid) {
        logger.info("Initializing collection cache with seed data...");
        const { CollectionSeeder } = await import("../collection/CollectionSeeder.js");
        const seedData = CollectionSeeder.getSeedData();
        await collectionCache.saveCache(seedData);
        logger.info(`Collection cache initialized with ${seedData.length} items`);
      } else {
        const stats = await collectionCache.getCacheStats();
        logger.debug(`Collection cache already valid with ${stats.itemCount} items`);
      }
    } catch (error) {
      ErrorHandler.logError("DollhouseContainer.initializeCollectionCache", error);
    }
  }
}
