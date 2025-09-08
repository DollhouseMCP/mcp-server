/**
 * Configuration and sync tool definitions for unified management
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getConfigToolsV2(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "dollhouse_config",
        description: "Manage DollhouseMCP configuration settings. Replaces set_user_identity, get_user_identity, and clear_user_identity tools.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["get", "set", "reset", "export", "import", "wizard"],
              description: "The configuration action to perform"
            },
            setting: {
              type: "string",
              description: "Dot-notation path to setting (e.g., 'user.username', 'sync.enabled'). Required for 'set' action, optional for 'get'."
            },
            value: {
              description: "Value to set (required for 'set' action). Can be string, number, boolean, or object."
            },
            section: {
              type: "string",
              description: "Configuration section to reset (optional for 'reset' action)"
            },
            format: {
              type: "string",
              enum: ["yaml", "json"],
              description: "Export format (default: yaml)"
            },
            data: {
              type: "string",
              description: "Configuration data to import (required for 'import' action)"
            }
          },
          required: ["action"]
        }
      },
      handler: (args: any) => server.handleConfigOperation(args)
    },
    {
      tool: {
        name: "sync_portfolio",
        description: "Sync elements between local portfolio and GitHub repository with privacy controls",
        inputSchema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["list-remote", "download", "upload", "compare", "bulk-download", "bulk-upload"],
              description: "The sync operation to perform"
            },
            element_name: {
              type: "string",
              description: "Name of the element (required for download, upload, compare)"
            },
            element_type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Type of element (required for download, upload, compare)"
            },
            filter: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
                  description: "Filter by element type"
                },
                author: {
                  type: "string",
                  description: "Filter by author username"
                },
                updated_after: {
                  type: "string",
                  description: "Filter by update date (ISO 8601 format)"
                }
              },
              description: "Filters for bulk operations"
            },
            options: {
              type: "object",
              properties: {
                force: {
                  type: "boolean",
                  description: "Force overwrite existing elements"
                },
                dry_run: {
                  type: "boolean",
                  description: "Preview changes without applying them"
                },
                include_private: {
                  type: "boolean",
                  description: "Include elements marked as private/local-only"
                }
              },
              description: "Additional options for the operation"
            }
          },
          required: ["operation"]
        }
      },
      handler: (args: any) => server.handleSyncOperation(args)
    }
  ];
}