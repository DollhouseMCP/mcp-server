/**
 * Collection-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getCollectionTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  const tools: Array<{ tool: ToolDefinition; handler: any }> = [
    {
      tool: {
        name: "browse_collection",
        description: "Browse content from the DollhouseMCP collection by section and category. Content types include personas (AI behavioral profiles), skills, agents, prompts, templates, tools, and ensembles. When users ask for 'personas', they're referring to content in the personas category.",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "Collection section to browse (library, showcase, catalog). Leave empty to see all sections.",
            },
            category: {
              type: "string",
              description: "Category within the section. For library: personas, skills, agents, prompts, templates, tools, ensembles",
            },
          },
        },
      },
      handler: (args: any) => server.browseCollection(args?.section, args?.category)
    },
    {
      tool: {
        name: "search_collection",
        description: "Search for content in the collection by keywords. This searches all content types including personas (AI behavioral profiles that users activate to change AI behavior), skills, agents, prompts, etc. When a user asks to 'find a persona', search in the collection.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for finding content. Examples: 'creative writer', 'explain like I'm five', 'coding assistant'. Users typically search for personas by their behavioral traits or names.",
            },
          },
          required: ["query"],
        },
      },
      handler: (args: any) => server.searchCollection(args.query)
    },
    {
      tool: {
        name: "get_collection_content",
        description: "Get detailed information about content from the collection. Use this when users ask to 'see details about a persona' or 'show me the creative writer persona'. Personas are a type of content that defines AI behavioral profiles.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the content. For personas, this will be like 'library/personas/creative/storyteller_20250701_alice.md'. The path indicates the content type (personas, skills, etc.) and category.",
            },
          },
          required: ["path"],
        },
      },
      handler: (args: any) => server.getCollectionContent(args.path)
    },
    {
      tool: {
        name: "install_content",
        description: "Install content from the collection to your local collection. Use this when users ask to 'download a persona', 'install the explain like I'm five persona', or 'get a persona'. Personas are behavioral profiles stored as content in the collection.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the content. For personas, this will be like 'library/personas/creative/storyteller_20250701_alice.md'. The path indicates the content type (personas, skills, etc.) and category.",
            },
          },
          required: ["path"],
        },
      },
      handler: (args: any) => server.installContent(args.path)
    },
    {
      tool: {
        name: "submit_content",
        description: "Submit local content to the collection for community review. Use this when users want to 'share their persona' or 'submit a persona to the collection'. This handles all content types including personas (AI behavioral profiles).",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content name or filename to submit. For personas, use the persona's name (e.g., 'Creative Writer') or filename. The system will recognize it as a persona based on its metadata.",
            },
          },
          required: ["content"],
        },
      },
      handler: (args: any) => server.submitContent(args.content)
    }
  ];

  // Backward compatibility aliases (deprecated)
  // Will be removed in version 2.0.0 (estimated Q2 2025)
  const deprecatedAliases: Array<{ tool: ToolDefinition; handler: any }> = [
    {
      tool: {
        name: "browse_marketplace",
        description: "[DEPRECATED - Use browse_collection] " + tools[0].tool.description + " | Will be removed in v2.0.0",
        inputSchema: { ...tools[0].tool.inputSchema }
      },
      handler: tools[0].handler
    },
    {
      tool: {
        name: "search_marketplace",
        description: "[DEPRECATED - Use search_collection] " + tools[1].tool.description + " | Will be removed in v2.0.0",
        inputSchema: { ...tools[1].tool.inputSchema }
      },
      handler: tools[1].handler
    },
    {
      tool: {
        name: "get_marketplace_persona",
        description: "[DEPRECATED - Use get_collection_content] " + tools[2].tool.description + " | Will be removed in v2.0.0",
        inputSchema: { ...tools[2].tool.inputSchema }
      },
      handler: tools[2].handler
    },
    {
      tool: {
        name: "install_persona",
        description: "[DEPRECATED - Use install_content] " + tools[3].tool.description + " | Will be removed in v2.0.0",
        inputSchema: { ...tools[3].tool.inputSchema }
      },
      handler: tools[3].handler
    },
    {
      tool: {
        name: "submit_persona",
        description: "[DEPRECATED - Use submit_content] " + tools[4].tool.description + " | Will be removed in v2.0.0",
        inputSchema: { ...tools[4].tool.inputSchema }
      },
      handler: tools[4].handler
    }
  ];

  return [...tools, ...deprecatedAliases];
}