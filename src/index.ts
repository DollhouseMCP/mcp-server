#!/usr/bin/env node

// Load environment variables from .env files BEFORE anything else
// This ensures .env.local and .env are loaded for all modules
import { env } from './config/env.js';

import * as path from 'path';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorHandler } from "./utils/ErrorHandler.js";
import { logger } from "./utils/logger.js";
import { DollhouseContainer } from "./di/Container.js";
import { ElementType } from "./portfolio/PortfolioManager.js";
import { OperationalTelemetry, StartupTimer } from "./telemetry/index.js";
import { PACKAGE_VERSION } from "./generated/version.js";
import type { IndicatorConfig } from "./config/indicator-config.js";
import type { IToolHandler } from "./server/index.js";
import type { ToolRegistry } from "./handlers/ToolRegistry.js";
import type { PersonaHandler } from "./handlers/PersonaHandler.js";
import type { ElementCRUDHandler } from "./handlers/ElementCRUDHandler.js";
import type { CollectionHandler } from "./handlers/CollectionHandler.js";
import type { PortfolioHandler } from "./handlers/PortfolioHandler.js";
import type { GitHubAuthHandler } from "./handlers/GitHubAuthHandler.js";
import type { DisplayConfigHandler } from "./handlers/DisplayConfigHandler.js";
import type { IdentityHandler } from "./handlers/IdentityHandler.js";
import type { ConfigHandler } from "./handlers/ConfigHandler.js";
import type { SyncHandler } from "./handlers/SyncHandlerV2.js";
import type { EnhancedIndexHandler } from "./handlers/EnhancedIndexHandler.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { FileOperationsService } from "./services/FileOperationsService.js";
import { FileLockManager } from "./security/fileLockManager.js";
import * as os from "os";
import type { EnsembleElement } from "./elements/ensembles/types.js";

// Defensive error handling for npx/CLI execution
process.on('uncaughtException', (error) => {
  logger.error('Unhandled exception detected', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  console.error('[DollhouseMCP] Server startup failed');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection detected', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise
  });
  console.error('[DollhouseMCP] Server startup failed');
  process.exit(1);
});

// Only log execution environment in debug mode
if (process.env.DOLLHOUSE_DEBUG) {
  console.error('[DollhouseMCP] Debug mode enabled');
}

export class DollhouseMCPServer implements IToolHandler {
  private server: Server;
  public personasDir: string | null;
  private currentUser: string | null = null;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private container: DollhouseContainer;
  private toolRegistry?: ToolRegistry;
  private enhancedIndexHandler?: EnhancedIndexHandler;
  private personaHandler?: PersonaHandler;
  private elementCRUDHandler?: ElementCRUDHandler;
  private collectionHandler?: CollectionHandler;
  private portfolioHandler?: PortfolioHandler;
  private githubAuthHandler?: GitHubAuthHandler;
  private displayConfigHandler?: DisplayConfigHandler;
  private identityHandler?: IdentityHandler;
  private configHandler?: ConfigHandler;
  private syncHandler?: SyncHandler;
  private resourceHandler?: import('./handlers/ResourceHandler.js').ResourceHandler;

  /**
   * Create a new DollhouseMCPServer instance
   *
   * @param container DollhouseContainer instance for dependency injection.
   *                  Use `new DollhouseContainer()` for production or
   *                  `createIntegrationContainer().container` for tests.
   */
  constructor(container: DollhouseContainer) {
    // Build capabilities object conditionally based on configuration
    // Resources are disabled by default (advertise_resources: false)
    const capabilities: any = {
      tools: {},
    };

    // Check if resources should be advertised
    // This is a future-proof implementation - resources are opt-in
    try {
      // Initialize ConfigManager to check resource settings
      // Note: Config may not be fully initialized yet, so we check synchronously
      // If config is not initialized, defaults (advertise_resources: false) apply
      const fileLockManager = new FileLockManager();
      const fileOperations = new FileOperationsService(fileLockManager);
      const configManager = new ConfigManager(fileOperations, os);
      const resourcesConfig = configManager.getSetting<any>('elements.enhanced_index.resources');

      if (resourcesConfig?.advertise_resources === true) {
        capabilities.resources = {};
        logger.info('[DollhouseMCP] MCP Resources capability advertised (enabled via config)');
      } else {
        logger.info('[DollhouseMCP] MCP Resources capability NOT advertised (disabled by default)');
      }
    } catch (error) {
      // Config not initialized yet - use safe default (no resources)
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug(`[DollhouseMCP] Config not initialized yet, resources capability disabled by default: ${errorMessage}`);
    }

    this.server = new Server(
      {
        name: "dollhousemcp",
        version: PACKAGE_VERSION,
      },
      {
        capabilities,
      }
    );

    this.personasDir = null;
    this.currentUser = process.env.DOLLHOUSE_USER || null;
    this.container = container;
  }
  
