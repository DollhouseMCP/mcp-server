/**
 * Gatekeeper Session Management
 *
 * Manages per-connection session state for the Gatekeeper Policy Engine.
 * Each MCP client connection gets a separate session with isolated state.
 *
 * CRITICAL: Session state is IN-MEMORY only.
 * - Confirmations are NOT persisted to disk
 * - Each Claude Code / Claude Desktop / etc. = separate session
 * - No cross-session policy leakage
 * - Crash = fresh session (security-first decision)
 */

import { randomUUID } from 'crypto';
import type { ConfirmationRecord, PermissionLevel, CliApprovalRecord, CliApprovalScope } from './GatekeeperTypes.js';
import { env } from '../../config/env.js';

/**
 * Client information from MCP capabilities.
 * Identifies which MCP client is making requests.
 */
export interface ClientInfo {
  /** Client name (e.g., "claude-code", "claude-desktop") */
  name: string;
  /** Client version */
  version: string;
}

/**
 * Session state for a single MCP connection.
 * Tracks confirmations and activity for this session only.
 */
export interface GatekeeperSessionState {
  /** Unique session identifier */
  sessionId: string;
  /** Client information from MCP capabilities */
  clientInfo?: ClientInfo;
  /** When the session was created */
  createdAt: string;
  /** Last activity timestamp */
  lastActivity: string;
  /** Map of operation -> confirmation record */
  confirmations: Map<string, ConfirmationRecord>;
  /** Map of requestId -> CLI approval record (Issue #625 Phase 3) */
  cliApprovals: Map<string, CliApprovalRecord>;
  /** Map of toolName -> session-scoped CLI approval (Issue #625 Phase 3) */
  cliSessionApprovals: Map<string, CliApprovalRecord>;
  /** Whether permission_prompt has been called at least once this session (Issue #625 Phase 4) */
  permissionPromptActive: boolean;
}

/**
 * Gatekeeper Session Manager.
 * Manages per-connection session state with isolated confirmation tracking.
 *
 * DESIGN NOTES:
 * - Session ID is generated on MCP connection initialization
 * - Tied to the specific transport/connection
 * - NOT shared via filesystem (in-memory per server instance)
 * - Each `claude` CLI invocation spawns separate MCP server process = separate session
 *
 * PROCESS ISOLATION:
 * Each Claude Code session = separate node process (verified)
 * MCP stdio transport = child process per client. No sharing possible.
 *
 * HTTP/HTTPS TRANSPORT CONSIDERATIONS (for future implementers):
 * If implementing HTTP/HTTPS transport instead of stdio:
 * - Session state must be tied to authenticated client identity (API key, token)
 * - Multiple LLM clients could connect to a shared server (unlike stdio's 1:1)
 * - Consider signed session tokens (JWT) for stateless deployments
 * - Implement session expiration and renewal mechanisms
 * - For load-balanced deployments, use Redis or similar for shared session state
 */
/** Default maximum number of CLI approval records before LRU eviction */
const DEFAULT_MAX_CLI_APPROVALS = env.DOLLHOUSE_CLI_APPROVAL_MAX;

/** Default TTL for CLI approval records (5 minutes) */
const DEFAULT_APPROVAL_TTL_MS = env.DOLLHOUSE_CLI_APPROVAL_TTL_MS;

/** Minimum TTL for CLI approval records (1 second) */
const MIN_APPROVAL_TTL_MS = 1_000;

/** Maximum TTL for CLI approval records (24 hours) */
const MAX_APPROVAL_TTL_MS = 86_400_000;

/** Throttle interval for expiry sweeps (10 seconds) */
const EXPIRY_SWEEP_INTERVAL_MS = 10_000;

export class GatekeeperSession {
  private readonly state: GatekeeperSessionState;
  private readonly maxConfirmations: number;
  private readonly maxCliApprovals: number;
  private lastExpirySweep = 0;

  constructor(clientInfo?: ClientInfo, maxConfirmations: number = 100, maxCliApprovals: number = DEFAULT_MAX_CLI_APPROVALS) {
    this.maxConfirmations = maxConfirmations;
    this.maxCliApprovals = maxCliApprovals;
    this.state = {
      sessionId: randomUUID(),
      clientInfo,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      confirmations: new Map(),
      cliApprovals: new Map(),
      cliSessionApprovals: new Map(),
      permissionPromptActive: false,
    };
  }

  /**
   * Get the unique session identifier.
   */
  get sessionId(): string {
    return this.state.sessionId;
  }

  /**
   * Get the client information.
   */
  get clientInfo(): ClientInfo | undefined {
    return this.state.clientInfo;
  }

  /**
   * Get the session creation timestamp.
   */
  get createdAt(): string {
    return this.state.createdAt;
  }

