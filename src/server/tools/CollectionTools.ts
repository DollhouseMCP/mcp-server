/**
 * Collection-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getCollectionTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "browse_collection",
        description: "Browse content from the DollhouseMCP collection by section and content type. Content types include personas (AI behavioral profiles), skills, agents, prompts, templates, tools, and ensembles. When users ask for 'personas', they're referring to content in the personas type.",
        inputSchema: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "Collection section to browse (library, showcase, catalog). Leave empty to see all sections.",
            },
            type: {
              type: "string",
              description: "Content type within the library section: personas, skills, agents, prompts, templates, tools, or ensembles. Only used when section is 'library'.",
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
        name: "get_collection_content",
        description: "Get detailed information about content from the collection. Use this when users ask to 'see details about a persona' or 'show me the creative writer persona'. Personas are a type of content that defines AI behavioral profiles.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the AI customization element. Format: 'library/[type]/[element].md' where type is personas, skills, templates, agents, memories, or ensembles. Example: 'library/skills/code-review.md'.",
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
        description: "Install AI customization elements from the collection to your local portfolio. Use this when users ask to download/install any element type (personas, skills, templates, agents, memories, or ensembles). Examples: 'install the creative writer persona', 'get the code review skill', 'download the meeting notes template'.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the AI customization element. Format: 'library/[type]/[element].md' where type is personas, skills, templates, agents, memories, or ensembles. Example: 'library/skills/code-review.md'.",
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
}