  private async initializePortfolio(): Promise<void> {
    await this.container.preparePortfolio();
    this.personasDir = this.container.getPersonasDir();
  }
  
  /**
   * Complete initialization after portfolio is ready
   * FIX #610: This was previously in a .then() callback in the constructor
   * Now called synchronously from run() to prevent race condition
   */
  private async completeInitialization(): Promise<void> {
    // Create handlers with server instance - all state managed by services
    const handlers = await this.container.createHandlers(this.server);

    this.personaHandler = handlers.personaHandler;
    this.elementCRUDHandler = handlers.elementCrudHandler;
    this.collectionHandler = handlers.collectionHandler;
    this.portfolioHandler = handlers.portfolioHandler;
    this.githubAuthHandler = handlers.githubAuthHandler;
    this.displayConfigHandler = handlers.displayConfigHandler;
    this.identityHandler = handlers.identityHandler;
    this.configHandler = handlers.configHandler;
    this.syncHandler = handlers.syncHandler;
    this.toolRegistry = handlers.toolRegistry;
    this.enhancedIndexHandler = handlers.enhancedIndexHandler;

    // Initialize and register resource handlers
    // Resources are disabled by default and require explicit configuration
    await this.initializeResourceHandlers();

    this.isInitialized = true;
  }

  /**
   * Initialize MCP Resources handlers if enabled in configuration
   * This is separate from other handlers because it requires dynamic import
   * and conditional registration based on configuration
   */
  private async initializeResourceHandlers(): Promise<void> {
    try {
      const { ResourceHandler } = await import('./handlers/ResourceHandler.js');
      const configManager = this.container.resolve<ConfigManager>('ConfigManager');

      this.resourceHandler = new ResourceHandler(configManager);
      await this.resourceHandler.initialize(this.server);
    } catch (error) {
      // Resources are optional - don't fail server startup if they can't be initialized
      logger.warn('[DollhouseMCP] Failed to initialize resource handlers, continuing without resources');
      logger.debug(`Resource initialization error: ${error}`);
    }
  }
  
