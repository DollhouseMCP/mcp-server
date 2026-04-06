/**
 * MCP-AQL Token Economics Benchmark
 *
 * Measures and validates token savings from the MCP-AQL consolidated approach
 * compared to discrete tools.
 *
 * ## Real Claude Code Measurements (January 2026)
 *
 * These values were measured directly from Claude Code's /context command,
 * which reports actual token counts used by the model:
 *
 * | Configuration | Tools | Tokens  | vs Discrete |
 * |---------------|-------|---------|-------------|
 * | Discrete      | 42    | 29,592  | (baseline)  |
 * | CRUDE         | 5     | 4,314   | 85% savings |
 * | Single        | 1     | 1,100   | 96% savings |
 *
 * ### CRUDE Mode Breakdown (5 tools, 4,314 tokens total)
 * - mcp_aql_create:  858 tokens
 * - mcp_aql_read:    911 tokens
 * - mcp_aql_update:  766 tokens
 * - mcp_aql_delete:  783 tokens
 * - mcp_aql_execute: 996 tokens
 *
 * ### Single Mode (1 tool, 1,100 tokens)
 * - mcp_aql: 1,100 tokens
 *
 * Note: The chars/4 estimation used in this script underestimates actual
 * token counts by approximately 4x. For accurate measurements, always use
 * Claude Code's /context command with different MCP_AQL_ENDPOINT_MODE values.
 *
 * Issue: #189 (original), #198 (CLI flags)
 *
 * Usage:
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts                    # Default (4char tokenizer)
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --tokenizer 4char  # Simple chars/4 estimation
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --tokenizer tiktoken # OpenAI's tokenizer
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --tokenizer claude   # Anthropic tokenizer
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --compare            # Compare all methods
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --json               # Machine-readable output
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --compare --json     # Compare with JSON output
 *   npx tsx scripts/benchmark-mcp-aql-tokens.ts --help               # Show usage
 */

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

interface CliArgs {
  tokenizer: '4char' | 'tiktoken' | 'claude';
  compare: boolean;
  json: boolean;
  help: boolean;
}

/**
 * Parse command-line arguments using simple process.argv parsing.
 * Avoids adding external dependencies.
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    tokenizer: '4char',
    compare: false,
    json: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--compare' || arg === '-c') {
      result.compare = true;
    } else if (arg === '--json' || arg === '-j') {
      result.json = true;
    } else if (arg === '--tokenizer' || arg === '-t') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        console.error('Error: --tokenizer requires a value (4char, tiktoken, or claude)');
        process.exit(1);
      }
      if (!['4char', 'tiktoken', 'claude'].includes(value)) {
        console.error(`Error: Invalid tokenizer "${value}". Valid options: 4char, tiktoken, claude`);
        process.exit(1);
      }
      result.tokenizer = value as '4char' | 'tiktoken' | 'claude';
      i++; // Skip the value
    } else if (arg.startsWith('--tokenizer=')) {
      const value = arg.split('=')[1];
      if (!['4char', 'tiktoken', 'claude'].includes(value)) {
        console.error(`Error: Invalid tokenizer "${value}". Valid options: 4char, tiktoken, claude`);
        process.exit(1);
      }
      result.tokenizer = value as '4char' | 'tiktoken' | 'claude';
    } else if (!arg.startsWith('-')) {
      // Ignore positional arguments
    } else {
      console.error(`Error: Unknown option "${arg}"`);
      printUsage();
      process.exit(1);
    }
  }

  return result;
}

/**
 * Print usage information and exit.
 */
function printUsage(): void {
  console.log(`
MCP-AQL Token Economics Benchmark

Measures and validates token savings from the MCP-AQL consolidated approach
compared to discrete tools.

USAGE:
  npx tsx scripts/benchmark-mcp-aql-tokens.ts [OPTIONS]

OPTIONS:
  --tokenizer, -t <method>  Token estimation method (default: 4char)
                            Methods:
                              4char    - Simple chars/4 estimation (always available)
                              tiktoken - OpenAI's tiktoken library (requires: npm install tiktoken)
                              claude   - Anthropic tokenizer (requires: npm install @anthropic-ai/tokenizer)

  --compare, -c             Run benchmark with all available tokenizers and show comparison

  --json, -j                Output results in JSON format (machine-readable)

  --help, -h                Show this help message

EXAMPLES:
  # Run with default (4char) tokenizer
  npx tsx scripts/benchmark-mcp-aql-tokens.ts

  # Run with tiktoken tokenizer
  npx tsx scripts/benchmark-mcp-aql-tokens.ts --tokenizer tiktoken

  # Compare all available tokenizers
  npx tsx scripts/benchmark-mcp-aql-tokens.ts --compare

  # Output results in JSON format
  npx tsx scripts/benchmark-mcp-aql-tokens.ts --json

  # Compare all tokenizers with JSON output (includes timing)
  npx tsx scripts/benchmark-mcp-aql-tokens.ts --compare --json

TOKEN ESTIMATION METHODS:
  4char:    Simple estimation using ~4 characters per token.
            Always available, good approximation for structured JSON.

  tiktoken: OpenAI's official tokenizer (cl100k_base encoding).
            More accurate for GPT models. Requires optional dependency.

  claude:   Anthropic's tokenizer for Claude models.
            Most accurate for Claude. Requires optional dependency.

For detailed documentation, see: https://github.com/DollhouseMCP/mcp-server
`);
}

// ============================================================================
// TOKENIZER IMPLEMENTATIONS
// ============================================================================

/**
 * Tokenizer interface for pluggable token estimation.
 */
interface Tokenizer {
  name: string;
  available: boolean;
  estimateTokens(content: string | object): number;
  unavailableReason?: string;
}

/**
 * Simple 4-character-per-token estimation.
 * Always available, uses ~4 characters per token ratio which is
 * accurate for structured JSON content sent to LLM context windows.
 */
function create4CharTokenizer(): Tokenizer {
  return {
    name: '4char',
    available: true,
    estimateTokens(content: string | object): number {
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return Math.ceil(text.length / 4);
    }
  };
}

/**
 * Attempt to create tiktoken tokenizer using lazy loading.
 * Returns unavailable tokenizer if package not installed.
 */
