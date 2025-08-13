/**
 * Portfolio management tool definitions and handlers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';

// Portfolio tool argument interfaces
interface PortfolioStatusArgs {
  username?: string;
}

interface InitPortfolioArgs {
  repository_name?: string;
  private?: boolean;
  description?: string;
}

interface PortfolioConfigArgs {
  auto_sync?: boolean;
  default_visibility?: 'public' | 'private';
  auto_submit?: boolean;
  repository_name?: string;
}

interface SyncPortfolioArgs {
  direction?: 'push' | 'pull' | 'both';
  force?: boolean;
  dry_run?: boolean;
}

// Tool handler function type
type ToolHandler<T> = (args: T) => Promise<any>;

export function getPortfolioTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: ToolHandler<any> }> {
  const tools: Array<{ tool: ToolDefinition; handler: ToolHandler<any> }> = [
    {
      tool: {
        name: "portfolio_status",
        description: "Check the status of your GitHub portfolio repository including repository existence, elements count, sync status, and configuration details.",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "GitHub username to check portfolio for. If not provided, uses the authenticated user's username.",
            },
          },
        },
      },
      handler: (args: PortfolioStatusArgs) => server.portfolioStatus(args?.username)
    },
    {
      tool: {
        name: "init_portfolio",
        description: "Initialize a new GitHub portfolio repository for storing your DollhouseMCP elements. Creates the repository structure with proper directories and README.",
        inputSchema: {
          type: "object",
          properties: {
            repository_name: {
              type: "string",
              description: "Name for the portfolio repository. Defaults to 'dollhouse-portfolio' if not specified.",
            },
            private: {
              type: "boolean",
              description: "Whether to create a private repository. Defaults to false (public).",
            },
            description: {
              type: "string",
              description: "Repository description. Defaults to 'My DollhouseMCP element portfolio'.",
            },
          },
        },
      },
      handler: (args: InitPortfolioArgs) => server.initPortfolio({
        repositoryName: args?.repository_name,
        private: args?.private,
        description: args?.description
      })
    },
    {
      tool: {
        name: "portfolio_config",
        description: "Configure portfolio settings such as auto-sync preferences, default visibility, submission settings, and repository preferences.",
        inputSchema: {
          type: "object",
          properties: {
            auto_sync: {
              type: "boolean",
              description: "Whether to automatically sync local changes to GitHub portfolio.",
            },
            default_visibility: {
              type: "string",
              enum: ["public", "private"],
              description: "Default visibility for new portfolio repositories.",
            },
            auto_submit: {
              type: "boolean", 
              description: "Whether to automatically submit elements to the collection when they're added to portfolio.",
            },
            repository_name: {
              type: "string",
              description: "Default repository name for new portfolios.",
            },
          },
        },
      },
      handler: (args: PortfolioConfigArgs) => server.portfolioConfig({
        autoSync: args?.auto_sync,
        defaultVisibility: args?.default_visibility,
        autoSubmit: args?.auto_submit,
        repositoryName: args?.repository_name
      })
    },
    {
      tool: {
        name: "sync_portfolio",
        description: "Sync your local portfolio with GitHub repository. This uploads any new or modified elements to GitHub and can optionally pull remote changes.",
        inputSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["push", "pull", "both"],
              description: "Sync direction: 'push' (upload to GitHub), 'pull' (download from GitHub), or 'both' (bidirectional sync). Defaults to 'push'.",
            },
            force: {
              type: "boolean",
              description: "Whether to force sync even if there are conflicts. Use with caution as this may overwrite changes.",
            },
            dry_run: {
              type: "boolean",
              description: "Show what would be synced without actually performing the sync.",
            },
          },
        },
      },
      handler: (args: SyncPortfolioArgs) => server.syncPortfolio({
        direction: args?.direction || 'push',
        force: args?.force || false,
        dryRun: args?.dry_run || false
      })
    }
  ];

  return tools;
}