/**
 * Marketplace-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getMarketplaceTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "browse_marketplace",
        description: "Browse content from the DollhouseMCP marketplace by section and category",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "Marketplace section to browse (library, showcase, catalog). Leave empty to see all sections.",
            },
            category: {
              type: "string",
              description: "Category within the section. For library: personas, skills, agents, prompts, templates, tools, ensembles",
            },
          },
        },
      },
      handler: (args: any) => server.browseMarketplace(args?.section, args?.category)
    },
    {
      tool: {
        name: "search_marketplace",
        description: "Search for content in the marketplace by keywords",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for finding content (personas, skills, agents, etc.)",
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