async function createTiktokenTokenizer(): Promise<Tokenizer> {
  try {
    // Dynamic import to avoid requiring tiktoken as a dependency
    // Use dynamic string to prevent TypeScript from resolving the module
    const moduleName = 'tiktoken';
    const tiktoken = require(moduleName);
    const encoding = tiktoken.get_encoding('cl100k_base');

    return {
      name: 'tiktoken',
      available: true,
      estimateTokens(content: string | object): number {
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return encoding.encode(text).length;
      }
    };
  } catch {
    return {
      name: 'tiktoken',
      available: false,
      unavailableReason: 'Package not installed. Run: npm install tiktoken',
      estimateTokens(): number {
        return 0;
      }
    };
  }
}

/**
 * Attempt to create Anthropic Claude tokenizer using lazy loading.
 * Returns unavailable tokenizer if package not installed.
 */
async function createClaudeTokenizer(): Promise<Tokenizer> {
  try {
    // Dynamic import to avoid requiring @anthropic-ai/tokenizer as a dependency
    // Use dynamic string to prevent TypeScript from resolving the module
    const moduleName = '@anthropic-ai/tokenizer';
    const anthropicTokenizer = require(moduleName);

    return {
      name: 'claude',
      available: true,
      estimateTokens(content: string | object): number {
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return anthropicTokenizer.countTokens(text);
      }
    };
  } catch {
    return {
      name: 'claude',
      available: false,
      unavailableReason: 'Package not installed. Run: npm install @anthropic-ai/tokenizer',
      estimateTokens(): number {
        return 0;
      }
    };
  }
}

/**
 * Get the appropriate tokenizer based on CLI arguments.
 */
async function getTokenizer(name: string): Promise<Tokenizer> {
  switch (name) {
    case 'tiktoken':
      return createTiktokenTokenizer();
    case 'claude':
      return createClaudeTokenizer();
    case '4char':
    default:
      return create4CharTokenizer();
  }
}

/**
 * Get all tokenizers for comparison mode.
 */
async function getAllTokenizers(): Promise<Tokenizer[]> {
  return Promise.all([
    Promise.resolve(create4CharTokenizer()),
    createTiktokenTokenizer(),
    createClaudeTokenizer()
  ]);
}

// ============================================================================
// TOOL SCHEMA DEFINITIONS
// ============================================================================

/**
 * Tool schema structure matching MCP tool definitions.
 * Represents the JSON structure sent to LLMs when tools are listed.
 */
interface ToolSchema {
  /** Unique tool identifier */
  name: string;
  /** Human-readable description shown to LLMs */
  description: string;
  /** JSON Schema defining the tool's input parameters */
  inputSchema: object;
  /** Optional MCP annotations for tool behavior hints */
  annotations?: {
    /** Indicates tool only reads data, never modifies */
    readOnlyHint?: boolean;
    /** Indicates tool may delete or irreversibly modify data */
    destructiveHint?: boolean;
  };
}

// ============================================================================
// DISCRETE TOOL SCHEMAS (42 tools across 8 files)
// ============================================================================

/**
 * Complete schema definitions for all 42 discrete MCP tools.
 * Organized by source file: ElementTools, CollectionTools, PortfolioTools,
 * EnhancedIndexTools, AuthTools, ConfigToolsV2, BuildInfoTools, PersonaTools.
 */
