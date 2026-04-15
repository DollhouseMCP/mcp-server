/**
 * Gatekeeper Policy Engine
 *
 * Centralized access control enforcement for MCP-AQL operations.
 * Implements a multi-layer defense-in-depth model:
 *
 * Layer 1: Route Validation (existing - validates endpoint/operation matching)
 * Layer 2: Safety Tier Check (integrates @dollhousemcp/safety)
 * Layer 3: Element Policy Check (active element restrictions)
 * Layer 4: Permission Level Enforcement (AUTO_APPROVE, CONFIRM, DENY)
 *
 * Design Principles:
 * - "LLM instructions are suggestions. Adapter policies are enforcement."
 * - Session-scoped confirmations (no cross-session leakage)
 * - Security-first (crash = fresh session)
 * - Audit logging for all decisions
 */

import { CRUDEndpoint, getRoute } from './OperationRouter.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { GatekeeperSession, type ClientInfo } from './GatekeeperSession.js';
import { GatekeeperConfig, type GatekeeperConfigOptions } from './GatekeeperConfig.js';
import type { ContextTracker } from '../../security/encryption/ContextTracker.js';
import {
  PermissionLevel,
  GatekeeperErrorCode,
  type GatekeeperDecision,
  type EndpointPermissions,
  type GatekeeperAuditEntry,
  type CliApprovalRecord,
  type CliApprovalScope,
} from './GatekeeperTypes.js';
import {
  getDefaultPermissionLevel,
  resolveElementPolicy,
  createDecisionFromPolicy,
  type ActiveElement,
  type ElementPolicyResult,
} from './policies/index.js';

/**
 * Input for Gatekeeper enforcement.
 * Contains all context needed to make an access control decision.
 */
export interface EnforceInput {
  /** The operation being requested */
  operation: string;
  /** The CRUD endpoint being called */
  endpoint: CRUDEndpoint;
  /** Element type being operated on (if applicable) */
  elementType?: string;
  /** Currently active elements for policy evaluation */
  activeElements?: ActiveElement[];
  /**
   * Skip Layer 2 (element policy resolution) — use route-level defaults only.
   * Used for gatekeeper infrastructure operations (confirm_operation, verify_challenge)
   * to prevent cascading confirmation loops. Issue #758.
   */
  skipElementPolicies?: boolean;
}

/**
 * Per-session GatekeeperSession registry.
 * Maps sessionId → GatekeeperSession. Used by Gatekeeper to resolve
 * the correct session's confirmation/approval state at call time.
 *
 * Issue #1947: Per-session Gatekeeper isolation.
 */
class GatekeeperSessionRegistry {
  private readonly sessions = new Map<string, GatekeeperSession>();
  private readonly defaultId: string;

  constructor(defaultSessionId: string) {
    this.defaultId = defaultSessionId;
  }

  /** Register a pre-built GatekeeperSession for a session. */
  register(sessionId: string, session: GatekeeperSession): void {
    this.sessions.set(sessionId, session);
    logger.debug(`[GatekeeperSessionRegistry] Registered session '${sessionId}'`);
  }

  /** Get or lazily create a GatekeeperSession for a session. */
  getOrCreate(sessionId: string, config: GatekeeperConfig, clientInfo?: ClientInfo): GatekeeperSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new GatekeeperSession(clientInfo, config.maxSessionConfirmations, undefined, undefined, sessionId);
      this.sessions.set(sessionId, session);
      logger.warn(
        `[GatekeeperSessionRegistry] Auto-created session '${sessionId}' without persistence store. ` +
        `This may indicate a DI configuration issue — sessions should be registered via Container.`
      );
    }
    return session;
  }

  /** Get a session, or undefined if not registered. */
  get(sessionId: string): GatekeeperSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove a session (called on disconnect). */
  dispose(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      logger.debug(`[GatekeeperSessionRegistry] Disposed session '${sessionId}'`);
    }
  }

  /** Default session ID for background/startup contexts. */
  getDefaultSessionId(): string {
    return this.defaultId;
  }
}

/**
 * Gatekeeper Policy Engine.
 *
 * Central enforcement point for MCP-AQL access control.
 * Validates that operations are called correctly and enforces
 * permission policies based on operation type and active elements.
 *
 * Issue #1947: Gatekeeper resolves per-session GatekeeperSession via
 * ContextTracker. Each session gets its own confirmation state, CLI
 * approvals, and permission prompt tracking.
 */
