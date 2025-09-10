/**
 * Configuration-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getConfigTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "configure_indicator",
        description: "Configure how active persona indicators are displayed",
        inputSchema: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable or disable persona indicators",
            },
            style: {
              type: "string",
              description: "Display style: full, minimal, compact, or custom",
            },
            customFormat: {
              type: "string",
              description: "Custom format string (for style=custom). Use placeholders: {name}, {version}, {author}, {category}",
            },
            includeEmoji: {
              type: "boolean",
              description: "Include emoji in indicator (🎭)",
            },
            includeBrackets: {
              type: "boolean",
              description: "Wrap indicator in brackets",
            },
            includeVersion: {
              type: "boolean",
              description: "Include version in indicator",
            },
            includeAuthor: {
              type: "boolean",
              description: "Include author in indicator",
            },
            includeCategory: {
              type: "boolean",
              description: "Include category in indicator",
            },
          },
        },
      },
      handler: (args: any) => server.configureIndicator(args)
    },
    {
      tool: {
        name: "get_indicator_config",
        description: "Get current persona indicator configuration",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getIndicatorConfig()
    },
    {
      tool: {
        name: "configure_collection_submission",
        description: "Configure automatic collection submission settings. When enabled, the submit_collection_content tool will automatically create a submission issue in the DollhouseMCP collection repository after uploading to your portfolio.",
        inputSchema: {
          type: "object",
          properties: {
            autoSubmit: {
              type: "boolean",
              description: "Enable automatic submission to DollhouseMCP collection after portfolio upload. When false, content is only uploaded to your personal portfolio."
            }
          },
          required: ["autoSubmit"]
        }
      },
      handler: (args: any) => server.configureCollectionSubmission(args.autoSubmit)
    },
    {
      tool: {
        name: "get_collection_submission_config",
        description: "Get current collection submission configuration settings",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      handler: () => server.getCollectionSubmissionConfig()
    }
  ];
}