const discreteTools: ToolSchema[] = [
  // ElementTools.ts - 16 tools
  {
    name: "list_elements",
    description: "List all available elements of a specific type with optional pagination, filtering, and sorting",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The element type to list", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] },
        page: { type: "number", description: "Page number (1-indexed). Default: 1", minimum: 1 },
        pageSize: { type: "number", description: "Number of items per page. Default: 25, max: 100", minimum: 1, maximum: 100 },
        sortBy: { type: "string", description: "Field to sort by. Default: 'name'", enum: ["name", "created", "modified", "version", "retention"] },
        sortOrder: { type: "string", description: "Sort direction. Default: 'asc'", enum: ["asc", "desc"] },
        nameContains: { type: "string", description: "Filter by partial name match (case-insensitive)" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags (AND logic - must have ALL tags)" },
        tagsAny: { type: "array", items: { type: "string" }, description: "Filter by tags (OR logic - must have ANY tag)" },
        author: { type: "string", description: "Filter by author (exact match, case-insensitive)" },
        createdAfter: { type: "string", description: "Filter for elements created after this date (ISO 8601 format)" },
        createdBefore: { type: "string", description: "Filter for elements created before this date (ISO 8601 format)" },
        status: { type: "string", description: "Filter by element status", enum: ["active", "inactive", "all"] }
      },
      required: ["type"]
    }
  },
  {
    name: "activate_element",
    description: "Activate a specific element by name",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to activate" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] }
      },
      required: ["name", "type"]
    }
  },
  {
    name: "get_active_elements",
    description: "Get information about currently active elements of a specific type",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The element type to check", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] }
      },
      required: ["type"]
    }
  },
  {
    name: "deactivate_element",
    description: "Deactivate a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to deactivate" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] }
      },
      required: ["name", "type"]
    }
  },
  {
    name: "get_element_details",
    description: "Get detailed information about a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to get details for" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] }
      },
      required: ["name", "type"]
    }
  },
  {
    name: "reload_elements",
    description: "Reload elements of a specific type from the filesystem",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The element type to reload", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] }
      },
      required: ["type"]
    }
  },
  {
    name: "render_template",
    description: "Render a template element with provided variables",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The template name to render" },
        variables: { type: "object", description: "Variables to use in the template", additionalProperties: true }
      },
      required: ["name", "variables"]
    }
  },
  {
    name: "execute_agent",
    description: "Execute an agent with a goal. Activates configured elements and returns context for LLM-driven agentic loop. The agent configuration defines a goal template that is filled with provided parameters.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the agent to execute" },
        parameters: { type: "object", description: "Parameters for the agent goal template (e.g., {directory: \"src\"})", additionalProperties: true }
      },
      required: ["name", "parameters"]
    }
  },
  {
    name: "create_element",
    description: "Create a new element of any type",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] },
        description: { type: "string", description: "Element description" },
        content: { type: "string", description: "Element content (required for some types)" },
        metadata: { type: "object", description: "Additional metadata specific to element type", additionalProperties: true }
      },
      required: ["name", "type", "description"]
    }
  },
  {
    name: "edit_element",
    description: "Edit an existing element of any type",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to edit" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] },
        field: { type: "string", description: "The field to edit (e.g., 'description', 'metadata.author', 'content')" },
        value: { description: "The new value for the field", oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "object" }, { type: "array" }] }
      },
      required: ["name", "type", "field", "value"]
    }
  },
  {
    name: "validate_element",
    description: "Validate an element for correctness and best practices",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to validate" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] },
        strict: { type: "boolean", description: "Whether to apply strict validation rules", default: false }
      },
      required: ["name", "type"]
    }
  },
  {
    name: "delete_element",
    description: "Delete an element and optionally its associated data files",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The element name to delete" },
        type: { type: "string", description: "The element type", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"] },
        deleteData: { type: "boolean", description: "Whether to delete associated data files (if not specified, will prompt)" }
      },
      required: ["name", "type"]
    }
  },
  {
    name: "record_agent_step",
    description: "Record a step in the agent's execution, including progress, findings, and outcome. Use this to document what the agent has done, what it learned, and whether the step succeeded. This creates an audit trail and enables resumption.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Name of the agent executing this step" },
        stepDescription: { type: "string", description: "Brief description of what this step accomplished" },
        outcome: { type: "string", enum: ["success", "failure", "partial"], description: "Outcome of this step" },
        findings: { type: "string", description: "Detailed findings, results, or observations from this step" },
        confidence: { type: "number", description: "Confidence level in this step's outcome (0.0 to 1.0)", minimum: 0, maximum: 1 }
      },
      required: ["agentName", "stepDescription", "outcome", "findings"]
    }
  },
  {
    name: "complete_agent_goal",
    description: "Signal that the agent has completed its goal. This marks the goal as complete, updates decision outcomes, and calculates performance metrics.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Name of the agent completing its goal" },
        goalId: { type: "string", description: "Optional specific goal ID to complete" },
        outcome: { type: "string", enum: ["success", "failure", "partial"], description: "Final outcome" },
        summary: { type: "string", description: "Summary of what was accomplished" }
      },
      required: ["agentName", "outcome", "summary"]
    }
  },
  {
    name: "get_agent_state",
    description: "Query the current state of an agent, including active goals, decision history, progress, and execution context.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Name of the agent to query" },
        includeDecisionHistory: { type: "boolean", description: "Include full decision history in response" },
        includeContext: { type: "boolean", description: "Include full execution context" }
      },
      required: ["agentName"]
    }
  },
  {
    name: "continue_agent_execution",
    description: "Continue executing an agent from its current state. Use this to resume after interruption or start the next step in a multi-step workflow.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Name of the agent to continue" },
        parameters: { type: "object", description: "Optional parameters to update the execution context", additionalProperties: true },
        previousStepResult: { type: "string", description: "Optional summary of the previous step's result" }
      },
      required: ["agentName"]
    }
  },

  // CollectionTools.ts - 7 tools
  {
    name: "browse_collection",
    description: "Browse content from the DollhouseMCP collection by section and content type.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Collection section to browse (library, showcase, catalog)" },
        type: { type: "string", description: "Content type within the library section: personas, skills, agents, templates, or memories" }
      }
    }
  },
  {
    name: "search_collection",
    description: "Search for content in the collection by keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for finding content" }
      },
      required: ["query"]
    }
  },
  {
    name: "search_collection_enhanced",
    description: "Enhanced search for collection content with pagination, filtering, and sorting.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for finding content" },
        elementType: { type: "string", description: "Filter by content type", enum: ["personas", "skills", "agents", "templates", "tools", "memories", "prompts"] },
        category: { type: "string", description: "Filter by category", enum: ["creative", "professional", "educational", "personal", "gaming"] },
        page: { type: "number", description: "Page number for paginated results", minimum: 1 },
        pageSize: { type: "number", description: "Number of results per page", minimum: 1, maximum: 100 },
        sortBy: { type: "string", description: "Sort results by", enum: ["relevance", "name", "date"] }
      },
      required: ["query"]
    }
  },
  {
    name: "get_collection_content",
    description: "Get detailed information about content from the collection.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The collection path to the AI customization element" }
      },
      required: ["path"]
    }
  },
  {
    name: "install_collection_content",
    description: "Install AI customization elements FROM the DollhouseMCP collection TO your local portfolio.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The collection path to the AI customization element" }
      },
      required: ["path"]
    }
  },
  {
    name: "submit_collection_content",
    description: "Submit a single element TO the DollhouseMCP community collection.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content name or filename to submit" }
      },
      required: ["content"]
    }
  },
  {
    name: "get_collection_cache_health",
    description: "Get health status and statistics for the collection cache system.",
    inputSchema: { type: "object", properties: {} }
  },

  // PortfolioTools.ts - 6 tools
  {
    name: "portfolio_status",
    description: "Check the status of your GitHub portfolio repository.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "GitHub username to check portfolio for" }
      }
    }
  },
  {
    name: "init_portfolio",
    description: "Initialize a new GitHub portfolio repository for storing your DollhouseMCP elements.",
    inputSchema: {
      type: "object",
      properties: {
        repository_name: { type: "string", description: "Name for the portfolio repository" },
        private: { type: "boolean", description: "Whether to create a private repository" },
        description: { type: "string", description: "Repository description" }
      }
    }
  },
  {
    name: "portfolio_config",
    description: "Configure portfolio settings such as auto-sync preferences, default visibility, submission settings.",
    inputSchema: {
      type: "object",
      properties: {
        auto_sync: { type: "boolean", description: "Whether to automatically sync local changes" },
        default_visibility: { type: "string", enum: ["public", "private"], description: "Default visibility for new portfolios" },
        auto_submit: { type: "boolean", description: "Whether to automatically submit elements to collection" },
        repository_name: { type: "string", description: "Default repository name for new portfolios" }
      }
    }
  },
  {
    name: "sync_portfolio",
    description: "Sync ALL elements in your local portfolio with your GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["push", "pull", "both"], description: "Sync direction" },
        mode: { type: "string", enum: ["additive", "mirror", "backup"], description: "Sync mode" },
        force: { type: "boolean", description: "Whether to force sync even if there are conflicts" },
        dry_run: { type: "boolean", description: "Show what would be synced without performing the sync" },
        confirm_deletions: { type: "boolean", description: "Require explicit confirmation for each deletion" }
      }
    }
  },
  {
    name: "search_portfolio",
    description: "Search your local portfolio by content name, metadata, keywords, tags, or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], description: "Limit search to specific element type" },
        fuzzy_match: { type: "boolean", description: "Enable fuzzy matching" },
        max_results: { type: "number", description: "Maximum number of results to return" },
        include_keywords: { type: "boolean", description: "Include keyword matching in search" },
        include_tags: { type: "boolean", description: "Include tag matching in search" },
        include_triggers: { type: "boolean", description: "Include trigger word matching in search" },
        include_descriptions: { type: "boolean", description: "Include description text matching in search" }
      },
      required: ["query"]
    }
  },
  {
    name: "search_all",
    description: "Search across all available sources (local portfolio, GitHub portfolio, and collection) for elements.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        sources: { type: "array", items: { type: "string", enum: ["local", "github", "collection"] }, description: "Sources to search" },
        type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], description: "Limit search to specific element type" },
        page: { type: "number", description: "Page number for pagination" },
        page_size: { type: "number", description: "Number of results per page" },
        sort_by: { type: "string", enum: ["relevance", "source", "name", "version"], description: "Sort results by criteria" }
      },
      required: ["query"]
    }
  },

  // EnhancedIndexTools.ts - 4 tools
  {
    name: "find_similar_elements",
    description: "Find elements that are semantically similar to a given element using NLP scoring.",
    inputSchema: {
      type: "object",
      properties: {
        element_name: { type: "string", description: "Name of the element to find similar items for" },
        element_type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], description: "Type of the element" },
        limit: { type: "number", description: "Maximum number of similar elements to return" },
        threshold: { type: "number", description: "Minimum similarity score (0-1) to include" }
      },
      required: ["element_name"]
    }
  },
  {
    name: "get_element_relationships",
    description: "Get all relationships for a specific element, including semantic similarities, verb-based connections, and cross-element references.",
    inputSchema: {
      type: "object",
      properties: {
        element_name: { type: "string", description: "Name of the element to get relationships for" },
        element_type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], description: "Type of the element" },
        relationship_types: { type: "array", items: { type: "string", enum: ["similar", "uses", "extends", "requires", "complements", "verb-based"] }, description: "Filter by specific relationship types" }
      },
      required: ["element_name"]
    }
  },
  {
    name: "search_by_verb",
    description: "Search for elements that can handle a specific action verb (e.g., 'analyze', 'create', 'debug').",
    inputSchema: {
      type: "object",
      properties: {
        verb: { type: "string", description: "Action verb to search for" },
        limit: { type: "number", description: "Maximum number of results to return" }
      },
      required: ["verb"]
    }
  },
  {
    name: "get_relationship_stats",
    description: "Get statistics about the Enhanced Index relationships.",
    inputSchema: { type: "object", properties: {} }
  },

  // AuthTools.ts - 5 tools
  {
    name: "setup_github_auth",
    description: "Set up GitHub authentication to access all DollhouseMCP features.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "check_github_auth",
    description: "Check current GitHub authentication status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "clear_github_auth",
    description: "Remove GitHub authentication and disconnect from GitHub.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "configure_oauth",
    description: "Configure GitHub OAuth client ID for authentication.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "GitHub OAuth client ID" }
      }
    }
  },
  {
    name: "oauth_helper_status",
    description: "Get detailed diagnostic information about the OAuth helper process.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Include detailed log output if available" }
      }
    }
  },

  // ConfigToolsV2.ts - 2 tools
  {
    name: "dollhouse_config",
    description: "Manage DollhouseMCP configuration settings.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "reset", "export", "import", "wizard"], description: "The configuration action to perform" },
        setting: { type: "string", description: "Dot-notation path to setting" },
        value: { description: "Value to set" },
        section: { type: "string", description: "Configuration section to reset" },
        format: { type: "string", enum: ["yaml", "json"], description: "Export format" },
        data: { type: "string", description: "Configuration data to import" }
      },
      required: ["action"]
    }
  },
  {
    name: "portfolio_element_manager",
    description: "Manage individual elements between your local portfolio and GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list-remote", "download", "upload", "compare"], description: "The operation to perform" },
        element_name: { type: "string", description: "Name of the element" },
        element_type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], description: "Type of element" },
        filter: { type: "object", description: "Filters for bulk operations" },
        options: { type: "object", description: "Additional options" }
      },
      required: ["operation"]
    }
  },

  // BuildInfoTools.ts - 1 tool
  {
    name: "get_build_info",
    description: "Get comprehensive build and runtime information about the server",
    inputSchema: { type: "object", properties: {}, required: [] }
  },

  // PersonaTools.ts - 1 tool
  {
    name: "import_persona",
    description: "Import a persona from a file path or JSON string",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "File path to a .md or .json file, or a JSON string of the persona" },
        overwrite: { type: "boolean", description: "Overwrite if persona already exists" }
      },
      required: ["source"]
    }
  }
];