  /**
   * Ensure server is initialized before any operation
   * FIX #610: Added for test compatibility - tests don't call run()
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    
    // If initialization is already in progress, wait for it
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }
    
    // Start initialization
    this.initializationPromise = (async () => {
      try {
        await this.initializePortfolio();
        await this.completeInitialization();
        logger.info("Portfolio and personas initialized successfully (lazy)");
      } catch (error) {
        ErrorHandler.logError('DollhouseMCPServer.ensureInitialized', error);
        throw error;
      }
    })();
    
    await this.initializationPromise;
  }
  
  // Tool handler methods - now public for access from tool modules
  
  async listPersonas() {
    await this.ensureInitialized();
    return this.personaHandler!.listPersonas();
  }

  // Use activateElement(name, 'persona'), deactivateElement(name, 'persona'),
  // getActiveElements('persona'), and getElementDetails(name, 'persona') instead.
  // These were removed to normalize persona handling through the generic element API.

  async reloadPersonas() {
    await this.ensureInitialized();
    return this.personaHandler!.reloadPersonas();
  }

  // ===== Element Methods (Generic for all element types) =====
  
  async listElements(type: string) {
    try {
      const normalizedType = this.elementCRUDHandler!.normalizeElementType(type);
      if (normalizedType === ElementType.PERSONA) {
        return this.listPersonas();
      }
      return this.elementCRUDHandler!.listElements(normalizedType);
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.listElements', error, { type });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to list ${type}: ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async activateElement(name: string, type: string, context?: Record<string, any>) {
    try {
      // FIX: Issue #281 - Route all element types through elementCRUDHandler
      // PersonaHandler.activatePersona is deprecated; PersonaActivationStrategy handles personas
      const normalizedType = this.elementCRUDHandler!.normalizeElementType(type);
      return this.elementCRUDHandler!.activateElement(name, normalizedType, context);
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.activateElement', error, { type, name });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to activate ${type} '${name}': ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async getActiveElements(type: string) {
    try {
      // FIX: Issue #281 - Route all element types through elementCRUDHandler
      // PersonaHandler.getActivePersona is deprecated; PersonaActivationStrategy handles personas
      const normalizedType = this.elementCRUDHandler!.normalizeElementType(type);
      return this.elementCRUDHandler!.getActiveElements(normalizedType);
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.getActiveElements', error, { type });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get active ${type}: ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async deactivateElement(name: string, type: string) {
    try {
      // FIX: Issue #281 - Route all element types through elementCRUDHandler
      // PersonaHandler.deactivatePersona is deprecated; PersonaActivationStrategy handles personas
      const normalizedType = this.elementCRUDHandler!.normalizeElementType(type);
      return this.elementCRUDHandler!.deactivateElement(name, normalizedType);
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.deactivateElement', error, { type, name });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to deactivate ${type} '${name}': ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async getElementDetails(name: string, type: string) {
    // FIX: Issue #276 - Route all element types through elementCRUDHandler for consistent error handling
    // PersonaHandler.getPersonaDetails is deprecated; PersonaActivationStrategy handles personas
    const normalizedType = this.elementCRUDHandler!.normalizeElementType(type);
    return this.elementCRUDHandler!.getElementDetails(name, normalizedType);
  }
  
  async reloadElements(type: string) {
    await this.ensureInitialized();
    return this.elementCRUDHandler!.reloadElements(type);
  }

  // Element-specific methods
  async renderTemplate(name: string, variables: Record<string, any>) {
    await this.ensureInitialized();
    return this.elementCRUDHandler!.renderTemplate(name, variables);
  }

  async executeAgent(name: string, parameters: Record<string, any>) {
    await this.ensureInitialized();
    return this.elementCRUDHandler!.executeAgent(name, parameters);
  }
  
  /**
   * Create a new element in the portfolio.
   * @param args.elements - For ensembles: array of element references (Issue #278)
   */
  async createElement(args: {name: string; type: string; description: string; content?: string; instructions?: string; metadata?: Record<string, unknown>; elements?: EnsembleElement[]}) {
    await this.ensureInitialized();
    // FIX: Issue #20 - Remove persona special case, route all element creation through ElementCRUDHandler
    // This ensures consistent duplicate checking and error handling for all element types
    // FIX: Issue #278 - Support elements parameter for ensembles
    const normalizedType = this.elementCRUDHandler!.normalizeElementType(args.type);
    return this.elementCRUDHandler!.createElement({...args, type: normalizedType});
  }

  async editElement(args: {name: string; type: string; input: Record<string, unknown>}) {
    await this.ensureInitialized();
    // FIX: Issue #276 - Route all element types through elementCRUDHandler for consistent error handling
    // PersonaHandler.editPersona is deprecated; elementCRUDHandler handles personas via PersonaActivationStrategy
    const normalizedType = this.elementCRUDHandler!.normalizeElementType(args.type);
    return this.elementCRUDHandler!.editElement({...args, type: normalizedType});
  }

  async validateElement(args: {name: string; type: string; strict?: boolean}) {
    await this.ensureInitialized();
    // FIX: Issue #276 - Route all element types through elementCRUDHandler for consistent error handling
    // PersonaHandler.validatePersona is deprecated; elementCRUDHandler handles personas
    const normalizedType = this.elementCRUDHandler!.normalizeElementType(args.type);
    return this.elementCRUDHandler!.validateElement({...args, type: normalizedType});
  }

  async deleteElement(args: {name: string; type: string; deleteData?: boolean}) {
    await this.ensureInitialized();
    // FIX: Issue #276 - Route all element types through elementCRUDHandler for consistent error handling
    // PersonaHandler.deletePersona is deprecated; elementCRUDHandler handles personas via dedicated delete path
    const normalizedType = this.elementCRUDHandler!.normalizeElementType(args.type);
    return this.elementCRUDHandler!.deleteElement({...args, type: normalizedType});
  }

  async browseCollection(section?: string, type?: string) {
    await this.ensureInitialized();
    return this.collectionHandler!.browseCollection(section, type);
  }

  async searchCollection(query: string) {
    await this.ensureInitialized();
    return this.collectionHandler!.searchCollection(query);
  }

