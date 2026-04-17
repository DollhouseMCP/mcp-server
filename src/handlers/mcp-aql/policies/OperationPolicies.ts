/**
 * Operation Policies
 *
 * Default permission levels are derived from the operation's endpoint routing:
 * - READ    → AUTO_APPROVE (read-only, no side effects)
 * - CREATE  → CONFIRM_SESSION (additive state changes, safe once approved)
 * - UPDATE  → CONFIRM_SINGLE_USE (modifying existing data, each instance reviewed)
 * - DELETE  → CONFIRM_SINGLE_USE (destructive, each instance reviewed)
 * - EXECUTE → CONFIRM_SINGLE_USE (unpredictable side effects)
 *
 * OPERATION_POLICY_OVERRIDES contains only operations that deviate from their
 * endpoint default — e.g., operations that need stricter policies, special
 * canBeElevated flags, or looser defaults than their endpoint implies.
 *
 * Resolution hierarchy:
 * 1. Element policy (Layer 2 — active element allow/confirm/deny lists)
 * 2. Explicit override in OPERATION_POLICY_OVERRIDES
 * 3. Endpoint default (derived from OperationRouter)
 * 4. Secure fallback: CONFIRM_SINGLE_USE for unknown operations
 *
 * Examples:
 *
 *   activate_element → READ endpoint → AUTO_APPROVE (no override needed)
 *     Routing to READ is sufficient. No entry in OPERATION_POLICY_OVERRIDES.
 *
 *   create_element → CREATE endpoint → CONFIRM_SESSION (no override needed)
 *     Endpoint default handles it. First create confirms, rest of session is smooth.
 *
 *   verify_challenge → CREATE endpoint → overridden to AUTO_APPROVE
 *     On CREATE (default CONFIRM_SESSION) but must be frictionless to avoid
 *     requiring confirmation to complete a verification flow.
 *
 *   delete_element → DELETE endpoint → CONFIRM_SINGLE_USE + canBeElevated: false
 *     Matches endpoint default level, but override locks canBeElevated so no
 *     element policy can silently auto-approve deletions.
 *
 *   record_execution_step → CREATE endpoint → CONFIRM_SESSION (no override needed)
 *     Moved from EXECUTE to CREATE so it inherits CONFIRM_SESSION, matching
 *     the polling loop's need for session-level frictionless approval.
 *
 *   A persona with gatekeeper: { confirm: ['create_element'] } → CONFIRM_SESSION
 *     Element policy (Layer 2) can tighten or loosen within what the operation allows.
 *     This is a runtime override via element activation, not a code change.
 */

import { PermissionLevel, type OperationPolicy } from '../GatekeeperTypes.js';
import { getRoute, OPERATION_ROUTES, type CRUDEndpoint } from '../OperationRouter.js';

/**
 * Map CRUDE endpoints to their default permission levels.
 *
 * This is the single source of truth for what each endpoint implies.
 * If an operation is routed to READ, it gets AUTO_APPROVE unless overridden.
 */
const ENDPOINT_DEFAULT_LEVELS: Record<CRUDEndpoint, PermissionLevel> = {
  READ: PermissionLevel.AUTO_APPROVE,
  CREATE: PermissionLevel.CONFIRM_SESSION,
  UPDATE: PermissionLevel.CONFIRM_SINGLE_USE,
  DELETE: PermissionLevel.CONFIRM_SINGLE_USE,
  EXECUTE: PermissionLevel.CONFIRM_SINGLE_USE,
};

/**
 * Get the default permission level for a CRUDE endpoint.
 *
 * @param endpoint - The CRUDE endpoint
 * @returns The default permission level for that endpoint
 */
export function getEndpointDefaultLevel(endpoint: CRUDEndpoint): PermissionLevel {
  return ENDPOINT_DEFAULT_LEVELS[endpoint];
}

/**
 * Explicit policy overrides for operations that deviate from their endpoint default.
 *
 * Only add entries here when an operation needs:
 * - A different permission level than its endpoint implies
 * - A canBeElevated: false restriction
 * - A specific rationale that differs from the endpoint's general rationale
 *
 * Operations NOT listed here inherit their permission level from their endpoint.
 */