// ============================================================================
// PROJECTED SAVINGS: ACTUAL OPERATION COUNT
// ============================================================================

/**
 * Current number of operations registered in OperationRouter.
 *
 * The `discreteTools` array above contains 42 tools — the historical set from
 * before MCP-AQL consolidation. However, the router now serves many more
 * operations through the same 5 CRUDE endpoints. This constant captures the
 * actual operation count so we can project what the discrete-tool cost WOULD
 * be if every operation still needed its own tool.
 *
 * To update: run `grep -c "endpoint:" src/handlers/mcp-aql/OperationRouter.ts`
 * or `Object.keys(OPERATION_ROUTES).length` at runtime.
 */
const CURRENT_OPERATION_COUNT = 73;

// ============================================================================
// MCP-AQL UNIFIED TOOLS (5 CRUDE endpoints)
// ============================================================================

/**
 * Schema definitions for the 5 unified MCP-AQL CRUDE endpoints.
 * Consolidates 73 operations into semantic CRUDE operations (Create, Read, Update, Delete, Execute).
 * These match the actual tool definitions in src/server/tools/MCPAQLTools.ts
 */
const mcpAqlTools: ToolSchema[] = [
  {
    name: "mcp_aql_create",
    description: `Additive, non-destructive operations.

Supported operations: create_element, import_element, addEntry, activate_element, install_collection_content, submit_collection_content, init_portfolio, sync_portfolio, portfolio_element_manager, setup_github_auth, configure_oauth, import_persona

Element types: persona, skill, template, agent, memory, ensemble

These operations add new data without removing or overwriting existing content.

Quick start examples:
{ operation: "create_element", element_type: "persona", params: { element_name: "MyPersona", description: "A helpful assistant", instructions: "Be helpful and concise." } }
{ operation: "activate_element", element_type: "persona", params: { element_name: "Default" } }

Discover required parameters:
{ operation: "introspect", params: { query: "operations", name: "create_element" } }`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name to execute" },
        elementType: { type: "string", description: "Target element type (optional)" },
        params: { type: "object", description: "Operation parameters" }
      },
      required: ["operation"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  {
    name: "mcp_aql_read",
    description: `Safe, read-only operations.

Supported operations: search, list_elements, get_element, get_element_details, search_elements, query_elements, get_active_elements, validate_element, render, export_element, deactivate_element, introspect, browse_collection, search_collection, search_collection_enhanced, get_collection_content, get_collection_cache_health, portfolio_status, portfolio_config, search_portfolio, search_all, check_github_auth, oauth_helper_status, dollhouse_config, get_build_info, find_similar_elements, get_element_relationships, search_by_verb, get_relationship_stats

Element types: persona, skill, template, agent, memory, ensemble

These queries only read data and never modify server state.

Quick start examples:
{ operation: "list_elements", element_type: "persona" }
{ operation: "get_active_elements", element_type: "persona" }
{ operation: "search_elements", params: { query: "creative" } }

Discover all operations and parameters:
{ operation: "introspect", params: { query: "operations" } }`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name to execute" },
        elementType: { type: "string", description: "Target element type (optional)" },
        params: { type: "object", description: "Operation parameters" }
      },
      required: ["operation"]
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "mcp_aql_update",
    description: `Modifying operations that overwrite data.

Supported operations: edit_element

Element types: persona, skill, template, agent, memory, ensemble

These operations modify existing data, potentially overwriting previous values.

Quick start example:
{ operation: "edit_element", element_type: "persona", params: { element_name: "MyPersona", input: { description: "Updated description" } } }

Discover required parameters:
{ operation: "introspect", params: { query: "operations", name: "edit_element" } }`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name to execute" },
        elementType: { type: "string", description: "Target element type (optional)" },
        params: { type: "object", description: "Operation parameters" }
      },
      required: ["operation"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "mcp_aql_delete",
    description: `Destructive operations that remove data.

Supported operations: delete_element, clear, clear_github_auth

Element types: persona, skill, template, agent, memory, ensemble

These operations remove data. Use with caution.

Quick start examples:
{ operation: "delete_element", element_type: "persona", params: { element_name: "MyPersona" } }
{ operation: "clear", params: { element_name: "MyMemory" } }

Discover required parameters:
{ operation: "introspect", params: { query: "operations", name: "delete_element" } }`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name to execute" },
        elementType: { type: "string", description: "Target element type (optional)" },
        params: { type: "object", description: "Operation parameters" }
      },
      required: ["operation"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "mcp_aql_execute",
    description: `Execution lifecycle operations for executable elements (agents, workflows, pipelines).

Supported operations: execute_agent, get_execution_state, record_execution_step, complete_execution, continue_execution

These operations manage runtime execution state. Unlike CRUD operations (which manage definitions), Execute operations handle the execution lifecycle:
- execute_agent: Start a new execution
- get_execution_state: Query execution progress and findings
- record_execution_step: Record step completion or progress
- complete_execution: Signal successful completion
- continue_execution: Resume from saved state

IMPORTANT: Execute operations are potentially destructive (agents can perform any action) and non-idempotent (calling execute_agent twice creates two separate executions).

Quick start examples:
{ operation: "execute_agent", params: { element_name: "MyAgent", parameters: { goal: "Review code" } } }
{ operation: "get_execution_state", params: { element_name: "MyAgent" } }
{ operation: "record_execution_step", params: { element_name: "MyAgent", stepDescription: "Analyzed files", outcome: "success", findings: "Found 3 issues" } }
{ operation: "complete_execution", params: { element_name: "MyAgent", outcome: "success", summary: "Completed review" } }

Discover required parameters:
{ operation: "introspect", params: { query: "operations", name: "execute_agent" } }`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name to execute" },
        elementType: { type: "string", description: "Target element type (optional)" },
        params: { type: "object", description: "Operation parameters" }
      },
      required: ["operation"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }
];