  async searchCollectionEnhanced(query: string, options: any = {}) {
    await this.ensureInitialized();
    return this.collectionHandler!.searchCollectionEnhanced(query, options);
  }

  async getCollectionContent(path: string) {
    await this.ensureInitialized();
    return this.collectionHandler!.getCollectionContent(path);
  }

  async installContent(inputPath: string) {
    await this.ensureInitialized();
    return this.collectionHandler!.installContent(inputPath);
  }

  async submitContent(contentIdentifier: string) {
    await this.ensureInitialized();
    return this.collectionHandler!.submitContent(contentIdentifier);
  }

  async getCollectionCacheHealth() {
    await this.ensureInitialized();
    return this.collectionHandler!.getCollectionCacheHealth();
  }

  // User identity management - delegated to IdentityHandler
  async setUserIdentity(username: string, email?: string) {
    await this.ensureInitialized();
    return this.identityHandler!.setUserIdentity(username, email);
  }

  async getUserIdentity() {
    await this.ensureInitialized();
    return this.identityHandler!.getUserIdentity();
  }

  async clearUserIdentity() {
    await this.ensureInitialized();
    return this.identityHandler!.clearUserIdentity();
  }

  private getCurrentUserForAttribution(): string {
    return this.identityHandler!.getCurrentUserForAttribution();
  }

  // GitHub authentication management
  async setupGitHubAuth() {
    await this.ensureInitialized();
    return this.githubAuthHandler!.setupGitHubAuth();
  }
  
  async checkGitHubAuth() {
    await this.ensureInitialized();
    return this.githubAuthHandler!.checkGitHubAuth();
  }
  
  async getOAuthHelperStatus(verbose: boolean = false) {
    await this.ensureInitialized();
    return this.githubAuthHandler!.getOAuthHelperStatus(verbose);
  }
  

  
  async clearGitHubAuth() {
    await this.ensureInitialized();
    return this.githubAuthHandler!.clearGitHubAuth();
  }

  // OAuth configuration management
  async configureOAuth(client_id?: string) {
    await this.ensureInitialized();
    return this.githubAuthHandler!.configureOAuth(client_id);
  }










  /**
   * Configure indicator settings (delegated to DisplayConfigHandler)
   */
  async configureIndicator(config: Partial<IndicatorConfig>) {
    await this.ensureInitialized();
    return this.displayConfigHandler!.configureIndicator(config);
  }

  /**
   * Get current indicator configuration (delegated to DisplayConfigHandler)
   */
  async getIndicatorConfig() {
    await this.ensureInitialized();
    return this.displayConfigHandler!.getIndicatorConfig();
  }

  /**
   * Configure collection submission settings (delegated to CollectionHandler)
   */
  async configureCollectionSubmission(autoSubmit: boolean) {
    await this.ensureInitialized();
    return this.collectionHandler!.configureCollectionSubmission(autoSubmit);
  }

  /**
   * Get collection submission configuration (delegated to CollectionHandler)
   */
  async getCollectionSubmissionConfig() {
    await this.ensureInitialized();
    return this.collectionHandler!.getCollectionSubmissionConfig();
  }


  /**
   * Export a single persona
   */
  async exportPersona(personaName: string) {
    await this.ensureInitialized();
    return this.personaHandler!.exportPersona(personaName);
  }

  /**
   * Export all personas
   */
  async exportAllPersonas(includeDefaults = true) {
    await this.ensureInitialized();
    return this.personaHandler!.exportAllPersonas(includeDefaults);
  }

  /**
   * Import a persona
   */
  async importPersona(source: string, overwrite = false) {
    await this.ensureInitialized();
    return this.personaHandler!.importPersona(source, overwrite);
  }


  /**
   * Portfolio management methods
   */

  /**
   * Check portfolio status including repository existence and sync information
   */
  async portfolioStatus(username?: string) {
    await this.ensureInitialized();
    return this.portfolioHandler!.portfolioStatus(username);
  }

  /**
   * Initialize a new GitHub portfolio repository
   */
  async initPortfolio(options: {repositoryName?: string; private?: boolean; description?: string}) {
    await this.ensureInitialized();
    return this.portfolioHandler!.initPortfolio(options);
  }

  /**
   * Configure portfolio settings
   */
  async portfolioConfig(options: {autoSync?: boolean; defaultVisibility?: string; autoSubmit?: boolean; repositoryName?: string}) {
    await this.ensureInitialized();
    return this.portfolioHandler!.portfolioConfig(options);
  }