  /**
   * Get the last activity timestamp.
   */
  get lastActivity(): string {
    return this.state.lastActivity;
  }

  /**
   * Whether permission_prompt has been invoked at least once this session.
   * Used for fail-safe detection (Issue #625 Phase 4).
   */
  get isPermissionPromptActive(): boolean {
    return this.state.permissionPromptActive;
  }

  /**
   * Mark that permission_prompt has been invoked.
   * Called on first invocation to track that the CLI client supports it.
   */
  markPermissionPromptActive(): void {
    this.state.permissionPromptActive = true;
  }

  /**
   * Update the last activity timestamp.
   */
  touch(): void {
    this.state.lastActivity = new Date().toISOString();
  }

  /**
   * Record a confirmation for an operation.
   * Confirmations are scoped to this session only.
   *
   * @param operation - The operation being confirmed
   * @param permissionLevel - The permission level being confirmed
   * @param elementType - Optional element type scope
   */
  recordConfirmation(
    operation: string,
    permissionLevel: PermissionLevel.CONFIRM_SESSION | PermissionLevel.CONFIRM_SINGLE_USE,
    elementType?: string
  ): void {
    this.touch();

    // Enforce max confirmations (LRU eviction)
    if (this.state.confirmations.size >= this.maxConfirmations) {
      // Remove oldest confirmation
      const oldestKey = this.state.confirmations.keys().next().value;
      if (oldestKey) {
        this.state.confirmations.delete(oldestKey);
      }
    }

    const key = this.getConfirmationKey(operation, elementType);
    this.state.confirmations.set(key, {
      operation,
      confirmedAt: new Date().toISOString(),
      permissionLevel,
      useCount: 0,
      elementType,
    });
  }

  /**
   * Check if an operation has a valid session confirmation.
   * For CONFIRM_SINGLE_USE, this invalidates the confirmation after checking.
   *
   * RACE CONDITION NOTE:
   * The check-then-delete for CONFIRM_SINGLE_USE is safe because:
   * 1. Node.js is single-threaded - no concurrent access to Map
   * 2. MCP requests are processed sequentially per connection
   * 3. Each session instance is tied to a single client connection
   * If this code is ever used in a multi-threaded context or with shared
   * state across processes, atomic operations would be required.
   *
   * @param operation - The operation to check
   * @param elementType - Optional element type scope
   * @returns The confirmation record if valid, undefined otherwise
   */
  checkConfirmation(operation: string, elementType?: string): ConfirmationRecord | undefined {
    this.touch();

    const key = this.getConfirmationKey(operation, elementType);
    let confirmation = this.state.confirmations.get(key);

    // Fall back to unscoped confirmation when element-type-scoped key not found.
    // A session-wide confirmation for "create_element" covers "create_element:skill" etc.
    if (!confirmation && elementType) {
      confirmation = this.state.confirmations.get(operation);
    }

    if (!confirmation) {
      return undefined;
    }

    // Increment use count
    confirmation.useCount++;

    // For CONFIRM_SINGLE_USE, invalidate after first use
    if (confirmation.permissionLevel === 'CONFIRM_SINGLE_USE') {
      // Delete whichever key matched (scoped or unscoped)
      if (this.state.confirmations.has(key)) {
        this.state.confirmations.delete(key);
      } else {
        this.state.confirmations.delete(operation);
      }
    }

    return confirmation;
  }

  /**
   * Check if an operation has a session confirmation WITHOUT consuming it.
   * Use this to check status without affecting the confirmation state.
   *
   * @param operation - The operation to check
   * @param elementType - Optional element type scope
   * @returns The confirmation record if exists, undefined otherwise
   */
  peekConfirmation(operation: string, elementType?: string): ConfirmationRecord | undefined {
    const key = this.getConfirmationKey(operation, elementType);
    return this.state.confirmations.get(key);
  }

  /**
   * Revoke a confirmation for an operation.
   *
   * @param operation - The operation to revoke
   * @param elementType - Optional element type scope
   * @returns true if a confirmation was revoked
   */
  revokeConfirmation(operation: string, elementType?: string): boolean {
    this.touch();
    const key = this.getConfirmationKey(operation, elementType);
    return this.state.confirmations.delete(key);
  }

  /**
   * Revoke all confirmations for this session.
   * Useful when security-sensitive changes occur.
   */
  revokeAllConfirmations(): void {
    this.touch();
    this.state.confirmations.clear();
  }

  /**
   * Get all active confirmations for this session.
   * Useful for debugging and audit logging.
   */
  getActiveConfirmations(): ConfirmationRecord[] {
    return Array.from(this.state.confirmations.values());
  }

  // ── CLI Approval Store (Issue #625 Phase 3) ────────────────────

