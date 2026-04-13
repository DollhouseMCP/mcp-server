#!/usr/bin/env node

// Load environment variables from .env files BEFORE anything else
// This ensures .env.local and .env are loaded for all modules
import { env } from './config/env.js';

import * as path from 'path';
import { realpathSync } from 'node:fs';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorHandler } from "./utils/ErrorHandler.js";
import { logger } from "./utils/logger.js";
import { DollhouseContainer } from "./di/Container.js";
import {
  createStreamableHttpRuntime,
  getStreamableHttpRuntimeOptions,
  getRequestedTransportName,
  type StreamableHttpRuntimeOptions,
  type StreamableHttpRuntimeHandle,
} from './server/StreamableHttpServer.js';
import { createHttpSession } from './context/HttpSession.js';
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

// Transport-aware error handlers.
// In stdio mode (default): exit on unhandled errors — the process is the session.
// In HTTP mode: log and continue — one session's error must not kill the server
// for all connected clients. Set to true when HTTP transport starts.
let _httpModeActive = false;

/** Check if HTTP mode error handling is active. */
export function isHttpModeActive(): boolean {
  return _httpModeActive;
}

/** Activate HTTP mode error handling. Called by the HTTP transport on startup. */
export function setHttpModeActive(active: boolean): void {
  _httpModeActive = active;
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    transport: _httpModeActive ? 'http' : 'stdio',
  });

  if (_httpModeActive) {
    logger.error('[Lifecycle] Uncaught exception in HTTP mode — server continues serving');
    return;
  }

  console.error('[DollhouseMCP] Fatal error');
  process.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    transport: _httpModeActive ? 'http' : 'stdio',
  });

  if (_httpModeActive) {
    logger.error('[Lifecycle] Unhandled rejection in HTTP mode — server continues serving');
    return;
  }

  console.error('[DollhouseMCP] Fatal error');
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
//
// Bug fix: npx creates symlinks in .bin/ (e.g. .bin/mcp-server → dist/index.js).
// Node.js keeps the symlink path in process.argv[1], so without resolving it,
// isDirectExecution missed the dist/index.js suffix and the server never started.
const rawScriptPath = process.argv?.[1] ?? '';
let scriptPath = rawScriptPath ? path.normalize(rawScriptPath) : '';
try {
  scriptPath = realpathSync(scriptPath);
} catch {
  if (process.env.DOLLHOUSE_DEBUG) {
    console.error(`[DEBUG] Symlink resolution failed for ${rawScriptPath} — using original path`);
  }
}
const isDirectExecution =
  scriptPath.endsWith(`${path.sep}dist${path.sep}index.js`) ||
  scriptPath.endsWith(`${path.sep}src${path.sep}index.ts`);
// Modern npm (v7+) runs npx as "npm exec" — npm_execpath may point to
// npm-cli.js instead of npx-cli.js. Detect both legacy and modern npx.
const isNpxExecution =
  process.env.npm_execpath?.includes('npx') ||
  process.env.npm_command === 'exec';
// Match all registered bin entry names from package.json "bin" field
const binName = path.basename(rawScriptPath);
const isCliExecution = binName === 'dollhousemcp' || binName === 'mcp-server';
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
    console.error("[DollhouseMCP] Server startup failed",
      process.env.DOLLHOUSE_DEBUG ? error : (error as Error).message || 'unknown error');
    process.exit(1);
  }
}

/**
 * Resolve the console port from config file, with range validation.
 * Used by standalone --web mode when no CLI --port flag is provided.
 * Returns undefined if the config file is missing or the port is invalid.
 */
async function resolvePortFromConfig(): Promise<number | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const configPath = path.join(os.homedir(), '.dollhouse', 'config.yml');
    const raw = await readFile(configPath, 'utf8');
    if (raw.length > 64 * 1024) {
      logger.debug('[PortConfig] Config file exceeds 64KB — skipping');
      return undefined;
    }
    const { ConfigManager, validatePort } = await import('./config/ConfigManager.js');
    const configPort = validatePort(ConfigManager.readPortFromYaml(raw));
    if (configPort) {
      logger.debug(`[PortConfig] Resolved port ${configPort} from config file`);
      return configPort;
    }
    logger.debug('[PortConfig] No valid port in config file — using env/default');
    return undefined;
  } catch {
    logger.debug('[PortConfig] Config file not found — using env/default');
    return undefined;
  }
}

/**
 * Bootstrap a shared DollhouseContainer for HTTP mode.
 * Called once at startup — the container is shared across the web console
 * and all HTTP sessions.
 */
