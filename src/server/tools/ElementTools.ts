/**
 * Element-related tool definitions and handlers
 * Provides generic tools that work with all element types
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';
import { ElementType } from '../../portfolio/types.js';

// Type-safe interfaces for all element tool arguments
interface ListElementsArgs {
  type: string;
}

interface ActivateElementArgs {
  name: string;
  type: string;
}

interface DeactivateElementArgs {
  name: string;
  type: string;
}

interface GetElementDetailsArgs {
  name: string;
  type: string;
}

interface GetActiveElementsArgs {
  type: string;
}

interface CreateElementArgs {
  name: string;
  description: string;
  type: string;
  content?: string;
  metadata?: Record<string, any>;
}

interface EditElementArgs {
  name: string;
  type: string;
  field: string;
  value: any;
}

interface ValidateElementArgs {
  name: string;
  type: string;
  strict?: boolean;
}

interface DeleteElementArgs {
  name: string;
  type: string;
  deleteData?: boolean;
}

interface RenderTemplateArgs {
  name: string;
  variables: Record<string, any>;
}

interface ReloadElementsArgs {
  type: string;
}

interface ExecuteAgentArgs {
  name: string;
  goal: string;
}

export function getElementTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "list_elements",
        description: "List all available elements of a specific type",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to list",
              enum: Object.values(ElementType),
            },
          },
          required: ["type"],
        },
      },
      handler: (args: ListElementsArgs) => server.listElements(args.type)
    },
    {
      tool: {
        name: "activate_element",
        description: "Activate a specific element by name",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to activate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: ActivateElementArgs) => server.activateElement(args.name, args.type)
    },
    {
      tool: {
        name: "get_active_elements",
        description: "Get information about currently active elements of a specific type",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to check",
              enum: Object.values(ElementType),
            },
          },
          required: ["type"],
        },
      },
      handler: (args: GetActiveElementsArgs) => server.getActiveElements(args.type)
    },
    {
      tool: {
        name: "deactivate_element",
        description: "Deactivate a specific element",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to deactivate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: DeactivateElementArgs) => server.deactivateElement(args.name, args.type)
    },
    {
      tool: {
        name: "get_element_details",
        description: "Get detailed information about a specific element",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to get details for",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: GetElementDetailsArgs) => server.getElementDetails(args.name, args.type)
    },
    {
      tool: {
        name: "reload_elements",
        description: "Reload elements of a specific type from the filesystem",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to reload",
              enum: Object.values(ElementType),
            },
          },
          required: ["type"],
        },
      },
      handler: (args: ReloadElementsArgs) => server.reloadElements(args.type)
    },
    // Element-specific tools
    {
      tool: {
        name: "render_template",
        description: "Render a template element with provided variables",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The template name to render",
            },
            variables: {
              type: "object",
              description: "Variables to use in the template",
              additionalProperties: true,
            },
          },
          required: ["name", "variables"],
        },
      },
      handler: (args: RenderTemplateArgs) => server.renderTemplate(args.name, args.variables)
    },
    {
      tool: {
        name: "execute_agent",
        description: "Execute an agent element with a specific goal",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The agent name to execute",
            },
            goal: {
              type: "string",
              description: "The goal for the agent to achieve",
            },
          },
          required: ["name", "goal"],
        },
      },
      handler: (args: ExecuteAgentArgs) => server.executeAgent(args.name, args.goal)
    },
    // Generic element creation tool
    {
      tool: {
        name: "create_element",
        description: "Create a new element of any type",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            description: {
              type: "string",
              description: "Element description",
            },
            content: {
              type: "string",
              description: "Element content (required for some types)",
            },
            metadata: {
              type: "object",
              description: "Additional metadata specific to element type",
              additionalProperties: true,
            },
          },
          required: ["name", "type", "description"],
        },
      },
      handler: (args: CreateElementArgs) => server.createElement(args)
    },
    // Generic element editing tool
    {
      tool: {
        name: "edit_element",
        description: "Edit an existing element of any type",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to edit",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            field: {
              type: "string",
              description: "The field to edit (e.g., 'description', 'metadata.author', 'content')",
            },
            value: {
              description: "The new value for the field",
              oneOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "object" },
                { type: "array" },
              ],
            },
          },
          required: ["name", "type", "field", "value"],
        },
      },
      handler: (args: EditElementArgs) => server.editElement(args)
    },
    // Generic element validation tool
    {
      tool: {
        name: "validate_element",
        description: "Validate an element for correctness and best practices",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to validate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            strict: {
              type: "boolean",
              description: "Whether to apply strict validation rules",
              default: false,
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: ValidateElementArgs) => server.validateElement(args)
    },
    // Generic element deletion tool
    {
      tool: {
        name: "delete_element",
        description: "Delete an element and optionally its associated data files",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to delete",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            deleteData: {
              type: "boolean",
              description: "Whether to delete associated data files (if not specified, will prompt)",
              default: undefined,
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: DeleteElementArgs) => server.deleteElement(args)
    },
  ];
}