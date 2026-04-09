#!/usr/bin/env node

// Load environment variables from .env files BEFORE anything else
// This ensures .env.local and .env are loaded for all modules
import { env } from './config/env.js';

import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express, Request, Response } from "express";
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

type RuntimeTransportName = 'stdio' | 'streamable-http';
type DeferredSetupMode = 'full' | 'sink-only' | 'none';

interface AttachTransportOptions {
  transportName: RuntimeTransportName;
  deferredSetupMode: DeferredSetupMode;
  emitReadySentinel?: boolean;
  suppressConsoleLoggingAfterConnect?: boolean;
}

interface StreamableHttpRuntimeOptions {
  host?: string;
  port?: number;
  mcpPath?: string;
  allowedHosts?: string[];
  registerSignalHandlers?: boolean;
}

export interface StreamableHttpRuntimeHandle {
  app: Express;
  host: string;
  port: number;
  mcpPath: string;
  url: string;
  httpServer: HttpServer;
  close(): Promise<void>;
  activeSessionCount(): number;
}

interface StreamableHttpSession {
  server: DollhouseMCPServer;
  transport: StreamableHTTPServerTransport;
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

  private getTransportDisplayName(transportName: RuntimeTransportName): string {
    return transportName === 'stdio' ? 'stdio' : 'Streamable HTTP';
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

  private async initializeRuntime(transportName: RuntimeTransportName): Promise<void> {
    logger.debug("DollhouseMCPServer.initializeRuntime() started");
    logger.info(`Starting DollhouseMCP server for ${this.getTransportDisplayName(transportName)}...`);

    if (this.isInitialized) {
      return;
    }

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

      logger.info(`DollhouseMCP server ready - waiting for MCP connection on ${this.getTransportDisplayName(transportName)}`);
      logger.debug("DollhouseMCPServer.initializeRuntime() completed initialization");
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.initializeRuntime', error);
      throw error; // Re-throw to prevent server from starting with incomplete initialization
    }
  }

  private startDeferredSetup(mode: DeferredSetupMode): void {
    if (mode === 'none') {
      return;
    }

    const timer = this.container.resolve<StartupTimer>('StartupTimer');
    const deferredPromise = mode === 'full'
      ? this.container.completeDeferredSetup()
      : this.container.completeSinkSetup();

    deferredPromise.catch(err => logger.warn('[Startup] Deferred setup error:', err));

    const serverSetup = this.container.resolve<import('./server/ServerSetup.js').ServerSetup>('ServerSetup');
    serverSetup.setDeferredSetupPromise(deferredPromise);

    deferredPromise.then(async () => {
      const report = timer.getReport();
      logger.info(`[Startup] Full report: connect at ${report.connectAtMs}ms, ` +
        `critical ${report.criticalPathMs}ms, deferred ${report.deferredMs}ms, ` +
        `total ${report.totalMs}ms`);
    }).catch(() => { /* already logged */ });
  }

  public async attachTransport(
    transport: Transport,
    options: AttachTransportOptions,
  ): Promise<void> {
    await this.initializeRuntime(options.transportName);

    const timer = this.container.resolve<StartupTimer>('StartupTimer');

    // Connect ASAP — tools are registered, server can accept requests
    timer.startPhase('mcp_connect', true);
    await this.server.connect(transport);
    timer.endPhase('mcp_connect');
    timer.markConnect();

    if (options.suppressConsoleLoggingAfterConnect) {
      // In stdio mode, stdout/stderr must stay clean after connect.
      logger.setMCPConnected();
    }

    if (options.emitReadySentinel) {
      // Issue #706 Phase 3: Emit READY sentinel for bridge clients
      process.stderr.write('DOLLHOUSEMCP_READY\n');
    }

    logger.info(`DollhouseMCP server running on ${this.getTransportDisplayName(options.transportName)}`);
    this.startDeferredSetup(options.deferredSetupMode);
  }

  async run() {
    logger.debug("DollhouseMCPServer.run() started");

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

    await this.attachTransport(transport, {
      transportName: 'stdio',
      deferredSetupMode: 'full',
      emitReadySentinel: true,
      suppressConsoleLoggingAfterConnect: true,
    });
  }
}

