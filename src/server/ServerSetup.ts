/**
 * Server setup and initialization
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from './tools/ToolRegistry.js';
import { getPersonaTools } from './tools/PersonaTools.js';
import { getElementTools } from './tools/ElementTools.js';
import { getCollectionTools } from './tools/CollectionTools.js';
import { getUserTools } from './tools/UserTools.js';
import { getUpdateTools } from './tools/UpdateTools.js';
import { getConfigTools } from './tools/ConfigTools.js';
import { getAuthTools } from './tools/AuthTools.js';
import { getPortfolioTools } from './tools/PortfolioTools.js';
import { getBuildInfoTools } from './tools/BuildInfoTools.js';
import { IToolHandler } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from '../utils/logger.js';

export class ServerSetup {
  private toolRegistry: ToolRegistry;
  
  constructor() {
    this.toolRegistry = new ToolRegistry();
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
   * Register all tool categories
   */
  private registerTools(instance: IToolHandler): void {
    // Register element tools (new generic tools for all element types)
    this.toolRegistry.registerMany(getElementTools(instance));
    
    // Register persona tools (legacy - kept for backward compatibility)
    this.toolRegistry.registerMany(getPersonaTools(instance));
    
    // Register collection tools
    this.toolRegistry.registerMany(getCollectionTools(instance));
    
    // Register user tools
    this.toolRegistry.registerMany(getUserTools(instance));
    
    // Register auth tools
    this.toolRegistry.registerMany(getAuthTools(instance));
    
    // Register portfolio tools
    this.toolRegistry.registerMany(getPortfolioTools(instance));
    
    // Register update tools
    this.toolRegistry.registerMany(getUpdateTools(instance));
    
    // Register config tools
    this.toolRegistry.registerMany(getConfigTools(instance));
    
    // Register build info tools
    this.toolRegistry.registerMany(getBuildInfoTools(instance));
  }
  
  /**
   * Setup the ListToolsRequest handler
   */
  private setupListToolsHandler(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.toolRegistry.getAllTools()
      };
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
}