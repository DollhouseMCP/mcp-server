/**
 * Danger Zone Enforcer
 *
 * Provides programmatic enforcement for DANGER_ZONE safety tier.
 * Maintains a list of blocked agent execution contexts and prevents
 * further tool execution until verification is completed.
 *
 * This addresses Issue #110 - the semantic-only approach is insufficient
 * for the highest risk tier, as a compromised LLM could ignore warnings.
 *
 * A DI-managed store abstraction persists blocks in files or PostgreSQL.
 *
 * @since v2.0.0 - Agentic Loop Completion (Epic #380)
 * @since v2.1.0 - Durable block storage (Issue #402)
 */

import { randomUUID } from 'node:crypto';
import { validateAgentName } from './validateAgentName.js';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from './securityMonitor.js';
import { EvictingQueue } from '../utils/EvictingQueue.js';
import type { IDangerZoneBlockStore, PersistedBlock } from '../state/IDangerZoneBlockStore.js';
import { BlockPersistenceQueue } from './BlockPersistenceQueue.js';
import { isStateObject } from '../state/persistence-utils.js';
import { FileDangerZoneBlockStore, ResetSnapshotChangedError } from '../state/FileDangerZoneBlockStore.js';
import { SlidingWindowRateLimiter } from '../utils/SlidingWindowRateLimiter.js';
import type { DialogApprovalRequest, DialogApprovalResult } from '../web/console/consoleToken.js';

/** Rolling-window size for block-duration metrics (matches SecurityMonitor/LogManager). */
const METRICS_WINDOW_SIZE = 1000;

export type BlockReleaseReason = 'unavailable' | 'admin-only' | 'session' | 'declined';
export type BlockReleaseResult =
  | { released: true; agentName?: string }
  | { released: false; reason: BlockReleaseReason; agentName?: string };

export type LocalBlockResetResult = DialogApprovalResult | 'busy' | 'changed' | 'not_needed' | 'unsupported';
type ApproveLocalReset = (
  request: DialogApprovalRequest, commit: (approved: DialogApprovalRequest) => Promise<boolean>,
) => Promise<DialogApprovalResult>;

/**
 * Blocked execution context
 */
interface BlockedContext {
  originalRecord?: { value: unknown };
  requiresAdmin?: boolean;
  /** Stable identity for this block event */
  eventId?: string;
  /** Agent name that triggered danger zone */
  agentName: string;
  /** Reason for blocking */
  reason: string;
  /** Patterns that triggered the block */
  triggeredPatterns: string[];
  /** When the block was created */
  blockedAt: Date;
  /** Optional verification ID if verification was requested */
  verificationId?: string;
  /** Issue #1947: Session that created this block. Undefined = globally verifiable (backward compat). */
  sessionId?: string;
  /** Goal whose autonomy evaluation created this block. */
  goalId?: string;
}

/**
 * Audit context captured when a danger zone block occurs (Issue #404).
 * Provides full execution context for post-hoc investigation of blocks.
 *
 * NOTE: The DangerZoneBlocker interface in types.ts has a structurally
 * identical inline type. Keep both in sync when modifying fields.
 */
export interface DangerZoneAuditContext {
  stepNumber?: number;
  currentStepDescription?: string;
  currentStepOutcome?: string;
  nextActionHint?: string;
  riskScore?: number;
  goalDescription?: string;
  goalId?: string;
  safetyFactors?: string[];
}

/**
 * Result of a block check
 */
export interface BlockCheckResult {
  /** Whether the context is blocked */
  blocked: boolean;
  /** Stable identity for this block event */
  eventId?: string;
  /** Reason for blocking (if blocked) */
  reason?: string;
  /** How to resolve the block */
  resolution?: string;
  /** Verification ID if verification is required */
  verificationId?: string;
  /** Issue #1947: Session that created this block (undefined = globally verifiable) */
  sessionId?: string;
  /** Goal whose autonomy evaluation created this block */
  goalId?: string;
  /** Original ISO-8601 time when the block was created */
  blockedAt?: string;
}

