/**
 * Tool Registry for managing MCP tool definitions and handlers
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolHandler {
  (args: any): Promise<any>;
}

export interface ToolDefinition extends Tool {
  handler?: ToolHandler;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  
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
}