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
            instructions: {
              type: "string",
              description: "The main instructions/prompt for the persona",
            },
            triggers: {
              type: "string",
              description: "Comma-separated list of trigger words (optional)",
            },
          },
          required: ["name", "description", "instructions"],
        },
      },
      handler: (args: any) => server.createPersona(
        args.name,
        args.description,
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
    },
    {
      tool: {
        name: "export_persona",
        description: "Export a single persona to a JSON format",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to export",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.exportPersona(args.persona)
    },
    {
      tool: {
        name: "export_all_personas",
        description: "Export all personas to a JSON bundle",
        inputSchema: {
          type: "object",
          properties: {
            includeDefaults: {
              type: "boolean",
              description: "Include default personas in export (default: true)",
            },
          },
        },
      },
      handler: (args: any) => server.exportAllPersonas(args.includeDefaults)
    },
    {
      tool: {
        name: "import_persona",
        description: "Import a persona from a file path or JSON string",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "File path to a .md or .json file, or a JSON string of the persona",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite if persona already exists (default: false)",
            },
          },
          required: ["source"],
        },
      },
      handler: (args: any) => server.importPersona(args.source, args.overwrite)
    },
    {
      tool: {
        name: "share_persona",
        description: "Generate a shareable URL for a persona",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "The persona name or filename to share",
            },
            expiryDays: {
              type: "number",
              description: "Number of days the share link is valid (default: 7)",
            },
          },
          required: ["persona"],
        },
      },
      handler: (args: any) => server.sharePersona(args.persona, args.expiryDays)
    },
    {
      tool: {
        name: "import_from_url",
        description: "Import a persona from a shared URL",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The shared URL to import from",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite if persona already exists (default: false)",
            },
          },
          required: ["url"],
        },
      },
      handler: (args: any) => server.importFromUrl(args.url, args.overwrite)
    }
  ];
}