/**
 * Metrics for danger zone enforcement
 */
export interface DangerZoneMetrics {
  /** Current number of blocked agents */
  currentBlockedCount: number;
  /** Total blocks since startup */
  totalBlocksSinceStartup: number;
  /** Total unblocks since startup */
  totalUnblocksSinceStartup: number;
  /** Total clearAll calls since startup */
  totalClearAllCalls: number;
  /** Average block duration in milliseconds (for unblocked agents) */
  averageBlockDurationMs: number;
  /** Longest block duration in milliseconds */
  longestBlockDurationMs: number;
}


/**
 * DI-managed enforcement with user-scoped durable block storage.
 *
 * Thread-safety note: This uses a Map which is not inherently thread-safe,
 * but in a Node.js single-threaded environment this is acceptable.
 * Shared stores reconcile state before an enforcement decision.
 *
 * Persistence is owned by the selected store. Checks reconcile its current state;
 * local changes are serialized before publication or release.
 */
export class DangerZoneEnforcer {
  private readonly blockedContexts: Map<string, BlockedContext> = new Map();

  // Metrics tracking
  private totalBlocksSinceStartup = 0;
  private totalUnblocksSinceStartup = 0;
  private totalClearAllCalls = 0;
  private readonly blockDurations = new EvictingQueue<number>(METRICS_WINDOW_SIZE);

  // Admin token for clearAll (can be set via environment or configuration)
  private adminToken: string | null = process.env.DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN || null;

  // Persistence
  private readonly persistence: BlockPersistenceQueue;
  private readiness: 'loading' | 'ready' | 'unavailable' = 'loading';
  private retryable = false;
  private unavailableReason = 'unavailable';
  private readonly resetPromptLimiter = new SlidingWindowRateLimiter(3, 60_000);
  private retryAfter = 0;
  private loading: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private stopWatching?: () => void;
  private shuttingDown = false;
  constructor(private readonly store: IDangerZoneBlockStore) {
    this.persistence = new BlockPersistenceQueue(store, () => this.readiness === 'ready',
      error => this.reportWriteFailure(error), () => this.readSnapshot(false));
  }

  private reportWriteFailure(error: unknown): void {
    this.markUnavailable('write failed', true);
    logger.warn('Block-state storage write failed; enforcement is unavailable and agents are denied', { error });
    SecurityMonitor.logSecurityEvent({
      type: 'DANGER_ZONE_OPERATION', severity: 'MEDIUM', source: 'DangerZoneEnforcer.persistAsync',
      details: `Block-state storage write failed for ${this.blockedContexts.size} block(s); enforcement is unavailable and agents are denied`,
      additionalData: { error: String(error), activeBlocks: this.blockedContexts.size },
    });
  }

  /** Load and validate a complete snapshot before publishing it. Also supports repair/reload. */
  initialize(): Promise<void> {
    if (this.refreshing) return this.refreshing.then(() => this.initialize());
    return this.startLoad(false);
  }

  private ensureInitialized(): Promise<void> {
    if (this.loading) return this.loading;
    return this.readiness === 'loading' ? this.initialize() : Promise.resolve();
  }

  private startLoad(refresh: boolean): Promise<void> {
    if (this.loading) return this.loading;
    this.readiness = 'loading';
    const operation = this.load(refresh).finally(() => {
      if (this.loading === operation) this.loading = undefined;
    });
    this.loading = operation;
    return operation;
  }

  /** Join routine reads; retry storage failures with a bounded per-owner backoff. */
  async refresh(): Promise<void> {
    if (this.loading || this.readiness === 'loading') {
      await this.ensureInitialized();
      return;
    }
    const retry = this.readiness === 'unavailable' && this.retryable && Date.now() >= this.retryAfter;
    if (this.readiness === 'ready' || retry) return this.startRefresh(!retry);
    await this.refreshing;
  }

