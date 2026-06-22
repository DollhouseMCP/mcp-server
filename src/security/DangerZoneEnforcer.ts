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
 * Issue #402: Refactored from singleton to DI-managed class with
 * file-based persistence. Blocks survive server restarts via
 * ~/.dollhouse/security/blocked-agents.json.
 *
 * @since v2.0.0 - Agentic Loop Completion (Epic #380)
 * @since v2.1.0 - File-based persistence (Issue #402)
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from './securityMonitor.js';
import { EvictingQueue } from '../utils/EvictingQueue.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';

/** Rolling-window size for block-duration metrics (matches SecurityMonitor/LogManager). */
const METRICS_WINDOW_SIZE = 1000;

/**
 * Blocked execution context
 */
interface BlockedContext {
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
}

/**
 * Persisted format for blocked-agents.json
 */
interface PersistedBlocks {
  version: number;
  blocks: Record<string, {
    reason: string;
    triggeredPatterns: string[];
    blockedAt: string;
    verificationId?: string;
    sessionId?: string;
  }>;
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
  /** Reason for blocking (if blocked) */
  reason?: string;
  /** How to resolve the block */
  resolution?: string;
  /** Verification ID if verification is required */
  verificationId?: string;
  /** Issue #1947: Session that created this block (undefined = globally verifiable) */
  sessionId?: string;
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
 * Validates agent name input
 * @throws Error if agent name is invalid
 */
function validateAgentName(agentName: string, operation: string): void {
  if (!agentName || typeof agentName !== 'string') {
    throw new Error(`${operation}: Agent name is required`);
  }
  const trimmed = agentName.trim();
  if (trimmed.length === 0) {
    throw new Error(`${operation}: Agent name cannot be empty or whitespace`);
  }
  // Prevent path traversal and special characters that could cause issues
  // eslint-disable-next-line no-control-regex -- Intentionally checking for control chars as security measure
  if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) {
    throw new Error(`${operation}: Agent name contains invalid characters`);
  }
  if (trimmed.length > 256) {
    throw new Error(`${operation}: Agent name exceeds maximum length of 256 characters`);
  }
}

/**
 * DI-managed class for danger zone enforcement with file-based persistence.
 *
 * Thread-safety note: This uses a Map which is not inherently thread-safe,
 * but in a Node.js single-threaded environment this is acceptable.
 * For multi-process deployments, consider Redis or similar.
 *
 * Persistence: Blocks are persisted to ~/.dollhouse/security/blocked-agents.json.
 * The in-memory Map is the hot path for check(); disk is the durable backing store.
 * Disk writes are fire-and-forget — disk failure does not block enforcement.
 */
export class DangerZoneEnforcer {
  private blockedContexts: Map<string, BlockedContext> = new Map();

  // Metrics tracking
  private totalBlocksSinceStartup = 0;
  private totalUnblocksSinceStartup = 0;
  private totalClearAllCalls = 0;
  private blockDurations = new EvictingQueue<number>(METRICS_WINDOW_SIZE);

  // Admin token for clearAll (can be set via environment or configuration)
  private adminToken: string | null = process.env.DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN || null;

  // Persistence
  private readonly fileOps: FileOperationsService;
  private readonly securityDir: string;
  private readonly persistPath: string;

  constructor(fileOps: FileOperationsService, securityDir?: string) {
    this.fileOps = fileOps;
    this.securityDir = securityDir ?? path.join(os.homedir(), '.dollhouse', 'security');
    this.persistPath = path.join(this.securityDir, 'blocked-agents.json');
  }

  /**
   * Load persisted blocks from disk.
   * Call once after construction to restore state from a previous session.
   * If the file is missing or corrupt, starts with empty blocks.
   *
   * @example
   * ```ts
   * const enforcer = new DangerZoneEnforcer(fileOps);
   * await enforcer.initialize(); // restores blocks from ~/.dollhouse/security/blocked-agents.json
   * ```
   */
  async initialize(): Promise<void> {
    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedBlocks;

      if (data.version === 1 && data.blocks && typeof data.blocks === 'object') {
        for (const [name, block] of Object.entries(data.blocks)) {
          this.blockedContexts.set(name, {
            agentName: name,
            reason: block.reason,
            triggeredPatterns: block.triggeredPatterns ?? [],
            blockedAt: new Date(block.blockedAt),
            verificationId: block.verificationId,
            sessionId: block.sessionId,
          });
        }

        if (this.blockedContexts.size > 0) {
          const names = Array.from(this.blockedContexts.keys());
          logger.warn(
            `Restored ${this.blockedContexts.size} danger zone block(s) from disk: ${names.join(', ')}`
          );

          SecurityMonitor.logSecurityEvent({
            type: 'AUTONOMY_DENIED',
            severity: 'MEDIUM',
            source: 'DangerZoneEnforcer.initialize',
            details: `Restored ${this.blockedContexts.size} danger zone block(s) from disk: ${names.join(', ')}`,
            additionalData: { restoredAgents: names, count: this.blockedContexts.size },
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('No blocked-agents.json found, starting with empty blocks');
      } else {
        logger.warn('Failed to load blocked-agents.json, starting with empty blocks', { error });

        SecurityMonitor.logSecurityEvent({
          type: 'AUTONOMY_DENIED',
          severity: 'MEDIUM',
          source: 'DangerZoneEnforcer.initialize',
          details: 'Failed to load blocked-agents.json — starting with empty blocks (possible data corruption)',
          additionalData: { error: String(error) },
        });
      }
    }
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
   * enforcer.block('code-reviewer', 'Danger zone pattern matched', ['rm -rf'], 'verify-abc');
   * enforcer.check('code-reviewer').blocked; // true
   * ```
   */
  block(
    agentName: string,
    reason: string,
    triggeredPatterns: string[],
    verificationId?: string,
    auditContext?: DangerZoneAuditContext,
    sessionId?: string,
  ): void {
    validateAgentName(agentName, 'block');

    const trimmed = agentName.trim();
    const context: BlockedContext = {
      agentName: trimmed,
      reason,
      triggeredPatterns,
      blockedAt: new Date(),
      verificationId,
      sessionId,
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

    this.persistAsync();
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
   * enforcer.block('code-reviewer', 'Blocked', ['rm -rf'], 'verify-abc');
   *
   * enforcer.unblock('code-reviewer', 'wrong-id');  // false — mismatch
   * enforcer.unblock('code-reviewer', 'verify-abc'); // true  — success
   * ```
   */
  unblock(agentName: string, verificationId?: string, sessionId?: string): boolean {
    validateAgentName(agentName, 'unblock');

    const normalizedName = agentName.trim();
    const context = this.blockedContexts.get(normalizedName);

    if (!context) {
      logger.debug(
        `Unblock requested for agent '${normalizedName}' which is not currently blocked`,
        { agentName: normalizedName }
      );
      return true; // Not blocked, so "successfully" unblocked
    }

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
    this.blockedContexts.delete(normalizedName);
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

    this.persistAsync();
    return true;
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
   * const result = enforcer.check('code-reviewer');
   * if (result.blocked) {
   *   console.log(result.reason);     // why it was blocked
   *   console.log(result.resolution); // how to unblock
   * }
   * ```
   */
  check(agentName: string): BlockCheckResult {
    validateAgentName(agentName, 'check');

    const context = this.blockedContexts.get(agentName.trim());

    if (!context) {
      return { blocked: false };
    }

    return {
      blocked: true,
      reason: context.reason,
      // Issue #142 / #405: Actionable verify_challenge instructions
      resolution: context.verificationId
        ? `Use verify_challenge with params { challenge_id: "${context.verificationId}", code: "<code from screen>" } to unblock this agent.`
        : 'Contact administrator to enable danger zone operations',
      verificationId: context.verificationId,
      sessionId: context.sessionId,
    };
  }

  /**
   * Check if any agent is currently blocked
   * Useful for diagnostics
   *
   * @example
   * ```ts
   * if (enforcer.hasBlockedAgents()) {
   *   console.log('Blocked agents:', enforcer.getBlockedAgents());
   * }
   * ```
   */
  hasBlockedAgents(): boolean {
    return this.blockedContexts.size > 0;
  }

  /**
   * Get list of all blocked agents
   * Useful for admin/diagnostic purposes
   *
   * @example
   * ```ts
   * const agents = enforcer.getBlockedAgents(); // ['code-reviewer', 'data-agent']
   * ```
   */
  getBlockedAgents(): string[] {
    return Array.from(this.blockedContexts.keys());
  }

  /**
   * Clear all blocks (for testing or admin reset)
   *
   * When DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN is set, requires matching token.
   * Without environment variable, clearAll is unrestricted (for testing).
   *
   * @param adminToken - Admin token for authorization (required if env var is set)
   * @returns Whether the clear was successful
   *
   * @example
   * ```ts
   * // Without admin token configured
   * enforcer.clearAll(); // true
   *
   * // With admin token configured
   * enforcer.clearAll('wrong-token'); // false
   * enforcer.clearAll('correct-token'); // true
   * ```
   */
  clearAll(adminToken?: string): boolean {
    // If admin token is configured, require it
    if (this.adminToken && adminToken !== this.adminToken) {
      logger.warn(
        'clearAll failed: admin token required but not provided (or incorrect)',
        {
          tokenProvided: !!adminToken,
        }
      );
      SecurityMonitor.logSecurityEvent({
        type: 'AUTONOMY_DENIED',
        severity: 'HIGH',
        source: 'DangerZoneEnforcer.clearAll',
        details: 'clearAll failed: admin token required but not provided (or incorrect)',
        additionalData: { tokenProvided: !!adminToken },
      });
      return false;
    }

    const count = this.blockedContexts.size;
    const clearedAgents = Array.from(this.blockedContexts.keys());
    this.blockedContexts.clear();
    this.totalClearAllCalls++;

    logger.warn(
      `All danger zone blocks cleared (${count} agent${count !== 1 ? 's' : ''}: ${clearedAgents.join(', ') || 'none'})`,
      { count, clearedAgents }
    );

    SecurityMonitor.logSecurityEvent({
      type: 'AUTONOMY_PAUSED',
      severity: 'MEDIUM',
      source: 'DangerZoneEnforcer.clearAll',
      details: `All danger zone blocks cleared (${count} agent${count !== 1 ? 's' : ''}: ${clearedAgents.join(', ') || 'none'})`,
      additionalData: { clearedAgents, count, authorized: true },
    });

    this.persistAsync();
    return true;
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
   * Fire-and-forget persistence. Disk failure does not block enforcement.
   */
  private persistAsync(): void {
    this.persist().catch(error => {
      logger.warn('Failed to persist danger zone blocks to disk', { error });

      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_OPERATION',
        severity: 'MEDIUM',
        source: 'DangerZoneEnforcer.persistAsync',
        details: `Failed to persist ${this.blockedContexts.size} danger zone block(s) to disk — enforcement continues in-memory only`,
        additionalData: { error: String(error), activeBlocks: this.blockedContexts.size },
      });
    });
  }

  /**
   * Write current block state to disk.
   */
  private async persist(): Promise<void> {
    const data: PersistedBlocks = {
      version: 1,
      blocks: {},
    };

    for (const [name, ctx] of this.blockedContexts) {
      data.blocks[name] = {
        reason: ctx.reason,
        triggeredPatterns: ctx.triggeredPatterns,
        blockedAt: ctx.blockedAt.toISOString(),
        verificationId: ctx.verificationId,
        sessionId: ctx.sessionId,
      };
    }

    await fs.mkdir(this.securityDir, { recursive: true });
    await this.fileOps.writeFile(this.persistPath, JSON.stringify(data, null, 2));
  }
}
