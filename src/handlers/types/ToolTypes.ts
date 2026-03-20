/**
 * Shared types for MCP tool definitions and handlers
 *
 * This file contains types used by both ToolRegistry and individual tool files
 * to prevent circular dependencies.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Handler function type for MCP tools
 */
export type ToolHandler = (args: any) => Promise<any>;

/**
 * Extended tool definition that includes the handler function
 */
export interface ToolDefinition extends Tool {
  handler?: ToolHandler;
}

/**
 * Tool registration structure used when registering multiple tools
 */
export interface ToolRegistration {
  tool: ToolDefinition;
  handler?: ToolHandler;
}
