/**
 * Operation Router for MCP-AQL
 *
 * Maps MCP operations to CRUD endpoints (CREATE, READ, UPDATE, DELETE)
 * and their corresponding handler implementations.
 *
 * This routing table enables the unified MCP-AQL endpoint to dispatch
 * operations to the appropriate handlers based on their semantic meaning.
 */

export type CRUDEndpoint = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE' | 'EXECUTE';

/**
 * Handler reference in dot notation format: "Module.method"
 * Examples: "ElementCRUD.create", "Memory.addEntry", "Agent.execute"
 *
 * The format is resolved by MCPAQLHandler to actual manager method calls.
 * @see src/handlers/mcp-aql/MCPAQLHandler.ts for resolution logic
 */
export type HandlerReference = `${string}.${string}`;

/**
 * Route definition for an MCP operation
 */
export interface OperationRoute {
  /** CRUD endpoint this operation maps to */
  endpoint: CRUDEndpoint;
  /** Handler method responsible for executing this operation (format: "Module.method") */
  handler: HandlerReference;
  /** Optional description of what this operation does */
  description?: string;
  /** Alternative names that resolve to this operation */
  aliases?: string[];
  /** Parameters automatically injected when this operation is dispatched (merged under user params) */
  implicitParams?: Record<string, unknown>;
}

/**
 * Complete mapping of MCP operations to their CRUDE endpoints and handlers.
 *
 * Endpoint semantics (CRUDE = CRUD + Execute):
 * - CREATE: Operations that create new state (readOnly: false, destructive: false)
 * - READ: Operations that only read existing state (readOnly: true, destructive: false)
 * - UPDATE: Operations that modify existing state (readOnly: false, destructive: true)
 * - DELETE: Operations that remove state (readOnly: false, destructive: true)
 * - EXECUTE: Operations for runtime execution lifecycle (readOnly: false, destructive: false, stateful: true)
 */
