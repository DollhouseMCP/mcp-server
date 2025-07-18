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
        description: "Browse content from the DollhouseMCP collection by section and category",
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
        description: "Search for content in the collection by keywords",
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
      handler: (args: any) => server.searchCollection(args.query)
    },
    {
      tool: {
        name: "get_collection_content",
        description: "Get detailed information about content from the collection",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the content (e.g., 'library/personas/creative/storyteller_20250701_alice.md')",
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
        description: "Install content from the collection to your local collection",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The collection path to the content (e.g., 'library/personas/creative/storyteller_20250701_alice.md')",
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
        description: "Submit local content to the collection for community review",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content name or filename to submit",
            },
          },
          required: ["content"],
        },
      },
      handler: (args: any) => server.submitContent(args.content)
    }
  ];
}