async function bootstrapHttpContainer(): Promise<DollhouseContainer> {
  const container = new DollhouseContainer();
  await container.preparePortfolio();
  await container.bootstrapHttpHandlers();
  await container.completeSinkSetup();
  // Mark deferred setup as complete — HTTP mode runs completeSinkSetup()
  // directly (skipping completeConsoleSetup which handles leader election).
  // Without this, BuildInfoService reports "Initializing" indefinitely.
  container.deferredSetupComplete = true;
  return container;
}

/**
 * Start the web console alongside the HTTP transport.
 * Runs on a separate port (DOLLHOUSE_WEB_CONSOLE_PORT, default 41715) and
 * provides the management UI for monitoring HTTP sessions, logs, and metrics.
 *
 * @returns IngestRoutesResult for wiring HTTP session lifecycle into the console
 */
async function startHttpConsole(
  container: DollhouseContainer,
): Promise<import('./web/console/IngestRoutes.js').IngestRoutesResult> {
  const portfolioDir = path.join(os.homedir(), '.dollhouse', 'portfolio');

  // Resolve sinks from the shared container
  let memorySink: import('./logging/sinks/MemoryLogSink.js').MemoryLogSink | undefined;
  let metricsSink: import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink | undefined;
  let logManager: import('./logging/LogManager.js').LogManager | undefined;
  try { memorySink = container.resolve<import('./logging/sinks/MemoryLogSink.js').MemoryLogSink>('MemoryLogSink'); } catch (e) { logger.debug('[HTTP Console] MemoryLogSink not registered, using fallback', { error: (e as Error).message }); }
  try { metricsSink = container.resolve<import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink>('MemoryMetricsSink'); } catch (e) { logger.debug('[HTTP Console] MemoryMetricsSink not registered, using fallback', { error: (e as Error).message }); }
  try { logManager = container.resolve<import('./logging/LogManager.js').LogManager>('LogManager'); } catch (e) { logger.debug('[HTTP Console] LogManager not registered', { error: (e as Error).message }); }

  // Fallback sinks if not available from the container
  if (!memorySink) {
    const { MemoryLogSink } = await import('./logging/sinks/MemoryLogSink.js');
    memorySink = new MemoryLogSink({ appCapacity: 10000, securityCapacity: 5000, perfCapacity: 2000, telemetryCapacity: 1000 });
  }
  if (!metricsSink) {
    const { MemoryMetricsSink } = await import('./metrics/sinks/MemoryMetricsSink.js');
    metricsSink = new MemoryMetricsSink(240);
  }

  // Create ingest routes for session tracking
  const { createIngestRoutes } = await import('./web/console/IngestRoutes.js');
  const ingestResult = createIngestRoutes({
    logBroadcast: (_entry) => { /* wired after web server starts */ },
  });
  ingestResult.registerConsoleSession();

  // Initialize console token store for auth
  const { ConsoleTokenStore } = await import('./web/console/consoleToken.js');
  const { pickRandomTokenName } = await import('./web/console/SessionNames.js');
  const tokenStore = new ConsoleTokenStore(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
  try {
    await tokenStore.ensureInitialized(pickRandomTokenName());
  } catch (err) {
    logger.warn('[HTTP Console] Failed to initialize console token store', err);
  }

  // Resolve web console port
  const resolvedPort = await resolvePortFromConfig() ?? env.DOLLHOUSE_WEB_CONSOLE_PORT;

  // Resolve MCP-AQL handler for gateway routes
  let mcpAqlHandler: import('./handlers/mcp-aql/MCPAQLHandler.js').MCPAQLHandler | undefined;
  try { mcpAqlHandler = container.resolve<import('./handlers/mcp-aql/MCPAQLHandler.js').MCPAQLHandler>('mcpAqlHandler'); } catch (e) { logger.debug('[HTTP Console] MCPAQLHandler not registered', { error: (e as Error).message }); }

  // Start the web server
  const { startWebServer } = await import('./web/server.js');
  const webResult = await startWebServer({
    portfolioDir,
    port: resolvedPort,
    openBrowser: false,
    mcpAqlHandler,
    memorySink,
    metricsSink,
    additionalRouters: [ingestResult.router],
    tokenStore,
  });

  // Wire WebSSELogSink so live log entries reach the browser
  if (webResult.logBroadcast && logManager) {
    const { WebSSELogSink } = await import('./web/sinks/WebSSELogSink.js');
    logManager.registerSink(new WebSSELogSink(webResult.logBroadcast));
  }

  return ingestResult;
}

/**
 * Start DollhouseMCP in Streamable HTTP transport mode.
 *
 * Uses a shared DollhouseContainer for all HTTP sessions. If a web console
 * IngestRoutesResult is provided, HTTP session lifecycle events are forwarded
 * to the console's session registry.
 */
async function startStreamableHttpServer(
  options: StreamableHttpRuntimeOptions = {},
  params?: { container?: DollhouseContainer; ingestRoutes?: import('./web/console/IngestRoutes.js').IngestRoutesResult },
): Promise<StreamableHttpRuntimeHandle> {
  const container = params?.container ?? await bootstrapHttpContainer();
  const ingestRoutes = params?.ingestRoutes;

  // Activate HTTP mode error handling (no process.exit on uncaught exceptions)
  setHttpModeActive(true);

  return createStreamableHttpRuntime(async (transport) => {
    const sessionContext = createHttpSession();
    const { server, dispose: disposeServer } = container.createServerForHttpSession(sessionContext);
    await server.connect(transport);

    logger.info('[HTTP] Session connected', {
      sessionId: sessionContext.sessionId,
      userId: sessionContext.userId,
    });

    return {
      dispose: async () => {
        logger.info('[HTTP] Session disposing', { sessionId: sessionContext.sessionId });
        await disposeServer();
      },
    };
  }, {
    ...options,
    registerSignalHandlers: true,
    onSessionCreated: (sessionId) => {
      ingestRoutes?.registerHttpSession(sessionId, Date.now());
    },
    onSessionDisposed: (sessionId) => {
      ingestRoutes?.deregisterHttpSession(sessionId);
    },
  });
}

/**
 * Bootstrap the DI container for --web standalone mode with graceful
 * degradation. Returns the container and resolved services, or fallback
 * sinks if the container fails to initialize.
 */
async function bootstrapWebContainer(): Promise<{
  container?: DollhouseContainer;
  mcpAqlHandler?: import('./handlers/mcp-aql/MCPAQLHandler.js').MCPAQLHandler;
  memorySink: import('./logging/sinks/MemoryLogSink.js').MemoryLogSink;
  metricsSink: import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink;
  logManager?: import('./logging/LogManager.js').LogManager;
}> {
  let container: DollhouseContainer | undefined;
  let mcpAqlHandler;
  let memorySink: import('./logging/sinks/MemoryLogSink.js').MemoryLogSink | undefined;
  let metricsSink: import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink | undefined;
  let logManager: import('./logging/LogManager.js').LogManager | undefined;

  try {
    container = new DollhouseContainer();
    await container.preparePortfolio();
    const bundle = await container.bootstrapHandlers();
    await container.completeSinkSetup();

    try {
      const { sweepStalePortFiles } = await import('./web/portDiscovery.js');
      await sweepStalePortFiles();
    } catch { /* non-fatal */ }

    mcpAqlHandler = bundle.mcpAqlHandler;
    try { memorySink = container.resolve<import('./logging/sinks/MemoryLogSink.js').MemoryLogSink>('MemoryLogSink'); } catch { /* not registered */ }
    try { metricsSink = container.resolve<import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink>('MemoryMetricsSink'); } catch { /* not registered */ }
    try { logManager = container.resolve<import('./logging/LogManager.js').LogManager>('LogManager'); } catch { /* not registered */ }
  } catch (err) {
    console.error("[DollhouseMCP] Container bootstrap failed — web routes will use direct filesystem access.");
    console.error("[DollhouseMCP] Reason:", (err as Error).message || err);
  }

  // Fallback sinks if container bootstrap failed
  if (!memorySink) {
    const { MemoryLogSink } = await import('./logging/sinks/MemoryLogSink.js');
    memorySink = new MemoryLogSink({ appCapacity: 10000, securityCapacity: 5000, perfCapacity: 2000, telemetryCapacity: 1000 });
  }
  if (!metricsSink) {
    const { MemoryMetricsSink } = await import('./metrics/sinks/MemoryMetricsSink.js');
    metricsSink = new MemoryMetricsSink(240);
    try {
      container?.resolve<{ registerSink: (sink: typeof metricsSink) => void }>('MetricsManager')?.registerSink(metricsSink);
    } catch { /* MetricsManager may be unavailable in degraded startup */ }
  }

  return { container, mcpAqlHandler, memorySink, metricsSink, logManager };
}

/**
 * Listen for quit commands on stdin (standalone --web and HTTP modes).
 * Only active when stdin is a TTY (not piped).
 */
function listenForQuitCommands(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setEncoding('utf-8');
  process.stdin.resume();
  let quitDebounce: ReturnType<typeof setTimeout> | null = null;
  process.stdin.on('data', (data: string) => {
    const cmd = data.trim().toLowerCase();
    if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
      if (quitDebounce) return;
      quitDebounce = setTimeout(() => { quitDebounce = null; }, 200);
      console.error('\n  Shutting down DollhouseMCP...\n');
      process.exit(0);
    }
  });
}

