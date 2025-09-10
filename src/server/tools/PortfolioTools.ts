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
  mode?: 'additive' | 'mirror' | 'backup';
  force?: boolean;
  dry_run?: boolean;
  confirm_deletions?: boolean;
}

interface SearchPortfolioArgs {
  query: string;
  type?: string;
  fuzzy_match?: boolean;
  max_results?: number;
  include_keywords?: boolean;
  include_tags?: boolean;
  include_triggers?: boolean;
  include_descriptions?: boolean;
}

interface SearchAllArgs {
  query: string;
  sources?: string[];
  type?: string;
  page?: number;
  page_size?: number;
  sort_by?: 'relevance' | 'source' | 'name' | 'version';
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
        description: "Sync ALL elements in your local portfolio with your GitHub repository. By default uses 'additive' mode which only adds new items and never deletes (safest). Use 'mirror' mode for exact sync (with deletion confirmations). Use 'backup' mode to treat GitHub as backup source. ALWAYS run with dry_run:true first to preview changes. For individual elements, use 'portfolio_element_manager' instead.",
        inputSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["push", "pull", "both"],
              description: "Sync direction: 'push' (upload to GitHub), 'pull' (download from GitHub), or 'both' (bidirectional sync). Defaults to 'push'.",
            },
            mode: {
              type: "string",
              enum: ["additive", "mirror", "backup"],
              description: "Sync mode: 'additive' (default, only adds new items, never deletes), 'mirror' (makes exact match, requires confirmation for deletions), 'backup' (GitHub as backup, only pulls missing items locally). Defaults to 'additive' for safety.",
            },
            force: {
              type: "boolean",
              description: "Whether to force sync even if there are conflicts. Use with caution as this may overwrite changes. In 'mirror' mode, this skips deletion confirmations.",
            },
            dry_run: {
              type: "boolean",
              description: "Show what would be synced without actually performing the sync. RECOMMENDED to run with dry_run:true first to preview changes.",
            },
            confirm_deletions: {
              type: "boolean",
              description: "In 'mirror' mode, require explicit confirmation for each deletion. Defaults to true unless force:true is set.",
            },
          },
        },
      },
      handler: (args: SyncPortfolioArgs) => server.syncPortfolio({
        direction: args?.direction || 'push',
        mode: args?.mode || 'additive',
        force: args?.force || false,
        dryRun: args?.dry_run || false,
        confirmDeletions: args?.confirm_deletions !== false // Default true unless explicitly false
      })
    },
    {
      tool: {
        name: "search_portfolio",
        description: "Search your local portfolio by content name, metadata, keywords, tags, or description. This searches your local elements using the portfolio index for fast metadata-based lookups.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query. Can match element names, keywords, tags, triggers, or descriptions. Examples: 'creative writer', 'debug', 'code review', 'research'.",
            },
            type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Limit search to specific element type. If not specified, searches all types.",
            },
            fuzzy_match: {
              type: "boolean",
              description: "Enable fuzzy matching for approximate name matches. Defaults to true.",
            },
            max_results: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 20.",
            },
            include_keywords: {
              type: "boolean",
              description: "Include keyword matching in search. Defaults to true.",
            },
            include_tags: {
              type: "boolean",
              description: "Include tag matching in search. Defaults to true.",
            },
            include_triggers: {
              type: "boolean",
              description: "Include trigger word matching in search (for personas). Defaults to true.",
            },
            include_descriptions: {
              type: "boolean",
              description: "Include description text matching in search. Defaults to true.",
            },
          },
          required: ["query"],
        },
      },
      handler: (args: SearchPortfolioArgs) => server.searchPortfolio({
        query: args.query,
        elementType: args.type as any,
        fuzzyMatch: args.fuzzy_match,
        maxResults: args.max_results,
        includeKeywords: args.include_keywords,
        includeTags: args.include_tags,
        includeTriggers: args.include_triggers,
        includeDescriptions: args.include_descriptions
      })
    },
    {
      tool: {
        name: "search_all",
        description: "Search across all available sources (local portfolio, GitHub portfolio, and collection) for elements. This provides unified search with duplicate detection and version comparison across all three tiers of the DollhouseMCP ecosystem.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query. Can match element names, keywords, tags, triggers, or descriptions across all sources.",
            },
            sources: {
              type: "array",
              items: {
                type: "string",
                enum: ["local", "github", "collection"]
              },
              description: "Sources to search. Defaults to ['local', 'github']. Include 'collection' to search the community collection.",
            },
            type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Limit search to specific element type. If not specified, searches all types.",
            },
            page: {
              type: "number",
              description: "Page number for pagination (1-based). Defaults to 1.",
            },
            page_size: {
              type: "number",
              description: "Number of results per page. Defaults to 20.",
            },
            sort_by: {
              type: "string",
              enum: ["relevance", "source", "name", "version"],
              description: "Sort results by criteria. Defaults to 'relevance'.",
            },
          },
          required: ["query"],
        },
      },
      handler: (args: SearchAllArgs) => server.searchAll({
        query: args.query,
        sources: args.sources,
        elementType: args.type as any,
        page: args.page,
        pageSize: args.page_size,
        sortBy: args.sort_by as any
      })
    }
  ];

  return tools;
}