export const OPERATION_POLICY_OVERRIDES: Record<string, OperationPolicy> = {
  // ===== CREATE endpoint overrides =====
  // These are on CREATE (default CONFIRM_SESSION) but need AUTO_APPROVE
  verify_challenge: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'Verification flow — must be auto-approved to avoid requiring confirmation to verify',
  },
  release_deadlock: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'Deadlock relief flow — requires out-of-band verification and must remain reachable even when confirmations are blocked',
    canBeElevated: false,
  },
  beetlejuice_beetlejuice_beetlejuice: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'Test fixture for danger zone verification — must be auto-approved to avoid requiring confirmation to test',
  },

  // ===== DELETE endpoint overrides =====
  // These match the endpoint default (CONFIRM_SINGLE_USE) but need canBeElevated: false
  delete_element: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Destructive operation, permanently removes data',
    canBeElevated: false,
  },
  clear: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Destructive operation, clears all memory entries',
    canBeElevated: false,
  },
  clear_github_auth: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Destructive operation, removes authentication credentials',
    canBeElevated: false,
  },

  // ===== EXECUTE endpoint overrides =====
  // These are on EXECUTE (default CONFIRM_SINGLE_USE) but need different levels

  // Must be auto-approved to avoid infinite confirmation loops
  confirm_operation: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'Gatekeeper confirmation flow — must be auto-approved to avoid requiring confirmation to confirm',
  },
  // Issue #625: CLI-level permission delegation
  permission_prompt: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'Permission evaluation flow — must be auto-approved to avoid infinite permission loops',
    canBeElevated: false,
  },
  // Issue #625 Phase 3: CLI approval workflow
  approve_cli_permission: {
    defaultLevel: PermissionLevel.AUTO_APPROVE,
    rationale: 'CLI approval flow — must be auto-approved to avoid requiring confirmation to approve',
    canBeElevated: false,
  },

  // Note: get_execution_state and get_gathered_data moved to READ endpoint —
  // they inherit AUTO_APPROVE from the endpoint default, no override needed.
  // record_execution_step moved to CREATE endpoint —
  // it inherits CONFIRM_SESSION from the endpoint default, no override needed.

  // Session-confirmable lifecycle operations (less friction than per-use)
  complete_execution: {
    defaultLevel: PermissionLevel.CONFIRM_SESSION,
    rationale: 'Signals execution completion, part of active execution',
    canBeElevated: true,
  },
  continue_execution: {
    defaultLevel: PermissionLevel.CONFIRM_SESSION,
    rationale: 'Resumes execution from saved state',
    canBeElevated: true,
  },
  prepare_handoff: {
    defaultLevel: PermissionLevel.CONFIRM_SESSION,
    rationale: 'Prepares session handoff snapshot, read-heavy with serialization',
    canBeElevated: true,
  },

  // Non-elevatable execute operations (match endpoint default but lock elevation)
  execute_agent: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Executes agent with unpredictable side effects',
    canBeElevated: false,
  },
  abort_execution: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Terminates agent execution, rejecting further operations for the goalId',
    canBeElevated: false,
  },
  resume_from_handoff: {
    defaultLevel: PermissionLevel.CONFIRM_SINGLE_USE,
    rationale: 'Resumes execution from external handoff data, requires validation',
    canBeElevated: false,
  },
};

/**
 * @deprecated Use OPERATION_POLICY_OVERRIDES instead.
 * Kept as an alias for backward compatibility with code that imports OPERATION_POLICIES.
 */
export const OPERATION_POLICIES = OPERATION_POLICY_OVERRIDES;

/**
 * Get the explicit policy override for an operation, if one exists.
 *
 * @param operation - The operation name
 * @returns The override policy, or undefined if no override exists
 */
export function getOperationPolicy(operation: string): OperationPolicy | undefined {
  return OPERATION_POLICY_OVERRIDES[operation];
}

/**
 * Get the default permission level for an operation.
 *
 * Resolution order:
 * 1. Explicit override in OPERATION_POLICY_OVERRIDES
 * 2. Endpoint default from OperationRouter
 * 3. CONFIRM_SINGLE_USE for unknown operations (secure fallback)
 *
 * @param operation - The operation name
 * @returns The effective default permission level
 */
export function getDefaultPermissionLevel(operation: string): PermissionLevel {
  // 1. Check for explicit override
  const override = OPERATION_POLICY_OVERRIDES[operation];
  if (override) {
    return override.defaultLevel;
  }

  // 2. Derive from endpoint routing
  const route = getRoute(operation);
  if (route) {
    return ENDPOINT_DEFAULT_LEVELS[route.endpoint];
  }

  // 3. Secure fallback for unknown operations
  return PermissionLevel.CONFIRM_SINGLE_USE;
}

/**
 * Check if an operation can have its permission level elevated.
 * Some destructive operations cannot be elevated to AUTO_APPROVE.
 *
 * @param operation - The operation name
 * @returns true if the operation can be elevated
 */
export function canOperationBeElevated(operation: string): boolean {
  const override = OPERATION_POLICY_OVERRIDES[operation];
  // Default to allowing elevation for operations without explicit overrides
  return override?.canBeElevated ?? true;
}

/**
 * Get all operations at a specific effective permission level.
 * Considers both explicit overrides and endpoint-derived defaults.
 *
 * @param level - The permission level to filter by
 * @returns Array of operation names at that level
 */
export function getOperationsAtLevel(level: PermissionLevel): string[] {
  const results: string[] = [];

  for (const operation of Object.keys(OPERATION_ROUTES)) {
    if (getDefaultPermissionLevel(operation) === level) {
      results.push(operation);
    }
  }

  return results;
}

/**
 * Get all auto-approved operations.
 * These are safe to execute without any confirmation.
 */
export function getAutoApprovedOperations(): string[] {
  return getOperationsAtLevel(PermissionLevel.AUTO_APPROVE);
}

/**
 * Get all operations requiring confirmation.
 * These need user approval before execution.
 */
export function getConfirmationRequiredOperations(): string[] {
  return [
    ...getOperationsAtLevel(PermissionLevel.CONFIRM_SESSION),
    ...getOperationsAtLevel(PermissionLevel.CONFIRM_SINGLE_USE),
  ];
}
