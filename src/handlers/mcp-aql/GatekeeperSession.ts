/**
 * Gatekeeper Session Management
 *
 * Manages per-connection session state for the Gatekeeper Policy Engine.
 * Each MCP client connection gets a separate session with isolated state.
 *
 * Session state defaults to IN-MEMORY only (crash = fresh session).
 * When an IConfirmationStore is provided (Issue #1945), mutating
 * operations write through to the backing store for persistence
 * across restarts. The in-memory Maps remain the hot path.
 *
 * - Each Claude Code / Claude Desktop / etc. = separate session
 * - No cross-session policy leakage
 * - Without a backing store, crash = fresh session (security-first default)
 */

import { randomUUID } from 'crypto';
import type { ConfirmationRecord, PermissionLevel, CliApprovalRecord, CliApprovalScope, CreateCliApprovalArgs } from './GatekeeperTypes.js';
import { env } from '../../config/env.js';
import type { IConfirmationStore } from '../../state/IConfirmationStore.js';
import { logger } from '../../utils/logger.js';
import { redactToolInput, type AuditHmacResolver } from '../../security/toolRedaction.js';

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

/** Retain terminal approval records briefly so idempotent retries can observe them. */
const TERMINAL_APPROVAL_RETENTION_MS = 86_400_000;

export class GatekeeperSession {
  private readonly state: GatekeeperSessionState;
  private readonly maxConfirmations: number;
  private readonly maxCliApprovals: number;
  private readonly confirmationStore?: IConfirmationStore;
  private readonly auditHmacResolver?: AuditHmacResolver;
  private lastExpirySweep = 0;

