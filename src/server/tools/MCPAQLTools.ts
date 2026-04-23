/**
 * MCP-AQL Tools - Unified query interface for AI agents
 *
 * Provides two endpoint modes configurable via MCP_AQL_ENDPOINT_MODE environment variable:
 *
 * ## Mode 1: CRUDE Endpoints (Default) - MCP_AQL_ENDPOINT_MODE=crude
 * 5 tools: mcp_aql_create, mcp_aql_read, mcp_aql_update, mcp_aql_delete, mcp_aql_execute (~4,300 tokens)
 *
 * ## Mode 2: Single Endpoint (Minimal) - MCP_AQL_ENDPOINT_MODE=single
 * 1 tool: mcp_aql (~350 tokens)
 * Ideal for multi-server deployments where token budget is constrained.
 *
 * Note: These tools are only registered when MCP_INTERFACE_MODE=mcpaql (default).
 * When MCP_INTERFACE_MODE=discrete, discrete tools are registered instead.
 *
 * ## Why 5 CRUDE Endpoints? (Default Mode)
 *
 * The 5-endpoint CRUDE pattern (Create, Read, Update, Delete, Execute) was chosen for:
 *
 * 1. **User Comprehension**: CRUDE extends CRUD with Execute for non-idempotent
 *    operations, making it easy for users to reason about what each endpoint can do.
 *
 * 2. **Platform Annotations**: MCP platforms like ChatGPT's apps require
 *    tool annotations that describe safety and destructiveness. The 5-endpoint
 *    split maps directly to distinct permission levels:
 *    - CREATE: additive, non-destructive (readOnlyHint: false, destructiveHint: false)
 *    - READ: safe, read-only (readOnlyHint: true, destructiveHint: false)
 *    - UPDATE: modifying, potentially destructive (readOnlyHint: false, destructiveHint: true)
 *    - DELETE: destructive (readOnlyHint: false, destructiveHint: true)
 *    - EXECUTE: non-idempotent, potentially destructive (readOnlyHint: false, destructiveHint: true)
 *
 * 3. **Granular Permission Control**: Users can grant READ endpoint full access
 *    while locking down CREATE, UPDATE, DELETE, and EXECUTE. This enables safe
 *    read-only integrations without exposing mutation capabilities.
 *
 * ## Why Single Endpoint? (Minimal Mode)
 *
 * The single-endpoint mode was added for:
 *
 * 1. **Token Efficiency**: ~350 tokens vs ~4,300 tokens (92% reduction)
 * 2. **Multi-Server Deployments**: When running multiple MCP servers, token
 *    budgets can be constrained. Single endpoint reduces overhead.
 * 3. **Simplified Integration**: Some clients prefer a single entry point.
 *
 * Security is maintained through server-side Gatekeeper enforcement - the
 * server determines which operation type is being executed and applies
 * appropriate permission checks.
 *
 * ## GraphQL-Style Introspection
 *
 * MCP-AQL follows GraphQL patterns for self-documentation. Tool descriptions
 * are generated dynamically from OPERATION_ROUTES, ensuring they always reflect
 * the current available operations.
 *
 * ### Introspection Examples
 *
 * List all available operations:
 * ```json
 * { "operation": "introspect", "params": { "query": "operations" } }
 * ```
 *
 * Get details for a specific operation (parameters, examples, return types):
 * ```json
 * { "operation": "introspect", "params": { "query": "operations", "name": "create_element" } }
 * ```
 *
 * Discover available types (e.g., ElementType enum values):
 * ```json
 * { "operation": "introspect", "params": { "query": "types", "name": "ElementType" } }
 * ```
 *
 * ### Design Philosophy
 *
 * - **Single source of truth**: OPERATION_ROUTES defines all operations
 * - **Dynamic descriptions**: Adding an operation to OPERATION_ROUTES automatically
 *   updates tool descriptions - no manual synchronization needed
 * - **Introspection-first**: LLMs discover parameters via introspect, not static docs
 * - **GraphQL heritage**: Patterns familiar to any LLM trained on GraphQL
 */