function parseCommaSeparatedValues(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function normalizeMcpPath(rawPath: string | undefined): string {
  if (!rawPath || rawPath === '/') {
    return '/mcp';
  }

  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function getCliFlagValue(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function getRequestedTransportName(): RuntimeTransportName {
  if (process.argv.includes('--streamable-http') || process.argv.includes('--http')) {
    return 'streamable-http';
  }

  return env.DOLLHOUSE_TRANSPORT;
}

function getMcpSessionId(req: Request): string | undefined {
  const headerValue = req.headers['mcp-session-id'];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

function respondWithJsonRpcError(
  res: Response,
  statusCode: number,
  message: string,
  requestId: unknown = null,
): void {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: requestId,
  });
}

function getStreamableHttpRuntimeOptions(): StreamableHttpRuntimeOptions {
  const portFlag = getCliFlagValue('port');
  const hostFlag = getCliFlagValue('host');
  const pathFlag = getCliFlagValue('mcp-path');
  const allowedHostsFlag = getCliFlagValue('allowed-hosts');
  const parsedPort = portFlag !== undefined ? Number.parseInt(portFlag, 10) : undefined;

  return {
    host: hostFlag ?? env.DOLLHOUSE_HTTP_HOST,
    port: Number.isFinite(parsedPort) ? parsedPort : env.DOLLHOUSE_HTTP_PORT,
    mcpPath: normalizeMcpPath(pathFlag ?? env.DOLLHOUSE_HTTP_MCP_PATH),
    allowedHosts: parseCommaSeparatedValues(allowedHostsFlag) ?? env.DOLLHOUSE_HTTP_ALLOWED_HOSTS,
  };
}

export async function startStreamableHttpServer(
  options: StreamableHttpRuntimeOptions = {},
): Promise<StreamableHttpRuntimeHandle> {
  const host = options.host ?? env.DOLLHOUSE_HTTP_HOST;
  const port = options.port ?? env.DOLLHOUSE_HTTP_PORT;
  const mcpPath = normalizeMcpPath(options.mcpPath ?? env.DOLLHOUSE_HTTP_MCP_PATH);
  const allowedHosts = options.allowedHosts ?? env.DOLLHOUSE_HTTP_ALLOWED_HOSTS;
  const app = createMcpExpressApp({ host, allowedHosts });
  const sessions = new Map<string, StreamableHttpSession>();
  let closingPromise: Promise<void> | null = null;

  const disposeSession = async (sessionId: string | undefined): Promise<void> => {
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    try {
      await session.server.dispose();
    } catch (error) {
      logger.warn('[StreamableHTTP] Failed to dispose session server', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const createSession = async (): Promise<StreamableHttpSession> => {
    const sessionServer = new DollhouseMCPServer(new DollhouseContainer());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server: sessionServer, transport });
        logger.info('[StreamableHTTP] Session initialized', { sessionId });
      },
    });

    transport.onerror = (error) => {
      logger.warn('[StreamableHTTP] Transport error', {
        sessionId: transport.sessionId,
        error: error.message,
      });
    };

    transport.onclose = () => {
      void disposeSession(transport.sessionId);
    };

    try {
      await sessionServer.attachTransport(transport, {
        transportName: 'streamable-http',
        deferredSetupMode: 'sink-only',
      });
      return { server: sessionServer, transport };
    } catch (error) {
      await sessionServer.dispose().catch(() => {});
      throw error;
    }
  };

  app.get('/', (_req, res) => {
    res.json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
      transport: 'streamable-http',
      mcpPath,
      health: '/healthz',
      readiness: '/readyz',
    });
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      transport: 'streamable-http',
      version: PACKAGE_VERSION,
    });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({
      ready: true,
      transport: 'streamable-http',
      activeSessions: sessions.size,
    });
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
    });
  });

  app.post(mcpPath, async (req, res) => {
    if (closingPromise) {
      respondWithJsonRpcError(res, 503, 'Server shutting down');
      return;
    }

    const sessionId = getMcpSessionId(req);

    try {
      if (sessionId) {
        const existingSession = sessions.get(sessionId);
        if (!existingSession) {
          respondWithJsonRpcError(res, 404, 'Unknown MCP session', (req.body as { id?: unknown })?.id ?? null);
          return;
        }

        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        respondWithJsonRpcError(res, 400, 'Initialization request required before session use');
        return;
      }

      const session = await createSession();
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('[StreamableHTTP] Failed to handle MCP POST request', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!res.headersSent) {
        respondWithJsonRpcError(res, 500, 'Internal server error', (req.body as { id?: unknown })?.id ?? null);
      }
    }
  });

  const handleSessionLifecycleRequest = async (
    req: Request,
    res: Response,
    methodName: 'GET' | 'DELETE',
  ): Promise<void> => {
    const sessionId = getMcpSessionId(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      res.status(400).json({ error: 'A valid mcp-session-id header is required.' });
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error(`[StreamableHTTP] Failed to handle MCP ${methodName} request`, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  app.get(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'GET'));

  app.delete(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'DELETE'));

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });

  const address = httpServer.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  const url = `http://${host}:${resolvedPort}${mcpPath}`;

  logger.info('[StreamableHTTP] Hosted MCP server listening', {
    host,
    port: resolvedPort,
    mcpPath,
    allowedHosts,
  });

  const shutdown = async (): Promise<void> => {
    if (closingPromise) {
      return closingPromise;
    }

    closingPromise = (async () => {
      const allSessions = Array.from(sessions.values());
      sessions.clear();

      for (const session of allSessions) {
        try {
          await session.transport.close();
        } catch {
          /* transport shutdown is best-effort */
        }

        try {
          await session.server.dispose();
        } catch {
          /* server shutdown is best-effort */
        }
      }

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    })();

    return closingPromise;
  };

  let removeSignalHandlers = () => {};
  if (options.registerSignalHandlers) {
    const handleSignal = (signal: NodeJS.Signals) => {
      logger.info(`[StreamableHTTP] Received ${signal}, shutting down...`);
      shutdown()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error('[DollhouseMCP] Streamable HTTP shutdown failed:', error);
          process.exit(1);
        });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.on('SIGHUP', handleSignal);

    removeSignalHandlers = () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('SIGHUP', handleSignal);
    };
  }

  return {
    app,
    host,
    port: resolvedPort,
    mcpPath,
    url,
    httpServer,
    activeSessionCount: () => sessions.size,
    close: async () => {
      removeSignalHandlers();
      await shutdown();
    },
  };
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
      // CLI flag parsed early; config file resolved after container bootstrap (#1840)
      const portArg = process.argv.find(a => a.startsWith('--port='));
      const cliPort = portArg ? Number.parseInt(portArg.split('=')[1], 10) : undefined;
      const noBrowser = process.argv.includes('--no-open');

      // Pre-flight: kill any stale DollhouseMCP process squatting on our port
      // BEFORE any container/server setup. This is the definitive fix for #1850 —
      // clear the port first, then start cleanly.
      // Race condition note: a new process could grab the port between kill and
      // our bind, but recoverStalePort's TOCTOU mitigation (500ms lock file
      // re-read) and bindAndListen's own recovery handle that edge case.
      const targetPort = cliPort || env.DOLLHOUSE_WEB_CONSOLE_PORT;
      try {
        const { recoverStalePort } = await import('./web/console/StaleProcessRecovery.js');
        const recovered = await recoverStalePort(targetPort);
        if (recovered) {
          console.error(`  Cleared stale process from port ${targetPort}\n`);
        }
      } catch (err) {
        // Non-fatal — bindAndListen will handle EADDRINUSE as a fallback.
        // Log so operators can diagnose recovery failures.
        console.error(`[DollhouseMCP] Pre-flight port recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      let mcpAqlHandler;
      let memorySink: import('./logging/sinks/MemoryLogSink.js').MemoryLogSink | undefined;
      let metricsSink: import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink | undefined;
      try {
        const container = new DollhouseContainer();
        await container.preparePortfolio();
        const bundle = await container.bootstrapHandlers();

        // Wire sinks, hooks, collectors, and security — skip only leader election
        // and permission server. Standalone --web mode IS the server (#1866).
        await container.completeSinkSetup();

        // Sweep stale port files (normally done in completeConsoleSetup)
        try {
          const { sweepStalePortFiles } = await import('./web/portDiscovery.js');
          await sweepStalePortFiles();
        } catch { /* non-fatal */ }

        mcpAqlHandler = bundle.mcpAqlHandler;
        try { memorySink = container.resolve<import('./logging/sinks/MemoryLogSink.js').MemoryLogSink>('MemoryLogSink'); } catch { /* not registered */ }
        try { metricsSink = container.resolve<import('./metrics/sinks/MemoryMetricsSink.js').MemoryMetricsSink>('MemoryMetricsSink'); } catch { /* not registered */ }
      } catch (err) {
        console.error("[DollhouseMCP] Container bootstrap failed — web routes will use direct filesystem access.");
        console.error("[DollhouseMCP] Reason:", (err as Error).message || err);
        console.error("[DollhouseMCP] This may indicate a corrupt portfolio or missing dependencies.");
      }

      // Fallback sinks if container bootstrap failed entirely —
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
        metricsOnSnapshot: (snapshot) => { metricsSink?.onSnapshot(snapshot); },
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

      // Resolve port: CLI flag → config file → env var → default (#1840)
      const resolvedPort = cliPort || await resolvePortFromConfig();

      const { startWebServer } = await import('./web/server.js');
      await startWebServer({ portfolioDir, port: resolvedPort, openBrowser: !noBrowser, mcpAqlHandler, memorySink, metricsSink, additionalRouters: [ingestResult.router], tokenStore });

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
  } else if (getRequestedTransportName() === 'streamable-http') {
    (async () => {
      const runtime = await startStreamableHttpServer({
        ...getStreamableHttpRuntimeOptions(),
        registerSignalHandlers: true,
      });
      console.error(`[DollhouseMCP] Streamable HTTP server listening on ${runtime.url}`);
    })().catch(err => {
      console.error("[DollhouseMCP] Streamable HTTP server failed to start:", err);
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
