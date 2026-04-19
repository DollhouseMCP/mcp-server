/**
 * OperationSchema - Declarative operation definitions for MCP-AQL
 *
 * This module provides schema-driven operation definitions that enable:
 * 1. Declarative operation configuration (no manual switch statements)
 * 2. Auto-generated parameter validation
 * 3. Type-safe dispatch to handler methods
 * 4. Single source of truth for operation metadata
 *
 * ARCHITECTURE:
 * Operations are defined with:
 * - endpoint: CRUDE endpoint (CREATE, READ, UPDATE, DELETE, EXECUTE)
 * - handler: Key in HandlerRegistry
 * - method: Method name on the handler
 * - params: Parameter definitions with types and mappings
 * - description: Human-readable description
 *
 * The SchemaDispatcher uses these definitions to automatically route
 * operations to handler methods without manual dispatch code.
 *
 * @see Issue #247 - Schema-driven operation definitions
 */

import type { CRUDEndpoint } from './OperationRouter.js';
import { env } from '../../config/env.js';

// ============================================================================
// Parameter Schema Types
// ============================================================================

/**
 * Primitive types supported in parameter schemas
 */
export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'string[]'
  | 'string | string[]' // Union type for fields that accept preset string or array
  | 'unknown'; // For params that accept any type

/**
 * Parameter definition in operation schema
 */
export interface ParamDef {
  /** Parameter type for validation */
  type: ParamType;
  /** Whether the parameter is required (default: false) */
  required?: boolean;
  /** Default value if not provided */
  default?: unknown;
  /** Human-readable description */
  description?: string;
  /** Maps input param name to handler arg name (if different) */
  mapTo?: string;
  /**
   * Alternative sources to check for this parameter value.
   * Checked in order before falling back to the primary param name.
   *
   * Supports dot notation for nested access:
   * - 'input.elementType' - checks input.elementType
   * - 'params.type' - checks params.type (same as just checking the param)
   *
   * Use case: elementType can come from input.elementType OR params.type
   *
   * @example
   * type: { type: 'string', sources: ['input.elementType', 'params.type'] }
   */
  sources?: string[];
}

/**
 * Return type definition for introspection
 * @see Issue #254 - Auto-generate introspection from schema
 */
export interface ReturnTypeDef {
  /** Return type name (e.g., 'ElementList', 'SearchResult') */
  name: string;
  /** Type kind for categorization */
  kind: 'enum' | 'object' | 'scalar' | 'union';
  /** Human-readable description of what is returned */
  description: string;
}

/**
 * Parameter schema - map of parameter names to definitions
 */
export type ParamSchema = Record<string, ParamDef>;

// ============================================================================
// Operation Schema Types
// ============================================================================

/**
 * Handler keys - these map to properties in HandlerRegistry
 */
export type HandlerKey =
  | 'elementCRUD'
  | 'memoryManager'
  | 'agentManager'
  | 'templateRenderer'
  | 'elementQueryService'
  | 'collectionHandler'
  | 'portfolioHandler'
  | 'authHandler'
  | 'configHandler'
  | 'enhancedIndexHandler'
  | 'personaHandler'
  | 'syncHandler'
  | 'buildInfoService'
  | 'mcpAqlHandler'
  | 'cacheMemoryBudget';

/**
 * Complete operation schema definition
 */
export interface OperationDef {
  /** CRUDE endpoint this operation belongs to */
  endpoint: CRUDEndpoint;
  /** Handler key in HandlerRegistry */
  handler: HandlerKey;
  /** Method name to call on the handler */
  method: string;
  /** Parameter definitions */
  params?: ParamSchema;
  /** Human-readable description */
  description: string;
  /** Whether the handler is optional (may not be configured) */
  optional?: boolean;
  /**
   * Custom argument builder for complex cases:
   * - 'single': Pass params in schema order as positional args (default)
   * - 'spread': Pass (query, params) - for search-style operations
   * - 'named': Pass all params as a single named object
   * - 'namedWithType': Like 'named' but includes resolved 'type' param
   * - 'typeWithParams': Pass (type, fullParams) for operations needing type + pagination
   */
  argBuilder?: 'single' | 'spread' | 'named' | 'namedWithType' | 'typeWithParams';
  /**
   * Whether this operation needs access to the full OperationInput.
   * When true, SchemaDispatcher passes the full input for source resolution.
   * Required for operations that use param sources like 'input.elementType'.
   */
  needsFullInput?: boolean;
  /**
   * Automatic parameter name conversion style.
   * - 'snakeToCamel': Convert snake_case params to camelCase for handler
   *
   * When set, all params are automatically converted before being passed
   * to the handler. Individual param `mapTo` overrides still take precedence.
   *
   * @example
   * // Input: { dry_run: true, max_results: 10 }
   * // Handler receives: { dryRun: true, maxResults: 10 }
   */
  paramStyle?: 'snakeToCamel';
  /**
   * Capability category for get_capabilities grouping.
   * Operations are grouped by user-intent categories in the capabilities map.
   * Operations without a category appear under "Other".
   * @see Issue #1760 - get_capabilities operation
   */
  category?: string;
  /**
   * Return type information for introspection
   * @see Issue #254 - Auto-generate introspection from schema
   */
  returns?: ReturnTypeDef;
  /**
   * Usage examples for introspection
   * @see Issue #254 - Auto-generate introspection from schema
   */
  examples?: string[];
  /**
   * Normalizer to use for parameter transformation.
   *
   * If specified, the normalizer is called before the handler method,
   * transforming raw input parameters into the format expected by the handler.
   *
   * Normalizers are registered in NormalizerRegistry and looked up by name.
   *
   * @see Issue #243 - Schema-driven normalizer architecture
   *
   * @example
   * // Use the search params normalizer
   * normalizer: 'searchParams'
   */
  normalizer?: string;
}

/**
 * Complete operation schema - maps operation names to definitions
 */
export type OperationSchemaMap = Record<string, OperationDef>;

// ============================================================================
// Collection Operations Schema (Proof of Concept)
// ============================================================================

/**
 * Collection operations schema
 *
 * These are the first operations migrated to schema-driven dispatch.
 * Each operation defines:
 * - Where it lives (endpoint)
 * - What handler to use
 * - What method to call
 * - What parameters it accepts
 */
export const COLLECTION_OPERATIONS: OperationSchemaMap = {
  browse_collection: {
    endpoint: 'READ',
    handler: 'collectionHandler',
    method: 'browseCollection',
    category: 'Community Collection',
    description: 'Browse the DollhouseMCP community collection by section and type',
    optional: true,
    params: {
      section: { type: 'string', description: 'Collection section to browse' },
      type: { type: 'string', description: 'Element type filter' },
    },
    returns: { name: 'CollectionBrowseResult', kind: 'object', description: 'Browseable collection sections and items' },
    examples: ['{ operation: "browse_collection", params: { section: "personas" } }'],
  },
  search_collection: {
    endpoint: 'READ',
    handler: 'collectionHandler',
    method: 'searchCollection',
    category: 'Community Collection',
    description: 'Search the community collection for elements by keywords',
    optional: true,
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
    },
    returns: { name: 'CollectionSearchResult', kind: 'object', description: 'Matching elements from collection' },
    examples: ['{ operation: "search_collection", params: { query: "code review" } }'],
  },
  search_collection_enhanced: {
    endpoint: 'READ',
    handler: 'collectionHandler',
    method: 'searchCollectionEnhanced',
    category: 'Community Collection',
    description: 'Advanced search with pagination, filtering, and sorting',
    optional: true,
    argBuilder: 'spread',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
    },
    returns: { name: 'EnhancedSearchResult', kind: 'object', description: 'Paginated search results with metadata' },
    examples: ['{ operation: "search_collection_enhanced", params: { query: "assistant", limit: 10 } }'],
  },
  get_collection_content: {
    endpoint: 'READ',
    handler: 'collectionHandler',
    method: 'getCollectionContent',
    category: 'Community Collection',
    description: 'Get detailed information about content from the collection',
    optional: true,
    params: {
      path: { type: 'string', required: true, description: 'Content path in collection' },
    },
    returns: { name: 'CollectionContent', kind: 'object', description: 'Full content and metadata for collection item' },
    examples: ['{ operation: "get_collection_content", params: { path: "personas/creative-writer.md" } }'],
  },
  get_collection_cache_health: {
    endpoint: 'READ',
    handler: 'collectionHandler',
    method: 'getCollectionCacheHealth',
    category: 'Community Collection',
    description: 'Get health status and statistics for the collection cache',
    optional: true,
    params: {},
    returns: { name: 'CacheHealthStatus', kind: 'object', description: 'Cache health metrics and diagnostics' },
    examples: ['{ operation: "get_collection_cache_health" }'],
  },
  install_collection_content: {
    endpoint: 'CREATE',
    handler: 'collectionHandler',
    method: 'installContent',
    category: 'Community Collection',
    description: 'Install an element from the collection to your local portfolio',
    optional: true,
    params: {
      path: { type: 'string', required: true, description: 'Content path to install' },
    },
    returns: { name: 'InstallResult', kind: 'object', description: 'Installation result with element name, type, and local file path' },
    examples: ['{ operation: "install_collection_content", params: { path: "personas/creative-writer.md" } }'],
  },
  submit_collection_content: {
    endpoint: 'CREATE',
    handler: 'collectionHandler',
    method: 'submitContent',
    category: 'Community Collection',
    description: 'Submit a local element to the community collection via GitHub',
    optional: true,
    params: {
      content: { type: 'string', required: true, description: 'Content to submit' },
    },
    returns: { name: 'SubmitResult', kind: 'object', description: 'Submission result with GitHub PR URL and status message' },
    examples: ['{ operation: "submit_collection_content", params: { content: "personas/my-persona" } }'],
  },
} as const;

// ============================================================================
// Auth Operations Schema
// ============================================================================

export const AUTH_OPERATIONS: OperationSchemaMap = {
  setup_github_auth: {
    endpoint: 'CREATE',
    handler: 'authHandler',
    method: 'setupGitHubAuth',
    category: 'GitHub Authentication',
    description: 'Set up GitHub authentication using device flow',
    optional: true,
    params: {},
    returns: { name: 'AuthSetupResult', kind: 'object', description: 'Device flow setup: { userCode, verificationUrl, expiresIn, message }' },
    examples: ['{ operation: "setup_github_auth" }'],
  },
  check_github_auth: {
    endpoint: 'READ',
    handler: 'authHandler',
    method: 'checkGitHubAuth',
    category: 'GitHub Authentication',
    description: 'Check current GitHub authentication status',
    optional: true,
    params: {},
    returns: { name: 'AuthStatus', kind: 'object', description: 'Current authentication state and user info' },
    examples: ['{ operation: "check_github_auth" }'],
  },
  clear_github_auth: {
    endpoint: 'DELETE',
    handler: 'authHandler',
    method: 'clearGitHubAuth',
    category: 'GitHub Authentication',
    description: 'Remove GitHub authentication and disconnect',
    optional: true,
    params: {},
    returns: { name: 'OperationResult', kind: 'union', description: 'Success or failure status' },
    examples: ['{ operation: "clear_github_auth" }'],
  },
  configure_oauth: {
    endpoint: 'CREATE',
    handler: 'authHandler',
    method: 'configureOAuth',
    category: 'GitHub Authentication',
    description: 'Configure GitHub OAuth client ID',
    optional: true,
    params: {
      client_id: { type: 'string', description: 'OAuth client ID' },
    },
    returns: { name: 'OAuthConfig', kind: 'object', description: 'OAuth configuration status' },
    examples: ['{ operation: "configure_oauth", params: { client_id: "your-client-id" } }'],
  },
  oauth_helper_status: {
    endpoint: 'READ',
    handler: 'authHandler',
    method: 'getOAuthHelperStatus',
    category: 'GitHub Authentication',
    description: 'Get diagnostic information about OAuth helper process',
    optional: true,
    params: {
      verbose: { type: 'boolean', description: 'Include verbose diagnostics' },
    },
    returns: { name: 'OAuthHelperStatus', kind: 'object', description: 'Helper process diagnostics' },
    examples: ['{ operation: "oauth_helper_status", params: { verbose: true } }'],
  },
} as const;

