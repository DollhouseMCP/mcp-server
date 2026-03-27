import os from "os";
import * as path from "path";
import { VERSION } from "../constants/version.js";
import { SecurityMonitor } from "../security/securityMonitor.js";
import { VerbTriggerManager } from "../portfolio/VerbTriggerManager.js";
import { RelationshipManager } from "../portfolio/RelationshipManager.js";
import { NLPScoringManager } from "../portfolio/NLPScoringManager.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { loadIndicatorConfig } from "../config/indicator-config.js";
import { env } from "../config/env.js";
import { APICache, CollectionCache, CollectionIndexCache, CacheMemoryBudget } from "../cache/index.js";
import { getValidatedGlobalCacheMemoryBytes, getValidatedMaxBackupsPerElement, STORAGE_LAYER_CONFIG } from "../config/performance-constants.js";
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
import { ActivationStore } from "../services/ActivationStore.js";
import { VerificationStore } from "@dollhousemcp/safety";
import { VerificationNotifier } from "../services/VerificationNotifier.js";
import { PatternEncryptor } from "../security/encryption/PatternEncryptor.js";
import { PatternDecryptor } from "../security/encryption/PatternDecryptor.js";
import { ContextTracker } from "../security/encryption/ContextTracker.js";
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
import {
  PaginationService,
  FilterService,
  SortService,
  ElementQueryService,
} from '../services/query/index.js';
import { RetentionPolicyService, MemoryRetentionStrategy } from '../services/RetentionPolicyService.js';
import { PolicyExportService } from '../services/PolicyExportService.js';
import { PACKAGE_VERSION } from '../generated/version.js';
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

  constructor() {
    // FIX: DMCP-SEC-006 - Audit DI container initialization
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'DollhouseContainer.constructor',
      details: 'Dependency injection container initializing'
    });
    this.registerServices();
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
    this.register('CollectionCache', () => new CollectionCache(this.resolve('FileOperationsService'), undefined));
    this.register('RateLimitTracker', () => new Map<string, number[]>());
    this.register('FileLockManager', () => new FileLockManager());
    this.register('FileOperationsService', () => new FileOperationsService(this.resolve('FileLockManager')));
    this.register('ConfigManager', () => {
      return new ConfigManager(this.resolve('FileOperationsService'), os);
    });
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
    this.register('ElementEventDispatcher', () => ElementEventDispatcher.getSharedDispatcher());
    this.register('MCPLogger', () => logger);

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
    this.register('GitHubClient', () => new GitHubClient(
      this.resolve('APICache'),
      this.resolve('RateLimitTracker'),
      this.resolve('TokenManager')
    ));
    this.register('GitHubAuthManager', () => new GitHubAuthManager(
      this.resolve('APICache'),
      this.resolve('ConfigManager'),
      this.resolve('TokenManager')
    ));
    this.register('CollectionIndexManager', () => new CollectionIndexManager({
      fileOperations: this.resolve('FileOperationsService')
    }));
    this.register('CollectionBrowser', () => new CollectionBrowser(this.resolve('GitHubClient'), this.resolve('CollectionCache'), this.resolve('CollectionIndexManager')));
    this.register('CollectionSearch', () => new CollectionSearch(
      this.resolve('GitHubClient'),
      this.resolve('CollectionCache'),
      this.resolve('CollectionIndexCache')
    ));
    this.register('PersonaDetails', () => new PersonaDetails(this.resolve('GitHubClient')));

    // PORTFOLIO & MANAGERS
    this.register('PortfolioManager', () => new PortfolioManager(
      this.resolve('FileOperationsService'),
      undefined
    ));
    this.register('PersonaManager', () => new PersonaManager(
      this.resolve('PortfolioManager'),
      this.resolve('IndicatorConfig'),
      this.resolve('FileLockManager'),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('MetadataService'),
      this.resolve('PersonaImporter'),
      this.resolve('StateChangeNotifier'),
      {
        eventDispatcher: this.resolve('ElementEventDispatcher'),
        enableFileWatcher: true,
        autoReloadOnExternalChange: true,
        fileWatchService: this.resolve('FileWatchService'),
        memoryBudget: this.resolve('CacheMemoryBudget'),
        backupService: this.resolve('BackupService')
      }
    ));
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
      fileOperations: this.resolve('FileOperationsService')
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
        message: `DollhouseMCP v${VERSION} starting`,
        data: {
          version: VERSION,
          logLevel: config.logLevel,
          logFormat: config.logFormat,
          console: env.DOLLHOUSE_WEB_CONSOLE ? 'http://dollhouse.localhost:3939' : 'disabled',
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
      this.resolve('FileOperationsService')
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
    this.register('SkillManager', () => new SkillManager(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('SerializationService'),
      this.resolve('MetadataService'),
      this.resolve('FileWatchService'),
      this.resolve('CacheMemoryBudget'),
      this.resolve('BackupService')
    ));
    this.register('TemplateManager', () => new TemplateManager(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('SerializationService'),
      this.resolve('MetadataService'),
      this.resolve('FileWatchService'),
      this.resolve('CacheMemoryBudget'),
      this.resolve('BackupService')
    ));
    this.register('TemplateRenderer', () => new TemplateRenderer(this.resolve('TemplateManager')));
    this.register('AgentManager', () => new AgentManager(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve<PortfolioManager>('PortfolioManager').getBaseDir(),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('SerializationService'),
      this.resolve('MetadataService'),
      this.resolve('FileWatchService'),
      this.resolve('CacheMemoryBudget'),
      this.resolve('BackupService')
    ));
    this.register('MemoryManager', () => new MemoryManager(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('SerializationService'),
      this.resolve('MetadataService'),
      this.resolve('FileWatchService'),
      this.resolve('CacheMemoryBudget'),
      this.resolve('BackupService')
    ));
    this.register('EnsembleManager', () => new EnsembleManager(
      this.resolve('PortfolioManager'),
      this.resolve('FileLockManager'),
      this.resolve('FileOperationsService'),
      this.resolve('ValidationRegistry'),
      this.resolve('SerializationService'),
      this.resolve('MetadataService'),
      this.resolve('FileWatchService'),
      this.resolve('CacheMemoryBudget'),
      this.resolve('BackupService')
    ));
    Memory.configureMemoryManagerResolver(() => this.resolve('MemoryManager'));
    // Issue #51: Configure retention policy resolver for Memory class
    Memory.configureRetentionPolicyResolver(() => this.resolve('RetentionPolicyService'));
    // Issue #111: Configure element manager resolver for AgentManager (element-agnostic activation)
    AgentManager.setElementManagerResolver((managerName: string) => this.resolve(managerName));
    // Issue #402: Configure DangerZoneEnforcer resolver for AgentManager (autonomy evaluation)
    AgentManager.setDangerZoneEnforcerResolver(() => this.resolve('DangerZoneEnforcer'));
    // Issue #142: Configure VerificationStore resolver for AgentManager (danger zone verification)
    AgentManager.setVerificationStoreResolver(() => this.resolve('VerificationStore'));

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
    // Issue #402: DangerZoneEnforcer as DI-managed singleton (replaces module-level singleton)
    this.register('DangerZoneEnforcer', () => new DangerZoneEnforcer(
      this.resolve('FileOperationsService')
    ));
    // Issue #598: ActivationStore for per-session activation persistence
    this.register('ActivationStore', () => new ActivationStore(
      this.resolve('FileOperationsService')
    ));
    // Issue #142: VerificationStore for danger zone challenge codes (server-side)
    this.register('VerificationStore', () => new VerificationStore());
    // Issue #522: Non-blocking OS dialog notifier for verification codes
    this.register('VerificationNotifier', () => new VerificationNotifier());
    this.register('TokenManager', () => new TokenManager(
      this.resolve('FileOperationsService')
    ));
    this.register('PatternEncryptor', () => new PatternEncryptor());
    this.register('ContextTracker', () => new ContextTracker());
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
    this.register('ServerSetup', () => new ServerSetup(
      this.resolve<ContextTracker>('ContextTracker')
    ));
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

    await this.deferredMemoryAutoload(timer);
    await this.deferredActivationRestore(timer);
    await this.deferredPolicyExport();
    await this.deferredLogHooks(timer);
    await this.deferredMetricsCollectors(timer);
    await this.deferredWebConsole(timer);
    await this.deferredDangerZoneInit(timer);
    await this.deferredPatternEncryption(timer);
    await this.deferredBackgroundValidator(timer);

    this.deferredSetupComplete = true;

    const report = timer.getReport();
    logger.info(
      `[Startup] Deferred setup completed in ${report.deferredMs}ms ` +
      `(total startup: ${report.totalMs}ms, critical: ${report.criticalPathMs}ms)`
    );
  }

  private async deferredMemoryAutoload(timer: StartupTimer): Promise<void> {
    timer.startPhase('memory_autoload', false);
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
    timer.endPhase('memory_autoload');
  }

  private async deferredActivationRestore(timer: StartupTimer): Promise<void> {
    timer.startPhase('activation_restore', false);
    try {
      const activationStore = this.resolve<ActivationStore>('ActivationStore');
      await activationStore.initialize();

      if (activationStore.isEnabled()) {
        await this.restoreActivations(activationStore);
      }
    } catch (error) {
      logger.warn('[Container] Activation state restoration failed:', error);
    }
    timer.endPhase('activation_restore');
  }

  private async deferredPolicyExport(): Promise<void> {
    try {
      const policyExportService = this.resolve<PolicyExportService>('PolicyExportService');
      await policyExportService.exportPolicies();
    } catch (error) {
      logger.debug('[Container] Policy export skipped:', error);
    }
  }

  private async deferredLogHooks(timer: StartupTimer): Promise<void> {
    timer.startPhase('log_hooks', false);
    try {
      const logManager = this.resolve<LogManager>('LogManager');
      const logCleanups = wireLogHooks(logManager, this);
      this.register('_logHookCleanups', () => logCleanups);
    } catch (error) {
      logger.warn('[Container] Failed to wire log hooks:', error);
    }
    timer.endPhase('log_hooks');
  }

  private async deferredMetricsCollectors(timer: StartupTimer): Promise<void> {
    timer.startPhase('metrics_collectors', false);
    try {
      const metricsManager = this.resolve<MetricsManager>('MetricsManager');
      this.wireMetricsCollectors(metricsManager);
      metricsManager.start();
      logger.info('[Container] Metrics collection started');
    } catch (error) {
      logger.warn('[Container] Metrics wiring skipped:', error);
    }
    timer.endPhase('metrics_collectors');
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

  private async deferredWebConsole(timer: StartupTimer): Promise<void> {
    timer.startPhase('web_console', false);
    try {
      if (!env.DOLLHOUSE_WEB_CONSOLE) return;

      const { discoverAndBindPort } = await import('../web/portDiscovery.js');
      const port = await discoverAndBindPort();

      const { startWebServer } = await import('../web/server.js');
      const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');
      const memorySink = this.resolve<MemoryLogSink>('MemoryLogSink');
      const metricsSink = this.tryResolve<MemoryMetricsSink>('MemoryMetricsSink');
      const mcpAqlHandler = this.tryResolve<MCPAQLHandler>('mcpAqlHandler');

      const webResult = await startWebServer({
        portfolioDir: portfolioManager.getBaseDir(),
        memorySink,
        metricsSink,
        ...(port ? { port } : {}),
        ...(mcpAqlHandler ? { mcpAqlHandler } : {}),
      });

      this.wireSSEBroadcasts(webResult, metricsSink);
      logger.info('[Container] Web console started');
    } catch (error) {
      logger.warn('[Container] Web console startup failed:', error);
    }
    timer.endPhase('web_console');
  }

  private async deferredDangerZoneInit(timer: StartupTimer): Promise<void> {
    timer.startPhase('danger_zone_init', false);
    try {
      const dangerZoneEnforcer = this.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      await dangerZoneEnforcer.initialize();
    } catch (error) {
      logger.warn('[Container] DangerZoneEnforcer initialization failed:', error);
    }
    timer.endPhase('danger_zone_init');
  }

  private async deferredPatternEncryption(timer: StartupTimer): Promise<void> {
    timer.startPhase('pattern_encryption', false);
    try {
      const patternEncryptor = this.resolve('PatternEncryptor') as PatternEncryptor;
      await patternEncryptor.initialize();
      logger.info("Pattern encryption initialized");
    } catch (error) {
      logger.warn('[Container] Pattern encryption initialization failed:', error);
    }
    timer.endPhase('pattern_encryption');
  }

  private async deferredBackgroundValidator(timer: StartupTimer): Promise<void> {
    timer.startPhase('background_validator', false);
    try {
      const backgroundValidator = this.resolve('BackgroundValidator') as any;
      backgroundValidator.start();
      logger.info("Background validator started for memory security");
    } catch (error) {
      logger.warn('[Container] Background validator start failed:', error);
    }
    timer.endPhase('background_validator');
  }

  /**
   * Restore per-session activation state from the ActivationStore.
   * Called during preparePortfolio() after auto-load memories.
   *
   * Issue #598: Each element type is restored independently.
   * Missing elements (deleted since last session) are skipped and pruned.
   * Auto-loaded memories are deduplicated (not activated twice).
   */
  private async restoreActivations(store: ActivationStore): Promise<void> {
    const personaManager = this.resolve<PersonaManager>('PersonaManager');
    const skillManager = this.resolve<SkillManager>('SkillManager');
    const agentManager = this.resolve<AgentManager>('AgentManager');
    const memoryManager = this.resolve<MemoryManager>('MemoryManager');
    const ensembleManager = this.resolve<EnsembleManager>('EnsembleManager');

    let restoredCount = 0;
    let skippedCount = 0;

    // Restore personas (uses filename if available, falls back to name)
    // Issue #843: activatePersona() is now async — uses disk fallback for cache misses
    for (const activation of store.getActivations('persona')) {
      try {
        const identifier = activation.filename || activation.name;
        const result = await personaManager.activatePersona(identifier);
        if (result.success) {
          restoredCount++;
        } else {
          logger.debug(`[ActivationStore] Pruning missing persona '${activation.name}'`);
          store.removeStaleActivation('persona', activation.name);
          skippedCount++;
        }
      } catch {
        logger.debug(`[ActivationStore] Skipping failed persona '${activation.name}'`);
        store.removeStaleActivation('persona', activation.name);
        skippedCount++;
      }
    }

    // Restore skills
    // NOTE: activateSkill() returns {success, message} — it never throws on not-found.
    for (const activation of store.getActivations('skill')) {
      try {
        const result = await skillManager.activateSkill(activation.name);
        if (result.success) {
          restoredCount++;
        } else {
          logger.debug(`[ActivationStore] Pruning missing skill '${activation.name}'`);
          store.removeStaleActivation('skill', activation.name);
          skippedCount++;
        }
      } catch {
        logger.debug(`[ActivationStore] Skipping failed skill '${activation.name}'`);
        store.removeStaleActivation('skill', activation.name);
        skippedCount++;
      }
    }

    // Restore agents
    for (const activation of store.getActivations('agent')) {
      try {
        const result = await agentManager.activateAgent(activation.name);
        if (result.success) {
          restoredCount++;
        } else {
          logger.debug(`[ActivationStore] Pruning missing agent '${activation.name}'`);
          store.removeStaleActivation('agent', activation.name);
          skippedCount++;
        }
      } catch {
        logger.debug(`[ActivationStore] Skipping failed agent '${activation.name}'`);
        store.removeStaleActivation('agent', activation.name);
        skippedCount++;
      }
    }

    // Restore memories (dedup against auto-loaded ones)
    const activeMemories = await memoryManager.getActiveMemories();
    const activeMemoryNames = new Set(activeMemories.map(m => m.metadata.name));
    for (const activation of store.getActivations('memory')) {
      if (activeMemoryNames.has(activation.name)) {
        logger.debug(`[ActivationStore] Memory '${activation.name}' already active (auto-loaded), skipping`);
        continue;
      }
      try {
        const result = await memoryManager.activateMemory(activation.name);
        if (result.success) {
          restoredCount++;
        } else {
          logger.debug(`[ActivationStore] Pruning missing memory '${activation.name}'`);
          store.removeStaleActivation('memory', activation.name);
          skippedCount++;
        }
      } catch {
        logger.debug(`[ActivationStore] Skipping failed memory '${activation.name}'`);
        store.removeStaleActivation('memory', activation.name);
        skippedCount++;
      }
    }

    // Restore ensembles
    for (const activation of store.getActivations('ensemble')) {
      try {
        const result = await ensembleManager.activateEnsemble(activation.name);
        if (result.success) {
          restoredCount++;
        } else {
          logger.debug(`[ActivationStore] Pruning missing ensemble '${activation.name}'`);
          store.removeStaleActivation('ensemble', activation.name);
          skippedCount++;
        }
      } catch {
        logger.debug(`[ActivationStore] Skipping failed ensemble '${activation.name}'`);
        store.removeStaleActivation('ensemble', activation.name);
        skippedCount++;
      }
    }

    if (restoredCount > 0 || skippedCount > 0) {
      logger.info(
        `[ActivationStore] Restored ${restoredCount} element(s), skipped ${skippedCount} stale for session '${store.getSessionId()}'`
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

    PathValidator.initialize(this.personasDir);

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
      this.resolve('ActivationStore'),
      this.resolve('BackupService'),
      this.resolve('PolicyExportService')
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
      this.resolve('PortfolioRepoManager')
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
      indicatorService
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
    const gatekeeper = new Gatekeeper(undefined, {
      enableAuditLogging: true,
      requireDangerZoneVerification: true,
      allowElementPolicyOverrides: env.DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES,
    });

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
      verificationStore: this.resolve('VerificationStore'),  // Issue #142: Verification codes
      verificationNotifier: this.resolve('VerificationNotifier'),  // Issue #522: OS dialog for codes
      memorySink: this.resolve<MemoryLogSink>('MemoryLogSink'),  // Issue #528: CRUDE-routed query_logs
      performanceMonitor: this.resolve<PerformanceMonitor>('PerformanceMonitor'),
      operationMetricsTracker: this.resolve<OperationMetricsTracker>('OperationMetricsTracker'),
      gatekeeperMetricsTracker: this.resolve<GatekeeperMetricsTracker>('GatekeeperMetricsTracker'),
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

    // Register tools based on MCP_INTERFACE_MODE (Issue #237)
    // - 'discrete': Register individual discrete tools (~40 tools)
    // - 'mcpaql': Register consolidated MCP-AQL interface only (~4 or 1 tools)
    // Token counts are logged dynamically at startup via logToolTokenStats()
    const interfaceMode = env.MCP_INTERFACE_MODE;
    logger.info(`MCP Interface Mode: ${interfaceMode}`);

    if (interfaceMode === 'discrete') {
      // Discrete mode: Register all individual tools
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
      // MCP-AQL mode: Register only MCP-AQL tools
      toolRegistry.registerMCPAQLTools(bundle.mcpAqlHandler);
    }

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
      if (typeof instance.dispose === 'function') {
        promises.push({ name, promise: Promise.resolve().then(() => instance.dispose()) });
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
