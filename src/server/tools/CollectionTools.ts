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
        description: "Browse content from the DollhouseMCP collection by section and content type. Content types include personas (AI behavioral profiles), skills, agents, and templates. When users ask for 'personas', they're referring to content in the personas type.",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "Collection section to browse (library, showcase, catalog). Leave empty to see all sections.",
            },
            type: {
              type: "string",
              description: "Content type within the library section: personas, skills, agents, or templates. Only used when section is 'library'.",
            },
          },
        },
      },
      handler: (args: any) => server.browseCollection(args?.section, args?.type)
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
        name: "search_collection_enhanced",
        description: "Enhanced search for collection content with pagination, filtering, and sorting. Use this for advanced searches when users need specific content types or want to browse results in pages.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for finding content. Examples: 'creative writer', 'explain like I'm five', 'coding assistant'.",
            },
            elementType: {
              type: "string",
              description: "Filter by content type: personas, skills, agents, templates, tools, ensembles, memories, prompts",
              enum: ["personas", "skills", "agents", "templates", "tools", "ensembles", "memories", "prompts"]
            },
            category: {
              type: "string",
              description: "Filter by category: creative, professional, educational, personal, gaming",
              enum: ["creative", "professional", "educational", "personal", "gaming"]
            },
            page: {
              type: "number",
              description: "Page number for paginated results (default: 1)",
              minimum: 1
            },
            pageSize: {
              type: "number", 
              description: "Number of results per page (default: 25, max: 100)",
              minimum: 1,
              maximum: 100
            },
            sortBy: {
              type: "string",
              description: "Sort results by relevance, name, or date",
              enum: ["relevance", "name", "date"]
            }
          },
          required: ["query"],
        },
      },
      handler: (args: any) => server.searchCollectionEnhanced(args.query, {
        elementType: args.elementType,
        category: args.category,
        page: args.page,
        pageSize: args.pageSize,
        sortBy: args.sortBy
      })
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
              description: "The collection path to the AI customization element. Format: 'library/[type]/[element].md' where type is personas, skills, templates, or agents. Example: 'library/skills/code-review.md'.",
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
        description: "Install AI customization elements from the collection to your local portfolio. Use this when users ask to download/install any element type (personas, skills, templates, or agents). Examples: 'install the creative writer persona', 'get the code review skill', 'download the meeting notes template'.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the AI customization element. Format: 'library/[type]/[element].md' where type is personas, skills, templates, or agents. Example: 'library/skills/code-review.md'.",
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
    },
    {
      tool: {
        name: "get_collection_cache_health",
        description: "Get health status and statistics for the collection cache system. This helps monitor cache performance and identify any issues with offline browsing capability.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      handler: () => server.getCollectionCacheHealth()
    }
  ];

  // PERFORMANCE FIX #548: Removed deprecated marketplace aliases
  // These duplicated existing collection tools and increased MCP overhead
  // Users should migrate to: browse_collection, search_collection, 
  // get_collection_content, install_content, submit_content
  
  return tools;
}