// ============================================================================
// Enhanced Index Operations Schema
// ============================================================================

export const ENHANCED_INDEX_OPERATIONS: OperationSchemaMap = {
  find_similar_elements: {
    endpoint: 'READ',
    handler: 'enhancedIndexHandler',
    method: 'findSimilarElements',
    category: 'Intelligence',
    description: 'Find semantically similar elements using NLP scoring',
    optional: true,
    argBuilder: 'named',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName' },
      element_type: { type: 'string', mapTo: 'elementType' },
      limit: { type: 'number', default: 10 },
      threshold: { type: 'number', default: 0.5 },
    },
    returns: { name: 'SimilarElements', kind: 'object', description: 'List of similar elements with similarity scores' },
    examples: ['{ operation: "find_similar_elements", params: { element_name: "creative-writer", element_type: "persona", limit: 5 } }'],
  },
  get_element_relationships: {
    endpoint: 'READ',
    handler: 'enhancedIndexHandler',
    method: 'getElementRelationships',
    category: 'Intelligence',
    description: 'Get all relationships for a specific element',
    optional: true,
    argBuilder: 'named',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName' },
      element_type: { type: 'string', mapTo: 'elementType' },
      relationship_types: { type: 'string[]', mapTo: 'relationshipTypes' },
    },
    returns: { name: 'ElementRelationships', kind: 'object', description: 'Relationship graph for the element' },
    examples: ['{ operation: "get_element_relationships", params: { element_name: "code-reviewer", element_type: "skill" } }'],
  },
  search_by_verb: {
    endpoint: 'READ',
    handler: 'enhancedIndexHandler',
    method: 'searchByVerb',
    category: 'Intelligence',
    description: 'Search for elements that handle a specific action verb',
    optional: true,
    argBuilder: 'named',
    params: {
      verb: { type: 'string', required: true },
      limit: { type: 'number', default: 20 },
    },
    returns: { name: 'VerbSearchResult', kind: 'object', description: 'Elements matching the action verb' },
    examples: ['{ operation: "search_by_verb", params: { verb: "analyze", limit: 10 } }'],
  },
  get_relationship_stats: {
    endpoint: 'READ',
    handler: 'enhancedIndexHandler',
    method: 'getRelationshipStats',
    category: 'Intelligence',
    description: 'Get statistics about Enhanced Index relationships',
    optional: true,
    params: {},
    returns: { name: 'RelationshipStats', kind: 'object', description: 'Aggregate statistics about element relationships' },
    examples: ['{ operation: "get_relationship_stats" }'],
  },
} as const;

// ============================================================================
// Template Operations Schema
// ============================================================================

export const TEMPLATE_OPERATIONS: OperationSchemaMap = {
  render: {
    endpoint: 'READ',
    handler: 'templateRenderer',
    method: 'render',
    category: 'Template Rendering',
    description: 'Render a template with provided variables. For section-format templates (<template>, <style>, <script>), renders the <template> section by default — variable substitution only applies there. Use section: "style" or "script" to retrieve raw passthrough sections where }} is safe.',
    params: {
      // Issue #290: Use element_name for consistency
      element_name: { type: 'string', required: true, mapTo: 'name', description: 'Template name' },
      variables: { type: 'object', description: 'Variables to substitute in the <template> section (e.g. { "title": "My Page", "user": "Alice" })' },
      section: { type: 'string', required: false, description: 'Extract a specific raw section without variable substitution: "style" or "script". Useful for CSS theme templates or JS-only templates. Only valid for section-format templates.' },
      all_sections: { type: 'boolean', required: false, description: 'Return all sections together: { template: rendered, style: raw, script: raw }. Use when you need the rendered HTML alongside its CSS and JS.' },
    },
    returns: { name: 'RenderResult', kind: 'object', description: 'Rendered template content. content field has the result string; sections field populated when all_sections: true.' },
    examples: [
      '{ operation: "render", params: { element_name: "meeting-notes", variables: { date: "2024-01-15", attendees: ["Alice", "Bob"] } } }',
      '{ operation: "render", params: { element_name: "dashboard-theme-dark", section: "style" } }',
      '{ operation: "render", params: { element_name: "dashboard-page", variables: { title: "My Dashboard" }, all_sections: true } }',
    ],
  },
} as const;

// ============================================================================
// Introspection Operations Schema
// ============================================================================

export const INTROSPECTION_OPERATIONS: OperationSchemaMap = {
  introspect: {
    endpoint: 'READ',
    handler: 'elementCRUD', // Uses IntrospectionResolver directly
    method: '__introspect__', // Special marker for introspection
    category: 'System Introspection',
    description: 'Query available operations, types, and element format specs for discovery',
    params: {
      query: { type: 'string', required: true, description: "What to introspect: 'operations' (list/detail operations), 'types' (list/detail type definitions), 'format' (element creation format specs — required/optional fields, syntax, examples), 'categories' (category format rules + how to discover existing categories via query_elements). Default: 'operations'" },
      name: { type: 'string', description: "Specific item name. For 'operations': operation name. For 'types': type name. For 'format': element type (e.g. 'template', 'persona'). Not used for 'categories'. Omit for overview." },
    },
    returns: { name: 'IntrospectionResult', kind: 'object', description: 'Operations, types, or format specification information' },
    examples: [
      '{ operation: "introspect", params: { query: "operations" } }',
      '{ operation: "introspect", params: { query: "operations", name: "create_element" } }',
      '{ operation: "introspect", params: { query: "types", name: "ElementType" } }',
      '{ operation: "introspect", params: { query: "format" } }',
      '{ operation: "introspect", params: { query: "format", name: "template" } }',
      '{ operation: "introspect", params: { query: "categories" } }',
    ],
  },
  get_capabilities: {
    endpoint: 'READ',
    handler: 'elementCRUD', // Uses IntrospectionResolver directly
    method: '__capabilities__', // Special marker for capabilities
    category: 'System Introspection',
    description: 'Get a high-level map of all server capabilities grouped by user intent. Returns brief descriptions of every available operation organized by category. Use introspect for full details on any specific operation.',
    params: {
      category: { type: 'string', description: 'Filter to a specific category name. Omit to see all categories.' },
    },
    returns: { name: 'CapabilitiesResult', kind: 'object', description: 'Categorized capability map with brief descriptions, sources, and status' },
    examples: [
      '{ operation: "get_capabilities" }',
      '{ operation: "get_capabilities", params: { category: "Element Lifecycle" } }',
    ],
  },
} as const;

// ============================================================================
// Persona Operations Schema
// ============================================================================

export const PERSONA_OPERATIONS: OperationSchemaMap = {
  import_persona: {
    endpoint: 'CREATE',
    handler: 'personaHandler',
    method: 'importPersona',
    category: 'Element Lifecycle',
    description: 'Import a persona from a file path or JSON string',
    optional: true,
    params: {
      source: { type: 'string', required: true, description: 'File path or JSON string' },
      overwrite: { type: 'boolean', description: 'Overwrite existing persona' },
    },
    returns: { name: 'ImportResult', kind: 'object', description: 'Import status and persona info' },
    examples: ['{ operation: "import_persona", params: { source: "/path/to/persona.md", overwrite: true } }'],
  },
} as const;

// ============================================================================
// Config Operations Schema
// ============================================================================

export const CONFIG_OPERATIONS: OperationSchemaMap = {
  dollhouse_config: {
    endpoint: 'READ',
    handler: 'configHandler',
    method: 'handleConfigOperation',
    category: 'Configuration & Diagnostics',
    description: 'Manage DollhouseMCP configuration settings',
    optional: true,
    argBuilder: 'named',
    params: {
      action: { type: 'string', required: true, description: 'get, set, reset, export, import, wizard' },
      setting: { type: 'string' },
      value: { type: 'string' },
      section: { type: 'string' },
      format: { type: 'string' },
      data: { type: 'string' },
    },
    returns: { name: 'ConfigResult', kind: 'object', description: 'Configuration operation result' },
    examples: [
      '{ operation: "dollhouse_config", params: { action: "get", setting: "debug" } }',
      '{ operation: "dollhouse_config", params: { action: "set", setting: "logLevel", value: "verbose" } }',
    ],
  },
  convert_skill_format: {
    endpoint: 'READ',
    handler: 'configHandler',
    method: 'convertSkillFormat',
    category: 'Configuration & Diagnostics',
    description: 'Convert between current Agent Skill and Dollhouse Skill formats (both directions) with structured warnings and optional roundtrip state for lossless supported-field restoration',
    optional: true,
    argBuilder: 'named',
    params: {
      direction: { type: 'string', required: true, description: 'Conversion direction: agent_to_dollhouse or dollhouse_to_agent' },
      agent_skill: { type: 'object', description: 'Agent Skill structure for agent_to_dollhouse: { "SKILL.md": "...", "scripts/": { ... }, "references/": { ... }, "assets/": { ... }, "agents/": { ... } }' },
      dollhouse: { type: 'object', description: 'Structured Dollhouse skill artifact for dollhouse_to_agent: { metadata, instructions, content }' },
      dollhouse_markdown: { type: 'string', description: 'Serialized Dollhouse markdown input for dollhouse_to_agent (alternative to dollhouse object)' },
      roundtrip_state: { type: 'object', description: 'Optional state returned by agent_to_dollhouse for exact reverse conversion' },
      prefer_roundtrip_state: { type: 'boolean', default: true, description: 'When true (default), use roundtrip_state if valid for lossless restoration' },
      path_mode: { type: 'string', default: 'safe', description: 'Path handling mode: safe (default, allowlisted/validated paths, security findings sanitized) or lossless (preserve non-allowlisted paths for full-fidelity conversions while still reporting security findings). Input bounds: 2 MiB per text field, 16 MiB aggregate, 2000 file entries. Conversion metrics returned in report.metrics.' },
      security_mode: { type: 'string', default: 'strict', description: 'Security handling mode for agent_to_dollhouse: strict (default, fail conversion on high/critical findings) or warn (surface findings in report.warnings and continue). Frontmatter is also checked for unsafe YAML patterns (including YAML-bomb/amplification patterns). Use warn only for trusted migration workflows.' },
    },
    returns: { name: 'SkillConversionResult', kind: 'object', description: 'Converted artifact plus machine-readable conversion report and warnings' },
    examples: [
      '{ operation: "convert_skill_format", params: { direction: "agent_to_dollhouse", agent_skill: { "SKILL.md": "---\\nname: my-skill\\ndescription: test\\n---\\n\\nUse this skill." } } }',
      '{ operation: "convert_skill_format", params: { direction: "agent_to_dollhouse", security_mode: "warn", path_mode: "lossless", agent_skill: { "SKILL.md": "---\\nname: my-skill\\ndescription: test\\n---\\n\\nUse this skill." } } }',
      '{ operation: "convert_skill_format", params: { direction: "dollhouse_to_agent", path_mode: "lossless", dollhouse_markdown: "---\\nname: my-skill\\ndescription: test\\ninstructions: Use this skill.\\n---\\n\\nReference content" } }',
    ],
  },
  get_build_info: {
    endpoint: 'READ',
    handler: 'buildInfoService',
    method: '__buildInfo__', // Special marker for build info
    category: 'Configuration & Diagnostics',
    description: 'Get comprehensive build and runtime information',
    optional: true,
    params: {},
    returns: { name: 'BuildInfo', kind: 'object', description: 'Build info: { version, buildDate, nodeVersion, platform, elementCounts }' },
    examples: ['{ operation: "get_build_info" }'],
  },
  get_cache_budget_report: {
    endpoint: 'READ',
    handler: 'cacheMemoryBudget',
    method: '__cacheBudget__',
    category: 'Configuration & Diagnostics',
    description: 'Get global cache memory budget report with per-cache diagnostics',
    optional: true,
    params: {},
    returns: { name: 'BudgetReport', kind: 'object', description: 'Cache memory usage, per-cache stats, hit rates, and budget utilization' },
    examples: ['{ operation: "get_cache_budget_report" }'],
  },
} as const;

