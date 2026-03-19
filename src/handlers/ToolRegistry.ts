/**
 * Tool Registry for managing MCP tool definitions and handlers
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition, ToolHandler } from "./types/ToolTypes.js";
import { getAuthTools } from "../server/tools/AuthTools.js";
import { getCollectionTools } from "../server/tools/CollectionTools.js";
import { getConfigToolsV2 } from "../server/tools/ConfigToolsV2.js";
import { getElementTools } from "../server/tools/ElementTools.js";
import { getEnhancedIndexTools } from "../server/tools/EnhancedIndexTools.js";
import type { IndexConfiguration } from "../portfolio/config/IndexConfig.js";
import { getBuildInfoTools } from "../server/tools/BuildInfoTools.js";
import type { BuildInfoService } from "../services/BuildInfoService.js";
import { getPersonaExportImportTools } from "../server/tools/PersonaTools.js";
import { getPortfolioTools } from "../server/tools/PortfolioTools.js";
import { getMCPAQLTools } from "../server/tools/MCPAQLTools.js";
import type { PersonaHandler } from './PersonaHandler.js';
import type { ElementCRUDHandler } from './ElementCRUDHandler.js';
import type { CollectionHandler } from './CollectionHandler.js';
import type { PortfolioHandler } from './PortfolioHandler.js';
import type { GitHubAuthHandler } from './GitHubAuthHandler.js';
import type { ConfigHandler } from './ConfigHandler.js';
import type { SyncHandler } from './SyncHandlerV2.js';
import type { EnhancedIndexHandler } from './EnhancedIndexHandler.js';
import type { MCPAQLHandler } from './mcp-aql/MCPAQLHandler.js';

// Re-export types for backward compatibility
export type { ToolDefinition, ToolHandler };

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  constructor(_server: Server) {}

  /**
   * Register a tool with its definition and handler
   */
  register(tool: ToolDefinition, handler?: ToolHandler): void {
    if (handler) {
      tool.handler = handler;
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once
   */
  registerMany(tools: Array<{ tool: ToolDefinition; handler?: ToolHandler }>): void {
    tools.forEach(({ tool, handler }) => this.register(tool, handler));
  }

  registerPersonaTools(handler: PersonaHandler): void {
    this.registerMany(getPersonaExportImportTools(handler));
  }

  registerElementTools(handler: ElementCRUDHandler): void {
    this.registerMany(getElementTools(handler));
  }

  registerCollectionTools(handler: CollectionHandler): void {
    this.registerMany(getCollectionTools(handler));
  }

  registerPortfolioTools(handler: PortfolioHandler): void {
    this.registerMany(getPortfolioTools(handler));
  }

  registerAuthTools(handler: GitHubAuthHandler): void {
    this.registerMany(getAuthTools(handler));
  }

  registerConfigTools(handler: {
    handleConfigOperation: ConfigHandler['handleConfigOperation'];
    handleSyncOperation: SyncHandler['handleSyncOperation'];
  }): void {
    this.registerMany(getConfigToolsV2(handler));
  }

  registerEnhancedIndexTools(handler: EnhancedIndexHandler, config: IndexConfiguration): void {
    this.registerMany(getEnhancedIndexTools(handler, config));
  }

  registerBuildInfoTools(buildInfoService: BuildInfoService): void {
    this.registerMany(getBuildInfoTools(buildInfoService));
  }

  registerMCPAQLTools(handler: MCPAQLHandler): void {
    this.registerMany(getMCPAQLTools(handler));
  }

  /**
   * Get all registered tools (for ListToolsRequest)
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map(({ handler, ...tool }) => tool);
  }

  /**
   * Get a specific tool handler
   */
  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the count of registered tools
   */
  getToolCount(): number {
    return this.tools.size;
  }

  /**
   * Estimate the token count for all registered tools.
   *
   * This provides an approximate token count based on the JSON representation
   * of all tool definitions (name, description, inputSchema, annotations).
   *
   * Token estimation uses ~4 characters per token, which is appropriate for
   * JSON/structured content. This matches the ratio used by tokenizers like
   * cl100k_base for structured text.
   *
   * @returns Estimated total token count for all registered tools
   */
  getToolTokenEstimate(): number {
    const tools = this.getAllTools();

    // Serialize tools to JSON for token estimation
    const toolsJson = JSON.stringify(tools, null, 0);

    // Use ~4 characters per token (appropriate for JSON/structured content)
    // This is more accurate than word-based estimation for schema definitions
    return Math.ceil(toolsJson.length / 4);
  }

  /**
   * Get detailed token statistics for registered tools.
   * Returns individual tool token estimates plus total.
   */
  getToolTokenStats(): {
    tools: Array<{ name: string; tokens: number }>;
    total: number;
    count: number;
  } {
    const tools = this.getAllTools();
    const toolStats = tools.map(tool => ({
      name: tool.name,
      tokens: Math.ceil(JSON.stringify(tool).length / 4)
    }));

    return {
      tools: toolStats,
      total: toolStats.reduce((sum, t) => sum + t.tokens, 0),
      count: tools.length
    };
  }
}