import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';
import { UnifiedEndpoint } from '../../handlers/mcp-aql/UnifiedEndpoint.js';
import { getOperationsForEndpoint, type CRUDEndpoint } from '../../handlers/mcp-aql/OperationRouter.js';
import { ElementType } from '../../handlers/mcp-aql/types.js';
import type { ToolDefinition, ToolHandler } from '../../handlers/types/ToolTypes.js';
import { env } from '../../config/env.js';
import { ELEMENT_ROLES } from '../../elements/ensembles/constants.js';

// ============================================================================
// Dynamic Description Generation
// ============================================================================

/**
 * Get element types as a comma-separated string.
 * Derived from the ElementType enum to ensure consistency.
 */
function getElementTypesString(): string {
  return Object.values(ElementType).join(', ');
}

/**
 * Get operations for an endpoint as a comma-separated string.
 * Derived from OPERATION_ROUTES to ensure consistency.
 */
function getOperationsString(endpoint: CRUDEndpoint): string {
  return getOperationsForEndpoint(endpoint).join(', ');
}

// ============================================================================
// Tool Schema
// ============================================================================

/**
 * Shared input schema for CRUD operations (create, read, update, delete)
 * All operations use the OperationInput structure from the GraphQL schema
 */
const operationInputSchema = {
  type: "object" as const,
  properties: {
    operation: {
      type: "string",
      description: "Operation name to execute"
    },
    element_type: {
      type: "string",
      description: "Target element type (optional)"
    },
    params: {
      type: "object",
      description: "Operation parameters"
    },
    operations: {
      type: "array",
      description: "Array of operations for batch execution",
      items: {
        type: "object",
        properties: {
          operation: { type: "string" },
          element_type: { type: "string" },
          params: { type: "object" }
        },
        required: ["operation"]
      }
    }
  },
  required: ["operation" as const]
};

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Get MCP-AQL tools for registration in the ToolRegistry.
 *
 * Returns different tools based on MCP_AQL_ENDPOINT_MODE environment variable:
 * - 'crude' (default): 5 CRUDE endpoints (Create, Read, Update, Delete, Execute) (~4,300 tokens)
 * - 'single': 1 unified endpoint (~350 tokens)
 *
 * Note: MCP_AQL_MODE is supported as a deprecated alias for backward compatibility.
 */
export function getMCPAQLTools(handler: MCPAQLHandler): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  // Use MCP_AQL_ENDPOINT_MODE, falling back to deprecated MCP_AQL_MODE for backward compatibility
  const mode = env.MCP_AQL_ENDPOINT_MODE ?? env.MCP_AQL_MODE ?? 'crude';

  if (mode === 'single') {
    return getUnifiedTools(handler);
  }

  // Default: CRUDE mode (5 endpoints)
  return getCRUDETools(handler);
}

/**
 * Get the unified single endpoint tool (MCP_AQL_MODE=single)
 * Token footprint: ~300-400 tokens
 */