// ============================================================================
// Portfolio Operations Schema (Issue #252)
// ============================================================================

/**
 * Portfolio operations schema - demonstrates paramStyle conversion pattern.
 *
 * PATTERN: Automatic Parameter Style Conversion
 * External APIs often use snake_case naming, while JavaScript handlers
 * typically use camelCase. The `paramStyle: 'snakeToCamel'` setting
 * enables automatic conversion without individual `mapTo` definitions.
 *
 * This pattern is important for MCP-AQL adapters wrapping external MCP
 * servers that follow different naming conventions.
 *
 * @example
 * // Input from MCP client: { dry_run: true, max_results: 10 }
 * // Handler receives: { dryRun: true, maxResults: 10 }
 */
export const PORTFOLIO_OPERATIONS: OperationSchemaMap = {
  portfolio_status: {
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'portfolioStatus',
    category: 'Portfolio Management',
    description: 'Check GitHub portfolio repository status and element counts',
    optional: true,
    argBuilder: 'single',
    params: {
      username: { type: 'string', description: 'GitHub username to check' },
    },
    returns: { name: 'PortfolioStatus', kind: 'object', description: 'Portfolio sync status and element counts' },
    examples: ['{ operation: "portfolio_status" }'],
  },
  init_portfolio: {
    endpoint: 'CREATE',
    handler: 'portfolioHandler',
    method: 'initPortfolio',
    category: 'Portfolio Management',
    description: 'Initialize a new GitHub portfolio repository',
    optional: true,
    argBuilder: 'named',
    paramStyle: 'snakeToCamel',
    params: {
      repository_name: { type: 'string', description: 'Name for the portfolio repository' },
      private: { type: 'boolean', description: 'Whether the repository should be private' },
      description: { type: 'string', description: 'Repository description' },
    },
    returns: { name: 'PortfolioInitResult', kind: 'object', description: 'Newly created portfolio repository details' },
    examples: ['{ operation: "init_portfolio", params: { repository_name: "my-portfolio", private: true } }'],
  },
  portfolio_config: {
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'portfolioConfig',
    category: 'Portfolio Management',
    description: 'Configure portfolio settings (auto-sync, visibility, etc.)',
    optional: true,
    argBuilder: 'named',
    paramStyle: 'snakeToCamel',
    params: {
      auto_sync: { type: 'boolean', description: 'Enable automatic syncing' },
      default_visibility: { type: 'string', description: 'Default visibility for new elements' },
      auto_submit: { type: 'boolean', description: 'Automatically submit to collection' },
      repository_name: { type: 'string', description: 'Portfolio repository name' },
    },
    returns: { name: 'PortfolioConfig', kind: 'object', description: 'Current portfolio configuration settings' },
    examples: ['{ operation: "portfolio_config", params: { auto_sync: true } }'],
  },
  sync_portfolio: {
    endpoint: 'CREATE',
    handler: 'portfolioHandler',
    method: 'syncPortfolio',
    category: 'Portfolio Management',
    description: 'Sync local portfolio with GitHub repository',
    optional: true,
    argBuilder: 'named',
    paramStyle: 'snakeToCamel',
    params: {
      direction: { type: 'string', default: 'push', description: 'Sync direction: push or pull' },
      mode: { type: 'string', description: 'Sync mode' },
      force: { type: 'boolean', default: false, description: 'Force sync even with conflicts' },
      dry_run: { type: 'boolean', default: false, description: 'Preview changes without applying' },
      confirm_deletions: { type: 'boolean', description: 'Confirm before deleting elements' },
    },
    returns: { name: 'SyncResult', kind: 'object', description: 'Sync results with changed element list and conflict details' },
    examples: ['{ operation: "sync_portfolio", params: { direction: "push", dry_run: true } }'],
  },

  /**
   * Unified search operation (Issue #243)
   *
   * Consolidates all search functionality with a scope parameter.
   * Uses the 'searchParams' normalizer to transform:
   * - scope → sources array conversion
   * - pagination (offset/limit → page/pageSize)
   * - sort parameter normalization
   * - filter parameter extraction
   *
   * @see SearchParamsNormalizer for transformation logic
   */
  search: {
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'searchAll',
    category: 'Element Discovery',
    description: 'Unified search across local, GitHub, and collection sources with flexible scope',
    optional: true,
    normalizer: 'searchParams',
    argBuilder: 'named',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
      scope: { type: 'unknown', description: 'Search scope: "local", "github", "collection", "all", or array of scopes' },
      type: { type: 'string', description: 'Filter by element type' },
      page: { type: 'number', description: 'Page number for pagination' },
      limit: { type: 'number', description: 'Results per page' },
      sort: { type: 'object', description: 'Sort options: { field, order }' },
      filters: { type: 'object', description: 'Filter options: { tags, author, createdAfter, createdBefore }' },
      options: { type: 'object', description: 'Search options: { fuzzyMatch, includeKeywords, includeTags }' },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'UnifiedSearchResult', kind: 'object', description: 'Paginated search results from specified scopes' },
    examples: [
      '{ operation: "search", params: { query: "creative" } }',
      '{ operation: "search", params: { query: "helper", fields: "minimal" } }',
      '{ operation: "search", params: { query: "assistant", fields: ["element_name", "description"] } }',
      // Memory-specific: filter by tags to find categorized entries
      '{ operation: "search", params: { query: "*", type: "memory", filters: { tags: ["important", "reference"] } } }',
    ],
  },

  // Legacy search operations (prefer unified "search" operation above)
  search_portfolio: {
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'searchPortfolio',
    category: 'Element Discovery',
    description: 'Search local portfolio by content name, keywords, or tags',
    optional: true,
    argBuilder: 'named',
    paramStyle: 'snakeToCamel',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
      type: { type: 'string', mapTo: 'elementType', description: 'Filter by element type' },
      fuzzy_match: { type: 'boolean', description: 'Enable fuzzy matching' },
      max_results: { type: 'number', description: 'Maximum number of results' },
      include_keywords: { type: 'boolean', description: 'Search in keywords' },
      include_tags: { type: 'boolean', description: 'Search in tags' },
      include_triggers: { type: 'boolean', description: 'Search in triggers' },
      include_descriptions: { type: 'boolean', description: 'Search in descriptions' },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'PortfolioSearchResult', kind: 'object', description: 'Matching elements from local portfolio' },
    examples: [
      '{ operation: "search_portfolio", params: { query: "creative", type: "persona" } }',
      '{ operation: "search_portfolio", params: { query: "helper", fields: "minimal" } }',
    ],
  },
  search_all: {
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'searchAll',
    category: 'Element Discovery',
    description: 'Unified search across local, GitHub, and collection sources',
    optional: true,
    argBuilder: 'named',
    paramStyle: 'snakeToCamel',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
      sources: { type: 'string[]', description: 'Sources to search: local, github, collection' },
      type: { type: 'string', mapTo: 'elementType', description: 'Filter by element type' },
      page: { type: 'number', description: 'Page number for pagination' },
      page_size: { type: 'number', description: 'Results per page' },
      sort_by: { type: 'string', description: 'Sort field' },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'UnifiedSearchResult', kind: 'object', description: 'Search results from all sources with source attribution' },
    examples: [
      '{ operation: "search_all", params: { query: "helper", sources: ["local", "collection"] } }',
      '{ operation: "search_all", params: { query: "creative", fields: "standard" } }',
    ],
  },
  portfolio_element_manager: {
    endpoint: 'CREATE',
    handler: 'syncHandler',
    method: 'handleSyncOperation',
    category: 'Portfolio Management',
    description: 'Manage individual elements between local and GitHub',
    optional: true,
    argBuilder: 'named',
    params: {
      operation: { type: 'string', required: true, description: 'list-remote, download, upload, compare' },
      element_name: { type: 'string', description: 'Element name to operate on' },
      element_type: { type: 'string', description: 'Element type' },
      filter: { type: 'object', description: 'Filter options for list operations' },
      options: { type: 'object', description: 'Operation options (force, dry_run, etc.)' },
    },
    returns: { name: 'ElementManagerResult', kind: 'object', description: 'Element management result: { action, element_name, success, message }' },
    examples: ['{ operation: "portfolio_element_manager", params: { operation: "download", element_name: "MyPersona", element_type: "persona" } }'],
  },
} as const;

// ============================================================================
// ElementCRUD Operations Schema (Issue #251)
// ============================================================================

/**
 * ElementCRUD operations schema - demonstrates input normalization pattern.
 *
 * PATTERN: Input Normalization
 * The 'type' parameter can come from two sources:
 * 1. input.elementType (top-level in OperationInput)
 * 2. params.type (inside the params object)
 *
 * The schema uses `sources` to define this fallback chain, and
 * `needsFullInput: true` tells SchemaDispatcher to provide full input access.
 *
 * This pattern is important for MCP-AQL adapters where external servers
 * may accept the same parameter in multiple locations.
 */