  private startRefresh(refresh: boolean): Promise<void> {
    this.refreshing ??= this.load(refresh).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async retryFileRecovery(): Promise<void> {
    if (this.readiness === 'unavailable' && !this.shuttingDown) await this.startRefresh(false);
  }

  private stopFileRecovery(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  private async load(refresh: boolean): Promise<void> {
    const recovering = this.readiness === 'unavailable';
    await this.persistence.pause();
    if (!recovering && this.readiness === 'unavailable') return;
    if (!await this.readSnapshot(refresh)) return;
    this.readiness = 'ready';
    const drained = await this.persistence.resume();
    if (this.readiness !== 'ready') return;
    if (drained) this.restoreProjected();
    this.retryable = false;
    this.stopFileRecovery();
    if (recovering) logger.info('Block-state storage recovered; enforcement is ready');
  }

  /** Called with writes paused or by the queue between ordered mutations. */
  private async readSnapshot(refresh: boolean): Promise<boolean> {
    try {
      const result = await this.store.load(refresh);
      if (result.status !== 'loaded' && result.status !== 'absent') {
        this.markUnavailable(result.status, result.status === 'unreadable');
        return false;
      }
      const restored = new Map<string, BlockedContext>();
      for (const [name, value] of Object.entries(result.status === 'loaded' ? result.value : {})) {
        validateAgentName(name, 'restore');
        const normalized = name.trim();
        if (restored.has(normalized)) {
          throw new Error('Duplicate persisted agent name');
        }
        restored.set(normalized, this.restoreBlockedContext(normalized, value));
      }
      this.blockedContexts.clear();
      for (const [name, block] of restored) {
        this.blockedContexts.set(name, block);
      }
      this.persistence.replace(this.snapshot());
      this.restoreProjected();
      return true;
    } catch (error) {
      logger.warn('Blocked-agent snapshot could not be restored', { error });
      this.markUnavailable('invalid');
      return false;
    }
  }

  private restoreProjected(): void {
    this.blockedContexts.clear();
    for (const [name, value] of Object.entries(this.persistence.projected())) {
      this.blockedContexts.set(name, this.restoreBlockedContext(name, value));
    }
  }

  private markUnavailable(reason: string, retryable = false): void {
    const entering = this.readiness !== 'unavailable';
    this.retryable = retryable;
    this.retryAfter = Date.now() + 1000;
    this.readiness = 'unavailable';
    this.unavailableReason = reason;
    this.persistence.unavailable();
    this.restoreProjected();
    if (!this.shuttingDown) this.stopWatching ??= this.store.watchForRecovery?.(() => this.retryFileRecovery());
    if (!entering) return;
    const diagnostics = {
      reason, location: this.store.location,
      recovery: 'Repair the store and reload or restart; an administrator may reset it with clearAll.',
    };
    logger.warn('Blocked-agent state is unavailable', diagnostics);
    SecurityMonitor.logSecurityEvent({
      type: 'AUTONOMY_DENIED', severity: 'HIGH', source: 'DangerZoneEnforcer.initialize',
      details: 'Blocked-agent state is unavailable', additionalData: diagnostics,
    });
  }

  private restoreBlockedContext(agentName: string, value: unknown): BlockedContext {
    const optionalStrings = ['eventId', 'verificationId', 'sessionId', 'goalId'];
    const valid = isStateObject(value) && typeof value.reason === 'string'
      && optionalStrings.every(key => value[key] === undefined || typeof value[key] === 'string')
      && (value.triggeredPatterns === undefined || (Array.isArray(value.triggeredPatterns)
        && value.triggeredPatterns.every(pattern => typeof pattern === 'string')))
      && (value.requiresAdmin === undefined || typeof value.requiresAdmin === 'boolean');
    if (!valid) {
      return {
        agentName,
        reason: 'Persisted block could not be read',
        triggeredPatterns: [],
        blockedAt: new Date(0),
        requiresAdmin: true,
        originalRecord: { value },
      };
    }
    const block = value as unknown as PersistedBlock;
    return {
      eventId: block.eventId ?? block.verificationId,
      agentName,
      reason: block.reason,
      triggeredPatterns: block.triggeredPatterns ?? [],
      blockedAt: this.restoreBlockedAt(agentName, block.blockedAt),
      verificationId: block.verificationId,
      sessionId: block.sessionId,
      goalId: block.goalId,
      requiresAdmin: block.requiresAdmin,
    };
  }

  private restoreBlockedAt(agentName: string, value: unknown): Date {
    const parsed = new Date(typeof value === 'string' ? value : Number.NaN);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }

    logger.warn(`Invalid persisted blockedAt for agent '${agentName}'; preserving block with epoch timestamp`);
    return new Date(0);
  }

  /**
   * Block an agent context due to danger zone trigger
   *
   * @param agentName - Name of the agent to block
   * @param reason - Why the agent is blocked
   * @param triggeredPatterns - Patterns that caused the block
   * @param verificationId - Optional verification ID for unblocking
   * @param auditContext - Optional execution context for audit trail (Issue #404)
   * @throws Error if agentName is invalid
   *
   * @example
   * ```ts
   * await enforcer.block('code-reviewer', 'Danger zone pattern matched', ['rm -rf'], 'verify-abc');
   * (await enforcer.check('code-reviewer')).blocked; // true
   * ```
   */
  async block(
    agentName: string,
    reason: string,
    triggeredPatterns: string[],
    verificationId?: string,
    auditContext?: DangerZoneAuditContext,
    sessionId?: string,
  ): Promise<boolean> {
    validateAgentName(agentName, 'block');

    const trimmed = agentName.trim();
    const context: BlockedContext = {
      eventId: randomUUID(),
      agentName: trimmed,
      reason,
      triggeredPatterns,
      blockedAt: new Date(Date.now()),
      verificationId,
      sessionId,
      goalId: auditContext?.goalId,
    };

    this.blockedContexts.set(trimmed, context);
    this.totalBlocksSinceStartup++;

    logger.warn(
      `Agent '${trimmed}' blocked: danger zone pattern matched (${triggeredPatterns.join(', ')})`,
      {
        agentName: trimmed,
        reason,
        triggeredPatterns,
        verificationId,
        eventId: context.eventId,
      }
    );

    SecurityMonitor.logSecurityEvent({
      type: 'AUTONOMY_DENIED',
      severity: 'HIGH',
      source: 'DangerZoneEnforcer.block',
      details: `Agent '${trimmed}' blocked: danger zone pattern matched (${triggeredPatterns.join(', ')})`,
      additionalData: {
        agentName: trimmed,
        reason,
        triggeredPatterns,
        verificationId,
        totalActiveBlocks: this.blockedContexts.size,
        // Issue #404: Audit context for post-hoc investigation
        stepNumber: auditContext?.stepNumber,
        currentStepDescription: auditContext?.currentStepDescription,
        currentStepOutcome: auditContext?.currentStepOutcome,
        nextActionHint: auditContext?.nextActionHint,
        riskScore: auditContext?.riskScore,
        goalDescription: auditContext?.goalDescription?.substring(0, 200),
        goalId: auditContext?.goalId,
        safetyFactors: auditContext?.safetyFactors,
      },
    });

    const receipt = this.persistence.admit({ kind: 'put', name: trimmed, block: this.serializeBlock(context) });
    void this.ensureInitialized();
    return receipt.then(saved => {
      if (!saved) {
        const details = 'Agent block was not confirmed';
        const additionalData = { agentName: trimmed, verificationId,
          reason: this.readiness === 'ready' ? 'declined' : 'unavailable' };
        logger.warn(details, additionalData);
        SecurityMonitor.logSecurityEvent({
          type: 'AUTONOMY_DENIED', severity: 'HIGH', source: 'DangerZoneEnforcer.block',
          details, additionalData,
        });
      }
      return saved;
    });
  }

  /**
   * Unblock an agent context after verification
   *
   * @param agentName - Name of the agent to unblock
   * @param verificationId - Verification ID that was completed
   * @returns Whether the unblock was successful
   * @throws Error if agentName is invalid
   *
   * @example
   * ```ts
   * await enforcer.block('code-reviewer', 'Blocked', ['rm -rf'], 'verify-abc');
   *
   * await enforcer.unblock('code-reviewer', 'wrong-id');  // false — mismatch
   * await enforcer.unblock('code-reviewer', 'verify-abc'); // true  — success
   * ```
   */
  async unblock(agentName: string, verificationId?: string, sessionId?: string): Promise<boolean> {
    validateAgentName(agentName, 'unblock');
    await this.refresh();
    if (this.readiness !== 'ready') return false;

    const normalizedName = agentName.trim();
    const context = this.blockedContexts.get(normalizedName);

    if (!context) {
      logger.debug(
        `Unblock requested for agent '${normalizedName}' which is not currently blocked`,
        { agentName: normalizedName }
      );
      return true; // Not blocked, so "successfully" unblocked
    }

    if (context.requiresAdmin) return false;

    // Issue #1947: If the block has a sessionId, only the same session can unblock it.
    // If the block has a sessionId but the caller doesn't provide one, reject (prevents bypass).
    if (context.sessionId && context.sessionId !== sessionId) {
      logger.warn(
        `Unblock denied for agent '${normalizedName}': session mismatch (block session: ${context.sessionId}, caller: ${sessionId})`,
      );
      SecurityMonitor.logSecurityEvent({
        type: 'VERIFICATION_FAILED',
        severity: 'HIGH',
        source: 'DangerZoneEnforcer.unblock',
        details: `Unblock denied for agent '${normalizedName}': cross-session unblock attempt`,
        additionalData: {
          agentName: normalizedName,
          blockSessionId: context.sessionId,
          callerSessionId: sessionId,
          reason: 'session_mismatch',
        },
      });
      return false;
    }

    // If verification was required, check that it matches
    if (context.verificationId && verificationId !== context.verificationId) {
      logger.warn(
        `Unblock failed for agent '${normalizedName}': verification ID mismatch (expected: ${context.verificationId}, got: ${verificationId ?? 'none'})`,
        {
          agentName: normalizedName,
          expected: context.verificationId,
          provided: verificationId,
        }
      );

      SecurityMonitor.logSecurityEvent({
        type: 'VERIFICATION_FAILED',
        severity: 'HIGH',
        source: 'DangerZoneEnforcer.unblock',
        details: `Unblock denied for agent '${normalizedName}': verification ID mismatch (expected: ${context.verificationId}, got: ${verificationId ?? 'none'})`,
        additionalData: {
          agentName: normalizedName,
          expectedVerificationId: context.verificationId,
          providedVerificationId: verificationId ?? null,
          reason: 'verification_id_mismatch',
        },
      });

      return false;
    }

    const blockDuration = Date.now() - context.blockedAt.getTime();
    const removed = await this.persistence.admit({ kind: 'remove', name: normalizedName, eventId: context.eventId });
    this.restoreProjected();
    if (!removed || this.blockedContexts.has(normalizedName)) return false;
    this.totalUnblocksSinceStartup++;
    this.blockDurations.push(blockDuration);

    logger.info(
      `Agent '${normalizedName}' unblocked after verification (blocked for ${blockDuration}ms)`,
      {
        agentName: normalizedName,
        blockDurationMs: blockDuration,
      }
    );

    SecurityMonitor.logSecurityEvent({
      type: 'AUTONOMY_PAUSED',
      severity: 'MEDIUM',
      source: 'DangerZoneEnforcer.unblock',
      details: `Agent '${normalizedName}' unblocked after verification (blocked for ${blockDuration}ms)`,
      additionalData: {
        agentName: normalizedName,
        verificationId,
        blockDurationMs: blockDuration,
      },
    });

    return true;
  }

  /** Release a challenge-owned block only after current storage state is available. */
  async releaseChallenge(challengeId: string, sessionId?: string): Promise<BlockReleaseResult> {
    await this.refresh();
    if (this.readiness !== 'ready') return { released: false, reason: 'unavailable' };
    const block = Array.from(this.blockedContexts.values()).find(context => {
      const original = context.originalRecord?.value;
      return context.verificationId === challengeId
        || (isStateObject(original) && original.verificationId === challengeId);
    });
    if (!block) return { released: true };
    const restricted = this.releaseRestriction(block, sessionId);
    if (restricted) return { released: false, reason: restricted, agentName: block.agentName };
    if (await this.unblock(block.agentName, challengeId, sessionId)) {
      return { released: true, agentName: block.agentName };
    }
    const reason = this.readiness !== 'ready' ? 'unavailable'
      : this.releaseRestriction(this.blockedContexts.get(block.agentName), sessionId) ?? 'declined';
    return { released: false, reason, agentName: block.agentName };
  }

  private releaseRestriction(block: BlockedContext | undefined, sessionId?: string): BlockReleaseReason | undefined {
    if (block?.requiresAdmin) return 'admin-only';
    if (block?.sessionId && block.sessionId !== sessionId) return 'session';
    return undefined;
  }

  /**
   * Check if an agent context is blocked
   *
   * @param agentName - Name of the agent to check
   * @returns Block check result
   * @throws Error if agentName is invalid
   *
   * @example
   * ```ts
   * const result = await enforcer.check('code-reviewer');
   * if (result.blocked) {
   *   console.log(result.reason);     // why it was blocked
   *   console.log(result.resolution); // how to unblock
   * }
   * ```
   */
  async check(agentName: string, localStdio = false): Promise<BlockCheckResult> {
    validateAgentName(agentName, 'check');
    await this.refresh();
    if (this.readiness !== 'ready') {
      if (localStdio && this.store instanceof FileDangerZoneBlockStore) {
        return {
          blocked: true,
          reason: `Blocked-agent state is unavailable (${this.unavailableReason}) at ${this.store.location}.`,
          resolution: 'Request a local reset using request_blocked_agent_reset and review the desktop prompt.',
        };
      }
      return {
        blocked: true, reason: 'Blocked-agent state is unavailable.',
        resolution: 'Contact an administrator.',
      };
    }

    const context = this.blockedContexts.get(agentName.trim());

    if (!context) {
      return { blocked: false };
    }

    return {
      blocked: true,
      eventId: context.eventId,
      reason: context.reason,
      // Issue #142 / #405: Actionable verify_challenge instructions
      resolution: context.verificationId
        ? `Use verify_challenge with params { challenge_id: "${context.verificationId}", code: "<code from screen>" } to unblock this agent.`
        : 'Contact administrator to enable danger zone operations',
      verificationId: context.verificationId,
      sessionId: context.sessionId,
      goalId: context.goalId,
      blockedAt: context.blockedAt.toISOString(),
    };
  }

  /**
   * Check if any agent is currently blocked
   * Useful for diagnostics
   *
   * @example
   * ```ts
   * if (await enforcer.hasBlockedAgents()) {
   *   console.log('Blocked agents:', await enforcer.getBlockedAgents());
   * }
   * ```
   */
  async hasBlockedAgents(): Promise<boolean> {
    await this.ensureInitialized();
    return this.blockedContexts.size > 0;
  }

  /**
   * Get list of all blocked agents
   * Useful for admin/diagnostic purposes
   *
   * @example
   * ```ts
   * const agents = await enforcer.getBlockedAgents(); // ['code-reviewer', 'data-agent']
   * ```
   */
  async getBlockedAgents(): Promise<string[]> {
    await this.ensureInitialized();
    return Array.from(this.blockedContexts.keys());
  }

  /**
   * Clear all blocks (for testing or admin reset)
   *
   * Requires a configured DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN and matching token.
   * Refuses when no token is configured. Tests can configure one with setAdminToken.
   *
   * @param adminToken - Required matching admin token for authorization
   * @returns Whether the clear was successful
   *
   * @example
   * ```ts
   * // Without admin token configured
   * await enforcer.clearAll(); // false
   *
   * // With admin token configured
   * await enforcer.clearAll('wrong-token'); // false
   * await enforcer.clearAll('correct-token'); // true
   * ```
   */
  async clearAll(adminToken?: string): Promise<boolean> {
    if (!this.adminToken || adminToken !== this.adminToken) {
      logger.warn(
        'clearAll denied: configured admin token required',
        {
          tokenConfigured: !!this.adminToken,
          tokenProvided: !!adminToken,
        }
      );
      SecurityMonitor.logSecurityEvent({
        type: 'AUTONOMY_DENIED',
        severity: 'HIGH',
        source: 'DangerZoneEnforcer.clearAll',
        details: 'clearAll denied: configured admin token required',
        additionalData: { tokenConfigured: !!this.adminToken, tokenProvided: !!adminToken },
      });
      return false;
    }

    if (this.loading || this.readiness === 'loading') await this.ensureInitialized();
    if (this.readiness === 'ready' || this.refreshing) await this.refresh();
    if (this.readiness === 'loading') return false;
    if (this.readiness === 'unavailable') return this.resetUnavailable();
    const count = this.blockedContexts.size;
    const clearedAgents = Array.from(this.blockedContexts.keys());
    const cleared = await this.persistence.admit({ kind: 'clear' });
    this.restoreProjected();
    if (!cleared) {
      const details = 'Danger zone block clear was not confirmed';
      logger.warn(details, { count, clearedAgents });
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source: 'DangerZoneEnforcer.clearAll',
        details, additionalData: { count, clearedAgents, authorized: true },
      });
      return false;
    }
    this.totalClearAllCalls++;