  /**
   * Create a CLI approval request.
   * Returns a unique request ID (format: cli-<UUIDv4>).
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
    this.touch();
    this.expireStaleApprovals(true); // Force sweep on write path to ensure capacity

    // LRU eviction at max capacity
    if (this.state.cliApprovals.size >= this.maxCliApprovals) {
      const oldestKey = this.state.cliApprovals.keys().next().value;
      if (oldestKey) {
        this.state.cliApprovals.delete(oldestKey);
      }
    }

    const requestId = `cli-${randomUUID()}`;
    // Clamp ttlMs to valid bounds (1s-24h) if provided
    const clampedTtl = ttlMs != null
      ? Math.max(MIN_APPROVAL_TTL_MS, Math.min(MAX_APPROVAL_TTL_MS, ttlMs))
      : undefined;
    const record: CliApprovalRecord = {
      requestId,
      toolName,
      toolInput,
      riskLevel,
      riskScore,
      irreversible,
      requestedAt: new Date().toISOString(),
      consumed: false,
      scope: 'single',
      denyReason,
      policySource,
      ttlMs: clampedTtl,
    };
    this.state.cliApprovals.set(requestId, record);
    return requestId;
  }

  /**
   * Approve a pending CLI approval request.
   * Sets approvedAt, and promotes to session approvals if tool_session scope.
   *
   * @returns The approved record, or undefined if not found
   */
  approveCliRequest(requestId: string, scope: CliApprovalScope = 'single'): CliApprovalRecord | undefined {
    this.touch();
    const record = this.state.cliApprovals.get(requestId);
    if (!record || record.approvedAt) {
      return undefined;
    }

    record.approvedAt = new Date().toISOString();
    record.scope = scope;

    // Promote to session approvals if tool_session scope
    if (scope === 'tool_session') {
      this.state.cliSessionApprovals.set(record.toolName, record);
    }

    return record;
  }

  /**
   * Check if a CLI tool call has a valid approval.
   * Checks session approvals first (fast path), then individual approvals.
   * Consumes single-scope approvals on use.
   *
   * @returns The matching approval record, or undefined
   */
  checkCliApproval(toolName: string, _toolInput: Record<string, unknown>): CliApprovalRecord | undefined {
    this.touch();
    this.expireStaleApprovals();

    // Fast path: check session-scoped approvals by tool name
    const sessionApproval = this.state.cliSessionApprovals.get(toolName);
    if (sessionApproval) {
      return sessionApproval;
    }

    // Check individual approvals
    for (const [, record] of this.state.cliApprovals) {
      if (record.toolName === toolName && record.approvedAt && !record.consumed) {
        if (record.scope === 'single') {
          record.consumed = true;
        }
        return record;
      }
    }

    return undefined;
  }

  /**
   * Get all pending (unapproved) CLI approval requests.
   * Forces expiry sweep to ensure accurate user-facing results.
   */
  getPendingCliApprovals(): CliApprovalRecord[] {
    this.expireStaleApprovals(true);
    const pending: CliApprovalRecord[] = [];
    for (const [, record] of this.state.cliApprovals) {
      if (!record.approvedAt) {
        pending.push(record);
      }
    }
    return pending;
  }

  /**
   * Expire stale approval requests.
   * Uses per-record ttlMs if set, otherwise DEFAULT_APPROVAL_TTL_MS (5 minutes).
   *
   * @param force - Skip throttle check (used by write paths that must ensure capacity)
   */
  private expireStaleApprovals(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastExpirySweep < EXPIRY_SWEEP_INTERVAL_MS) return;
    this.lastExpirySweep = now;

    for (const [key, record] of this.state.cliApprovals) {
      const ttl = record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
      const age = now - new Date(record.requestedAt).getTime();
      // Evict stale pending requests AND consumed single-use approvals (#1782)
      if (age > ttl && (!record.approvedAt || record.consumed)) {
        this.state.cliApprovals.delete(key);
      }
    }
  }

  /**
   * Get a summary of the session state.
   * Safe to expose for debugging without revealing sensitive data.
   */
  getSummary(): {
    sessionId: string;
    clientInfo?: ClientInfo;
    createdAt: string;
    lastActivity: string;
    confirmationCount: number;
    cliApprovalCount: number;
    permissionPromptActive: boolean;
  } {
    return {
      sessionId: this.state.sessionId,
      clientInfo: this.state.clientInfo,
      createdAt: this.state.createdAt,
      lastActivity: this.state.lastActivity,
      confirmationCount: this.state.confirmations.size,
      cliApprovalCount: this.state.cliApprovals.size,
      permissionPromptActive: this.state.permissionPromptActive,
    };
  }

  /**
   * Generate a unique key for confirmation lookups.
   * Combines operation and optional element type.
   */
  private getConfirmationKey(operation: string, elementType?: string): string {
    return elementType ? `${operation}:${elementType}` : operation;
  }
}