export const ELEMENT_CRUD_OPERATIONS: OperationSchemaMap = {
  create_element: {
    endpoint: 'CREATE',
    handler: 'elementCRUD',
    method: 'createElement',
    category: 'Element Lifecycle',
    description: 'Create a new element of any type. Note: Gatekeeper may return a confirmation prompt instead of creating immediately — use confirm_operation to approve, then retry.',
    needsFullInput: true,
    argBuilder: 'namedWithType',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type (persona, skill, template, agent, memory, ensemble)',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      description: { type: 'string', required: true, description: 'Element description' },
      // Issue #602 resolved: Both 'instructions' and 'content' are first-class fields with distinct semantic roles.
      instructions: { type: 'string', description: 'Behavioral INSTRUCTIONS — written in active/command voice as directives the AI must follow. For personas: "You ARE a security expert. ALWAYS check for vulnerabilities." For skills: "When triggered, ANALYZE code systematically. CHECK security FIRST." For agents: semantic behavioral profile — how the agent should behave (distinct from systemPrompt which is the raw LLM system message). For templates: rendering directives. Optional for memories and ensembles.' },
      content: { type: 'string', description: 'Reference material, knowledge, and context — informational text the element draws from. For skills: domain knowledge, examples, reference frameworks. For templates: the template body with variable placeholders (REQUIRED). For personas: background context and expertise areas. For agents: reference material for task execution. For memories: initial entry content.' },
      // --- Agent V2 goal (required for execute_agent) ---
      goal: { type: 'object', description: 'For agents: Goal configuration REQUIRED for execute_agent. Contains template (string with {param} placeholders), parameters (array of {name, type, required, description}), and optional successCriteria (or success_criteria, string array). Snake_case keys are auto-normalized.' },
      // --- Common fields — all element types (Issue #722) ---
      // Routed in SchemaDispatcher.buildArgs → namedWithType for any element_type.
      tags: { type: 'string[]', description: 'Tags for categorization and search (all element types). Example: ["code-review", "security", "automation"]' },
      triggers: { type: 'string[]', description: 'Action verbs that trigger this element (all element types). Example: ["review", "audit", "analyze"]' },
      // --- Agent V2 fields — only meaningful for agents (Issue #722) ---
      // Routed in SchemaDispatcher.buildArgs → namedWithType inside the isAgent guard.
      // Pipeline: SchemaDispatcher → createElement → AgentManager.create → serializeElement.
      // Note: snake_case variants (e.g. system_prompt, risk_tolerance, success_criteria) are
      // automatically normalized to camelCase at both the dispatcher and manager layers (Issue #725).
      activates: { type: 'object', description: 'For agents: Elements to activate when agent executes. Keys: skills, personas, memories, templates, ensembles. Values: string arrays of element names.' },
      tools: { type: 'object', description: 'For agents: Tool access policy. Contains allowed (required string array) and optional denied (string array).' },
      systemPrompt: { type: 'string', description: 'For agents: Custom system prompt injected into LLM context during execution. Also accepted as system_prompt.' },
      autonomy: { type: 'object', description: 'For agents: Autonomy configuration. Keys: riskTolerance (or risk_tolerance), maxAutonomousSteps (or max_autonomous_steps), requiresApproval (or requires_approval, glob patterns), autoApprove (or auto_approve, glob patterns). Snake_case keys are auto-normalized.' },
      resilience: { type: 'object', description: 'For agents: Resilience policy for failure recovery. Keys: onStepLimitReached (or on_step_limit_reached), onExecutionFailure (or on_execution_failure), maxRetries (or max_retries), maxContinuations (or max_continuations), retryBackoff (or retry_backoff), preserveState (or preserve_state). Snake_case keys are auto-normalized.' },
      category: { type: 'string', description: 'Category label for skills, templates, and memories. Must start with a letter, followed by letters, digits, hyphens, or underscores (max 21 chars). Example: "code-analysis". Not supported on personas, agents, or ensembles.' },
      // --- Security: element-level gatekeeper policy (all element types, Issue #726) ---
      // Layer 2 of the 3-layer gatekeeper system. Layer 1 (route policies) provides automatic
      // baseline security for ALL elements. Layer 2 lets you customize per-element access control.
      // Policies are DYNAMIC — they take effect when the element is activated and revert when deactivated.
      gatekeeper: { type: 'object', description: 'Per-element security policy that controls what operations are allowed when this element is active. Policies are dynamic — activate the element and the policy takes effect; deactivate it and the restrictions revert. This gives users composable security: a "no-web" persona blocks web access while active, a "read-only" skill auto-approves reads but blocks writes, an ensemble can lock down which agents may be executed. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?: string[], blockedTypes?: string[] }, externalRestrictions?: { description: string, allowPatterns?: string[], confirmPatterns?: string[], denyPatterns?: string[] } }. Use allow/confirm/deny for MCP-AQL operation patterns like "read_*", "edit_*", "execute_agent", or "delete_element". Use externalRestrictions for external tool or hook patterns like "Read:*", "Edit:*", "Bash:git status*", or "Bash:rm *". Priority: deny > confirm > allow > route default. scopeRestrictions limits which element types the policy applies to (e.g. allowedTypes: ["skill", "template"] means the policy only governs operations on those types). If omitted entirely, the element inherits system defaults which already include confirmation for sensitive operations.' },
      metadata: { type: 'object', description: 'Additional metadata. For ensembles: include elements array. For skills/templates/memories: category can also be passed here.' },
    },
    returns: { name: 'Element', kind: 'object', description: 'Created element with name, type, version, file path, and metadata' },
    examples: [
      // Issue #602: Dual-field examples showing both 'instructions' (behavioral) and 'content' (reference)
      '{ operation: "create_element", element_type: "persona", params: { element_name: "MyPersona", description: "A helpful assistant", instructions: "You ARE a helpful assistant. ALWAYS provide clear, accurate responses." } }',
      '{ operation: "create_element", element_type: "agent", params: { element_name: "CodeReviewer", description: "Automated code review agent", instructions: "You are methodical and thorough. ALWAYS check security first. Report issues by severity.", goal: { template: "Review {files} for {review_type} issues", parameters: [{ name: "files", type: "string", required: true }, { name: "review_type", type: "string", required: true }], successCriteria: ["Review completed", "Issues documented"] } } }',
      '{ operation: "create_element", element_type: "skill", params: { element_name: "CodeReview", description: "Reviews code for quality", instructions: "ANALYZE code systematically. CHECK security patterns FIRST. Report findings by severity.", content: "# Code Review Reference\\n\\n## Common Patterns\\n- OWASP Top 10\\n- CWE/SANS Top 25" } }',
      '{ operation: "create_element", element_type: "skill", params: { element_name: "read-only-review", description: "Review session with write restrictions", instructions: "When active, ALLOW browsing and analysis but REQUIRE confirmation for edits.", gatekeeper: { allow: ["read_*", "list_*", "search_*", "get_*"], confirm: ["create_*", "edit_*", "update_*"], deny: ["delete_*"], externalRestrictions: { description: "Review shell guardrails", allowPatterns: ["Read:*", "Glob:*", "Grep:*"], confirmPatterns: ["Edit:*", "Write:*", "Bash:git push*"], denyPatterns: ["Bash:rm *", "WebSearch:*"] } } } }',
      '{ operation: "create_element", element_type: "template", params: { element_name: "BugReport", description: "Bug report template", content: "## Bug Report\\n\\n**Summary:** {{summary}}\\n**Steps:** {{steps}}\\n**Expected:** {{expected}}", instructions: "Render all sections. NEVER omit required fields." } }',
      // Memory relationship patterns - naming conventions for element-linked memories:
      // agent-{name}-context: Agent execution state and learned behaviors
      '{ operation: "create_element", element_type: "memory", params: { element_name: "agent-code-reviewer-context", description: "Stores context and learned preferences for code-reviewer agent" } }',
      // persona-{name}-preferences: Persona personalization data
      '{ operation: "create_element", element_type: "memory", params: { element_name: "persona-teacher-preferences", description: "Learned preferences for teacher persona behavior" } }',
      // session-{purpose}: Cross-cutting session data used by multiple elements
      '{ operation: "create_element", element_type: "memory", params: { element_name: "session-context", description: "Shared context accessible to all active elements" } }',
      // project-{name}-{purpose}: Project-scoped knowledge
      '{ operation: "create_element", element_type: "memory", params: { element_name: "project-webapp-decisions", description: "Architecture decisions for the webapp project" } }',
      // Issue #1767: Ensemble example with valid roles (primary, support, override, monitor, core)
      '{ operation: "create_element", element_type: "ensemble", params: { element_name: "my-ensemble", description: "Combined element set", metadata: { elements: [{ element_name: "expert", element_type: "persona", role: "primary" }, { element_name: "analysis", element_type: "skill", role: "support" }] } } }',
    ],
  },
  list_elements: {
    endpoint: 'READ',
    handler: 'elementCRUD',
    method: 'listElements',
    category: 'Element Discovery',
    description: 'List elements with pagination, filtering, sorting, and aggregation. Returns structured JSON: { items, pagination, sorting, element_type }. Default: page 1, pageSize 20, sorted by name ascending. TIP: If the user wants to browse, explore, or view their portfolio visually, prefer open_portfolio_browser instead — it opens a full web UI with search, filters, and detail views.',
    needsFullInput: true,
    argBuilder: 'typeWithParams', // (type, fullParams) for pagination support
    params: {
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type to list (persona, skill, template, agent, memory, ensemble)',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      page: { type: 'number', default: 1, description: 'Page number (1-indexed)' },
      pageSize: { type: 'number', default: 20, description: 'Items per page (max 100)' },
      sortBy: { type: 'string', default: 'name', description: "Sort field: 'name', 'created', 'modified', 'version'" },
      sortOrder: { type: 'string', default: 'asc', description: "Sort direction: 'asc' or 'desc'" },
      nameContains: { type: 'string', description: 'Filter: partial name match (case-insensitive)' },
      tags: { type: 'string[]', description: 'Filter: must have ALL specified tags (AND logic)' },
      tagsAny: { type: 'string[]', description: 'Filter: must have ANY specified tag (OR logic)' },
      author: { type: 'string', description: 'Filter: by author username' },
      status: { type: 'string', description: "Filter: 'active', 'inactive', or 'all'" },
      category: { type: 'string', description: 'Filter: by category (case-insensitive)' },
      include_public: {
        type: 'boolean',
        default: false,
        mapTo: 'includePublic',
        description: "When true, results include public-visibility elements owned by other users (database mode). File mode: no effect until shared pool lands. Default: false (caller's own elements only).",
        sources: ['input.include_public', 'input.includePublic', 'params.include_public', 'params.includePublic'],
      },
      aggregate: { type: 'object', description: "Aggregation: { count: true } returns count only (~50 tokens). { count: true, group_by: 'category' } returns grouped counts. Allowed group_by fields: author, category, status, tags, version." },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: preset ("minimal", "standard", "full") or array of field names',
      },
    },
    returns: { name: 'ElementList', kind: 'object', description: 'Structured JSON: { items: [{ name, description, type, version, tags }], pagination: { page, pageSize, totalItems, totalPages, hasNextPage, hasPrevPage }, sorting: { sortBy, sortOrder }, element_type }. When aggregate is used: { count, element_type, groups? }' },
    examples: [
      '{ operation: "list_elements", element_type: "persona" }',
      // Response: { items: [{ name: "Default", description: "...", type: "persona", version: "1.0.0", tags: [...] }, ...], pagination: { page: 1, pageSize: 20, totalItems: 42, totalPages: 3, hasNextPage: true, hasPrevPage: false }, sorting: { sortBy: "name", sortOrder: "asc" }, element_type: "persona" }
      '{ operation: "list_elements", element_type: "persona", params: { page: 2, pageSize: 10 } }',
      '{ operation: "list_elements", element_type: "skill", params: { tags: ["typescript"], sortBy: "modified", sortOrder: "desc" } }',
      '{ operation: "list_elements", element_type: "persona", params: { aggregate: { count: true } } }',
      // Response: { count: 42, element_type: "persona" }
      '{ operation: "list_elements", element_type: "persona", params: { aggregate: { count: true, group_by: "category" } } }',
      // Response: { count: 42, element_type: "persona", groups: { "assistant": 15, "creative": 12, "technical": 15 } }
      '{ operation: "list_elements", element_type: "persona", params: { fields: "minimal" } }',
      // TIP: For visual browsing, use open_portfolio_browser instead:
      // { operation: "open_portfolio_browser", params: { tab: "portfolio", type: "persona" } }
    ],
  },
  get_element: {
    endpoint: 'READ',
    handler: 'elementCRUD',
    method: 'getElementDetails',
    category: 'Element Lifecycle',
    description: 'Get a specific element by name. TIP: If the user wants to browse or explore multiple elements rather than retrieve one specific element, prefer open_portfolio_browser instead.',
    needsFullInput: true,
    argBuilder: 'single', // (elementName, elementType)
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'Element', kind: 'object', description: 'Full element details' },
    examples: [
      '{ operation: "get_element", element_type: "persona", params: { element_name: "MyPersona" } }',
      '{ operation: "get_element", element_type: "skill", params: { element_name: "CodeReview", fields: "standard" } }',
    ],
  },
  // Issue #738: get_element_details currently shares the same code path as get_element
  // (both call ElementCRUDHandler.getElementDetails). It exists as a future divergence
  // point — get_element will remain a general-purpose read, while get_element_details
  // will return extended metadata (e.g., relationship graph, stack membership, gatekeeper
  // policy resolution, activation state, reverse dependencies) once that code path is built out.
  get_element_details: {
    endpoint: 'READ',
    handler: 'elementCRUD',
    method: 'getElementDetails',
    category: 'Element Lifecycle',
    description: 'Get detailed information about a specific element including extended metadata. TIP: If the user wants to browse or explore multiple elements rather than retrieve one specific element, prefer open_portfolio_browser instead.',
    needsFullInput: true,
    argBuilder: 'single', // (elementName, elementType)
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'ElementDetails', kind: 'object', description: 'Complete element with all metadata' },
    examples: [
      '{ operation: "get_element_details", element_type: "skill", params: { element_name: "CodeReview" } }',
      '{ operation: "get_element_details", element_type: "persona", params: { element_name: "Default", fields: ["element_name", "instructions"] } }',
    ],
  },
  edit_element: {
    endpoint: 'UPDATE',
    handler: 'elementCRUD',
    method: 'editElement',
    category: 'Element Lifecycle',
    description: 'Edit an element using GraphQL-aligned nested input objects',
    needsFullInput: true,
    argBuilder: 'namedWithType',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      input: { type: 'object', required: true, description: 'Nested object with fields to update (deep-merged with existing element). Common fields (all types): instructions, content, description, tags, triggers, category, gatekeeper. Agent fields: goal, activates, tools, systemPrompt (or system_prompt), autonomy, resilience. Ensemble fields: elements (array of { element_name, element_type, role, priority?, activation? } — merges by name; use _remove: true to remove). Gatekeeper: { allow?, confirm?, deny?, scopeRestrictions?: { allowedTypes?, blockedTypes? } } — dynamic security policy that takes effect when the element is active. Snake_case keys are auto-normalized to camelCase.' },
    },
    returns: { name: 'Element', kind: 'object', description: 'Updated element with deep-merged changes applied' },
    examples: [
      '{ operation: "edit_element", element_type: "persona", params: { element_name: "MyPersona", input: { instructions: "Updated behavioral directives for this persona." } } }',
      '{ operation: "edit_element", element_type: "agent", params: { element_name: "MyAgent", input: { instructions: "Updated agent behavioral profile.", goal: { template: "Complete: {task}", successCriteria: ["Task done"] } } } }',
      '{ operation: "edit_element", element_type: "skill", params: { element_name: "MySkill", input: { content: "Updated domain reference material.", metadata: { triggers: ["code", "review"] } } } }',
      '{ operation: "edit_element", element_type: "agent", params: { element_name: "MyAgent", input: { gatekeeper: { allow: ["read_*"], confirm: ["execute_agent"], deny: ["delete_element"] } } } }',
      '{ operation: "edit_element", element_type: "agent", params: { element_name: "MyAgent", input: { autonomy: { riskTolerance: "conservative", maxAutonomousSteps: 5 }, resilience: { onExecutionFailure: "retry", maxRetries: 3 } } } }',
      '{ operation: "edit_element", element_type: "ensemble", params: { element_name: "MyEnsemble", input: { elements: [{ element_name: "new-skill", element_type: "skill", role: "support" }] } } }',
    ],
  },
  upgrade_element: {
    endpoint: 'UPDATE',
    handler: 'elementCRUD',
    method: 'upgradeElement',
    category: 'Element Lifecycle',
    description: 'Upgrade element from v1 single-body format to v2.0 dual-field format (instructions + content). Reads existing body text, assigns to instructions or content based on element type, saves in new format with instructions in YAML frontmatter.',
    needsFullInput: true,
    argBuilder: 'namedWithType',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name to upgrade' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      dry_run: { type: 'boolean', description: 'Preview changes without writing to disk (default: false)' },
      instructions_override: { type: 'string', description: 'Manually specify instructions (overrides auto-detection from body text)' },
      content_override: { type: 'string', description: 'Manually specify content (overrides auto-detection)' },
    },
    returns: { name: 'UpgradeResult', kind: 'object', description: 'Upgrade result with preview of changes or confirmation of upgrade' },
    examples: [
      '{ operation: "upgrade_element", element_type: "persona", params: { element_name: "MyPersona", dry_run: true } }',
      '{ operation: "upgrade_element", element_type: "skill", params: { element_name: "CodeReview" } }',
    ],
  },
  validate_element: {
    endpoint: 'READ',
    handler: 'elementCRUD',
    method: 'validateElement',
    category: 'Element Lifecycle',
    description: 'Validate an existing element by name',
    needsFullInput: true,
    argBuilder: 'namedWithType',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      strict: { type: 'boolean', description: 'Use strict validation' },
    },
    returns: { name: 'ValidationResult', kind: 'object', description: 'Validation result: { valid, errors?, warnings?, info? }' },
    examples: ['{ operation: "validate_element", element_type: "template", params: { element_name: "BugReport", strict: true } }'],
  },
  delete_element: {
    endpoint: 'DELETE',
    handler: 'elementCRUD',
    method: 'deleteElement',
    category: 'Element Lifecycle',
    description: 'Delete an element',
    needsFullInput: true,
    argBuilder: 'namedWithType',
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      deleteData: { type: 'boolean', description: 'Also delete associated data' },
    },
    returns: { name: 'DeleteResult', kind: 'object', description: 'Deletion confirmation with element name and type' },
    examples: ['{ operation: "delete_element", element_type: "memory", params: { element_name: "OldMemory" } }'],
  },
  export_element: {
    endpoint: 'READ',
    handler: 'elementCRUD',
    method: '__export__', // Special marker - uses internal handler
    category: 'Element Lifecycle',
    description: 'Export an element to a portable format',
    needsFullInput: true,
    argBuilder: 'single', // (elementName, elementType, format)
    params: {
      element_name: { type: 'string', required: true, mapTo: 'elementName', description: 'Element name' },
      element_type: {
        type: 'string',
        required: true,
        mapTo: 'elementType',
        description: 'Element type',
        sources: ['input.element_type', 'input.elementType', 'params.element_type'],
      },
      format: { type: 'string', default: 'json', description: 'Export format (json or yaml)' },
    },
    returns: { name: 'ExportPackage', kind: 'object', description: 'Portable element package for sharing or backup' },
    examples: ['{ operation: "export_element", element_type: "persona", params: { element_name: "MyPersona", format: "yaml" } }'],
  },
  import_element: {
    endpoint: 'CREATE',
    handler: 'elementCRUD',
    method: '__import__', // Special marker - uses internal handler
    category: 'Element Lifecycle',
    description: 'Import an element from exported data',
    argBuilder: 'named',
    params: {
      data: { type: 'unknown', required: true, description: 'Export package data (string or object)' },
      overwrite: { type: 'boolean', description: 'Overwrite if exists' },
    },
    returns: { name: 'Element', kind: 'object', description: 'Imported element with resolved metadata and file path' },
    examples: ['{ operation: "import_element", params: { data: "{ ... export package ... }", overwrite: false } }'],
  },
} as const;