export class Gatekeeper {
  private readonly config: GatekeeperConfig;
  private readonly sessionRegistry: GatekeeperSessionRegistry;
  private readonly contextTracker?: ContextTracker;
  private readonly defaultClientInfo?: ClientInfo;

  /**
   * Permission flags for each CRUDE endpoint.
   * These define the security characteristics of each endpoint.
   */
  private static readonly ENDPOINT_PERMISSIONS: Record<CRUDEndpoint, EndpointPermissions> = {
    CREATE: { readOnly: false, destructive: false },
    READ: { readOnly: true, destructive: false },
    UPDATE: { readOnly: false, destructive: true },
    DELETE: { readOnly: false, destructive: true },
    EXECUTE: { readOnly: false, destructive: true },
  };

  constructor(
    clientInfo?: ClientInfo,
    configOptions?: GatekeeperConfigOptions,
    contextTracker?: ContextTracker,
    defaultSessionId?: string,
  ) {
    this.config = new GatekeeperConfig(configOptions);
    this.contextTracker = contextTracker;
    this.defaultClientInfo = clientInfo;
    this.sessionRegistry = new GatekeeperSessionRegistry(defaultSessionId ?? 'default');
  }

  /**
   * Resolve the current session's GatekeeperSession.
   * Uses ContextTracker to find the sessionId, falls back to default.
   */
  private resolveSession(): GatekeeperSession {
    const sessionId = this.contextTracker?.getSessionContext()?.sessionId
      ?? this.sessionRegistry.getDefaultSessionId();
    return this.sessionRegistry.getOrCreate(sessionId, this.config, this.defaultClientInfo);
  }

  /**
   * Register a pre-built GatekeeperSession for a session.
   * Called by Container during session creation.
   */
  registerSession(sessionId: string, session: GatekeeperSession): void {
    this.sessionRegistry.register(sessionId, session);
  }

  /**
   * Remove a session's GatekeeperSession.
   * Called by Container during session disconnect.
   */
  disposeSession(sessionId: string): void {
    this.sessionRegistry.dispose(sessionId);
  }

  /**
   * Get the session ID for this Gatekeeper instance.
   */
  get sessionId(): string {
    return this.resolveSession().sessionId;
  }

  /**
   * Get a summary of the current session.
   */
  getSessionSummary(): ReturnType<GatekeeperSession['getSummary']> {
    return this.resolveSession().getSummary();
  }

  /**
   * Whether permission_prompt has been invoked this session (Issue #625 Phase 4).
   */
  get isPermissionPromptActive(): boolean {
    return this.resolveSession().isPermissionPromptActive;
  }

  /**
   * Mark that permission_prompt has been invoked (Issue #625 Phase 4).
   */
  markPermissionPromptActive(): void {
    this.resolveSession().markPermissionPromptActive();
  }

  /**
   * Validates that an operation is being called via the correct endpoint.
   * Throws an error if the operation doesn't exist or is called via wrong endpoint.
   *
   * This is Layer 1: Route Validation (existing PermissionGuard behavior).
   *
   * @param operation - The operation being called (e.g., 'create_element')
   * @param calledEndpoint - The endpoint it was called through (e.g., 'CREATE')
   * @throws Error if operation unknown or endpoint mismatch
   */
  validateRoute(operation: string, calledEndpoint: CRUDEndpoint): void {
    this.validateRouteWithSession(operation, calledEndpoint, this.resolveSession());
  }

  /**
   * Internal route validation with pre-resolved session (avoids double-resolve in enforce()).
   */
  private validateRouteWithSession(operation: string, calledEndpoint: CRUDEndpoint, session: GatekeeperSession): void {
    const route = getRoute(operation);

    if (!route) {
      this.logAuditEvent(operation, calledEndpoint, {
        allowed: false,
        permissionLevel: PermissionLevel.DENY,
        errorCode: GatekeeperErrorCode.UNKNOWN_OPERATION,
        reason: `Unknown operation: "${operation}"`,
      }, undefined, session);

      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'Gatekeeper.validateRoute',
        details: `Unknown operation: "${operation}"`,
        additionalData: { operation, calledEndpoint, sessionId: session.sessionId },
      });

