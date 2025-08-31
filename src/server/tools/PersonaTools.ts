/**
 * Persona export/import tool definitions and handlers
 * Note: Core persona management functionality (list, activate, create, edit, etc.) 
 * is now available through the generic element tools (list_elements, activate_element, etc.)
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getPersonaExportImportTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
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
    }
  ];
}