// ============================================================================
// Memory Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Memory operations schema — introspection-only.
 *
 * These operations are dispatched via MCPAQLHandler.dispatchMemory() which
 * performs memory instance lookup by name. They cannot be routed through
 * SchemaDispatcher without extracting that pre-processing logic.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
export const MEMORY_SCHEMAS: OperationSchemaMap = {
  addEntry: {
    endpoint: 'CREATE',
    handler: 'mcpAqlHandler',
    method: 'dispatchMemory',
    category: 'Memory',
    description: 'Add a new entry to a memory element',
    params: {
      element_name: { type: 'string', required: true, description: 'Memory element name' },
      content: { type: 'string', required: true, description: 'The text content of the entry. An entry = content + tags + metadata + system fields (timestamp, trust).' },
      tags: { type: 'string[]', description: 'Tags for categorizing this entry (e.g. ["important", "source:user"])' },
      metadata: { type: 'object', description: 'Structured metadata for correlation and tracking (e.g. { source: "api", correlationId: "req-123" })' },
    },
    returns: { name: 'MemoryEntry', kind: 'object', description: 'Created entry: { id, content, tags, metadata, timestamp, trustLevel, source }. All new entries start as "untrusted". Trust levels: untrusted → validated → trusted (or flagged/quarantined). Background validation promotes trust asynchronously.' },
    examples: [
      '{ operation: "addEntry", params: { element_name: "my-memory", content: "Remember this fact", tags: ["important"] } }',
      // Response: { _type: "MemoryEntry", id: "mem_...", content: "Remember this fact", tags: ["important"], timestamp: "2026-...", trustLevel: "untrusted", source: "unknown" }
      '{ operation: "addEntry", params: { element_name: "audit-log", content: "User performed action", tags: ["audit", "source:api"], metadata: { correlationId: "req-123" } } }',
      '{ operation: "addEntry", params: { element_name: "session-notes", content: "Key decision made" } }',
    ],
  },
  clear: {
    endpoint: 'DELETE',
    handler: 'mcpAqlHandler',
    method: 'dispatchMemory',
    category: 'Memory',
    description: 'Clear all entries from a memory element (irreversible)',
    params: {
      element_name: { type: 'string', required: true, description: 'Memory element name to clear' },
    },
    returns: { name: 'ClearResult', kind: 'object', description: 'Confirmation with element name and cleared entry count' },
    examples: [
      '{ operation: "clear", params: { element_name: "temp-memory" } }',
      // Response: { success: true, message: "Cleared all entries from temp-memory" }
    ],
  },
} as const;

// ============================================================================
// Execution Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Execution lifecycle operations schema — introspection-only.
 *
 * These operations are dispatched via MCPAQLHandler.dispatchExecute() which
 * performs agent state management, autonomy evaluation, and resilience checks.
 * They cannot be routed through SchemaDispatcher without extracting that
 * complex pre-processing logic.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
