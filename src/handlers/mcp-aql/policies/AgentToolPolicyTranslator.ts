/**
 * Agent Tool Policy Translator (Issue #449)
 *
 * Translates an agent's `tools` configuration (allowed/denied endpoint names)
 * into an `ElementGatekeeperPolicy` that the Gatekeeper can enforce.
 *
 * This bridges the informational `AgentToolConfig` with the enforceable
 * Gatekeeper policy system, giving agent tool restrictions programmatic teeth.
 *
 * **Policy precedence:** This translator is only used when an agent has no
 * explicit `gatekeeper` policy. If both `gatekeeper` and `tools` are present,
 * the explicit `gatekeeper` policy takes precedence (see MCPAQLHandler).
 *
 * @module AgentToolPolicyTranslator
 */

import type { ElementGatekeeperPolicy } from '../GatekeeperTypes.js';
import type { AgentToolConfig } from '../../../elements/agents/types.js';
import { getOperationsForEndpoint } from '../OperationRouter.js';
import type { CRUDEndpoint } from '../OperationRouter.js';

/**
 * Operations that are exempt from tools-based deny synthesis.
 * These must always be available for agent lifecycle and safety flows.
 *
 * - **Execution lifecycle**: An agent must be able to manage its own execution
 *   (execute, get state, update state, complete, continue).
 * - **Safety system**: An agent must interact with Gatekeeper confirmation
 *   and danger zone verification flows.
 */
const EXEMPT_OPERATIONS = new Set([
  // Execution lifecycle — agent must manage its own execution
  'execute_agent',
  'get_execution_state',
  'record_execution_step',
  'complete_execution',
  'continue_execution',
  'abort_execution', // Issue #249
  'get_gathered_data', // Issue #68
  'prepare_handoff', // Issue #69
  'resume_from_handoff', // Issue #69
  // Safety system — agent must interact with Gatekeeper/verification
  'confirm_operation',
  'verify_challenge',
  'permission_prompt', // Issue #625: CLI-level permission delegation
  'approve_cli_permission', // Issue #625 Phase 3: CLI approval workflow
  'get_pending_cli_approvals', // Issue #625 Phase 3: CLI approval visibility
]);

/**
 * Maps MCP-AQL tool names (as used in `AgentToolConfig.allowed/denied`)
 * to their corresponding CRUD endpoint types in the OperationRouter.
 *
 * Tool names follow the format `mcp_aql_{endpoint}` and map to one of
 * the five CRUD endpoints: CREATE, READ, UPDATE, DELETE, EXECUTE.
 */
const ENDPOINT_TOOL_MAP = new Map<string, CRUDEndpoint>([
  ['mcp_aql_create', 'CREATE'],
  ['mcp_aql_read', 'READ'],
  ['mcp_aql_update', 'UPDATE'],
  ['mcp_aql_delete', 'DELETE'],
  ['mcp_aql_execute', 'EXECUTE'],
]);

/**
 * Translates an {@link AgentToolConfig} into an {@link ElementGatekeeperPolicy}.
 *
 * The translation works as follows:
 * - If `tools.allowed` is specified, all operations **not** in the allowed
 *   endpoints are added to the deny list (allowlist → denylist inversion).
 * - If `tools.denied` is specified, all operations from the denied endpoints
 *   are added to the deny list directly.
 * - Both `allowed` and `denied` can be specified simultaneously; their effects
 *   are cumulative (union of denied operations).
 *
 * Lifecycle and safety operations ({@link EXEMPT_OPERATIONS}) are **never**
 * included in the synthesized deny list, regardless of the tool config.
 *
 * @param toolConfig - The agent's tool configuration containing allowed/denied endpoint names
 * @returns A synthesized {@link ElementGatekeeperPolicy} with a deny list,
 *          or `undefined` if the config produces no restrictions
 *
 * @example
 * ```typescript
 * // Agent that can only read — all other endpoints denied
 * translateToolConfigToPolicy({ allowed: ['mcp_aql_read'] });
 * // → { deny: ['addEntry', 'clear', 'create_element', 'delete_element', 'edit_element', ...] }
 *
 * // Agent that cannot delete — only delete operations denied
 * translateToolConfigToPolicy({ allowed: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_execute'] });
 * // → { deny: ['clear', 'delete_element'] }
 *
 * // No restrictions — returns undefined
 * translateToolConfigToPolicy({ allowed: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_delete', 'mcp_aql_execute'] });
 * // → undefined
 * ```
 */
export function translateToolConfigToPolicy(
  toolConfig: AgentToolConfig
): ElementGatekeeperPolicy | undefined {
  const denySet = new Set<string>();

  if (toolConfig.allowed && toolConfig.allowed.length > 0) {
    // Compute the set of allowed operations from allowed endpoints
    const allowedOps = new Set<string>();
    for (const toolName of toolConfig.allowed) {
      const endpoint = ENDPOINT_TOOL_MAP.get(toolName);
      if (endpoint) {
        for (const op of getOperationsForEndpoint(endpoint)) {
          allowedOps.add(op);
        }
      }
    }

    // Everything NOT in the allowed set gets denied (except exempt operations)
    for (const endpoint of ENDPOINT_TOOL_MAP.values()) {
      for (const op of getOperationsForEndpoint(endpoint)) {
        if (!allowedOps.has(op) && !EXEMPT_OPERATIONS.has(op)) {
          denySet.add(op);
        }
      }
    }
  }

  if (toolConfig.denied && toolConfig.denied.length > 0) {
    // Add all operations from denied endpoints
    for (const toolName of toolConfig.denied) {
      const endpoint = ENDPOINT_TOOL_MAP.get(toolName);
      if (endpoint) {
        for (const op of getOperationsForEndpoint(endpoint)) {
          if (!EXEMPT_OPERATIONS.has(op)) {
            denySet.add(op);
          }
        }
      }
    }
  }

  if (denySet.size === 0) {
    return undefined;
  }

  return { deny: Array.from(denySet).sort() };
}
