/**
 * User identity-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getUserTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "set_user_identity",
        description: "Set your username for persona attribution and collection participation",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Your username (alphanumeric, hyphens, underscores, dots)",
            },
            email: {
              type: "string",
              description: "Your email address (optional)",
            },
          },
          required: ["username"],
        },
      },
      handler: (args: any) => server.setUserIdentity(args.username, args?.email)
    },
    {
      tool: {
        name: "get_user_identity",
        description: "Get current user identity information",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getUserIdentity()
    },
    {
      tool: {
        name: "clear_user_identity",
        description: "Clear user identity and return to anonymous mode",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.clearUserIdentity()
    }
  ];
}