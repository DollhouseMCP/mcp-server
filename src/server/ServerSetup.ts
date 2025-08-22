/**
 * Server setup and initialization
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from './tools/ToolRegistry.js';
import { getPersonaExportImportTools } from './tools/PersonaTools.js';
import { getElementTools } from './tools/ElementTools.js';
import { getCollectionTools } from './tools/CollectionTools.js';
import { getUserTools } from './tools/UserTools.js';
import { getConfigTools } from './tools/ConfigTools.js';
import { getAuthTools } from './tools/AuthTools.js';
import { getPortfolioTools } from './tools/PortfolioTools.js';
import { getBuildInfoTools } from './tools/BuildInfoTools.js';
import { IToolHandler } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from '../utils/logger.js';
import { ToolDiscoveryCache } from '../utils/ToolCache.js';

export class ServerSetup {
  private toolRegistry: ToolRegistry;
  private toolCache: ToolDiscoveryCache;
  
  constructor() {
    this.toolRegistry = new ToolRegistry();
    this.toolCache = new ToolDiscoveryCache();
  }
  
  /**
   * Initialize the server with all tools and handlers
   */
  setupServer(server: Server, instance: IToolHandler): void {
    // Register all tools
    this.registerTools(instance);
    
    // Setup request handlers
    this.setupListToolsHandler(server);
    this.setupCallToolHandler(server);
  }
  
  /**
   * Register all tool categories and invalidate cache
   */
  private registerTools(instance: IToolHandler): void {
    // Register element tools (new generic tools for all element types)
    this.toolRegistry.registerMany(getElementTools(instance));
    
    // Register persona export/import tools (core functionality moved to element tools)
    this.toolRegistry.registerMany(getPersonaExportImportTools(instance));
    
    // Register collection tools
    this.toolRegistry.registerMany(getCollectionTools(instance));
    
    // Register user tools
    this.toolRegistry.registerMany(getUserTools(instance));
    
    // Register auth tools
    this.toolRegistry.registerMany(getAuthTools(instance));
    
    // Register portfolio tools
    this.toolRegistry.registerMany(getPortfolioTools(instance));
    
    
    // Register config tools
    this.toolRegistry.registerMany(getConfigTools(instance));
    
    // Register build info tools
    this.toolRegistry.registerMany(getBuildInfoTools(instance));
    
    // Invalidate cache since tools have changed
    this.toolCache.invalidateToolList();
    logger.debug('ToolDiscoveryCache: Cache invalidated due to tool registration');
  }
  
  /**
   * Setup the ListToolsRequest handler with caching
   */
  private setupListToolsHandler(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const startTime = Date.now();
      
      // Try to get cached tools first
      let tools = this.toolCache.getToolList();
      
      if (!tools) {
        // Cache miss - fetch tools from registry
        tools = this.toolRegistry.getAllTools();
        
        // Cache the results for future requests
        this.toolCache.setToolList(tools);
        
        const duration = Date.now() - startTime;
        logger.info('ToolDiscoveryCache: Cache miss - fetched and cached tools', {
          toolCount: tools.length,
          duration: `${duration}ms`,
          source: 'registry'
        });
      } else {
        const duration = Date.now() - startTime;
        logger.debug('ToolDiscoveryCache: Cache hit - returned cached tools', {
          toolCount: tools.length,
          duration: `${duration}ms`,
          source: 'cache'
        });
      }
      
      return { tools };
    });
  }
  
  /**
   * Setup the CallToolRequest handler
   */
  private setupCallToolHandler(server: Server): void {
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        const handler = this.toolRegistry.getHandler(name);
        
        if (!handler) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
        }
        
        // Normalize Unicode in all string arguments to prevent security bypasses
        const normalizedArgs = this.normalizeArgumentsUnicode(args, name);
        
        return await handler(normalizedArgs);
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool ${name}: ${error}`
        );
      }
    });
  }
  
  /**
   * Recursively normalize Unicode in all string values within arguments
   */
  private normalizeArgumentsUnicode(args: any, toolName: string): any {
    if (args === null || args === undefined) {
      return args;
    }
    
    if (typeof args === 'string') {
      const result = UnicodeValidator.normalize(args);
      if (result.detectedIssues && result.detectedIssues.length > 0) {
        logger.warn(`Unicode security issues detected in tool ${toolName}:`, {
          issues: result.detectedIssues,
          severity: result.severity
        });
      }
      return result.normalizedContent;
    }
    
    if (Array.isArray(args)) {
      return args.map(item => this.normalizeArgumentsUnicode(item, toolName));
    }
    
    if (typeof args === 'object') {
      const normalized: any = {};
      for (const [key, value] of Object.entries(args)) {
        // Normalize both keys and values to prevent Unicode attacks in property names
        const normalizedKey = typeof key === 'string' ? 
          UnicodeValidator.normalize(key).normalizedContent : key;
        normalized[normalizedKey] = this.normalizeArgumentsUnicode(value, toolName);
      }
      return normalized;
    }
    
    // For non-string primitive types, return as-is
    return args;
  }
  
  /**
   * Get the tool registry
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
  
  /**
   * Get the tool discovery cache
   */
  getToolCache(): ToolDiscoveryCache {
    return this.toolCache;
  }
  
  /**
   * Invalidate the tool discovery cache (useful for external tool changes)
   */
  invalidateToolCache(): void {
    this.toolCache.invalidateToolList();
    logger.info('ToolDiscoveryCache: Cache manually invalidated');
  }
  
  /**
   * Log current cache performance metrics
   */
  logCachePerformance(): void {
    this.toolCache.logPerformance();
  }
}