/**
 * Start DollhouseMCP in standalone --web mode.
 * Runs the portfolio web UI without an MCP transport connection.
 */
async function startWebStandaloneMode(): Promise<void> {
  const portfolioDir = path.join(os.homedir(), '.dollhouse', 'portfolio');
  const portArg = process.argv.find(a => a.startsWith('--port='));
  const cliPort = portArg ? Number.parseInt(portArg.split('=')[1], 10) : undefined;
  const noBrowser = process.argv.includes('--no-open');

  // Pre-flight: kill any stale process squatting on our port (#1850)
  const targetPort = cliPort || env.DOLLHOUSE_WEB_CONSOLE_PORT;
  try {
    const { recoverStalePort } = await import('./web/console/StaleProcessRecovery.js');
    if (await recoverStalePort(targetPort)) {
      console.error(`  Cleared stale process from port ${targetPort}\n`);
    }
  } catch (err) {
    console.error(`[DollhouseMCP] Pre-flight port recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { mcpAqlHandler, memorySink, metricsSink, logManager } = await bootstrapWebContainer();

  const { createIngestRoutes } = await import('./web/console/IngestRoutes.js');
  const ingestResult = createIngestRoutes({
    logBroadcast: (_entry) => { /* wired after server starts */ },
    metricsOnSnapshot: (snapshot) => { metricsSink.onSnapshot(snapshot); },
  });
  ingestResult.registerConsoleSession();

  const { ConsoleTokenStore } = await import('./web/console/consoleToken.js');
  const { pickRandomTokenName } = await import('./web/console/SessionNames.js');
  const tokenStore = new ConsoleTokenStore(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
  try {
    await tokenStore.ensureInitialized(pickRandomTokenName());
  } catch (err) {
    console.error('[DollhouseMCP] Failed to initialize console token store — Auth tab will be non-functional', err);
  }

  const resolvedPort = cliPort || await resolvePortFromConfig();
  const { startWebServer } = await import('./web/server.js');
  const webResult = await startWebServer({ portfolioDir, port: resolvedPort, openBrowser: !noBrowser, mcpAqlHandler, memorySink, metricsSink, additionalRouters: [ingestResult.router], tokenStore });

  if (webResult.logBroadcast && logManager) {
    const { WebSSELogSink } = await import('./web/sinks/WebSSELogSink.js');
    logManager.registerSink(new WebSSELogSink(webResult.logBroadcast));
  }

  listenForQuitCommands();
}

/**
 * Start DollhouseMCP in Streamable HTTP mode with optional web console.
 */
async function startHttpMode(): Promise<void> {
  const options = getStreamableHttpRuntimeOptions();
  const container = await bootstrapHttpContainer();

  let ingestRoutes: import('./web/console/IngestRoutes.js').IngestRoutesResult | undefined;
  if (env.DOLLHOUSE_HTTP_WEB_CONSOLE) {
    try {
      ingestRoutes = await startHttpConsole(container);
      console.error(`[DollhouseMCP] Management console at http://127.0.0.1:${env.DOLLHOUSE_WEB_CONSOLE_PORT}`);
    } catch (err) {
      console.error('[DollhouseMCP] Web console failed to start (HTTP transport will continue):', (err as Error).message || err);
    }
  }

  const runtime = await startStreamableHttpServer(options, { container, ingestRoutes });
  console.error(`[DollhouseMCP] Streamable HTTP server listening on ${runtime.url}`);
}

/**
 * Main entry point dispatcher. Selects the startup mode based on CLI flags
 * and environment, then runs the appropriate async startup function.
 */
async function main(): Promise<void> {
  const isWebMode = process.argv.includes('--web');

  if (isWebMode) {
    if (!process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG) {
      logger.setMinLevel('error');
    }
    return startWebStandaloneMode();
  }

  if (getRequestedTransportName() === 'streamable-http') {
    return startHttpMode();
  }

  if (isDebugStartupLogging) {
    console.error("DEBUG: Server startup condition met. Calling startServerWithRetry.");
  }
  return startServerWithRetry();
}

if ((isDirectExecution || isNpxExecution || isCliExecution) && (!isTest || isTestMode)) {
  main().catch(err => { // NOSONAR — top-level await breaks Jest CJS transform; .catch() is required here
    console.error('[DollhouseMCP] Server startup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