  /**
   * Sync portfolio with GitHub
   */
  async syncPortfolio(options: {
    direction: string;
    mode?: string;
    force: boolean;
    dryRun: boolean;
    confirmDeletions?: boolean;
  }) {
    await this.ensureInitialized();
    return this.portfolioHandler!.syncPortfolio(options);
  }

  /**
   * Handle configuration operations - delegates to ConfigHandler
  */
  async handleConfigOperation(options: any) {
    await this.ensureInitialized();
    return this.configHandler!.handleConfigOperation(options);
  }

  /**
   * Handle sync operations - delegates to SyncHandler
   */
  async handleSyncOperation(options: any) {
    await this.ensureInitialized();
    return this.syncHandler!.handleSyncOperation(options);
  }

  async dispose(): Promise<void> {
    await this.container.dispose();
  }

  /**
   * Search local portfolio using the metadata index system
   * This provides fast, comprehensive search across all element types
   */
  async searchPortfolio(options: {
    query: string; 
    elementType?: string; 
    fuzzyMatch?: boolean; 
    maxResults?: number; 
    includeKeywords?: boolean; 
    includeTags?: boolean; 
    includeTriggers?: boolean; 
    includeDescriptions?: boolean;
  }) {
    await this.ensureInitialized();
    return this.portfolioHandler!.searchPortfolio(options);
  }

  /**
   * Search across all sources (local, GitHub, collection) using UnifiedIndexManager
   * This provides comprehensive search with duplicate detection and version comparison
   */
  async searchAll(options: {
    query: string;
    sources?: string[];
    elementType?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
  }) {
    await this.ensureInitialized();
    return this.portfolioHandler!.searchAll(options);
  }

  /**
   * Find semantically similar elements using Enhanced Index
   */
  async findSimilarElements(options: {
    elementName: string;
    elementType?: string;
    limit: number;
    threshold: number;
  }) {
    return this.enhancedIndexHandler!.findSimilarElements(options);
  }

  /**
   * Get all relationships for a specific element
   */
  async getElementRelationships(options: {
    elementName: string;
    elementType?: string;
    relationshipTypes?: string[];
  }) {
    return this.enhancedIndexHandler!.getElementRelationships(options);
  }

  /**
   * Search for elements by action verb
   */
  async searchByVerb(options: {
    verb: string;
    limit: number;
  }) {
    return this.enhancedIndexHandler!.searchByVerb(options);
  }

  /**
   * Get statistics about Enhanced Index relationships
   */
  async getRelationshipStats() {
    return this.enhancedIndexHandler!.getRelationshipStats();
  }

  async run() {
    logger.debug("DollhouseMCPServer.run() started");
    logger.info("Starting DollhouseMCP server...");

    const timer = this.container.resolve<StartupTimer>('StartupTimer');

    // Issue #706: Critical path only — get to connect() as fast as possible
    // Non-critical work (memory auto-load, activation restore, etc.) is
    // deferred to completeDeferredSetup() which runs post-connect.
    try {
      timer.startPhase('portfolio_prepare', true);
      await this.initializePortfolio();
      timer.endPhase('portfolio_prepare');

      timer.startPhase('handler_creation', true);
      await this.completeInitialization();
      timer.endPhase('handler_creation');

      // Initialize operational telemetry (async, non-blocking, never throws)
      const operationalTelemetry = this.container.resolve<OperationalTelemetry>('OperationalTelemetry');
      operationalTelemetry.initialize().catch(() => {
        // Telemetry errors are logged internally, safe to ignore here
      });

      logger.info("Portfolio and personas initialized successfully");

      if (!env.DOLLHOUSE_GATEKEEPER_ENABLED) {
        logger.warn("⚠️  Gatekeeper is DISABLED (DOLLHOUSE_GATEKEEPER_ENABLED=false). All permission checks are bypassed.");
      }

      logger.info("DollhouseMCP server ready - waiting for MCP connection on stdio");
      logger.debug("DollhouseMCPServer.run() completed initialization");
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.run.initialization', error);
      throw error; // Re-throw to prevent server from starting with incomplete initialization
    }

    const transport = new StdioServerTransport();

    // Set up graceful shutdown handlers
    const cleanup = async () => {
      logger.info("Shutting down DollhouseMCP server...");

      try {
        await this.container.dispose();
        logger.info("Cleanup completed");
      } catch (error) {
        logger.error("Error during cleanup", { error });
      }

      process.exit(0);
    };

    // Register shutdown handlers
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);

