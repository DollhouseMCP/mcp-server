/**
 * Marketplace-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { DollhouseMCPServer } from '../../index.js';

export function getMarketplaceTools(server: DollhouseMCPServer): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "browse_marketplace",
        description: "Browse personas from the DollhouseMCP marketplace by category",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Category to browse (creative, professional, educational, gaming, personal)",
            },
          },
        },
      },
      handler: (args: any) => server.browseMarketplace(args?.category)
    },
    {
      tool: {
        name: "search_marketplace",
        description: "Search for personas in the marketplace by keywords",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for finding personas",
            },
          },
          required: ["query"],
        },
      },
      handler: (args: any) => server.searchMarketplace(args.query)
    },
    {
      tool: {
        name: "get_marketplace_persona",
        description: "Get detailed information about a persona from the marketplace",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The marketplace path to the persona (e.g., 'creative/storyteller_20250701_alice.md')",
            },
          },
          required: ["path"],
        },
      },
      handler: (args: any) => server.getMarketplacePersona(args.path)
    },
    {
      tool: {
        name: "install_persona",
        description: "Install a persona from the marketplace to your local collection",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The marketplace path to the persona (e.g., 'creative/storyteller_20250701_alice.md')",
            },
          },
          required: ["path"],
        },
      },
      handler: (args: any) => server.installPersona(args.path)
    },
    {
      tool: {
        name: "submit_persona",
        description: "Submit a local persona to the marketplace for community review",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to submit",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.submitPersona(args.persona)
    }
  ];
}