/**
 * Server setup and initialization
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from './tools/ToolRegistry.js';
import { getPersonaTools } from './tools/PersonaTools.js';
import { getMarketplaceTools } from './tools/MarketplaceTools.js';
import { getUserTools } from './tools/UserTools.js';
import { getUpdateTools } from './tools/UpdateTools.js';
import { getConfigTools } from './tools/ConfigTools.js';
import { IToolHandler } from './types.js';

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
    // Register persona tools
    this.toolRegistry.registerMany(getPersonaTools(instance));
    
    // Register marketplace tools
    this.toolRegistry.registerMany(getMarketplaceTools(instance));
    
    // Register user tools
    this.toolRegistry.registerMany(getUserTools(instance));
    
    // Register update tools
    this.toolRegistry.registerMany(getUpdateTools(instance));
    
    // Register config tools
    this.toolRegistry.registerMany(getConfigTools(instance));
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
        
        return await handler(args);
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
   * Get the tool registry
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}