// ============================================================================
// INTROSPECTION OPERATION SCHEMAS (loaded on-demand)
// ============================================================================

// Sample introspection schemas - returned when LLM queries operation details
const introspectionSchemas = {
  create_element: {
    name: { type: "string", required: true },
    type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], required: true },
    description: { type: "string", required: true },
    content: { type: "string" },
    metadata: { type: "object" }
  },
  list_elements: {
    type: { type: "string", enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"], required: true },
    page: { type: "number" },
    pageSize: { type: "number" },
    sortBy: { type: "string" },
    filters: { type: "object" }
  },
  edit_element: {
    name: { type: "string", required: true },
    type: { type: "string", required: true },
    field: { type: "string", required: true },
    value: { type: "any", required: true }
  },
  delete_element: {
    name: { type: "string", required: true },
    type: { type: "string", required: true },
    deleteData: { type: "boolean" }
  }
};

// ============================================================================
// BENCHMARK FUNCTIONS
// ============================================================================

/**
 * Measures token counts for an array of tool schemas using a specified tokenizer.
 *
 * @param tools - Array of tool schemas to measure
 * @param tokenizer - Tokenizer to use for estimation
 * @returns Object containing total tokens, per-tool breakdown, and average
 */
function measureToolTokens(tools: ToolSchema[], tokenizer: Tokenizer): { total: number; perTool: Map<string, number>; avgPerTool: number } {
  const perTool = new Map<string, number>();
  let total = 0;

  for (const tool of tools) {
    const tokens = tokenizer.estimateTokens(tool);
    perTool.set(tool.name, tokens);
    total += tokens;
  }

  return {
    total,
    perTool,
    avgPerTool: total / tools.length
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

/**
 * Pad string to width, right-aligned for numbers.
 */
function padRight(str: string, width: number): string {
  return str.padEnd(width);
}

function padLeft(str: string, width: number): string {
  return str.padStart(width);
}

// ============================================================================
// COMPARISON TABLE OUTPUT
// ============================================================================

interface TokenizerResult {
  tokenizer: Tokenizer;
  discreteTokens: number;
  mcpAqlTokens: number;
  savings: number;
  savingsPercent: number;
  timingMs: number;
}

/**
 * Print comparison table for multiple tokenizers.
 */
function printComparisonTable(results: TokenizerResult[]): void {
  console.log('\nToken Estimation Comparison:');

  // Calculate column widths
  const methodWidth = 12;
  const discreteWidth = 10;
  const mcpAqlWidth = 10;
  const savingsWidth = 9;
  const timingWidth = 10;

  // Print header
  console.log('+' + '-'.repeat(methodWidth + 2) + '+' + '-'.repeat(discreteWidth + 2) + '+' + '-'.repeat(mcpAqlWidth + 2) + '+' + '-'.repeat(savingsWidth + 2) + '+' + '-'.repeat(timingWidth + 2) + '+');
  console.log('| ' + padRight('Method', methodWidth) + ' | ' + padRight('Discrete', discreteWidth) + ' | ' + padRight('MCP-AQL', mcpAqlWidth) + ' | ' + padRight('Savings', savingsWidth) + ' | ' + padRight('Time (ms)', timingWidth) + ' |');
  console.log('+' + '-'.repeat(methodWidth + 2) + '+' + '-'.repeat(discreteWidth + 2) + '+' + '-'.repeat(mcpAqlWidth + 2) + '+' + '-'.repeat(savingsWidth + 2) + '+' + '-'.repeat(timingWidth + 2) + '+');

  // Print rows
  for (const result of results) {
    if (!result.tokenizer.available) {
      console.log('| ' + padRight(result.tokenizer.name, methodWidth) + ' | ' + padRight('(N/A)', discreteWidth) + ' | ' + padRight('(N/A)', mcpAqlWidth) + ' | ' + padRight('(N/A)', savingsWidth) + ' | ' + padRight('(N/A)', timingWidth) + ' |');
    } else {
      const timingStr = result.timingMs.toFixed(2);
      console.log('| ' + padRight(result.tokenizer.name, methodWidth) + ' | ' + padLeft(formatNumber(result.discreteTokens), discreteWidth) + ' | ' + padLeft(formatNumber(result.mcpAqlTokens), mcpAqlWidth) + ' | ' + padLeft(formatPercent(result.savingsPercent), savingsWidth) + ' | ' + padLeft(timingStr, timingWidth) + ' |');
    }
  }

  console.log('+' + '-'.repeat(methodWidth + 2) + '+' + '-'.repeat(discreteWidth + 2) + '+' + '-'.repeat(mcpAqlWidth + 2) + '+' + '-'.repeat(savingsWidth + 2) + '+' + '-'.repeat(timingWidth + 2) + '+');

  // Print unavailable tokenizers
  const unavailable = results.filter(r => !r.tokenizer.available);
  if (unavailable.length > 0) {
    console.log('\nUnavailable tokenizers:');
    for (const result of unavailable) {
      console.log(`  - ${result.tokenizer.name}: ${result.tokenizer.unavailableReason}`);
    }
  }
}

/**
 * Run comparison across all tokenizers.
 */
async function runComparison(): Promise<TokenizerResult[]> {
  const tokenizers = await getAllTokenizers();
  const results: TokenizerResult[] = [];

  for (const tokenizer of tokenizers) {
    if (!tokenizer.available) {
      results.push({
        tokenizer,
        discreteTokens: 0,
        mcpAqlTokens: 0,
        savings: 0,
        savingsPercent: 0,
        timingMs: 0
      });
      continue;
    }

    // Measure timing for this tokenizer
    const startTime = performance.now();
    const discreteMetrics = measureToolTokens(discreteTools, tokenizer);
    const mcpAqlMetrics = measureToolTokens(mcpAqlTools, tokenizer);
    const endTime = performance.now();
    const timingMs = endTime - startTime;

    const savings = discreteMetrics.total - mcpAqlMetrics.total;
    const savingsPercent = (savings / discreteMetrics.total) * 100;

    results.push({
      tokenizer,
      discreteTokens: discreteMetrics.total,
      mcpAqlTokens: mcpAqlMetrics.total,
      savings,
      savingsPercent,
      timingMs
    });
  }

  return results;
}

// ============================================================================
// MAIN BENCHMARK
// ============================================================================

/**
 * Runs the complete MCP-AQL token economics benchmark.
 * Measures discrete tools vs MCP-AQL unified approach and reports savings.
 *
 * @returns Benchmark results including tool counts, token counts, and savings percentage
 *
 * @example
 * const results = await runTokenBenchmark();
 * console.log(results.savings.percent); // e.g., 85.0
 */
async function main() {
  const args = parseArgs();

  // Handle help flag
  if (args.help) {
    printUsage();
    return;
  }

  // Handle comparison mode
  if (args.compare) {
    const results = await runComparison();

    // JSON output mode
    if (args.json) {
      const jsonOutput = {
        mode: 'comparison',
        timestamp: new Date().toISOString(),
        results: results.map(r => ({
          tokenizer: r.tokenizer.name,
          available: r.tokenizer.available,
          unavailableReason: r.tokenizer.unavailableReason,
          discreteTokens: r.discreteTokens,
          mcpAqlTokens: r.mcpAqlTokens,
          savings: r.savings,
          savingsPercent: r.savingsPercent,
          timingMs: r.timingMs
        }))
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return;
    }

    // Human-readable output
    console.log('\n' + '='.repeat(80));
    console.log('  MCP-AQL TOKEN ECONOMICS BENCHMARK - COMPARISON MODE');
    console.log('  Issue #198: Tokenizer CLI flags');
    console.log('='.repeat(80) + '\n');

    console.log('Running benchmark with all available tokenizers...\n');

    printComparisonTable(results);

    // Report actual savings for available tokenizers
    console.log('\nToken Savings Report:');
    for (const result of results) {
      if (!result.tokenizer.available) continue;
      console.log(`  ${result.tokenizer.name}: ${formatPercent(result.savingsPercent)} savings`);
    }

    return;
  }

  // Get specified tokenizer
  const tokenizer = await getTokenizer(args.tokenizer);

  if (!tokenizer.available) {
    if (args.json) {
      console.log(JSON.stringify({
        error: `Tokenizer "${args.tokenizer}" is not available`,
        reason: tokenizer.unavailableReason,
        fallback: '4char'
      }, null, 2));
    } else {
      console.error(`\nError: Tokenizer "${args.tokenizer}" is not available.`);
      console.error(`Reason: ${tokenizer.unavailableReason}`);
      console.error('\nFalling back to 4char tokenizer...\n');
    }
    const fallbackTokenizer = create4CharTokenizer();
    return runBenchmarkWithTokenizer(fallbackTokenizer, args.json);
  }

  return runBenchmarkWithTokenizer(tokenizer, args.json);
}

/**
 * Run the full benchmark with a specific tokenizer.
 */
async function runBenchmarkWithTokenizer(tokenizer: Tokenizer, jsonOutput: boolean = false) {
  // Measure timing
  const startTime = performance.now();
  const discreteMetrics = measureToolTokens(discreteTools, tokenizer);
  const mcpAqlMetrics = measureToolTokens(mcpAqlTools, tokenizer);
  const endTime = performance.now();
  const timingMs = endTime - startTime;

  // Calculate introspection schema totals
  let introspectionTotal = 0;
  const introspectionBreakdown: Record<string, number> = {};
  for (const [op, schema] of Object.entries(introspectionSchemas)) {
    const tokens = tokenizer.estimateTokens(schema);
    introspectionTotal += tokens;
    introspectionBreakdown[op] = tokens;
  }

  const tokenSavings = discreteMetrics.total - mcpAqlMetrics.total;
  const percentSavings = (tokenSavings / discreteMetrics.total) * 100;
  const consolidationRatio = discreteTools.length / mcpAqlTools.length;
  const introspectionAvgTokens = introspectionTotal / Object.keys(introspectionSchemas).length;
  const typicalOps = 5;
  const mcpAqlWithIntrospection = mcpAqlMetrics.total + (typicalOps * introspectionAvgTokens);

  // Projected savings: estimate what discrete tools would cost for ALL current operations.
  // Uses the measured average token cost per discrete tool as a heuristic for operations
  // that never had discrete tools (they would have similar schema verbosity).
  const projectedDiscreteTokens = Math.round(CURRENT_OPERATION_COUNT * discreteMetrics.avgPerTool);
  const projectedSavings = projectedDiscreteTokens - mcpAqlMetrics.total;
  const projectedSavingsPercent = (projectedSavings / projectedDiscreteTokens) * 100;
  const projectedConsolidationRatio = CURRENT_OPERATION_COUNT / mcpAqlTools.length;

  // JSON output mode
  if (jsonOutput) {
    const sortedDiscrete = [...discreteMetrics.perTool.entries()].sort((a, b) => b[1] - a[1]);
    const jsonResult = {
      mode: 'single',
      timestamp: new Date().toISOString(),
      tokenizer: tokenizer.name,
      timingMs,
      discreteTools: {
        count: discreteTools.length,
        totalTokens: discreteMetrics.total,
        avgPerTool: discreteMetrics.avgPerTool,
        top5: sortedDiscrete.slice(0, 5).map(([name, tokens]) => ({ name, tokens })),
        perTool: Object.fromEntries(discreteMetrics.perTool)
      },
      mcpAqlTools: {
        count: mcpAqlTools.length,
        totalTokens: mcpAqlMetrics.total,
        avgPerTool: mcpAqlMetrics.avgPerTool,
        perTool: Object.fromEntries(mcpAqlMetrics.perTool)
      },
      introspectionSchemas: {
        totalTokens: introspectionTotal,
        avgPerSchema: introspectionAvgTokens,
        perSchema: introspectionBreakdown
      },
      savings: {
        tokens: tokenSavings,
        percent: percentSavings,
        consolidationRatio
      },
      projectedSavings: {
        currentOperationCount: CURRENT_OPERATION_COUNT,
        projectedDiscreteTokens,
        mcpAqlTokens: mcpAqlMetrics.total,
        tokens: projectedSavings,
        percent: projectedSavingsPercent,
        consolidationRatio: projectedConsolidationRatio
      },
      scenarios: {
        sessionStart: {
          discrete: discreteMetrics.total,
          mcpAql: mcpAqlMetrics.total,
          savings: tokenSavings,
          savingsPercent: percentSavings
        },
        typicalSession: {
          operations: typicalOps,
          discrete: discreteMetrics.total,
          mcpAql: Math.round(mcpAqlWithIntrospection),
          savings: Math.round(discreteMetrics.total - mcpAqlWithIntrospection),
          savingsPercent: ((discreteMetrics.total - mcpAqlWithIntrospection) / discreteMetrics.total) * 100
        }
      }
    };
    console.log(JSON.stringify(jsonResult, null, 2));
    return jsonResult;
  }

  // Human-readable output
  console.log('\n' + '='.repeat(80));
  console.log('  MCP-AQL TOKEN ECONOMICS BENCHMARK');
  console.log('  Issue #189: Token economics measurement');
  console.log('  Issue #198: Tokenizer CLI flags');
  console.log('='.repeat(80) + '\n');

  console.log(`Tokenizer: ${tokenizer.name}`);
  console.log(`Timing: ${timingMs.toFixed(2)}ms`);
  console.log('');

  // Measure discrete tools
  console.log('DISCRETE TOOLS ANALYSIS');
  console.log('-'.repeat(80));
  console.log(`  Total tools: ${discreteTools.length}`);
  console.log(`  Total tokens: ${formatNumber(discreteMetrics.total)}`);
  console.log(`  Average tokens per tool: ${formatNumber(Math.round(discreteMetrics.avgPerTool))}`);
  console.log();

  // Top 5 largest tools
  const sortedDiscrete = [...discreteMetrics.perTool.entries()].sort((a, b) => b[1] - a[1]);
  console.log('  Top 5 largest tools:');
  for (let i = 0; i < 5 && i < sortedDiscrete.length; i++) {
    console.log(`    ${i + 1}. ${sortedDiscrete[i][0]}: ${formatNumber(sortedDiscrete[i][1])} tokens`);
  }
  console.log();

  // Measure MCP-AQL tools
  console.log('MCP-AQL UNIFIED TOOLS ANALYSIS');
  console.log('-'.repeat(80));
  console.log(`  Total tools: ${mcpAqlTools.length}`);
  console.log(`  Total tokens: ${formatNumber(mcpAqlMetrics.total)}`);
  console.log(`  Average tokens per tool: ${formatNumber(Math.round(mcpAqlMetrics.avgPerTool))}`);
  console.log();

  // Individual MCP-AQL tools
  console.log('  Per-tool breakdown:');
  for (const [name, tokens] of mcpAqlMetrics.perTool) {
    console.log(`    ${name}: ${formatNumber(tokens)} tokens`);
  }
  console.log();

  // Introspection schemas (on-demand via introspect operation)
  console.log('INTROSPECTION SCHEMAS (on-demand)');
  console.log('-'.repeat(80));
  for (const [op, tokens] of Object.entries(introspectionBreakdown)) {
    console.log(`  ${op}: ${formatNumber(tokens)} tokens`);
  }
  console.log(`  Average introspection schema: ${formatNumber(Math.round(introspectionAvgTokens))} tokens`);
  console.log();

  // Calculate savings
  console.log('TOKEN SAVINGS ANALYSIS (baseline: 42 historical discrete tools)');
  console.log('-'.repeat(80));

  console.log(`  Discrete tools baseline:  ${formatNumber(discreteMetrics.total)} tokens (${discreteTools.length} tools)`);
  console.log(`  MCP-AQL unified approach: ${formatNumber(mcpAqlMetrics.total)} tokens (${mcpAqlTools.length} tools)`);
  console.log(`  Token savings:            ${formatNumber(tokenSavings)} tokens`);
  console.log(`  Percentage savings:       ${formatPercent(percentSavings)}`);
  console.log(`  Tool consolidation ratio: ${discreteTools.length}:${mcpAqlTools.length} (${consolidationRatio.toFixed(1)}x reduction)`);
  console.log();

  // Projected savings: what if all current operations had discrete tools?
  console.log('PROJECTED SAVINGS (all ${CURRENT_OPERATION_COUNT} current operations)');
  console.log('-'.repeat(80));
  console.log(`  Current operations in router:  ${CURRENT_OPERATION_COUNT}`);
  console.log(`  Avg tokens per discrete tool:  ${formatNumber(Math.round(discreteMetrics.avgPerTool))}`);
  console.log(`  Projected discrete cost:       ${formatNumber(projectedDiscreteTokens)} tokens (${CURRENT_OPERATION_COUNT} × ${Math.round(discreteMetrics.avgPerTool)})`);
  console.log(`  Actual MCP-AQL cost:           ${formatNumber(mcpAqlMetrics.total)} tokens`);
  console.log(`  Projected savings:             ${formatNumber(projectedSavings)} tokens (${formatPercent(projectedSavingsPercent)})`);
  console.log(`  Projected consolidation ratio: ${CURRENT_OPERATION_COUNT}:${mcpAqlTools.length} (${projectedConsolidationRatio.toFixed(1)}x reduction)`);
  console.log();

  // Usage scenarios
  console.log('USAGE SCENARIOS');
  console.log('-'.repeat(80));

  // Scenario 1: Full tool listing at session start
  console.log('  Scenario 1: Full tool listing (session start)');
  console.log(`    Discrete: ${formatNumber(discreteMetrics.total)} tokens`);
  console.log(`    MCP-AQL:  ${formatNumber(mcpAqlMetrics.total)} tokens`);
  console.log(`    Savings:  ${formatNumber(tokenSavings)} tokens (${formatPercent(percentSavings)})`);
  console.log();

  // Scenario 2: Typical session with 5 operations
  console.log(`  Scenario 2: Typical session (${typicalOps} operations with introspection)`);
  console.log(`    Discrete: ${formatNumber(discreteMetrics.total)} tokens (full schema always loaded)`);
  console.log(`    MCP-AQL:  ${formatNumber(Math.round(mcpAqlWithIntrospection))} tokens (base + ${typicalOps} introspection queries)`);
  console.log(`    Savings:  ${formatNumber(Math.round(discreteMetrics.total - mcpAqlWithIntrospection))} tokens (${formatPercent(((discreteMetrics.total - mcpAqlWithIntrospection) / discreteMetrics.total) * 100)})`);
  console.log();

  // Summary
  console.log('='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log(`
  The MCP-AQL consolidated approach achieves significant token savings:

  Baseline (42 historical tools):
  - ${formatPercent(percentSavings)} reduction in base tool schema tokens
  - ${discreteTools.length} discrete tools -> ${mcpAqlTools.length} unified endpoints
  - ${formatNumber(tokenSavings)} fewer tokens loaded at session start

  Projected (all ${CURRENT_OPERATION_COUNT} current operations):
  - ${formatPercent(projectedSavingsPercent)} reduction vs hypothetical discrete tools
  - ${CURRENT_OPERATION_COUNT} operations -> ${mcpAqlTools.length} unified endpoints
  - ${formatNumber(projectedSavings)} fewer tokens loaded at session start

  Key Benefits:
  - Reduced context window consumption
  - Faster tool discovery for LLM agents
  - Semantic CRUDE operations improve agent comprehension
  - Operation namespacing scales without adding tools
  - Introspection enables on-demand schema loading during usage
`);

  // Return results for testing
  return {
    discreteTools: {
      count: discreteTools.length,
      totalTokens: discreteMetrics.total,
      avgPerTool: discreteMetrics.avgPerTool
    },
    mcpAqlTools: {
      count: mcpAqlTools.length,
      totalTokens: mcpAqlMetrics.total,
      avgPerTool: mcpAqlMetrics.avgPerTool
    },
    savings: {
      tokens: tokenSavings,
      percent: percentSavings
    },
    projectedSavings: {
      currentOperationCount: CURRENT_OPERATION_COUNT,
      projectedDiscreteTokens,
      tokens: projectedSavings,
      percent: projectedSavingsPercent,
      consolidationRatio: projectedConsolidationRatio
    },
    tokenizer: tokenizer.name,
    timingMs
  };
}

// Legacy function for backwards compatibility
function estimateTokens(content: string | object): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return Math.ceil(text.length / 4);
}

// Run benchmark
main().catch(console.error);

export { main as runTokenBenchmark, estimateTokens, discreteTools, mcpAqlTools, parseArgs, create4CharTokenizer };