export const EXECUTION_SCHEMAS: OperationSchemaMap = {
  execute_agent: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Start execution of an agent. The agent must have a goal.template defined (set during create_element). Pass values for the template placeholders in parameters. ' +
      'Lifecycle: Elements listed in the agent\'s activates field (e.g., activates: { personas: ["Reviewer"], skills: ["code-analysis"] }) are automatically activated when execution begins — their gatekeeper policies, instructions, and capabilities become active for the duration. ' +
      'Resilience: If the agent has a resilience policy, it governs automatic recovery during execution. onStepLimitReached (pause|continue|restart) controls what happens when maxAutonomousSteps is hit. onExecutionFailure (pause|retry|restart-fresh) controls recovery from step failures. Additional fields: maxRetries (default 3), maxContinuations (default 10), retryBackoff (linear|exponential). Without a resilience policy, execution pauses at step limits and failures (safe default).',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent name (must already exist with a goal.template)' },
      parameters: { type: 'object', required: true, description: 'Values for the agent goal template placeholders. If goal.template is "Review {files} for {review_type} issues", pass { files: "src/*.ts", review_type: "security" }. For agents with parameterless templates, pass {}.' },
      maxAutonomousSteps: { type: 'number', description: 'Runtime override for max autonomous steps (overrides the agent\'s autonomy.maxAutonomousSteps). Interacts with resilience: if the agent has onStepLimitReached: "continue", execution auto-continues up to maxContinuations times after hitting this limit.' },
    },
    returns: { name: 'ExecuteAgentResult', kind: 'object', description: 'Execution result: { _type, agentName, goal, goalId, stateVersion, activeElements (elements activated via agent.activates), availableTools, successCriteria, safetyTier }' },
    examples: [
      // Matches CodeReviewer from create_element: goal.template = "Review {files} for {review_type} issues"
      '{ operation: "execute_agent", params: { element_name: "CodeReviewer", parameters: { files: "src/*.ts", review_type: "security" } } }',
      '{ operation: "execute_agent", params: { element_name: "CodeReviewer", parameters: { files: "lib/auth.ts", review_type: "quality" }, maxAutonomousSteps: 5 } }',
    ],
  },
  get_execution_state: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Query current execution state including progress and findings',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent or executable element name' },
      includeDecisionHistory: { type: 'boolean', description: 'Include decision history in response' },
      includeContext: { type: 'boolean', description: 'Include execution context in response' },
    },
    returns: { name: 'ExecutionState', kind: 'object', description: 'Current execution state with progress, decisions, and context' },
    examples: [
      '{ operation: "get_execution_state", params: { element_name: "code-reviewer", includeDecisionHistory: true } }',
    ],
  },
  record_execution_step: {
    endpoint: 'CREATE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Record execution progress, step completion, or findings. Returns autonomy directive with continue/pause decision and notifications.',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent or executable element name' },
      stepDescription: { type: 'string', required: true, description: 'Description of step completed' },
      outcome: { type: 'string', required: true, description: "Step outcome: 'success', 'failure', or 'partial'" },
      findings: { type: 'string', description: 'Step findings or results' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
      nextActionHint: { type: 'string', description: 'Hint about the next planned action (for autonomy evaluation)' },
      riskScore: { type: 'number', description: 'Risk score for the next action (0-100 integer, for autonomy evaluation). Higher values increase likelihood of autonomy pause.' },
    },
    returns: { name: 'StepResult', kind: 'object', description: 'Step result: { _type, success, message, decision: { id, goalId, decision, reasoning, confidence }, state: { goalCount, stateVersion }, autonomy: { continue, reason?, factors, stepsRemaining?, notifications?: [{ type, message }] } }' },
    examples: [
      '{ operation: "record_execution_step", params: { element_name: "code-reviewer", stepDescription: "Analyzed src/ directory", outcome: "success", findings: "Found 3 style issues", nextActionHint: "Apply fixes", riskScore: 25 } }',
      // Response: { _type: "StepResult", success: true, decision: { ... }, autonomy: { continue: true, factors: [...], stepsRemaining: 4 } }
    ],
  },
  complete_execution: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Signal that execution finished successfully with summary',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent or executable element name' },
      outcome: { type: 'string', required: true, description: "Execution outcome: 'success', 'failure', or 'partial'" },
      summary: { type: 'string', required: true, description: 'Summary of execution results' },
      goalId: { type: 'string', description: 'Goal ID if tracking specific goal' },
    },
    returns: { name: 'CompletionResult', kind: 'object', description: 'Goal completion status with metrics and updated stateVersion' },
    examples: [
      '{ operation: "complete_execution", params: { element_name: "code-reviewer", outcome: "success", summary: "Reviewed 15 files, found 3 issues" } }',
    ],
  },
  continue_execution: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Resume execution from saved state',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent or executable element name' },
      previousStepResult: { type: 'string', description: 'Result from previous step' },
      parameters: { type: 'object', description: 'Additional parameters for continuation' },
    },
    returns: { name: 'ContinueResult', kind: 'object', description: 'Resumed execution state with updated context and stateVersion' },
    examples: [
      '{ operation: "continue_execution", params: { element_name: "code-reviewer", previousStepResult: "Files analyzed" } }',
    ],
  },
  abort_execution: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Abort a running agent execution, rejecting further operations for the goalId',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent or executable element name to abort' },
      reason: { type: 'string', description: 'Reason for aborting the execution' },
    },
    returns: { name: 'AbortResult', kind: 'object', description: 'Abort confirmation: { _type, success, agentName, abortedGoalIds, reason, message }' },
    examples: [
      '{ operation: "abort_execution", params: { element_name: "code-reviewer", reason: "User requested cancellation" } }',
      // Response: { _type: "AbortResult", success: true, agentName: "code-reviewer", abortedGoalIds: ["goal_abc123"], reason: "User requested cancellation" }
    ],
  },
  get_gathered_data: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Get aggregated execution data (steps, decisions, findings, and summary statistics) for a specific goal',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent name' },
      goalId: { type: 'string', required: true, description: 'Goal ID to gather data for' },
    },
    returns: { name: 'GatheredData', kind: 'object', description: 'Aggregated data: { _type, goalId, agentName, entries, summary: { totalSteps, successfulSteps, averageConfidence }, goal }' },
    examples: [
      '{ operation: "get_gathered_data", params: { element_name: "code-reviewer", goalId: "goal_abc123" } }',
      // Response: { _type: "GatheredData", goalId: "goal_abc123", entries: [...], summary: { totalSteps: 5, successfulSteps: 4 } }
    ],
  },
  prepare_handoff: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Serialize goal progress into a portable handoff block for session transfer',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent name to prepare handoff for' },
      goalId: { type: 'string', required: true, description: 'Goal ID to include in the handoff' },
    },
    returns: { name: 'HandoffResult', kind: 'object', description: 'Handoff state snapshot: { _type, handoffState: { version, agentName, goalId, checksum }, handoffBlock: "human-readable header + compressed base64 payload" }' },
    examples: [
      '{ operation: "prepare_handoff", params: { element_name: "code-reviewer", goalId: "goal_abc123" } }',
      // Response: { _type: "HandoffResult",
      //   handoffState: { version: "1.0.0", agentName: "code-reviewer", goalId: "goal_abc123", checksum: "sha256..." },
      //   handoffBlock: "╔═══ AGENT HANDOFF ═══╗\n Agent: code-reviewer\n Goal: ...\n╚══════════════════════╝\n--- HANDOFF PAYLOAD START ---\n...base64...\n--- HANDOFF PAYLOAD END ---" }
    ],
  },
  resume_from_handoff: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchExecute',
    category: 'Agent Execution',
    description: 'Resume agent execution from a handoff block with integrity validation',
    params: {
      element_name: { type: 'string', required: true, description: 'Agent name to resume (must match handoff block)' },
      handoffBlock: { type: 'string', required: true, description: 'The full handoff block text (including payload markers)' },
      parameters: { type: 'object', description: 'Goal template parameters (same as execute_agent parameters)' },
    },
    returns: { name: 'ResumeResult', kind: 'object', description: 'Resumed execution with restoration metadata: { _type, agentName, goal, goalId, restoredFrom: { agentName, goalId, stepsCompleted, preparedAt } }' },
    examples: [
      '{ operation: "resume_from_handoff", params: { element_name: "code-reviewer", handoffBlock: "...full handoff block...", parameters: { task: "Review PR #42" } } }',
      // Response: { _type: "ResumeResult", agentName: "code-reviewer", goalId: "goal_new456", restoredFrom: { goalId: "goal_abc123", stepsCompleted: 5 } }
    ],
  },
} as const;

// ============================================================================
// Gatekeeper Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Gatekeeper operations schema — introspection-only.
 *
 * These operations are dispatched via MCPAQLHandler.dispatchGatekeeper() which
 * performs session-level confirmation tracking and danger zone verification.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
