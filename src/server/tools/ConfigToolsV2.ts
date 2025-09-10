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
        name: "portfolio_element_manager",
        description: "Manage individual elements between your local portfolio and GitHub repository. USE THIS TO DOWNLOAD/UPLOAD INDIVIDUAL PERSONAS, SKILLS, OR OTHER ELEMENTS! When a user asks to 'download X persona from my GitHub' or 'upload Y skill to GitHub', use this tool. Operations: 'download' (GitHub→local), 'upload' (local→GitHub), 'list-remote' (see what's on GitHub), 'compare' (diff local vs GitHub). FUZZY MATCHING enabled - 'verbose victorian scholar' will find 'Verbose-Victorian-Scholar'. After downloading, use reload_elements then activate_element.",
        inputSchema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["list-remote", "download", "upload", "compare"],
              description: "The operation to perform. 'download' = get from GitHub to local, 'upload' = send from local to GitHub, 'list-remote' = see what's on GitHub, 'compare' = see differences"
            },
            element_name: {
              type: "string",
              description: "Name of the element (required for download, upload, compare). FUZZY MATCHING ENABLED: Just type the name naturally - 'verbose victorian scholar', 'Victorian Scholar', 'verbose-victorian', etc. will all work"
            },
            element_type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Type of element (required for download, upload, compare). For personas use 'personas'"
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
                  description: "Force overwrite existing elements. Use force:true when downloading to skip confirmation prompts"
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
              description: "Additional options. For downloads, use options:{force:true} to skip confirmations"
            }
          },
          required: ["operation"]
        }
      },
      handler: (args: any) => server.handleSyncOperation(args)
    }
  ];
}