    // Connect ASAP — tools are registered, server can accept requests
    timer.startPhase('mcp_connect', true);
    await this.server.connect(transport);
    timer.endPhase('mcp_connect');
    timer.markConnect();

    // Mark that MCP is now connected - no more console output allowed
    logger.setMCPConnected();

    // Issue #706 Phase 3: Emit READY sentinel for bridge clients
    process.stderr.write('DOLLHOUSEMCP_READY\n');

    logger.info("DollhouseMCP server running on stdio");

    // Issue #706 Phase 2: Deferred setup — runs post-connect, non-blocking
    // Pattern encryption, background validator, memory auto-load, activation
    // restore, log hooks, danger zone init all move here.
    const deferredPromise = this.container.completeDeferredSetup();
    deferredPromise.catch(err => logger.warn('[Startup] Deferred setup error:', err));

    // Issue #706 Phase 4: Wire deferred promise into ServerSetup for request buffering
    const serverSetup = this.container.resolve<import('./server/ServerSetup.js').ServerSetup>('ServerSetup');
    serverSetup.setDeferredSetupPromise(deferredPromise);

    // Log startup timing after deferred setup completes
    deferredPromise.then(async () => {
      const report = timer.getReport();
      logger.info(`[Startup] Full report: connect at ${report.connectAtMs}ms, ` +
        `critical ${report.criticalPathMs}ms, deferred ${report.deferredMs}ms, ` +
        `total ${report.totalMs}ms`);
    }).catch(() => { /* already logged */ });

  }
}

// Export is already at class declaration

// Only start the server if this file is being run directly (not imported by tests)
// Handle different execution methods (direct, npx, CLI)
const scriptPath = process.argv?.[1] ? path.normalize(process.argv[1]) : '';
const isDirectExecution =
  scriptPath.endsWith(`${path.sep}dist${path.sep}index.js`) ||
  scriptPath.endsWith(`${path.sep}src${path.sep}index.ts`);
const isNpxExecution = process.env.npm_execpath?.includes('npx');
const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp');
const isTest = process.env.JEST_WORKER_ID; // This is set when Jest runs tests
const isTestMode = process.env.TEST_MODE === 'true'; // Check for TEST_MODE environment variable
const dollhouseDebugFlag = process.env.DOLLHOUSE_DEBUG?.toLowerCase();
const isDebugStartupLogging = dollhouseDebugFlag === 'true' || dollhouseDebugFlag === '1';

// Progressive startup with retries for npx/CLI execution
const STARTUP_DELAYS = [10, 50, 100, 200]; // Progressive delays in ms

async function startServerWithRetry(retriesLeft = STARTUP_DELAYS.length): Promise<void> {
  if (isDebugStartupLogging) {
    console.error("DEBUG: startServerWithRetry called.");
  }
  try {
    const container = new DollhouseContainer();
    const server = new DollhouseMCPServer(container);
    await server.run();
  } catch (error) {
    if (retriesLeft > 0 && (isNpxExecution || isCliExecution)) {
      // Try again with a longer delay
      const delayIndex = STARTUP_DELAYS.length - retriesLeft;
      const delay = STARTUP_DELAYS[delayIndex];
      await new Promise(resolve => setTimeout(resolve, delay));
      return startServerWithRetry(retriesLeft - 1);
    }
    // Final failure - minimal error message for security
    // Note: Using console.error here is intentional as it's the final error before exit
    console.error("[DollhouseMCP] Server startup failed", error); // Added error object
    process.exit(1);
  }
}