export const GATEKEEPER_SCHEMAS: OperationSchemaMap = {
  confirm_operation: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Confirm a pending operation that requires user approval (Gatekeeper flow)',
    params: {
      operation: { type: 'string', required: true, description: 'Operation name to confirm (e.g., "create_element")' },
      element_type: { type: 'string', description: 'Optional element type scope for the confirmation' },
    },
    returns: { name: 'ConfirmResult', kind: 'object', description: 'Confirmation status: { confirmed, operation, element_type?, message }' },
    examples: [
      '{ operation: "confirm_operation", params: { operation: "create_element" } }',
      // Response: { confirmed: true, operation: "create_element", message: "Operation confirmed for this session" }
    ],
  },
  verify_challenge: {
    endpoint: 'CREATE',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Submit verification code to unblock a danger zone operation',
    params: {
      challenge_id: { type: 'string', required: true, description: 'UUID v4 challenge ID from danger zone trigger' },
      code: { type: 'string', required: true, description: 'Verification code displayed to the user' },
    },
    returns: { name: 'VerifyResult', kind: 'object', description: 'Verification status: { verified, challenge_id, agentName?, message }' },
    examples: [
      '{ operation: "verify_challenge", params: { challenge_id: "550e8400-e29b-41d4-a716-446655440000", code: "ABC123" } }',
      // Response: { verified: true, challenge_id: "...", agentName: "my-agent", message: "Agent unblocked" }
    ],
  },
  beetlejuice_beetlejuice_beetlejuice: {
    endpoint: 'CREATE',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Safe-trigger the full danger zone verification pipeline for testing purposes',
    params: {
      agent_name: { type: 'string', description: 'Agent to block (defaults to "beetlejuice-test-agent")' },
    },
    returns: { name: 'BeetlejuiceResult', kind: 'object', description: 'Challenge details: { challenge_id, agentName, expiresAt, message }. Code is displayed via OS dialog, never in response.' },
    examples: [
      '{ operation: "beetlejuice_beetlejuice_beetlejuice" }',
      // Response: { challenge_id: "...", agentName: "beetlejuice-test-agent", expiresAt: "...", message: "Verification code displayed via system dialog" }
      '{ operation: "beetlejuice_beetlejuice_beetlejuice", params: { agent_name: "my-test-agent" } }',
    ],
  },
  // Issue #625: CLI-level permission delegation via --permission-prompt-tool
  // Issue #647: Moved to READ — policy evaluation is read-only
  permission_prompt: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Evaluate a CLI-level permission prompt (Bash, Edit, Write, MCP tools). Returns allow/deny decision for non-interactive Claude Code sessions using --permission-prompt-tool.',
    params: {
      tool_name: { type: 'string', required: true, description: 'The tool requesting permission (e.g., "Bash", "Edit", "Write", "mcp__server__tool")' },
      input: { type: 'object', required: true, description: 'The tool input parameters to evaluate (e.g., { command: "git push" } for Bash)' },
      agent_identity: { type: 'string', description: 'Optional: identity of the sub-agent making the request (from Claude Code --permission-prompt-tool)' },
    },
    returns: { name: 'PermissionDecision', kind: 'object', description: '{ behavior: "allow"|"deny", updatedInput?, message?, classification?: { riskLevel, reason, stage, riskScore?, irreversible? }, policyContext?: { evaluatedElements, decisionChain }, approvalRequest?: { requestId, toolName, riskLevel, riskScore, irreversible, reason } }. Risk scores: 0=safe, 40=moderate, 80=dangerous, 100=blocked; adjustments: irreversible(+10), network(+10), out-of-scope read(+10), file creation(+5). Stages: static_allow, static_deny, element_deny, element_allow, cli_approval, approval_required, default_allow.' },
    examples: [
      '{ operation: "permission_prompt", params: { tool_name: "Bash", input: { command: "npm test" } } }',
      '{ operation: "permission_prompt", params: { tool_name: "Edit", input: { file_path: "src/index.ts", old_string: "...", new_string: "..." } } }',
    ],
  },
  // Permission evaluation for PreToolUse hooks (all platforms)
  evaluate_permission: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Evaluate CLI permission for a tool via HTTP/hook. Returns platform-formatted response (claude_code, gemini, cursor, windsurf, codex). Alternative to permission_prompt for interactive sessions using PreToolUse hooks.',
    params: {
      tool_name: { type: 'string', required: true, description: 'The tool requesting permission (e.g., "Bash", "Edit", "Write")' },
      input: { type: 'object', description: 'The tool input parameters to evaluate' },
      platform: { type: 'string', description: 'Target platform for response formatting (default: "claude_code"). Options: claude_code, gemini, cursor, windsurf, codex' },
      session_id: { type: 'string', description: 'Optional persisted activation session ID to evaluate against when hooks run in a separate leader process' },
    },
    returns: { name: 'PlatformPermissionDecision', kind: 'object', description: 'Platform-formatted permission decision. Claude Code: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason? } }. Gemini: { decision: "allow"|"deny", reason? }. Cursor: { permission: "allow"|"deny"|"ask", reason? }. Windsurf: { allowed: boolean, reason? }. Codex: { hookSpecificOutput: { permissionDecision, reason? } }.' },
    examples: [
      '{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git status" } } }',
      '{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git push --force" }, platform: "claude_code", session_id: "claude-code-session" } }',
    ],
  },
  // Issue #625 Phase 2: CLI policy visibility
  get_effective_cli_policies: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Get effective CLI-level permission policies across all active elements',
    params: {
      tool_name: { type: 'string', description: 'Optional: evaluate a specific tool (e.g., "Bash", "Edit:src/index.ts")' },
      tool_input: { type: 'object', description: 'Optional: tool input to evaluate (e.g., { command: "npm test" })' },
    },
    returns: { name: 'EffectiveCliPolicies', kind: 'object', description: '{ activeElementCount, hasAllowlist, elements, combinedAllowPatterns, combinedDenyPatterns, evaluation? }' },
    examples: [
      '{ operation: "get_effective_cli_policies" }',
      '{ operation: "get_effective_cli_policies", params: { tool_name: "Bash", tool_input: { command: "git push" } } }',
    ],
  },
  // Issue #625 Phase 3: CLI approval workflow
  approve_cli_permission: {
    endpoint: 'EXECUTE',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Approve a pending CLI tool permission request. Used by bridges (Zulip, Slack) to relay human approval for tools that require it.',
    params: {
      request_id: { type: 'string', required: true, description: 'Approval request ID from permission_prompt deny response (format: cli-<UUID>)' },
      scope: { type: 'string', description: '"single" (default, consumed on use) or "tool_session" (all uses of that tool for the session)' },
    },
    returns: { name: 'ApproveResult', kind: 'object', description: '{ approved, requestId, toolName, scope, message }' },
    examples: [
      '{ operation: "approve_cli_permission", params: { request_id: "cli-abc..." } }',
      '{ operation: "approve_cli_permission", params: { request_id: "cli-abc...", scope: "tool_session" } }',
    ],
  },
  get_pending_cli_approvals: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchGatekeeper',
    category: 'Security & Permissions',
    description: 'Get all pending CLI tool approval requests for this session. Returns unapproved requests that are waiting for human authorization.',
    params: {},
    returns: { name: 'PendingApprovals', kind: 'object', description: '{ pending: CliApprovalRecord[], count: number }' },
    examples: [
      '{ operation: "get_pending_cli_approvals" }',
    ],
  },
} as const;

// ============================================================================
// Logging Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Logging operations schema — introspection-only.
 *
 * Dispatched via MCPAQLHandler.dispatchLogging() with runtime parameter
 * validation via validateLogQueryParams().
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
export const LOGGING_SCHEMAS: OperationSchemaMap = {
  query_logs: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchLogging',
    category: 'Configuration & Diagnostics',
    description: 'Query recent log entries from the in-memory buffer. Returns filtered, paginated results sorted newest-first. Only queries the hot tier (in-memory); evicted entries exist only in disk log files.',
    params: {
      category: { type: 'string', description: "Log category filter: 'application', 'security', 'performance', 'telemetry', or 'all'. Default: 'all'" },
      level: { type: 'string', description: "Minimum log level (inclusive): 'debug', 'info', 'warn', or 'error'. Omit for all levels" },
      source: { type: 'string', description: 'Component name filter (case-insensitive substring match)' },
      message: { type: 'string', description: 'Free text search in message field (case-insensitive substring match)' },
      since: { type: 'string', description: 'ISO 8601 timestamp — return entries after this time' },
      until: { type: 'string', description: 'ISO 8601 timestamp — return entries before this time' },
      limit: { type: 'number', description: 'Max results to return (1-500, default 50)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
      correlationId: { type: 'string', description: 'Correlation ID for request tracing' },
    },
    returns: { name: 'LogQueryResult', kind: 'object', description: 'Log entries: { _type: "LogQueryResult", entries, total, filters }' },
    examples: [
      '{ operation: "query_logs" }',
      // Response: { _type: "LogQueryResult", entries: [...], total: 42 }
      '{ operation: "query_logs", params: { category: "security", level: "warn", limit: 10 } }',
      '{ operation: "query_logs", params: { since: "2026-01-01T00:00:00Z", source: "Gatekeeper" } }',
    ],
  },
} as const;

// ============================================================================
// Metrics Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Metrics collection query schema — introspection-only.
 *
 * Dispatched via MCPAQLHandler.dispatchMetrics() which routes to
 * MemoryMetricsSink.query(). Follows the same pattern as query_logs.
 */
export const METRICS_SCHEMAS: OperationSchemaMap = {
  query_metrics: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchMetrics',
    category: 'Configuration & Diagnostics',
    description: 'Query collected metrics snapshots. Returns filtered, paginated results sorted newest-first. Supports filtering by metric name (prefix or exact), source, type, and time range.',
    params: {
      names: { type: 'string[]', description: "Metric name filters. Exact match or prefix match with trailing '.' or '.*' (e.g., 'system.memory.*')" },
      source: { type: 'string', description: 'Collector source filter (case-insensitive substring match)' },
      type: { type: 'string', description: "Metric type filter: 'counter', 'gauge', or 'histogram'" },
      since: { type: 'string', description: 'ISO 8601 timestamp — return snapshots after this time' },
      until: { type: 'string', description: 'ISO 8601 timestamp — return snapshots before this time' },
      latest: { type: 'boolean', description: 'If true (default), return only the most recent snapshot. Set false for historical range queries' },
      limit: { type: 'number', description: 'Max snapshots to return (1-100, default 1)' },
      offset: { type: 'number', description: 'Number of snapshots to skip for pagination (default 0)' },
    },
    returns: { name: 'MetricQueryResult', kind: 'object', description: 'Metric snapshots: { _type: "MetricQueryResult", snapshots, total, hasMore, oldestAvailable, newestAvailable }' },
    examples: [
      '{ operation: "query_metrics" }',
      '{ operation: "query_metrics", params: { names: ["system.memory.*"], type: "gauge" } }',
      '{ operation: "query_metrics", params: { latest: false, limit: 10, since: "2026-01-01T00:00:00Z" } }',
    ],
  },
} as const;

// ============================================================================
// Activation Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Activation lifecycle operations schema — introspection-only.
 *
 * These operations are dispatched via MCPAQLHandler.dispatchActivation() which
 * routes to ElementCRUDHandler activation strategies. They cannot be routed
 * through SchemaDispatcher without extracting that strategy-based dispatch logic.
 *
 * Issue #598: Activation state is now persisted per-session via ActivationStore.
 * Set DOLLHOUSE_SESSION_ID env var to isolate activation state between sessions.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 * @see Issue #598 - Per-session activation persistence
 */
export const ACTIVATION_SCHEMAS: OperationSchemaMap = {
  activate_element: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchActivation',
    category: 'Activation',
    description: 'Activate an element for use in the current session. Activation state is persisted per-session (DOLLHOUSE_SESSION_ID) and restored on server restart.',
    params: {
      element_name: { type: 'string', required: true, description: 'Name of the element to activate' },
      element_type: { type: 'string', required: true, description: 'Element type: persona, skill, agent, memory, or ensemble' },
    },
    returns: { name: 'ActivationResult', kind: 'object', description: 'Activation confirmation with element details and rendered content' },
    examples: [
      '{ operation: "activate_element", params: { element_name: "code-reviewer", element_type: "skill" } }',
      '{ operation: "activate_element", params: { element_name: "Creative Dev", element_type: "persona" } }',
    ],
  },
  deactivate_element: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchActivation',
    category: 'Activation',
    description: 'Deactivate an element, removing it from the current session. Persisted activation state is updated.',
    params: {
      element_name: { type: 'string', required: true, description: 'Name of the element to deactivate' },
      element_type: { type: 'string', required: true, description: 'Element type: persona, skill, agent, memory, or ensemble' },
    },
    returns: { name: 'DeactivationResult', kind: 'object', description: 'Deactivation confirmation with element name' },
    examples: [
      '{ operation: "deactivate_element", params: { element_name: "code-reviewer", element_type: "skill" } }',
    ],
  },
  get_active_elements: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchActivation',
    category: 'Activation',
    description: 'Get all currently active elements with rendered content, optionally filtered by type',
    params: {
      element_type: { type: 'string', description: 'Optional element type filter. Omit to get all active elements across all types.' },
    },
    returns: { name: 'ActiveElementsResult', kind: 'object', description: 'Active elements with rendered content, grouped by type when unfiltered' },
    examples: [
      '{ operation: "get_active_elements" }',
      '{ operation: "get_active_elements", params: { element_type: "skill" } }',
    ],
  },
} as const;

// ============================================================================
// Search Operations Schema (Introspection-Only)
// ============================================================================

/**
 * Search operations schema — introspection-only.
 *
 * These operations are dispatched via MCPAQLHandler.dispatchSearch() which
 * routes to ElementQueryService methods. They cannot be routed through
 * SchemaDispatcher without extracting that pre-processing logic.
 *
 * @see Issue #595 - Operation documentation coverage gate
 */
