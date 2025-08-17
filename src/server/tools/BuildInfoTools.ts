/**
 * Build information tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getBuildInfoTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "get_build_info",
        description: "Get comprehensive build and runtime information about the DollhouseMCP server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getBuildInfo()
    }
  ];
}