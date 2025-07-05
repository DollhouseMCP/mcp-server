/**
 * Persona-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getPersonaTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "list_personas",
        description: "List all available personas",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.listPersonas()
    },
    {
      tool: {
        name: "activate_persona",
        description: "Activate a specific persona by name or filename",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to activate",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.activatePersona(args.persona)
    },
    {
      tool: {
        name: "get_active_persona",
        description: "Get information about the currently active persona",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getActivePersona()
    },
    {
      tool: {
        name: "deactivate_persona",
        description: "Deactivate the current persona",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.deactivatePersona()
    },
    {
      tool: {
        name: "get_persona_details",
        description: "Get detailed information about a specific persona",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to get details for",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.getPersonaDetails(args.persona)
    },
    {
      tool: {
        name: "reload_personas",
        description: "Reload all personas from the personas directory",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.reloadPersonas()
    },
    {
      tool: {
        name: "create_persona",
        description: "Create a new persona with guided assistance",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The display name for the persona",
            },
            description: {
              type: "string",
              description: "A brief description of the persona",
            },
            category: {
              type: "string",
              description: "Category: creative, professional, educational, gaming, or personal",
            },
            instructions: {
              type: "string",
              description: "The main instructions/prompt for the persona",
            },
            triggers: {
              type: "string",
              description: "Comma-separated list of trigger words (optional)",
            },
          },
          required: ["name", "description", "category", "instructions"],
        },
      },
      handler: (args: any) => server.createPersona(
        args.name,
        args.description,
        args.category,
        args.instructions,
        args.triggers
      )
    },
    {
      tool: {
        name: "edit_persona",
        description: "Edit an existing persona's properties",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to edit",
            },
            field: {
              type: "string",
              description: "Field to edit: name, description, instructions, triggers, category, version, or metadata fields",
            },
            value: {
              type: "string",
              description: "The new value for the field",
            },
          },
          required: ["persona", "field", "value"],
        },
      },
      handler: (args: any) => server.editPersona(args.persona, args.field, args.value)
    },
    {
      tool: {
        name: "validate_persona",
        description: "Validate a persona's format and provide quality feedback",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to validate",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.validatePersona(args.persona)
    }
  ];
}