export const SEARCH_SCHEMAS: OperationSchemaMap = {
  search_elements: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchSearch',
    category: 'Element Discovery',
    description: 'Full-text search across element names, descriptions, and content with pagination and sorting. TIP: If the user wants to browse or explore their portfolio visually rather than get text results, prefer open_portfolio_browser with a q parameter instead — it opens a web UI with the search pre-populated.',
    params: {
      query: { type: 'string', required: true, description: 'Search query string (max 1000 characters)' },
      element_type: { type: 'string', description: 'Optional element type filter (searches all types if omitted)' },
      page: { type: 'number', description: 'Page number for pagination (1-indexed)' },
      pageSize: { type: 'number', description: 'Results per page' },
      sort: { type: 'object', description: 'Sort options: { sortBy, sortOrder }' },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'SearchResult', kind: 'object', description: 'Search results: { items: [{ type, name, description, matchedIn }], pagination: { page, pageSize, totalItems, totalPages }, sorting }' },
    examples: [
      '{ operation: "search_elements", params: { query: "creative" } }',
      '{ operation: "search_elements", element_type: "persona", params: { query: "assistant", pageSize: 10 } }',
      // TIP: For visual search, use open_portfolio_browser with q parameter:
      // { operation: "open_portfolio_browser", params: { tab: "portfolio", q: "creative" } }
    ],
  },
  query_elements: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchSearch',
    category: 'Element Discovery',
    description: 'Query elements with filters, sorting, pagination, and count aggregation. Returns structured JSON.',
    params: {
      element_type: { type: 'string', required: true, description: 'Element type to query (required)' },
      filters: { type: 'object', description: 'Filter options: { nameContains, tags, author, status, category }' },
      sort: { type: 'object', description: 'Sort options: { sortBy, sortOrder }' },
      pagination: { type: 'object', description: 'Pagination: { page, pageSize }' },
      aggregate: { type: 'object', description: 'Aggregation: { count?: boolean, group_by?: string }. group_by groups results by a metadata field and returns counts per group. Allowed group_by fields: category, author, tags, status, version. Use group_by: "category" to discover existing categories in the portfolio.' },
      fields: {
        type: 'string | string[]',
        description: 'Fields to include: array like ["element_name", "description"] OR preset: "minimal", "standard", "full"',
      },
    },
    returns: { name: 'QueryResult', kind: 'object', description: 'Query results: { items: [{ name, description, type, version, tags }], pagination, sorting, filters }. With aggregate: adds count (total), groups (if group_by used, e.g. { development: 5, security: 3 }).' },
    examples: [
      '{ operation: "query_elements", element_type: "persona", params: { filters: { tags: ["assistant"] } } }',
      '{ operation: "query_elements", element_type: "skill", params: { pagination: { page: 1, pageSize: 10 }, sort: { sortBy: "name" } } }',
      '{ operation: "query_elements", element_type: "skill", params: { aggregate: { count: true, group_by: "category" } } }',
      '{ operation: "query_elements", element_type: "template", params: { filters: { category: "security" }, aggregate: { count: true } } }',
    ],
  },
} as const;

// ============================================================================
// Aggregated Schema
// ============================================================================

/**
 * Schema-driven operations — used by SchemaDispatcher for dispatch.
 *
 * Only operations that can be fully dispatched through SchemaDispatcher
 * belong here. Operations with complex pre-processing (memory lookup,
 * agent state management, gatekeeper sessions, log validation) are in
 * INTROSPECTION_ONLY_SCHEMAS instead.
 */
export const SCHEMA_DRIVEN_OPERATIONS: OperationSchemaMap = {
  ...COLLECTION_OPERATIONS,
  ...AUTH_OPERATIONS,
  ...ENHANCED_INDEX_OPERATIONS,
  ...TEMPLATE_OPERATIONS,
  ...INTROSPECTION_OPERATIONS,
  ...PERSONA_OPERATIONS,
  ...CONFIG_OPERATIONS,
  ...PORTFOLIO_OPERATIONS,
  ...ELEMENT_CRUD_OPERATIONS,
} as const;

/**
 * Introspection-only schemas — metadata for operations dispatched by
 * legacy methods (dispatchMemory, dispatchExecute, dispatchGatekeeper,
 * dispatchLogging). These are NOT used for dispatch routing.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
/**
 * Browser operation schemas
 * @see Issue #774 - open portfolio browser
 */
export const BROWSER_SCHEMAS: OperationSchemaMap = {
  open_portfolio_browser: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchBrowser',
    category: 'Management Console',
    description: `Start the portfolio web UI and open it in the system browser. The web server runs on localhost:${env.DOLLHOUSE_WEB_CONSOLE_PORT} and shows all portfolio elements with search, filtering, and detail views. Supports URL parameters for deep-linking with pre-populated search, filters, and element navigation. Aliases: open_console, open_management_console, open_dollhouse_mcp.`,
    params: {
      tab: { type: 'string', description: 'Tab to open (portfolio, logs, metrics, permissions, setup). Default: last-used tab.', required: false },
      q: { type: 'string', description: 'Pre-populate search query on the target tab.' },
      type: { type: 'string', description: 'Filter by element type (persona, skill, template, agent, memory, ensemble) on portfolio tab.' },
      name: { type: 'string', description: 'Navigate directly to a specific element detail view on portfolio tab.' },
      level: { type: 'string', description: 'Filter by log level (debug, info, warn, error) on logs tab.' },
      category: { type: 'string', description: 'Filter by category on logs tab (application, security, performance).' },
      since: { type: 'string', description: 'Time range filter (ISO 8601 or relative: 5m, 1h, 24h, 7d) on logs/metrics tabs.' },
    },
    returns: { name: 'BrowserResult', kind: 'object', description: 'Confirmation with the URL of the opened browser' },
    examples: [
      '{ operation: "open_portfolio_browser" }',
      '{ operation: "open_portfolio_browser", params: { tab: "logs" } }',
      '{ operation: "open_portfolio_browser", params: { tab: "portfolio", q: "axiom", type: "persona" } }',
      '{ operation: "open_portfolio_browser", params: { tab: "logs", level: "error", since: "1h" } }',
    ],
  },
  open_logs: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchBrowser',
    category: 'Management Console',
    description: 'Open the management console directly on the logs tab. Supports URL parameters for pre-filtered views. Aliases: open_dollhouse_logs, open_dollhouse_mcp_logs.',
    params: {
      level: { type: 'string', description: 'Filter by minimum log level (debug, info, warn, error).' },
      category: { type: 'string', description: 'Filter by log category (application, security, performance).' },
      source: { type: 'string', description: 'Filter by log source component.' },
      q: { type: 'string', description: 'Search log messages.' },
      since: { type: 'string', description: 'Time range (ISO 8601 or relative: 5m, 1h, 24h, 7d).' },
    },
    returns: { name: 'BrowserResult', kind: 'object', description: 'Confirmation with the URL of the opened browser' },
    examples: [
      '{ operation: "open_logs" }',
      '{ operation: "open_logs", params: { level: "error", since: "1h" } }',
    ],
  },
  open_metrics: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchBrowser',
    category: 'Management Console',
    description: 'Open the management console directly on the metrics tab. Supports URL parameters for filtered views. Aliases: open_dollhouse_metrics, open_dollhouse_mcp_metrics.',
    params: {
      since: { type: 'string', description: 'Time range (15m, 30m, 1h).' },
      refresh: { type: 'number', description: 'Auto-refresh interval in seconds. 0 disables.' },
    },
    returns: { name: 'BrowserResult', kind: 'object', description: 'Confirmation with the URL of the opened browser' },
    examples: [
      '{ operation: "open_metrics" }',
      '{ operation: "open_metrics", params: { since: "1h", refresh: 5 } }',
    ],
  },
  open_permissions: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchBrowser',
    category: 'Management Console',
    description: 'Open the management console directly on the permissions tab. Aliases: open_dollhouse_permissions.',
    params: {},
    returns: { name: 'BrowserResult', kind: 'object', description: 'Confirmation with the URL of the opened browser' },
    examples: ['{ operation: "open_permissions" }'],
  },
  open_setup: {
    endpoint: 'READ',
    handler: 'mcpAqlHandler',
    method: 'dispatchBrowser',
    category: 'Management Console',
    description: 'Open the management console directly on the setup/install tab. Aliases: open_dollhouse_setup, open_installer.',
    params: {},
    returns: { name: 'BrowserResult', kind: 'object', description: 'Confirmation with the URL of the opened browser' },
    examples: ['{ operation: "open_setup" }'],
  },
} as const;

export const INTROSPECTION_ONLY_SCHEMAS: OperationSchemaMap = {
  ...MEMORY_SCHEMAS,
  ...EXECUTION_SCHEMAS,
  ...GATEKEEPER_SCHEMAS,
  ...LOGGING_SCHEMAS,
  ...METRICS_SCHEMAS,
  ...ACTIVATION_SCHEMAS,
  ...SEARCH_SCHEMAS,
  ...BROWSER_SCHEMAS,
} as const;

/**
 * All operation schemas — union of dispatch-driven and introspection-only.
 * Used by IntrospectionResolver for complete operation documentation.
 *
 * @see Issue #594 - Document all MCP-AQL operations via schema
 */
export const ALL_OPERATION_SCHEMAS: OperationSchemaMap = {
  ...SCHEMA_DRIVEN_OPERATIONS,
  ...INTROSPECTION_ONLY_SCHEMAS,
} as const;

/**
 * Check if an operation is schema-driven (used for SchemaDispatcher routing)
 */
export function isSchemaOperation(operation: string): boolean {
  return operation in SCHEMA_DRIVEN_OPERATIONS;
}

/**
 * Get schema definition for a schema-driven operation (dispatch routing)
 */
export function getOperationSchema(operation: string): OperationDef | undefined {
  return SCHEMA_DRIVEN_OPERATIONS[operation];
}

/**
 * Check if any operation schema exists (dispatch-driven or introspection-only)
 */
export function hasOperationSchema(operation: string): boolean {
  return operation in ALL_OPERATION_SCHEMAS;
}

/**
 * Get schema for any operation (dispatch-driven or introspection-only)
 */
export function getAnyOperationSchema(operation: string): OperationDef | undefined {
  return ALL_OPERATION_SCHEMAS[operation];
}

// ============================================================================
// Introspection Helpers (Issue #254)
// ============================================================================

/**
 * Parameter info format used by IntrospectionResolver
 * This interface matches what IntrospectionResolver expects
 */
export interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: unknown;
}

/**
 * Convert ParamSchema to ParameterInfo array for introspection
 *
 * @param schema - The ParamSchema from an operation definition
 * @returns Array of ParameterInfo for IntrospectionResolver
 */
export function schemaToParameterInfo(schema: ParamSchema | undefined): ParameterInfo[] {
  if (!schema) return [];

  return Object.entries(schema).map(([name, def]) => ({
    name,
    type: def.type,
    required: def.required ?? false,
    description: def.description ?? `${name} parameter`,
    ...(def.default !== undefined ? { default: def.default } : {}),
  }));
}

/**
 * Get all schema-driven operations with their full definitions
 * Used by SchemaDispatcher to iterate over dispatchable operations
 */
export function getAllSchemaOperations(): Record<string, OperationDef> {
  return SCHEMA_DRIVEN_OPERATIONS;
}

/**
 * Get all operation schemas (dispatch-driven + introspection-only)
 * Used by IntrospectionResolver for complete operation documentation
 */
export function getAllOperationSchemas(): Record<string, OperationDef> {
  return ALL_OPERATION_SCHEMAS;
}
