/**
 * Update/maintenance-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { DollhouseMCPServer } from '../../index.js';

export function getUpdateTools(server: DollhouseMCPServer): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "check_for_updates",
        description: "Check if a newer version of DollhouseMCP is available",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.checkForUpdates()
    },
    {
      tool: {
        name: "update_server",
        description: "Update DollhouseMCP to the latest version from GitHub",
        inputSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Confirm the update (true to proceed, false for preview)",
            },
          },
          required: ["confirm"],
        },
      },
      handler: (args: any) => server.updateServer(args.confirm)
    },
    {
      tool: {
        name: "rollback_update",
        description: "Rollback to the previous version from backup",
        inputSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Confirm the rollback (true to proceed, false for info)",
            },
          },
          required: ["confirm"],
        },
      },
      handler: (args: any) => server.rollbackUpdate(args.confirm)
    },
    {
      tool: {
        name: "get_server_status",
        description: "Get current server status, version, and system information",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getServerStatus()
    }
  ];
}