function getUnifiedTools(handler: MCPAQLHandler): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  const unifiedEndpoint = new UnifiedEndpoint(handler);

  // Build dynamic description from OPERATION_ROUTES
  const description = `DollhouseMCP unified API - GraphQL-style query interface for AI element management.

CRUDE Operations:
- CREATE: ${getOperationsString('CREATE')}
- READ: ${getOperationsString('READ')}
- UPDATE: ${getOperationsString('UPDATE')}
- DELETE: ${getOperationsString('DELETE')}
- EXECUTE: ${getOperationsString('EXECUTE')}

Element types: ${getElementTypesString()}

Quick start examples:
{ operation: "list_elements", element_type: "persona" }
{ operation: "create_element", element_type: "persona", params: { element_name: "MyPersona", description: "A helpful assistant", instructions: "You ARE a helpful assistant. ALWAYS provide clear, accurate responses." } }
{ operation: "create_element", element_type: "agent", params: { element_name: "MyAgent", description: "Task executor", instructions: "Execute goals methodically. Report progress at each step.", goal: { template: "Complete: {objective}", parameters: [{ name: "objective", type: "string", required: true }] } } }
{ operation: "create_element", element_type: "memory", params: { element_name: "session-notes", description: "Session context and notes" } }
{ operation: "addEntry", params: { element_name: "session-notes", content: "Remember this fact", tags: ["important"] } }
{ operation: "execute_agent", params: { element_name: "MyAgent", parameters: { objective: "Review code" } } }
{ operation: "record_execution_step", params: { element_name: "MyAgent", stepDescription: "Reviewed auth module", outcome: "success", findings: "Found 2 issues" } }
{ operation: "complete_execution", params: { element_name: "MyAgent", outcome: "success", summary: "Review complete" } }

Execution loop: call execute_agent once to start, then record_execution_step after
each work chunk, then complete_execution when done. Use continue_execution only to
resume a paused execution, and pass the same goal parameters you used for
execute_agent when resuming.

Gatekeeper: Some operations may return a confirmation prompt instead of executing immediately. Use confirm_operation to approve, then retry.

Discover all operations:
{ operation: "introspect", params: { query: "operations" } }`;

  return [
    {
      tool: {
        name: "mcp_aql",
        description,
        inputSchema: operationInputSchema,
        annotations: {
          // Unified endpoint can perform any operation, so we use conservative hints
          // The actual operation's safety is enforced server-side by Gatekeeper
          readOnlyHint: false,
          destructiveHint: true // Conservative: some operations are destructive
        }
      },
      handler: async (args: any) => {
        const result = await unifiedEndpoint.handle(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }
  ];
}

/**
 * Get the 5 CRUDE endpoint tools (MCP_AQL_ENDPOINT_MODE=crude, default)
 * CRUDE = Create, Read, Update, Delete, Execute
 * Token footprint: ~4,300 tokens (measured via Claude Code /context)
 *
 * Descriptions are generated dynamically from OPERATION_ROUTES to ensure
 * they always reflect the current available operations.
 */
function getCRUDETools(handler: MCPAQLHandler): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  const elementTypes = getElementTypesString();

  return [
    // mcp_aql_create - Additive, non-destructive operations
    {
      tool: {
        name: "mcp_aql_create",
        description: `Additive, non-destructive operations.

Supported operations: ${getOperationsString('CREATE')}

Element types: ${elementTypes}

These operations add new data without removing or overwriting existing content.

Quick start examples:
{ operation: "create_element", element_type: "persona", params: { element_name: "MyPersona", description: "A helpful assistant", instructions: "You ARE a helpful assistant. ALWAYS provide clear, accurate responses." } }
{ operation: "create_element", element_type: "agent", params: { element_name: "MyAgent", description: "Task executor", instructions: "Execute goals methodically. Report progress at each step.", goal: { template: "Complete: {objective}", parameters: [{ name: "objective", type: "string", required: true }] } } }
{ operation: "create_element", element_type: "memory", params: { element_name: "session-notes", description: "Session context and notes" } }
{ operation: "create_element", element_type: "ensemble", params: { element_name: "my-ensemble", description: "Combined element set", metadata: { elements: [{ element_name: "expert", element_type: "persona", role: "primary" }, { element_name: "analysis", element_type: "skill", role: "support" }] } } }
Valid ensemble roles: ${ELEMENT_ROLES.join(', ')}
{ operation: "addEntry", params: { element_name: "session-notes", content: "Remember this fact", tags: ["important"] } }
Note: addEntry content supports markdown (headers, lists, bold, tables, code blocks). Ensure markdown content is properly JSON-escaped — use ${String.raw`\n`} for newlines, ${String.raw`\"`} for quotes, and ${String.raw`\\`} for backslashes within the JSON string value.

Execution lifecycle — record agent progress (appends step records, like addEntry):
{ operation: "record_execution_step", params: { element_name: "code-reviewer", stepDescription: "Analyzed files", outcome: "success", findings: "Found 3 issues" } }
This is the normal next lifecycle call after mcp_aql_execute { operation: "execute_agent", ... }.
Response flow: record_execution_step returns { autonomy: { continue, factors, notifications? } }. Check autonomy.continue to decide whether to proceed. Check autonomy.notifications for permission_pending (gatekeeper blocks), autonomy_pause, or danger_zone alerts to relay to human operators.

Import & portfolio:
{ operation: "import_element", element_type: "skill", params: { element_name: "code-formatter", data: "..." } }
{ operation: "import_persona", params: { source: "/path/to/persona.md" } }
{ operation: "install_collection_content", params: { element_type: "persona", element_name: "Creative-Writer" } }
{ operation: "submit_collection_content", params: { element_type: "skill", element_name: "code-formatter" } }
{ operation: "init_portfolio" }
{ operation: "sync_portfolio" }
{ operation: "portfolio_element_manager", params: { action: "push", element_type: "persona", element_name: "Tech-Writer" } }

Auth & verification:
{ operation: "setup_github_auth" }
{ operation: "configure_oauth", params: { client_id: "your-client-id" } }
{ operation: "verify_challenge", params: { code: "ABC123" } }
{ operation: "release_deadlock" }
{ operation: "beetlejuice_beetlejuice_beetlejuice" }

Batch operations: Use the operations array to execute multiple operations sequentially in a single request.
{ operations: [{ operation: "addEntry", params: { element_name: "log", content: "Step 1" } }, { operation: "addEntry", params: { element_name: "log", content: "Step 2" } }] }

Discover required parameters — use mcp_aql_read:
{ operation: "introspect", params: { query: "operations", name: "create_element" } }
Discover element format specs (required fields, syntax, examples) — use mcp_aql_read:
{ operation: "introspect", params: { query: "format", name: "template" } }`,
        inputSchema: operationInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false
        }
      },
      handler: async (args: any) => {
        const result = await handler.handleCreate(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    },

    // mcp_aql_read - Safe, read-only operations
    {
      tool: {
        name: "mcp_aql_read",
        description: `Safe, read-only operations.

Supported operations: ${getOperationsString('READ')}

Element types: ${elementTypes}

These queries only read data and never modify server state.

Quick start examples:
{ operation: "list_elements", element_type: "persona" }
{ operation: "get_active_elements", element_type: "persona" }
{ operation: "search_elements", params: { query: "creative" } }
{ operation: "get_element", element_type: "memory", params: { element_name: "session-notes" } }

Element operations:
{ operation: "activate_element", element_type: "persona", params: { element_name: "Default" } }
{ operation: "deactivate_element", element_type: "persona", params: { element_name: "Default" } }
{ operation: "get_element_details", element_type: "skill", params: { element_name: "code-review" } }
{ operation: "query_elements", element_type: "persona", params: { filters: { category: "creative" } } }
{ operation: "validate_element", element_type: "agent", params: { element_name: "task-planner" } }
{ operation: "render", params: { element_name: "meeting-notes", variables: { date: "2026-03-03" } } }
{ operation: "export_element", element_type: "persona", params: { element_name: "Tech-Writer" } }
{ operation: "open_portfolio_browser" }
{ operation: "open_logs" }
{ operation: "open_metrics" }
{ operation: "open_permissions" }
{ operation: "open_setup" }

Memory-specific search (filter by tags):
{ operation: "search", params: { query: "*", type: "memory", filters: { tags: ["important"] } } }

Execution lifecycle — read-only queries:
{ operation: "get_execution_state", params: { element_name: "code-reviewer" } }
{ operation: "get_gathered_data", params: { element_name: "code-reviewer", goalId: "goal-id" } }

Collection:
{ operation: "browse_collection", params: { section: "personas" } }
{ operation: "search_collection", params: { query: "creative" } }
{ operation: "search_collection_enhanced", params: { query: "creative", page: 1 } }
{ operation: "get_collection_content", params: { element_type: "persona", element_name: "Creative-Writer" } }
{ operation: "get_collection_cache_health" }

Portfolio:
{ operation: "portfolio_status" }
{ operation: "portfolio_config" }
{ operation: "search_portfolio", params: { query: "creative" } }
{ operation: "search_all", params: { query: "creative" } }

System:
{ operation: "dollhouse_config" }
{ operation: "get_build_info" }
{ operation: "get_cache_budget_report" }
{ operation: "query_logs", params: { level: "error", limit: 10 } }
{ operation: "query_metrics" }
{ operation: "query_metrics", params: { names: ["system.memory.*"], type: "gauge" } }
{ operation: "convert_skill_format", params: { direction: "agent_to_dollhouse", agent_skill: { "SKILL.md": "---\\nname: my-skill\\ndescription: test\\n---\\n\\nUse this skill." } } }
{ operation: "convert_skill_format", params: { direction: "agent_to_dollhouse", security_mode: "warn", path_mode: "lossless", agent_skill: { "SKILL.md": "---\\nname: my-skill\\ndescription: test\\n---\\n\\nUse this skill." } } }
{ operation: "convert_skill_format", params: { direction: "dollhouse_to_agent", path_mode: "lossless", dollhouse_markdown: "---\\nname: my-skill\\ndescription: test\\ninstructions: Use this skill.\\n---\\n\\n### binaries/logo.png\\n(binary link: ./skills/binaries/logo.png)" } }

Auth:
{ operation: "check_github_auth" }
{ operation: "oauth_helper_status" }

Gatekeeper & CLI policies:
{ operation: "permission_prompt", params: { tool: "Bash", prompt: "run npm test" } }
{ operation: "evaluate_permission", params: { tool_name: "Bash", input: { command: "git status" }, platform: "claude_code" } }
{ operation: "get_effective_cli_policies" }
{ operation: "get_pending_cli_approvals" }
{ operation: "get_permission_authority" }
{ operation: "get_permission_authority", params: { host: "claude-code" } }

Enhanced index:
{ operation: "find_similar_elements", params: { element_type: "persona", element_name: "Creative-Writer" } }
{ operation: "get_element_relationships", params: { element_type: "skill", element_name: "code-review" } }
{ operation: "search_by_verb", params: { verb: "review" } }
{ operation: "get_relationship_stats" }

Discover all operations and parameters:
{ operation: "get_capabilities" }
{ operation: "get_capabilities", params: { category: "Element Lifecycle" } }
{ operation: "introspect", params: { query: "operations" } }`,
        inputSchema: operationInputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false
        }
      },
      handler: async (args: any) => {
        const result = await handler.handleRead(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    },

    // mcp_aql_update - Modifying operations that overwrite data
    {
      tool: {
        name: "mcp_aql_update",
        description: `Modifying operations that overwrite data.

Supported operations: ${getOperationsString('UPDATE')}

Element types: ${elementTypes}

These operations modify existing data, potentially overwriting previous values.

Note: Memories are append-only and do not support edit_element. Use addEntry (CREATE) to add new entries.

Quick start example:
{ operation: "edit_element", element_type: "persona", params: { element_name: "MyPersona", input: { description: "Updated description" } } }
{ operation: "edit_element", element_type: "persona", params: { element_name: "Friendly-Teacher", input: { instructions: "Updated behavioral directives." } } }
{ operation: "edit_element", element_type: "agent", params: { element_name: "code-reviewer", input: { instructions: "Updated agent behavioral profile.", goal: { template: "Complete: {task}" } } } }
{ operation: "upgrade_element", element_type: "agent", params: { element_name: "task-planner" } }

Discover required parameters — use mcp_aql_read:
{ operation: "introspect", params: { query: "operations", name: "edit_element" } }`,
        inputSchema: operationInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true
        }
      },
      handler: async (args: any) => {
        const result = await handler.handleUpdate(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    },

    // mcp_aql_delete - Destructive operations that remove data
    {
      tool: {
        name: "mcp_aql_delete",
        description: `Destructive operations that remove data.

Supported operations: ${getOperationsString('DELETE')}

Element types: ${elementTypes}

These operations remove data. Use with caution.

⚠️ SECURITY: Do not auto-allow this endpoint in your host settings (e.g., Claude Code settings.json). Each delete operation should require explicit human approval. Auto-allowing bypasses the per-operation confirmation gate, leaving only element deny policies as protection against unintended data loss.

Quick start examples:
{ operation: "delete_element", element_type: "persona", params: { element_name: "Old-Persona" } }
{ operation: "clear", params: { element_name: "temp-notes" } }
{ operation: "clear_github_auth" }

Discover required parameters — use mcp_aql_read:
{ operation: "introspect", params: { query: "operations", name: "delete_element" } }`,
        inputSchema: operationInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true
        }
      },
      handler: async (args: any) => {
        const result = await handler.handleDelete(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    },

    // mcp_aql_execute - Execution lifecycle operations (CRUDE's 'E')
    {
      tool: {
        name: "mcp_aql_execute",
        description: `Execution lifecycle operations for executable elements (agents, workflows, pipelines).

Supported operations: ${getOperationsString('EXECUTE')}

These operations manage runtime execution state. Unlike CRUD operations (which manage definitions), Execute operations handle the execution lifecycle:
- execute_agent: Start a new execution (returns goalId and stateVersion for tracking)
- complete_execution: Signal successful completion once the goal is done
- continue_execution: Resume a previously paused execution with the same goal parameters
- abort_execution: Abort a running execution, rejecting further operations
- confirm_operation: Confirm a pending operation that requires user approval (Gatekeeper flow)
- approve_cli_permission: Approve a pending CLI tool permission request
- prepare_handoff: Serialize goal progress into a portable handoff block for session transfer
- resume_from_handoff: Resume agent execution from a handoff block with integrity validation

IMPORTANT: Execute operations are potentially destructive (agents can perform any action) and non-idempotent (calling execute_agent twice creates two separate executions).

⚠️ SECURITY: Do not auto-allow this endpoint in your host settings (e.g., Claude Code settings.json). Each execution should require explicit human approval. Auto-allowing bypasses the per-operation confirmation gate. While DangerZone verification and element deny policies still provide protection, the primary human review checkpoint is lost.

Canonical loop:
1. Call execute_agent once to start the goal and receive { goalId, stateVersion, activeElements, safetyTier, ... }.
2. After each chunk of work, use mcp_aql_create: { operation: "record_execution_step", ... }.
3. Read record_execution_step.autonomy.continue and any autonomy.notifications to decide whether to continue, pause for a human, or handle a gatekeeper block.
4. When the goal is finished, call complete_execution.
Use continue_execution only when an already-started goal was paused and you are resuming it with the same goal parameters. It is not the normal next call after execute_agent.

Quick start examples:
{ operation: "execute_agent", params: { element_name: "code-reviewer", parameters: { objective: "Review code" } } }
Next lifecycle step — use mcp_aql_create:
{ operation: "record_execution_step", params: { element_name: "code-reviewer", stepDescription: "Reviewed auth module", outcome: "success", findings: "Found 2 security issues" } }
{ operation: "complete_execution", params: { element_name: "code-reviewer", outcome: "success", summary: "Completed review" } }
{ operation: "abort_execution", params: { element_name: "data-collector", reason: "User requested cancellation" } }
{ operation: "continue_execution", params: { element_name: "rubric-qa-agent", previousStepResult: "Verified citation set", parameters: { run_dir: "/app/run", deliverable_path: "/app/run/output.docx" } } }
{ operation: "confirm_operation", params: { operation: "execute_agent" } }
{ operation: "approve_cli_permission", params: { request_id: "req-123", decision: "allow" } }
{ operation: "prepare_handoff", params: { element_name: "code-reviewer" } }
{ operation: "resume_from_handoff", params: { element_name: "code-reviewer", handoff_block: "..." } }

Discover required parameters — use mcp_aql_read:
{ operation: "introspect", params: { query: "operations", name: "execute_agent" } }`,
        inputSchema: operationInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true  // Potentially destructive - agents can perform any action
        }
      },
      handler: async (args: any) => {
        const result = await handler.handleExecute(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }
  ];
}