export const OPERATION_ROUTES: Record<string, OperationRoute> = {
  // ===== CREATE endpoint (readOnly: false, destructive: false) =====
  create_element: {
    endpoint: 'CREATE',
    handler: 'ElementCRUD.create',
    description: 'Create a new element of any type',
  },
  import_element: {
    endpoint: 'CREATE',
    handler: 'ElementCRUD.import',
    description: 'Import an element from exported data',
  },
  addEntry: {
    endpoint: 'CREATE',
    handler: 'Memory.addEntry',
    description: 'Add a new entry to a memory element',
  },
  activate_element: {
    endpoint: 'READ',
    handler: 'Activation.activate',
    description: 'Activate an element for use in the current session',
  },
  // Issue #774: Open portfolio browser in system browser
  open_portfolio_browser: {
    endpoint: 'READ',
    handler: 'Browser.open',
    description: 'Start the portfolio web UI and open it in the system browser',
    aliases: [
      'open_console',
      'open_management_console',
      'open_dollhouse_console',
      'open_dollhouse_mcp',
      'open_dollhouse_mcp_console',
      'open_web_console',
    ],
  },
  // Console tab deep-link operations
  open_logs: {
    endpoint: 'READ',
    handler: 'Browser.open',
    description: 'Open the management console on the logs tab',
    aliases: ['open_dollhouse_logs', 'open_dollhouse_mcp_logs', 'open_log_viewer'],
    implicitParams: { tab: 'logs' },
  },
  open_metrics: {
    endpoint: 'READ',
    handler: 'Browser.open',
    description: 'Open the management console on the metrics tab',
    aliases: ['open_dollhouse_metrics', 'open_dollhouse_mcp_metrics', 'open_metrics_dashboard'],
    implicitParams: { tab: 'metrics' },
  },
  open_permissions: {
    endpoint: 'READ',
    handler: 'Browser.open',
    description: 'Open the management console on the permissions tab',
    aliases: ['open_dollhouse_permissions', 'open_dollhouse_mcp_permissions'],
    implicitParams: { tab: 'permissions' },
  },
  open_setup: {
    endpoint: 'READ',
    handler: 'Browser.open',
    description: 'Open the management console on the setup/install tab',
    aliases: ['open_dollhouse_setup', 'open_dollhouse_mcp_setup', 'open_installer'],
    implicitParams: { tab: 'setup' },
  },
  // Issue #452: Gatekeeper confirmation flow
  // Routed through EXECUTE so MCP clients can gate it separately from CREATE.
  // confirm_operation is non-idempotent and acts as a human-in-the-loop checkpoint —
  // it must not silently auto-approve when only CREATE is allowed.
  confirm_operation: {
    endpoint: 'EXECUTE',
    handler: 'Gatekeeper.confirm',
    description: 'Confirm a pending operation that requires user approval',
  },
  // Issue #625: CLI-level permission delegation via --permission-prompt-tool
  // Issue #647: Moved to READ — this is a policy evaluation (read-only), not a state mutation.
  // Enables --permission-prompt-tool to point at mcp_aql_read.
  permission_prompt: {
    endpoint: 'READ',
    handler: 'Gatekeeper.permissionPrompt',
    description: 'Evaluate CLI-level permission prompts for non-interactive sessions via --permission-prompt-tool',
  },
  // Permission evaluation for PreToolUse hooks (interactive sessions, all platforms)
  evaluate_permission: {
    endpoint: 'READ',
    handler: 'Gatekeeper.evaluatePermission',
    description: 'Evaluate CLI permission for a tool via HTTP/hook. Returns platform-formatted response (claude_code, gemini, cursor, windsurf, codex).',
  },
  // Issue #625 Phase 2: CLI policy visibility
  get_effective_cli_policies: {
    endpoint: 'READ',
    handler: 'Gatekeeper.getEffectiveCliPolicies',
    description: 'Get effective CLI permission policies for the current session (Issue #625 Phase 2)',
  },
  // Issue #625 Phase 3: CLI approval workflow
  approve_cli_permission: {
    endpoint: 'EXECUTE',
    handler: 'Gatekeeper.approveCliPermission',
    description: 'Approve a pending CLI tool permission request (Issue #625 Phase 3)',
  },
  get_pending_cli_approvals: {
    endpoint: 'READ',
    handler: 'Gatekeeper.getPendingCliApprovals',
    description: 'Get pending CLI tool approval requests for this session (Issue #625 Phase 3)',
  },
  // Issue #142: Danger zone verification flow
  verify_challenge: {
    endpoint: 'CREATE',
    handler: 'Gatekeeper.verify',
    description: 'Submit verification code to unblock a danger zone operation',
  },
  // Issue #503: Beetlejuice safe-trigger for danger zone verification testing
  beetlejuice_beetlejuice_beetlejuice: {
    endpoint: 'CREATE',
    handler: 'Gatekeeper.beetlejuice',
    description: 'Safe-trigger the full danger zone verification pipeline for testing purposes',
  },

  // ===== READ endpoint (readOnly: true, destructive: false) =====
  // Unified search operation (Issue #243)
  search: {
    endpoint: 'READ',
    handler: 'UnifiedSearch.search',
    description: 'Unified search across local, GitHub, and collection sources with scope parameter',
  },
  list_elements: {
    endpoint: 'READ',
    handler: 'ElementCRUD.list',
    description: 'List elements with pagination (default 20/page), filtering, sorting, and count aggregation. Returns structured JSON.',
  },
  get_element: {
    endpoint: 'READ',
    handler: 'ElementCRUD.get',
    description: 'Get an element by name and type, returning full content and metadata',
  },
  get_element_details: {
    endpoint: 'READ',
    handler: 'ElementCRUD.getDetails',
    description: 'Get detailed information about a specific element',
  },
  search_elements: {
    endpoint: 'READ',
    handler: 'Search.search',
    description: 'Full-text search across element names, descriptions, and content. Returns structured JSON with pagination.',
  },
  query_elements: {
    endpoint: 'READ',
    handler: 'Search.query',
    description: 'Query elements with filters, sorting, pagination, and count aggregation. Returns structured JSON.',
  },
  get_active_elements: {
    endpoint: 'READ',
    handler: 'Activation.getActive',
    description: 'Get all currently active elements with rendered content, optionally filtered by type',
  },
  validate_element: {
    endpoint: 'READ',
    handler: 'ElementCRUD.validate',
    description: 'Validate an existing element by name',
  },
  render: {
    endpoint: 'READ',
    handler: 'Template.render',
    description: 'Render a template with provided variables',
  },
  export_element: {
    endpoint: 'READ',
    handler: 'ElementCRUD.export',
    description: 'Export an element to a portable format',
  },
  deactivate_element: {
    endpoint: 'READ',
    handler: 'Activation.deactivate',
    description: 'Deactivate an element, removing it from the current session',
  },
  introspect: {
    endpoint: 'READ',
    handler: 'Introspection.resolve',
    description: 'Query available operations and types for discovery',
  },

  // ===== UPDATE endpoint (readOnly: false, destructive: true) =====
  edit_element: {
    endpoint: 'UPDATE',
    handler: 'ElementCRUD.edit',
    description: 'Edit a single field on an element',
  },
  upgrade_element: {
    endpoint: 'UPDATE',
    handler: 'ElementCRUD.upgrade',
    description: 'Upgrade element from v1 single-body to v2 dual-field format (instructions + content)',
  },

  // ===== DELETE endpoint (readOnly: false, destructive: true) =====
  delete_element: {
    endpoint: 'DELETE',
    handler: 'ElementCRUD.delete',
    description: 'Delete an element',
  },
  clear: {
    endpoint: 'DELETE',
    handler: 'Memory.clear',
    description: 'Clear all entries from a memory element (irreversible)',
  },

  // ===== EXECUTE endpoint (runtime execution lifecycle) =====
  // These operations manage the execution lifecycle of executable elements
  // (agents, workflows, pipelines). Unlike CRUD which manages definitions,
  // EXECUTE manages runtime state and is inherently non-idempotent.
  execute_agent: {
    endpoint: 'EXECUTE',
    handler: 'Execute.execute',
    description: 'Start execution of an agent or executable element',
  },
  get_execution_state: {
    endpoint: 'READ',
    handler: 'Execute.getState',
    description: 'Query current execution state including progress and findings',
  },
  record_execution_step: {
    endpoint: 'CREATE',
    handler: 'Execute.updateState',
    description: 'Record execution progress, step completion, or findings. Returns autonomy directive with continue/pause decision and notifications.',
  },
  complete_execution: {
    endpoint: 'EXECUTE',
    handler: 'Execute.complete',
    description: 'Signal that execution finished successfully with summary',
  },
  continue_execution: {
    endpoint: 'EXECUTE',
    handler: 'Execute.continue',
    description: 'Resume execution from saved state',
  },
  abort_execution: {
    endpoint: 'EXECUTE',
    handler: 'Execute.abort',
    description: 'Abort a running agent execution, rejecting further operations for the goalId',
  },
  get_gathered_data: {
    endpoint: 'READ',
    handler: 'Execute.getGatheredData',
    description: 'Get aggregated execution data (steps, decisions, findings, and summary statistics) for a specific goal. Use after record_execution_step calls to review progress.',
  },
  prepare_handoff: {
    endpoint: 'EXECUTE',
    handler: 'Execute.prepareHandoff',
    description: 'Prepare a session handoff package: serializes goal progress, gathered data, and active elements into a compressed, integrity-checked block that can be copy-pasted to resume in another session.',
  },
  resume_from_handoff: {
    endpoint: 'EXECUTE',
    handler: 'Execute.resumeFromHandoff',
    description: 'Resume agent execution from a handoff block. Validates integrity, verifies agent name match, restores context, and continues execution with caller-supplied parameters.',
  },

  // ===== COLLECTION operations =====
  browse_collection: {
    endpoint: 'READ',
    handler: 'Collection.browse',
    description: 'Browse the DollhouseMCP community collection by section and type',
  },
  search_collection: {
    endpoint: 'READ',
    handler: 'Collection.search',
    description: 'Search the community collection for elements by keywords',
  },
  search_collection_enhanced: {
    endpoint: 'READ',
    handler: 'Collection.searchEnhanced',
    description: 'Advanced search with pagination, filtering, and sorting',
  },
  get_collection_content: {
    endpoint: 'READ',
    handler: 'Collection.getContent',
    description: 'Get detailed information about content from the collection',
  },
  get_collection_cache_health: {
    endpoint: 'READ',
    handler: 'Collection.getCacheHealth',
    description: 'Get health status and statistics for the collection cache',
  },
  install_collection_content: {
    endpoint: 'CREATE',
    handler: 'Collection.install',
    description: 'Install an element from the collection to your local portfolio',
  },
  submit_collection_content: {
    endpoint: 'CREATE',
    handler: 'Collection.submit',
    description: 'Submit a local element to the community collection via GitHub',
  },

  // ===== PORTFOLIO operations =====
  portfolio_status: {
    endpoint: 'READ',
    handler: 'Portfolio.status',
    description: 'Check GitHub portfolio repository status and element counts',
  },
  portfolio_config: {
    endpoint: 'READ',
    handler: 'Portfolio.config',
    description: 'Configure portfolio settings (auto-sync, visibility, etc.)',
  },
  search_portfolio: {
    endpoint: 'READ',
    handler: 'Portfolio.search',
    description: 'Search local portfolio by content name, keywords, or tags',
  },
  search_all: {
    endpoint: 'READ',
    handler: 'Portfolio.searchAll',
    description: 'Unified search across local, GitHub, and collection sources',
  },
  init_portfolio: {
    endpoint: 'CREATE',
    handler: 'Portfolio.init',
    description: 'Initialize a new GitHub portfolio repository',
  },
  sync_portfolio: {
    endpoint: 'CREATE',
    handler: 'Portfolio.sync',
    description: 'Sync local portfolio with GitHub repository',
  },
  portfolio_element_manager: {
    endpoint: 'CREATE',
    handler: 'Portfolio.elementManager',
    description: 'Manage individual elements between local and GitHub',
  },

  // ===== AUTH operations =====
  setup_github_auth: {
    endpoint: 'CREATE',
    handler: 'Auth.setup',
    description: 'Set up GitHub authentication using device flow',
  },
  check_github_auth: {
    endpoint: 'READ',
    handler: 'Auth.check',
    description: 'Check current GitHub authentication status',
  },
  clear_github_auth: {
    endpoint: 'DELETE',
    handler: 'Auth.clear',
    description: 'Remove GitHub authentication and disconnect',
  },
  configure_oauth: {
    endpoint: 'CREATE',
    handler: 'Auth.configureOAuth',
    description: 'Configure GitHub OAuth client ID',
  },
  oauth_helper_status: {
    endpoint: 'READ',
    handler: 'Auth.oauthHelperStatus',
    description: 'Get diagnostic information about OAuth helper process',
  },

  // ===== CONFIG operations =====
  dollhouse_config: {
    endpoint: 'READ',
    handler: 'Config.manage',
    description: 'Manage DollhouseMCP configuration settings',
  },
  convert_skill_format: {
    endpoint: 'READ',
    handler: 'Config.convertSkillFormat',
    description: 'Convert between current Agent Skill and Dollhouse Skill formats with structured warnings and roundtrip support',
  },
  get_build_info: {
    endpoint: 'READ',
    handler: 'Config.getBuildInfo',
    description: 'Get comprehensive build and runtime information',
  },
  get_cache_budget_report: {
    endpoint: 'READ',
    handler: 'Config.getCacheBudgetReport',
    description: 'Get global cache memory budget report with per-cache diagnostics',
  },

  // ===== LOGGING operations =====
  query_logs: {
    endpoint: 'READ',
    handler: 'Logging.query',
    description: 'Query recent log entries from the in-memory buffer with filtering and pagination',
  },

  // ===== METRICS operations =====
  query_metrics: {
    endpoint: 'READ',
    handler: 'Metrics.query',
    description: 'Query collected metrics snapshots with filtering by name, source, type, and time range',
  },

  // ===== ENHANCED INDEX operations =====
  find_similar_elements: {
    endpoint: 'READ',
    handler: 'EnhancedIndex.findSimilar',
    description: 'Find semantically similar elements using NLP scoring',
  },
  get_element_relationships: {
    endpoint: 'READ',
    handler: 'EnhancedIndex.getRelationships',
    description: 'Get all relationships for a specific element',
  },
  search_by_verb: {
    endpoint: 'READ',
    handler: 'EnhancedIndex.searchByVerb',
    description: 'Search for elements that handle a specific action verb',
  },
  get_relationship_stats: {
    endpoint: 'READ',
    handler: 'EnhancedIndex.getStats',
    description: 'Get statistics about Enhanced Index relationships',
  },

  // ===== PERSONA operations =====
  import_persona: {
    endpoint: 'CREATE',
    handler: 'Persona.import',
    description: 'Import a persona from a file path or JSON string',
  },
} as const;