    const agentLabel = count === 1 ? 'agent' : 'agents';
    const clearedAgentList = clearedAgents.join(', ') || 'none';
    const details = `All danger zone blocks cleared (${count} ${agentLabel}: ${clearedAgentList})`;
    logger.warn(
      details,
      { count, clearedAgents }
    );

    SecurityMonitor.logSecurityEvent({
      type: 'AUTONOMY_PAUSED',
      severity: 'MEDIUM',
      source: 'DangerZoneEnforcer.clearAll',
      details,
      additionalData: { clearedAgents, count, authorized: true },
    });

    return true;
  }

  /** A request can open the dialog. Only its shared approval commit can reset storage. */
  async requestLocalReset(sessionId: string, approve: ApproveLocalReset): Promise<LocalBlockResetResult> {
    const store = this.store;
    if (!(store instanceof FileDangerZoneBlockStore)) return 'unsupported';
    try {
      return await store.withResetDialog(() => this.requestBoundReset(store, sessionId, approve));
    } catch (error) {
      return error instanceof Error && error.message === 'Timed out waiting for the file write lock'
        ? 'busy' : 'unavailable';
    }
  }

  private async requestBoundReset(
    store: FileDangerZoneBlockStore, sessionId: string, approve: ApproveLocalReset,
  ): Promise<LocalBlockResetResult> {
    await this.refresh();
    if (this.readiness !== 'unavailable') return 'not_needed';
    const digest = await store.readResetDigest();
    // Force validation of the snapshot immediately before offering a reset.
    await this.startRefresh(false);
    if (this.readiness !== 'unavailable') return 'not_needed';
    if (await store.readResetDigest() !== digest) return 'changed';
    if (!this.resetPromptLimiter.tryAcquire()) return 'rate_limited';

    const request = { requestId: randomUUID(), sessionId, operationDigest: digest, expiresAt: Date.now() + 60_000 };
    let changed = false;
    const result = await approve(request, async approved => {
      if (approved.requestId !== request.requestId || approved.sessionId !== sessionId ||
          approved.operationDigest !== digest || approved.expiresAt !== request.expiresAt) return false;
      if (this.refreshing) await this.refreshing;
      if (this.readiness !== 'unavailable' || this.shuttingDown) {
        changed = true;
        return false;
      }
      return this.resetUnavailable(async pendingBlocks => {
        try {
          return await store.reset({ expectedDigest: digest, pendingBlocks });
        } catch (error) {
          changed = error instanceof ResetSnapshotChangedError;
          throw error;
        }
      });
    });
    return changed ? 'changed' : result;
  }

  private resetUnavailable(resetLocal?: (pendingBlocks: Record<string, unknown>) => Promise<string>): Promise<boolean> {
    this.readiness = 'loading';
    const rebase = resetLocal ? () => this.persistence.replace({}) : this.persistence.resetBoundary();
    const reset = this.resetSnapshot(rebase, resetLocal);
    const operation = reset.then(() => undefined).finally(() => {
      if (this.loading === operation) this.loading = undefined;
    });
    this.loading = operation;
    return reset;
  }

  private async resetSnapshot(
    rebase: () => void, resetLocal?: (pendingBlocks: Record<string, unknown>) => Promise<string>,
  ): Promise<boolean> {
    const source = resetLocal ? 'DangerZoneEnforcer.requestLocalReset' : 'DangerZoneEnforcer.clearAll';
    try {
      await this.persistence.pause();
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source,
        details: 'Administrative block-state reset authorized',
      });
      const evidence = resetLocal ? await resetLocal(this.persistence.pendingBlocks()) : await this.store.reset();
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source,
        details: evidence ? 'Administrative block-state reset authorized; evidence preserved'
          : 'Administrative block-state reset authorized; no evidence to preserve',
        additionalData: { evidence },
      });
      rebase();
      this.restoreProjected();
      this.readiness = 'ready';
      await this.persistence.resume();
      if (this.readiness !== 'ready') return false;
      this.retryable = false;
      this.stopFileRecovery();
      this.totalClearAllCalls++;
      SecurityMonitor.logSecurityEvent({
        type: 'AUTONOMY_PAUSED', severity: 'HIGH', source,
        details: 'Administrative block-state reset completed', additionalData: { evidence },
      });
      return true;
    } catch {
      this.markUnavailable('reset failed', true);
      return false;
    }
  }

  /**
   * Get metrics for danger zone enforcement
   * Useful for monitoring and diagnostics
   *
   * @example
   * ```ts
   * const metrics = enforcer.getMetrics();
   * console.log(metrics.averageBlockDurationMs); // rolling window (see METRICS_WINDOW_SIZE)
   * ```
   */
  getMetrics(): DangerZoneMetrics {
    const durations = this.blockDurations.toArray();
    const avgDuration =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
    const maxDuration =
      durations.length > 0 ? Math.max(...durations) : 0;

    return {
      currentBlockedCount: this.blockedContexts.size,
      totalBlocksSinceStartup: this.totalBlocksSinceStartup,
      totalUnblocksSinceStartup: this.totalUnblocksSinceStartup,
      totalClearAllCalls: this.totalClearAllCalls,
      averageBlockDurationMs: Math.round(avgDuration),
      longestBlockDurationMs: maxDuration,
    };
  }

  /**
   * Set admin token programmatically (for testing)
   * @internal
   */
  setAdminToken(token: string | null): void {
    this.adminToken = token;
  }

  /**
   * Reset metrics (for testing)
   * @internal
   */
  resetMetrics(): void {
    this.totalBlocksSinceStartup = 0;
    this.totalUnblocksSinceStartup = 0;
    this.totalClearAllCalls = 0;
    this.blockDurations.clear();
  }

  /**
   * Capture block state while preserving unparsed records.
   */
  private snapshot(): Record<string, unknown> {
    const blocks: Record<string, unknown> = Object.create(null);
    for (const [name, ctx] of this.blockedContexts) {
      blocks[name] = ctx.originalRecord ? ctx.originalRecord.value : this.serializeBlock(ctx);
    }
    return blocks;
  }

  private serializeBlock(context: BlockedContext): PersistedBlock {
    const { agentName: _agentName, originalRecord: _originalRecord, ...block } = context;
    return { ...block, blockedAt: block.blockedAt.toISOString() };
  }

  /** Stop the owner's watcher and wait for writes or a recovery already in progress. */
  shutdown(): Promise<boolean> {
    this.shuttingDown = true;
    this.stopFileRecovery();
    return this.flush();
  }

  /** Wait for this owner's queued snapshots before shutdown. */
  async flush(): Promise<boolean> {
    const fence = this.persistence.fence();
    await this.ensureInitialized();
    await this.refreshing;
    return (await fence) && this.readiness === 'ready';
  }
}