      throw new Error(
        `Unknown operation: "${operation}". See tool descriptions for available operations on each endpoint.`
      );
    }

    if (route.endpoint !== calledEndpoint) {
      const decision: GatekeeperDecision = {
        allowed: false,
        permissionLevel: PermissionLevel.DENY,
        errorCode: GatekeeperErrorCode.ENDPOINT_MISMATCH,
        reason: `Operation "${operation}" called via wrong endpoint`,
        suggestion: `Use mcp_aql_${route.endpoint.toLowerCase()} instead of mcp_aql_${calledEndpoint.toLowerCase()}`,
      };

      this.logAuditEvent(operation, calledEndpoint, decision, undefined, session);

      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'HIGH',
        source: 'Gatekeeper.validateRoute',
        details: `Security violation: Operation "${operation}" called via wrong endpoint`,
        additionalData: {
          operation,
          expectedEndpoint: route.endpoint,
          actualEndpoint: calledEndpoint,
          permissionReason: this.getPermissionReason(route.endpoint),
          sessionId: session.sessionId,
        },
      });

      throw new Error(
        `Security violation: Operation "${operation}" must be called via mcp_aql_${route.endpoint.toLowerCase()} endpoint, ` +
          `not mcp_aql_${calledEndpoint.toLowerCase()}. ` +
          `This operation is classified as ${route.endpoint} due to its ${this.getPermissionReason(route.endpoint)}.`
      );
    }
  }

  /**
   * Enforce access control for an operation.
   * This is the main entry point for policy enforcement.
   *
   * Checks:
   * 1. Route validation (operation exists and matches endpoint)
   * 2. Element policies (active elements' allow/confirm/deny lists)
   * 3. Session confirmations (cached approvals)
   * 4. Default operation policies (permission levels)
   *
   * @param input - The enforcement input containing operation context
   * @returns A GatekeeperDecision indicating whether the operation is allowed
   */
  enforce(input: EnforceInput): GatekeeperDecision {
    const { operation, endpoint, elementType, activeElements = [], skipElementPolicies = false } = input;
    const session = this.resolveSession();

    // Layer 1: Route validation (throws if invalid)
    // Uses pre-resolved session to avoid double-resolve
    try {
      this.validateRouteWithSession(operation, endpoint, session);
    } catch (error) {
      // Convert thrown error to decision for consistent return type
      return {
        allowed: false,
        permissionLevel: PermissionLevel.DENY,
        errorCode: GatekeeperErrorCode.ENDPOINT_MISMATCH,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // Layer 2: Element policy resolution
    // Issue #679: allowElementPolicyOverrides=false bypasses this layer entirely (operator kill switch)
    // Issue #758: skipElementPolicies=true bypasses for gatekeeper infrastructure operations
    const shouldResolveElementPolicies = this.config.allowElementPolicyOverrides && !skipElementPolicies;
    const policyStart = Date.now();
    const policyResult = shouldResolveElementPolicies
      ? resolveElementPolicy(operation, activeElements, elementType)
      : { permissionLevel: getDefaultPermissionLevel(operation), sourceElement: undefined, matchedPolicy: undefined as ElementPolicyResult['matchedPolicy'] };
    const policyMs = Date.now() - policyStart;
    // Only log policy resolution when it's not the default AUTO_APPROVE path
    if (policyResult.permissionLevel !== PermissionLevel.AUTO_APPROVE || policyMs > 5) {
      logger.debug('Gatekeeper policy resolution', {
        operation,
        activeElementCount: activeElements.length,
        overridesEnabled: this.config.allowElementPolicyOverrides,
        resultLevel: policyResult.permissionLevel,
        sourceElement: policyResult.sourceElement,
        matchedPolicy: policyResult.matchedPolicy,
        durationMs: policyMs,
      });
    }

    // If element policy denies, return immediately
    if (policyResult.permissionLevel === PermissionLevel.DENY) {
      const decision = createDecisionFromPolicy(operation, policyResult, elementType);
      this.logAuditEvent(operation, endpoint, decision, elementType, session);
      return decision;
    }

    // Layer 3: Check session confirmations (per-session via registry)
    const confirmation = session.checkConfirmation(operation, elementType);
    if (confirmation) {
      const decision: GatekeeperDecision = {
        allowed: true,
        permissionLevel: policyResult.permissionLevel,
        reason: `Operation "${operation}" approved via session confirmation`,
        policySource: 'session_confirmation',
      };
      this.logAuditEvent(operation, endpoint, decision, elementType, session);
      return decision;
    }

    // Layer 4: Apply default/element policy
    const decision = createDecisionFromPolicy(operation, policyResult, elementType);
    this.logAuditEvent(operation, endpoint, decision, elementType, session);
    return decision;
  }

  /**
   * Record a confirmation for an operation.
   * Called when the user approves an operation that requires confirmation.
   *
   * @param operation - The operation being confirmed
   * @param level - The permission level (CONFIRM_SESSION or CONFIRM_SINGLE_USE)
   * @param elementType - Optional element type scope
   */
  recordConfirmation(
    operation: string,
    level: PermissionLevel.CONFIRM_SESSION | PermissionLevel.CONFIRM_SINGLE_USE,
    elementType?: string
  ): void {
    const session = this.resolveSession();
    session.recordConfirmation(operation, level, elementType);

    SecurityMonitor.logSecurityEvent({
      type: 'CONFIRMATION_RECORDED',
      severity: 'LOW',
      source: 'Gatekeeper.recordConfirmation',
      details: `Confirmation recorded for operation "${operation}"`,
      additionalData: {
        operation,
        permissionLevel: level,
        elementType,
        sessionId: session.sessionId,
      },
    });
  }

  /**
   * Revoke a confirmation for an operation.
   *
   * @param operation - The operation to revoke
   * @param elementType - Optional element type scope
   * @returns true if a confirmation was revoked
   */
  revokeConfirmation(operation: string, elementType?: string): boolean {
    return this.resolveSession().revokeConfirmation(operation, elementType);
  }

  /**
   * Revoke all confirmations for this session.
   * Useful when security-sensitive changes occur.
   */
  revokeAllConfirmations(): void {
    this.resolveSession().revokeAllConfirmations();
  }

  // ── CLI Approval Delegation (Issue #625 Phase 3) ──────────────

  /**
   * Create a CLI approval request.
   * Delegates to session and logs the event.
   */
  createCliApprovalRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    riskLevel: string,
    riskScore: number,
    irreversible: boolean,
    denyReason: string,
    policySource?: string,
    ttlMs?: number,
  ): string {
    const session = this.resolveSession();
    const requestId = session.createCliApprovalRequest(
      toolName, toolInput, riskLevel, riskScore, irreversible, denyReason, policySource, ttlMs
    );

    SecurityMonitor.logSecurityEvent({
      type: 'CLI_APPROVAL_REQUESTED',
      severity: 'MEDIUM',
      source: 'Gatekeeper.createCliApprovalRequest',
      details: `CLI approval requested for ${toolName}: ${denyReason}`,
      additionalData: { requestId, toolName, riskLevel, riskScore, irreversible, sessionId: session.sessionId },
    });

    return requestId;
  }

  /**
   * Approve a pending CLI approval request.
   */
  approveCliRequest(requestId: string, scope: CliApprovalScope = 'single'): CliApprovalRecord | undefined {
    const session = this.resolveSession();
    const record = session.approveCliRequest(requestId, scope);

    if (record) {
      SecurityMonitor.logSecurityEvent({
        type: 'CLI_APPROVAL_GRANTED',
        severity: 'MEDIUM',
        source: 'Gatekeeper.approveCliRequest',
        details: `CLI approval granted for ${record.toolName} (scope: ${scope})`,
        additionalData: { requestId, toolName: record.toolName, scope, sessionId: session.sessionId },
      });
    }

    return record;
  }

  /**
   * Check if a CLI tool call has a valid approval.
   */
  checkCliApproval(toolName: string, toolInput: Record<string, unknown>): CliApprovalRecord | undefined {
    const session = this.resolveSession();
    const record = session.checkCliApproval(toolName, toolInput);

    if (record) {
      SecurityMonitor.logSecurityEvent({
        type: 'CLI_APPROVAL_CONSUMED',
        severity: 'LOW',
        source: 'Gatekeeper.checkCliApproval',
        details: `CLI approval consumed for ${toolName} (scope: ${record.scope})`,
        additionalData: { requestId: record.requestId, toolName, scope: record.scope, sessionId: session.sessionId },
      });
    }

    return record;
  }

  /**
   * Get all pending CLI approval requests.
   */
  getPendingCliApprovals(): CliApprovalRecord[] {
    return this.resolveSession().getPendingCliApprovals();
  }

  /**
   * Gets the permission flags for an endpoint.
   *
   * @param endpoint - The CRUD endpoint to get permissions for
   * @returns The permission flags for the endpoint
   */
  static getPermissions(endpoint: CRUDEndpoint): EndpointPermissions {
    return Gatekeeper.ENDPOINT_PERMISSIONS[endpoint];
  }

  /**
   * Static validation method for backward compatibility with PermissionGuard.
   * Validates that an operation is being called via the correct endpoint.
   *
   * @param operation - The operation being called
   * @param calledEndpoint - The endpoint it was called through
   * @throws Error if operation unknown or endpoint mismatch
   *
   * @deprecated Use instance method validateRoute() or enforce() instead
   */
  static validate(operation: string, calledEndpoint: CRUDEndpoint): void {
    // Lightweight route validation without session-scoped audit logging.
    // For full enforcement with audit events, use the instance method enforce().
    const route = getRoute(operation);
    if (!route) {
      throw new Error(
        `Unknown operation: "${operation}". See tool descriptions for available operations on each endpoint.`
      );
    }
    if (route.endpoint !== calledEndpoint) {
      throw new Error(
        `Security violation: Operation "${operation}" must be called via mcp_aql_${route.endpoint.toLowerCase()} endpoint, ` +
          `not mcp_aql_${calledEndpoint.toLowerCase()}. ` +
          `This operation is classified as ${route.endpoint} due to its ${Gatekeeper.getPermissionReasonStatic(route.endpoint)}.`
      );
    }
  }

  /**
   * Get the default permission level for an operation.
   *
   * @param operation - The operation name
   * @returns The default permission level
   */
  getDefaultPermissionLevel(operation: string): PermissionLevel {
    return getDefaultPermissionLevel(operation);
  }

  /**
   * Returns a human-readable reason for the permission classification.
   */
  private getPermissionReason(endpoint: CRUDEndpoint): string {
    return Gatekeeper.getPermissionReasonStatic(endpoint);
  }

  /**
   * Static version of getPermissionReason for backward compatibility.
   */
  private static getPermissionReasonStatic(endpoint: CRUDEndpoint): string {
    switch (endpoint) {
      case 'CREATE':
        return 'additive, non-destructive nature';
      case 'READ':
        return 'read-only, safe nature';
      case 'UPDATE':
        return 'data modification capabilities';
      case 'DELETE':
        return 'destructive potential';
      case 'EXECUTE':
        return 'runtime execution lifecycle (stateful, non-idempotent)';
      default: {
        // Exhaustive check - TypeScript will error if a case is missing
        const _exhaustive: never = endpoint;
        return _exhaustive;
      }
    }
  }

  /**
   * Log an audit event for a Gatekeeper decision.
   */
  private logAuditEvent(
    operation: string,
    endpoint: CRUDEndpoint,
    decision: GatekeeperDecision,
    elementType?: string,
    session?: GatekeeperSession,
  ): void {
    if (!this.config.enableAuditLogging) {
      return;
    }

    const resolvedSession = session ?? this.resolveSession();
    const auditEntry: GatekeeperAuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: resolvedSession.sessionId,
      operation,
      endpoint,
      elementType,
      decision,
      clientInfo: resolvedSession.clientInfo,
    };

    // Only log security events for denied decisions — allowed ops are normal traffic
    if (!decision.allowed) {
      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'Gatekeeper.enforce',
        details: `Gatekeeper decision: DENIED - ${decision.reason}`,
        additionalData: auditEntry,
      });
    }
  }
}

// Re-export types and utilities for convenience
export { PermissionLevel, GatekeeperErrorCode } from './GatekeeperTypes.js';
export type {
  GatekeeperDecision,
  EndpointPermissions,
  ElementGatekeeperPolicy,
  ConfirmationRecord,
  CliApprovalRecord,
  CliApprovalScope,
  CliApprovalPolicy,
  RiskAssessment,
} from './GatekeeperTypes.js';
export type { ClientInfo } from './GatekeeperSession.js';