/**
 * Get the route definition for a given operation name.
 *
 * @param operation - The operation name (e.g., 'create_element', 'list_elements')
 * @returns The route definition, or undefined if the operation is not found
 *
 * @example
 * ```typescript
 * const route = getRoute('create_element');
 * // { endpoint: 'CREATE', handler: 'ElementCRUD.create', description: '...' }
 * ```
 */
/**
 * Resolve an operation name to its canonical form, checking aliases.
 * Returns the canonical operation name, or the input if no alias matches.
 */
export function resolveOperationName(operation: string): string {
  if (operation in OPERATION_ROUTES) return operation;
  for (const [canonical, route] of Object.entries(OPERATION_ROUTES)) {
    if (route.aliases?.includes(operation)) return canonical;
  }
  return operation;
}

export function getRoute(operation: string): OperationRoute | undefined {
  const canonical = resolveOperationName(operation);
  return OPERATION_ROUTES[canonical];
}

/**
 * Get all operations that map to a specific CRUD endpoint.
 *
 * @param endpoint - The CRUD endpoint ('CREATE', 'READ', 'UPDATE', 'DELETE')
 * @returns Array of operation names that map to this endpoint
 *
 * @example
 * ```typescript
 * const createOps = getOperationsForEndpoint('CREATE');
 * // ['create_element', 'import_element', 'addEntry']
 * ```
 */
export function getOperationsForEndpoint(endpoint: CRUDEndpoint): string[] {
  return Object.entries(OPERATION_ROUTES)
    .filter(([_, route]) => route.endpoint === endpoint)
    .map(([operation, _]) => operation);
}
