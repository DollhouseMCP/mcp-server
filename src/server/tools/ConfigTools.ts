/**
 * Configuration-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { DollhouseMCPServer } from '../../index.js';

export function getConfigTools(server: DollhouseMCPServer): Array<{ tool: ToolDefinition; handler: any }> {
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
    }
  ];
}