if ((isDirectExecution || isNpxExecution || isCliExecution) && (!isTest || isTestMode)) {
  // Issue #704: --web flag starts the portfolio web UI instead of MCP server
  const isWebMode = process.argv.includes('--web');
  if (isWebMode) {
    // Issue #796: Bootstrap DI container for web-only mode so API routes
    // go through MCPAQLHandler (validated, cached, gatekeeper-checked)
    //
    // Suppress terminal output in --web mode unless DOLLHOUSE_DEBUG is set.
    // All logs are still captured in MemoryLogSink and visible in the Logs tab —
    // the terminal only needs the console URL banner, not a wall of startup noise.
    if (!process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG) {
      logger.setMinLevel('error');
    }

    (async () => {
      const portfolioDir = path.join(os.homedir(), '.dollhouse', 'portfolio');
      const portArg = process.argv.find(a => a.startsWith('--port='));
      const port = portArg ? parseInt(portArg.split('=')[1], 10) : undefined;
      const noBrowser = process.argv.includes('--no-open');

      let mcpAqlHandler;
      let memorySink: import('./logging/sinks/MemoryLogSink.js').MemoryLogSink | undefined;
      let metricsSink: import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink | undefined;
      try {
        const container = new DollhouseContainer();
        await container.preparePortfolio();
        const bundle = await container.bootstrapHandlers();
        await container.completeDeferredSetup();
        mcpAqlHandler = bundle.mcpAqlHandler;
        // Extract sinks from container — deferred setup may have already wired them
        try { memorySink = container.resolve<import('./logging/sinks/MemoryLogSink.js').MemoryLogSink>('MemoryLogSink'); } catch { /* not registered */ }
        try { metricsSink = container.resolve<import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink>('MemoryMetricsSink'); } catch { /* not registered */ }
      } catch (err) {
        console.error("[DollhouseMCP] Container bootstrap failed — web routes will use direct filesystem access.");
        console.error("[DollhouseMCP] Reason:", (err as Error).message || err);
        console.error("[DollhouseMCP] This may indicate a corrupt portfolio or missing dependencies.");
      }

      // Ensure sinks exist even if container bootstrap failed —
      // standalone --web mode still needs working logs and metrics tabs
      if (!memorySink) {
        const { MemoryLogSink } = await import('./logging/sinks/MemoryLogSink.js');
        memorySink = new MemoryLogSink({
          appCapacity: 10000,
          securityCapacity: 5000,
          perfCapacity: 2000,
          telemetryCapacity: 1000,
        });
      }
      if (!metricsSink) {
        const { MemoryMetricsSink } = await import('./metrics/sinks/MemoryMetricsSink.js');
        metricsSink = new MemoryMetricsSink(240);
      }

      // Set up ingest routes so --web mode has a session registry (#1805).
      // Without this, the session indicator is always empty in standalone mode.
      const { createIngestRoutes } = await import('./web/console/IngestRoutes.js');
      const ingestResult = createIngestRoutes({
        logBroadcast: (entry) => { /* wired after server starts */ },
      });
      ingestResult.registerConsoleSession();

      // Initialize console token store so Auth tab routes mount (#1825).
      // Mirrors UnifiedConsole.ts:startAsLeader() — without this,
      // /api/console/totp and /api/console/token return 404.
      const { ConsoleTokenStore } = await import('./web/console/consoleToken.js');
      const { pickRandomPuppetName } = await import('./web/console/SessionNames.js');
      const tokenStore = new ConsoleTokenStore(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
      try {
        await tokenStore.ensureInitialized(pickRandomPuppetName());
      } catch (err) {
        console.error('[DollhouseMCP] Failed to initialize console token store — Auth tab will be non-functional', err);
      }

      const { startWebServer } = await import('./web/server.js');
      await startWebServer({ portfolioDir, port, openBrowser: !noBrowser, mcpAqlHandler, memorySink, metricsSink, additionalRouters: [ingestResult.router], tokenStore });

      // Listen for quit commands on stdin (standalone --web mode only).
      // In MCP stdio mode, stdin is consumed by the JSON-RPC transport.
      if (process.stdin.isTTY) {
        process.stdin.setEncoding('utf-8');
        process.stdin.resume();
        let quitDebounce: ReturnType<typeof setTimeout> | null = null;
        process.stdin.on('data', (data: string) => {
          const cmd = data.trim().toLowerCase();
          if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
            // Debounce rapid inputs (e.g., accidental double-tap)
            if (quitDebounce) return;
            quitDebounce = setTimeout(() => { quitDebounce = null; }, 200);
            console.error('\n  Shutting down DollhouseMCP...\n');
            process.exit(0);
          }
        });
      }
    })().catch(err => {
      console.error("[DollhouseMCP] Web UI failed to start:", err);
      process.exit(1);
    });
  } else {
    if (isDebugStartupLogging) {
      console.error("DEBUG: Server startup condition met. Calling startServerWithRetry.");
    }
    startServerWithRetry().catch(() => {
      // Note: Using console.error here is intentional as it's the final error before exit
      console.error("[DollhouseMCP] Server startup failed");
      process.exit(1);
    });
  }
}