  constructor(
    clientInfo?: ClientInfo,
    maxConfirmations: number = 100,
    maxCliApprovals: number = DEFAULT_MAX_CLI_APPROVALS,
    confirmationStore?: IConfirmationStore,
    /** Issue #1947: Use caller-provided sessionId instead of generating a random one. */
    sessionId?: string,
    auditHmacResolver?: AuditHmacResolver,
  ) {
    this.maxConfirmations = maxConfirmations;
    this.maxCliApprovals = maxCliApprovals;
    this.confirmationStore = confirmationStore;
    this.auditHmacResolver = auditHmacResolver;
    this.state = {
      sessionId: sessionId ?? randomUUID(),
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
   * Issue #1947: Restore persisted state from the backing store.
   * Populates in-memory Maps from disk so confirmations survive restarts.
   * Must be called after construction if persistence is desired.
   */
  async initialize(): Promise<void> {
    if (!this.confirmationStore) return;

    try {
      await this.confirmationStore.initialize();

      // Restore confirmations
      for (const record of this.confirmationStore.getAllConfirmations()) {
        const key = record.elementType
          ? `${record.operation}:${record.elementType}`
          : record.operation;
        this.state.confirmations.set(key, record);
      }

      // Restore CLI approvals
      for (const record of this.confirmationStore.getAllCliApprovals()) {
        this.state.cliApprovals.set(record.requestId, record);
      }

      // Restore session-scoped CLI approvals (tool_session promoted approvals)
      for (const record of this.confirmationStore.getAllCliSessionApprovals()) {
        this.state.cliSessionApprovals.set(record.toolName, record);
      }

      // Restore permission prompt state
      if (this.confirmationStore.getPermissionPromptActive()) {
        this.state.permissionPromptActive = true;
      }

      const totalRestored = this.state.confirmations.size +
        this.state.cliApprovals.size +
        this.state.cliSessionApprovals.size;
      if (totalRestored > 0) {
        logger.info(
          `[GatekeeperSession] Restored ${totalRestored} record(s) for session '${this.state.sessionId}'`
        );
      }
    } catch (error) {
      logger.warn('[GatekeeperSession] Failed to restore persisted state, starting fresh', { error });
    }
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

    if (this.confirmationStore) {
      this.confirmationStore.savePermissionPromptActive(true);
      this.persistToStore();
    }
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
    const record: ConfirmationRecord = {
      operation,
      confirmedAt: new Date().toISOString(),
      permissionLevel,
      useCount: 0,
      elementType,
    };
    this.state.confirmations.set(key, record);

    if (this.confirmationStore) {
      this.confirmationStore.saveConfirmation(key, record);
      this.persistToStore();
    }
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
      const deleteKey = this.state.confirmations.has(key) ? key : operation;
      this.state.confirmations.delete(deleteKey);

      if (this.confirmationStore) {
        this.confirmationStore.deleteConfirmation(deleteKey);
        this.persistToStore();
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
    const deleted = this.state.confirmations.delete(key);

    if (deleted && this.confirmationStore) {
      this.confirmationStore.deleteConfirmation(key);
      this.persistToStore();
    }

    return deleted;
  }

  /**
   * Revoke all confirmations for this session.
   * Useful when security-sensitive changes occur.
   */
  revokeAllConfirmations(): void {
    this.touch();
    this.state.confirmations.clear();

    if (this.confirmationStore) {
      this.confirmationStore.clearAllConfirmations();
      this.persistToStore();
    }
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
  async createCliApprovalRequest(args: CreateCliApprovalArgs): Promise<string> {
    const { toolName, toolInput, riskLevel, riskScore, irreversible, denyReason, policySource, ttlMs } = args;
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
    if (!this.auditHmacResolver) {
      throw new Error(
        'GatekeeperSession.createCliApprovalRequest requires an AuditHmacResolver. ' +
        'Inject one via the constructor (root path: SecurityServiceRegistrar registers the resolver in the DI container).',
      );
    }
    let redacted: Awaited<ReturnType<typeof redactToolInput>>;
    try {
      redacted = await redactToolInput(toolName, toolInput, this.auditHmacResolver);
    } catch (cause) {
      // The resolver fails closed on missing/corrupt keys, DB unavailability,
      // or filesystem errors. Re-wrap so the operator sees an audit-prefixed
      // message instead of a raw Drizzle / fs error from deep in the stack.
      throw new Error(
        `[Audit] Failed to redact tool input for ${toolName} — approval cannot be recorded: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }
    // Clamp ttlMs to valid bounds (1s-24h) if provided
    const clampedTtl = ttlMs == null
      ? undefined
      : Math.max(MIN_APPROVAL_TTL_MS, Math.min(MAX_APPROVAL_TTL_MS, ttlMs));
    const record: CliApprovalRecord = {
      requestId,
      toolName,
      toolInputDigest: redacted.digest,
      toolInputHash: redacted.hash,
      toolInputDetail: env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT ? redacted.detail : undefined,
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

    if (this.confirmationStore) {
      this.confirmationStore.saveCliApproval(requestId, record);
      this.persistToStore();
    }

    return requestId;
  }

  /**
   * Approve a pending CLI approval request.
   * Sets approvedAt, and promotes to session approvals if tool_session scope.
   * Awaits the store persist so a crash cannot lose the recorded decision
   * after the caller has been acknowledged.
   *
   * @returns The approved record, or undefined if not found
   */
  async approveCliRequest(
    requestId: string,
    scope: CliApprovalScope = 'single',
    approvedAt: string = new Date().toISOString(),
  ): Promise<CliApprovalRecord | undefined> {
    this.touch();
    this.expireStaleApprovals(true);
    const record = this.state.cliApprovals.get(requestId);
    if (!record || !isPendingCliApproval(record)) {
      return undefined;
    }

    record.approvedAt = approvedAt;
    record.scope = scope;

    // Promote to session approvals if tool_session scope
    if (scope === 'tool_session') {
      this.state.cliSessionApprovals.set(record.toolName, record);
    }

    if (this.confirmationStore) {
      this.confirmationStore.saveCliApproval(requestId, record);
      if (scope === 'tool_session') {
        this.confirmationStore.saveCliSessionApproval(record.toolName, record);
      }
      await this.persistDecision();
    }

    return record;
  }

  /**
   * Deny a pending CLI approval request.
   * Awaits the store persist so a crash cannot lose the recorded decision
   * after the caller has been acknowledged.
   *
   * @returns The denied record, or undefined if not found or already terminal
   */
  async denyCliRequest(
    requestId: string,
    deniedAt: string = new Date().toISOString(),
  ): Promise<CliApprovalRecord | undefined> {
    this.touch();
    this.expireStaleApprovals(true);
    const record = this.state.cliApprovals.get(requestId);
    if (!record || !isPendingCliApproval(record)) {
      return undefined;
    }

    record.deniedAt = deniedAt;

    if (this.confirmationStore) {
      this.confirmationStore.saveCliApproval(requestId, record);
      await this.persistDecision();
    }

    return record;
  }

  /**
   * Get a CLI approval request without changing its state.
   */
  getCliApproval(requestId: string): CliApprovalRecord | undefined {
    this.expireStaleApprovals(true);
    return this.state.cliApprovals.get(requestId);
  }

  /**
   * Get all retained CLI approval requests for this session.
   */
  getAllCliApprovals(): CliApprovalRecord[] {
    this.expireStaleApprovals(true);
    return Array.from(this.state.cliApprovals.values());
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
      if (!isUsableCliApproval(sessionApproval)) {
        this.state.cliSessionApprovals.delete(toolName);
        return undefined;
      }
      return sessionApproval;
    }

    // Check individual approvals
    for (const [, record] of this.state.cliApprovals) {
      if (record.toolName === toolName && !record.consumed && isUsableCliApproval(record)) {
        if (record.scope === 'single') {
          record.consumed = true;
          if (this.confirmationStore) {
            this.confirmationStore.saveCliApproval(record.requestId, record);
            this.persistToStore();
          }
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
      if (isPendingCliApproval(record)) {
        pending.push(record);
      }
    }
    return pending;
  }

  /**
   * Mark all pending CLI approvals cancelled because the owning session ended.
   * Awaits the store persist so the cancellation decisions are durable.
   */
  async cancelPendingCliApprovals(cancelledAt: string = new Date().toISOString()): Promise<number> {
    this.touch();
    let cancelledCount = 0;
    for (const record of this.state.cliApprovals.values()) {
      if (!isPendingCliApproval(record)) continue;
      record.cancelledAt = cancelledAt;
      cancelledCount++;
      if (this.confirmationStore) {
        this.confirmationStore.saveCliApproval(record.requestId, record);
      }
    }
    if (cancelledCount > 0) await this.persistDecision();
    return cancelledCount;
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
      if (this.markExpiredIfStale(record, now)) continue;
      if (this.purgeTerminalIfOld(key, record, now)) continue;
      this.evictConsumedIfStale(key, record, now);
    }
  }

  private markExpiredIfStale(record: CliApprovalRecord, now: number): boolean {
    if (!isPendingCliApproval(record) || approvalAge(record, now) <= approvalTtl(record)) return false;
    record.expiredAt = new Date(recordedExpiryTime(record)).toISOString();
    if (this.confirmationStore) {
      this.confirmationStore.saveCliApproval(record.requestId, record);
      this.persistToStore();
    }
    return true;
  }

  private purgeTerminalIfOld(key: string, record: CliApprovalRecord, now: number): boolean {
    if (!isPurgeableTerminalCliApproval(record) || now - terminalTime(record) <= TERMINAL_APPROVAL_RETENTION_MS) {
      return false;
    }
    this.state.cliApprovals.delete(key);
    this.state.cliSessionApprovals.delete(record.toolName);
    if (this.confirmationStore) {
      this.confirmationStore.deleteCliApproval(record.requestId);
      this.persistToStore();
    }
    return true;
  }

  private evictConsumedIfStale(key: string, record: CliApprovalRecord, now: number): void {
    // Evict consumed single-use approvals (#1782), but preserve terminal
    // states so decision retries return stable results.
    if (record.consumed && approvalAge(record, now) > approvalTtl(record)) {
      this.state.cliApprovals.delete(key);
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

  /**
   * Fire-and-forget persist to the backing store.
   * No-op when no confirmation store is configured (in-memory only mode).
   * Reserved for housekeeping writes (expiry sweeps, consumption, purges)
   * whose state is re-derivable; decision paths use persistDecision instead.
   */
  private persistToStore(): void {
    if (!this.confirmationStore) return;
    this.confirmationStore.persist().catch(error => {
      logger.warn('[GatekeeperSession] Failed to persist confirmation state', { error });
    });
  }

  /**
   * Awaited persist for security-decision paths (approve/deny/cancel).
   * Unlike persistToStore, failures propagate so a decision is never
   * acknowledged to the caller unless it is durable.
   */
  private async persistDecision(): Promise<void> {
    if (!this.confirmationStore) return;
    await this.confirmationStore.persist();
  }
}

function isPendingCliApproval(record: CliApprovalRecord): boolean {
  return !record.approvedAt && !record.deniedAt && !record.expiredAt && !record.cancelledAt;
}

function isUsableCliApproval(record: CliApprovalRecord): boolean {
  return Boolean(record.approvedAt) && !record.deniedAt && !record.expiredAt && !record.cancelledAt;
}

function isPurgeableTerminalCliApproval(record: CliApprovalRecord): boolean {
  return Boolean(record.deniedAt || record.expiredAt || record.cancelledAt);
}

function recordedExpiryTime(record: CliApprovalRecord): number {
  return new Date(record.requestedAt).getTime() + approvalTtl(record);
}

function terminalTime(record: CliApprovalRecord): number {
  const timestamp = record.deniedAt ?? record.expiredAt ?? record.cancelledAt ?? record.requestedAt;
  return new Date(timestamp).getTime();
}

function approvalAge(record: CliApprovalRecord, now: number): number {
  return now - new Date(record.requestedAt).getTime();
}

function approvalTtl(record: CliApprovalRecord): number {
  return record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
}
