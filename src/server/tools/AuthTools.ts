/**
 * Authentication-related tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

export function getAuthTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "setup_github_auth",
        description: "Set up GitHub authentication to access all DollhouseMCP features. This uses GitHub's secure device flow - no passwords needed! Use this when users say things like 'connect to GitHub', 'set up GitHub', 'I have a GitHub account now', or when they try to submit content without authentication.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      handler: () => server.setupGitHubAuth()
    },
    {
      tool: {
        name: "check_github_auth", 
        description: "Check current GitHub authentication status. Shows whether you're connected to GitHub, your username, and what actions are available. Use when users ask 'am I connected to GitHub?', 'what's my GitHub status?', or similar questions.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      handler: () => server.checkGitHubAuth()
    },
    {
      tool: {
        name: "clear_github_auth",
        description: "Remove GitHub authentication and disconnect from GitHub. Use when users say 'disconnect from GitHub', 'remove my GitHub connection', 'clear authentication', or want to switch accounts.",
        inputSchema: {
          type: "object", 
          properties: {}
        }
      },
      handler: () => server.clearGitHubAuth()
    },
    {
      tool: {
        name: "configure_oauth",
        description: "Configure GitHub OAuth client ID for authentication. If no client_id provided, shows current configuration status. If client_id provided, validates format and saves it to config. Use when users need to set up OAuth or check their configuration.",
        inputSchema: {
          type: "object",
          properties: {
            client_id: {
              type: "string",
              description: "GitHub OAuth client ID (starts with 'Ov23li' followed by at least 14 alphanumeric characters)"
            }
          }
        }
      },
      handler: (args: { client_id?: string }) => server.configureOAuth(args.client_id)
    }
  ];
}