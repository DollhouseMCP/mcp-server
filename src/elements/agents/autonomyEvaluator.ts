/**
 * Autonomy Evaluator Service
 *
 * Determines whether an agent should continue autonomously or pause
 * for human input after each step. This is the brain that enables
 * automatic continue/pause decisions in the agentic loop.
 *
 * Decision factors:
 * 1. Step count vs maxAutonomousSteps
 * 2. Next action vs requiresApproval patterns
 * 3. Safety tier (ALLOW/VERIFY/DENY)
 * 4. Risk tolerance configuration
 *
 * ## Danger Zone Verification Flow (Issue #142)
 *
 * When an agent action triggers the DANGER_ZONE or VERIFY safety tier,
 * a human-in-the-loop verification is required before the agent can proceed.
 *
 * End-to-end sequence:
 *
 *  1. Agent proposes an action (nextActionHint) during agentic loop
 *  2. evaluateAutonomy() calls checkSafetyTier() → returns DANGER_ZONE or VERIFY
 *  3. createVerificationChallenge() generates a challenge with:
 *     - challengeId (UUID v4 via crypto.randomUUID)
 *     - displayCode (human-readable code, e.g. "ABC123")
 *     - expiresAt (configurable, default 5 minutes)
 *  4. storeAndDisplayChallenge():
 *     a. Stores {code, expiresAt, reason} in VerificationStore (server-side, one-time use)
 *     b. Shows displayCode to human via OS-native dialog (AppleScript/zenity/PowerShell)
 *     c. displayCode is NEVER included in the LLM-facing directive
 *  5. For DANGER_ZONE: DangerZoneEnforcer.block() programmatically blocks the agent
 *     with verificationId=challengeId (file-backed, survives restarts)
 *  6. LLM receives directive with verification.verificationId but NO displayCode
 *     plus actionable guidance: "Use verify_challenge { challenge_id, code }"
 *  7. Human reads code from OS dialog, tells LLM
 *  8. LLM calls verify_challenge MCP-AQL operation
 *  9. MCPAQLHandler verify handler:
 *     a. Validates UUID v4 format (rejects invalid IDs before store lookup)
 *     b. Checks rate limit (max 10 failures per 60s sliding window)
 *     c. Distinguishes expired (VERIFICATION_EXPIRED) from wrong code (VERIFICATION_FAILED)
 *     d. On success: finds blocked agent by challengeId → DangerZoneEnforcer.unblock()
 *     e. Logs granular security events at each stage
 * 10. Agent retries the operation → passes (no longer blocked)
 *
 * Security invariants:
 * - displayCode never reaches the LLM (stripped before directive is built)
 * - Codes are one-time use (VerificationStore deletes after any verify attempt)
 * - Expired challenges are rejected with distinct VERIFICATION_EXPIRED events
 * - Challenge IDs are validated as UUID v4 before store lookup (anti-enumeration)
 * - Failed attempts are rate-limited globally (anti-brute-force)
 * - All verification events are logged with granular types for monitoring
 *
 * Part of the Agentic Loop Completion (Epic #380).
 *
 * @since v2.0.0
 */

import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { matchesPattern } from '../../utils/patternMatcher.js';
import {
  determineSafetyTier,
  createVerificationChallenge,
  DEFAULT_SAFETY_CONFIG,
  showVerificationDialog,
} from './safetyTierService.js';
import {
  getAutonomyRiskThresholds,
  getAutonomyMaxStepsDefault,
} from '../../config/autonomy-config.js';
import type {
  AutonomyContext,
  AutonomyDirective,
  AgentAutonomyConfig,
  SafetyTier,
} from './types.js';

/**
 * Default autonomy configuration
 *
 * Used when an agent doesn't specify autonomy settings.
 * Conservative defaults prioritize safety over speed.
 *
 * Note: maxAutonomousSteps uses a getter to support env-var overrides
 * (Issue #390). The static value here serves as the baseline; callers
 * should prefer mergeWithDefaults() which reads the live config.
 */
export const DEFAULT_AUTONOMY_CONFIG: Required<AgentAutonomyConfig> = {
  riskTolerance: 'moderate',
  maxAutonomousSteps: 10,
  requiresApproval: [],
  autoApprove: [],
  verificationTimeoutMinutes: 5,
};

// ============================================================================
// Internal Check Result Types
// ============================================================================

/** Result from checkStepLimit — indicates whether step budget allows continuation. */
interface StepLimitResult {
  /** Whether the agent may continue (true) or must pause (false). */
  continue: boolean;
  /** Human-readable pause reason (only set when continue=false). */
  reason?: string;
  /** Descriptive factor string for the directive's factors array. */
  factor: string;
}

/** Result from checkActionPatterns — indicates whether action patterns allow continuation. */
interface ActionPatternResult {
  /** Whether the agent may continue (true) or must pause (false). */
  continue: boolean;
  /** Human-readable pause reason (only set when continue=false). */
  reason?: string;
  /** Descriptive factor strings for the directive's factors array. */
  factors: string[];
}

/** Result from checkSafetyTier — includes tier info and optional verification. */
interface SafetyTierResult {
  /** Whether the agent may continue (true) or must pause (false). */
  continue: boolean;
  /** Human-readable pause reason (only set when continue=false). */
  reason?: string;
  /** Descriptive factor strings for the directive's factors array. */
  factors: string[];
  /** The evaluated safety tier. */
  tier?: SafetyTier;
  /** Verification challenge info when tier requires human verification. */
  verification?: AutonomyDirective['verification'];
  /** True when the agent must be hard-stopped (danger zone). */
  stopped?: boolean;
}

/** Result from checkRiskThreshold — indicates whether risk score is within tolerance. */
interface RiskThresholdResult {
  /** Whether the agent may continue (true) or must pause (false). */
  continue: boolean;
  /** Human-readable pause reason (only set when continue=false). */
  reason?: string;
  /** Descriptive factor string for the directive's factors array. */
  factor: string;
}

// ============================================================================
// Autonomy Decision Metrics (Issue #391)
// ============================================================================

/**
 * Snapshot of autonomy evaluation metrics.
 * Non-persisted, in-memory counters reset on server restart.
 */
export interface AutonomyMetricsSnapshot {
  /** Total evaluateAutonomy() calls since startup */
  totalEvaluations: number;
  /** Number of evaluations that returned continue=true */
  continueCount: number;
  /** Number of evaluations that returned continue=false */
  pauseCount: number;
  /** Distribution of pause reasons (reason string → count) */
  pauseReasons: Record<string, number>;
  /** Number of danger zone blocks triggered */
  dangerZoneTriggered: number;
  /** Number of verification challenges created */
  verificationRequired: number;
  /** Average step count at time of pause (0 if no pauses yet) */
  averageStepCountAtPause: number;
}

/**
 * Lightweight in-memory tracker for autonomy evaluation patterns.
 * Issue #391: Provides observability into agent continue/pause decisions.
 */
class AutonomyMetricsTracker {
  private _totalEvaluations = 0;
  private _continueCount = 0;
  private _pauseCount = 0;
  private _pauseReasons: Record<string, number> = {};
  private _dangerZoneTriggered = 0;
  private _verificationRequired = 0;
  private _pauseStepCounts: number[] = [];
  private static readonly MAX_STEP_COUNTS = 1000;
  private static readonly LOG_INTERVAL = 50;

  recordContinue(): void {
    this._totalEvaluations++;
    this._continueCount++;
    this.maybeLogSnapshot();
  }

  recordPause(reason: string, stepCount: number): void {
    this._totalEvaluations++;
    this._pauseCount++;
    this._pauseReasons[reason] = (this._pauseReasons[reason] || 0) + 1;
    this._pauseStepCounts.push(stepCount);
    if (this._pauseStepCounts.length > AutonomyMetricsTracker.MAX_STEP_COUNTS) {
      this._pauseStepCounts.shift();
    }
    this.maybeLogSnapshot();
  }

  recordDangerZone(): void {
    this._dangerZoneTriggered++;
  }

  recordVerification(): void {
    this._verificationRequired++;
  }

  getSnapshot(): AutonomyMetricsSnapshot {
    const avgStepCount = this._pauseStepCounts.length > 0
      ? Math.round(
          this._pauseStepCounts.reduce((a, b) => a + b, 0) / this._pauseStepCounts.length
        )
      : 0;
    return {
      totalEvaluations: this._totalEvaluations,
      continueCount: this._continueCount,
      pauseCount: this._pauseCount,
      pauseReasons: { ...this._pauseReasons },
      dangerZoneTriggered: this._dangerZoneTriggered,
      verificationRequired: this._verificationRequired,
      averageStepCountAtPause: avgStepCount,
    };
  }

  /** Reset (for testing). */
  reset(): void {
    this._totalEvaluations = 0;
    this._continueCount = 0;
    this._pauseCount = 0;
    this._pauseReasons = {};
    this._dangerZoneTriggered = 0;
    this._verificationRequired = 0;
    this._pauseStepCounts = [];
  }

  private maybeLogSnapshot(): void {
    if (this._totalEvaluations > 0 && this._totalEvaluations % AutonomyMetricsTracker.LOG_INTERVAL === 0) {
      logger.info('Autonomy evaluation metrics snapshot', {
        ...this.getSnapshot(),
      });
    }
  }
}

/** Module-level metrics instance (Issue #391) */
const autonomyMetrics = new AutonomyMetricsTracker();

/**
 * Get the current autonomy evaluation metrics snapshot.
 * Issue #391: Programmatic access for monitoring/diagnostics.
 */
export function getAutonomyMetrics(): AutonomyMetricsSnapshot {
  return autonomyMetrics.getSnapshot();
}

/**
 * Reset autonomy metrics (for testing only).
 * @internal
 */
export function resetAutonomyMetrics(): void {
  autonomyMetrics.reset();
}

/**
 * Sanitize a risk score to a valid 0-100 number.
 *
 * Handles NaN, non-number types, Infinity, and out-of-range values with
 * appropriate warning logs. Always returns a concrete number in [0, 100]
 * suitable for threshold comparison and safety tier evaluation.
 *
 * @param score - The raw risk score to sanitize (may be any numeric edge case)
 * @param agentName - Agent name for contextual log messages
 * @returns A clamped, finite number in the range [0, 100]
 */
function sanitizeRiskScore(score: number, agentName: string): number {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    logger.warn('Invalid risk score (NaN or non-number), treating as 0', {
      originalScore: score,
      agentName,
    });
    return 0;
  }

  if (!Number.isFinite(score)) {
    logger.warn('Infinite risk score, clamping to range boundary', {
      originalScore: score,
      agentName,
    });
    return score > 0 ? 100 : 0;
  }

  if (score < 0 || score > 100) {
    logger.warn('Risk score out of range, clamping to 0-100', {
      originalScore: score,
      agentName,
    });
    return Math.max(0, Math.min(100, score));
  }

  return score;
}

/**
 * Store a verification code server-side and show it to the human via OS dialog.
 * The display code is intentionally NOT returned to the LLM.
 *
 * Issue #142: Danger zone verification flow
 */
function storeAndDisplayChallenge(
  challenge: { challengeId: string; displayCode?: string; reason: string; expiresAt: string },
  context: AutonomyContext
): void {
  if (!challenge.displayCode) return;

  // Store server-side for later verification
  if (context.verificationStore) {
    context.verificationStore.set(challenge.challengeId, {
      code: challenge.displayCode,
      expiresAt: new Date(challenge.expiresAt).getTime(),
      reason: challenge.reason,
    });
  }

  // Show to human via OS-native dialog (fire-and-forget, non-blocking for evaluation)
  try {
    showVerificationDialog(
      challenge.displayCode,
      challenge.reason,
      { title: 'DollhouseMCP - Verification Required', icon: 'warning' }
    );
  } catch (error) {
    logger.warn('Failed to show verification dialog', {
      error: error instanceof Error ? error.message : String(error),
      challengeId: challenge.challengeId,
    });
  }
}

/**
 * Evaluate whether an agent should continue autonomously or pause
 *
 * This is the main entry point for autonomy decisions. Call this after
 * each step to determine if the LLM can proceed or must wait for
 * human approval.
 *
 * @param context - The autonomy evaluation context
 * @returns AutonomyDirective indicating continue or pause
 */
export function evaluateAutonomy(context: AutonomyContext): AutonomyDirective {
  const config = mergeWithDefaults(context.autonomyConfig);
  const factors: string[] = [];

  logger.debug('Evaluating autonomy', {
    agentName: context.agentName,
    stepCount: context.stepCount,
    outcome: context.currentStepOutcome,
    nextActionHint: context.nextActionHint,
  });

  // Early validation: sanitize risk score before any checks consume it
  if (context.riskScore !== undefined) {
    context.riskScore = sanitizeRiskScore(context.riskScore, context.agentName);
  }

  // Check 1: Step count limit
  const stepLimitResult = checkStepLimit(context.stepCount, config.maxAutonomousSteps);
  if (stepLimitResult) {
    factors.push(stepLimitResult.factor);
    if (!stepLimitResult.continue) {
      autonomyMetrics.recordPause(stepLimitResult.reason || 'step_limit', context.stepCount);
      return buildDirective(false, stepLimitResult.reason, factors, {
        stepsRemaining: 0,
      });
    }
  }

  // Check 2: Current step outcome
  if (context.currentStepOutcome === 'failure') {
    factors.push('Previous step failed');
    autonomyMetrics.recordPause('Previous step failed - human review recommended', context.stepCount);
    return buildDirective(false, 'Previous step failed - human review recommended', factors);
  }

  // Check 3: Pattern matching for next action
  if (context.nextActionHint) {
    const patternResult = checkActionPatterns(
      context.nextActionHint,
      config.requiresApproval,
      config.autoApprove
    );
    factors.push(...patternResult.factors);
    if (!patternResult.continue) {
      autonomyMetrics.recordPause(patternResult.reason || 'pattern_match', context.stepCount);
      return buildDirective(false, patternResult.reason, factors);
    }
  }

  // Check 4: Safety tier evaluation
  if (context.nextActionHint || context.riskScore !== undefined) {
    const safetyResult = checkSafetyTier(
      context.nextActionHint || context.currentStepDescription,
      context.riskScore || 0,
      config.riskTolerance,
      config.verificationTimeoutMinutes
    );
    factors.push(...safetyResult.factors);

    if (safetyResult.stopped) {
      // Issue #142: Create verification challenge for danger zone unblocking
      const dzChallenge = createVerificationChallenge(
        `Danger zone verification: ${(context.nextActionHint || context.currentStepDescription).substring(0, 100)}`,
        'display_code',
        config.verificationTimeoutMinutes
      );

      // Store the code server-side and show via OS dialog (Issue #142)
      storeAndDisplayChallenge(dzChallenge, context);

      // Programmatic enforcement: block the agent from further execution
      // This prevents a compromised LLM from ignoring the danger zone warning
      // Issue #402: Use DI-injected enforcer instead of singleton
      context.dangerZoneEnforcer?.block(
        context.agentName,
        safetyResult.reason || 'Danger zone operation detected',
        safetyResult.factors,
        dzChallenge.challengeId,
        {
          stepNumber: context.stepCount,
          currentStepDescription: context.currentStepDescription,
          currentStepOutcome: context.currentStepOutcome,
          nextActionHint: context.nextActionHint,
          riskScore: context.riskScore,
          goalDescription: context.goalDescription,
          goalId: context.goalId,
          safetyFactors: factors,
        }
      );

      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_TRIGGERED',
        severity: 'HIGH',
        source: 'AutonomyEvaluator.evaluateAutonomy',
        details: `Agent '${context.agentName}' blocked: danger zone verification required — ${safetyResult.reason ?? 'danger zone operation detected'}`,
        additionalData: {
          agentName: context.agentName,
          factors,
          nextActionHint: context.nextActionHint,
          stepCount: context.stepCount,
          riskScore: context.riskScore,
          currentStepDescription: context.currentStepDescription,
          goalDescription: context.goalDescription?.substring(0, 200),
          challengeId: dzChallenge.challengeId,
        },
      });
      autonomyMetrics.recordPause(safetyResult.reason || 'danger_zone', context.stepCount);
      autonomyMetrics.recordDangerZone();
      autonomyMetrics.recordVerification();
      return buildDirective(false, safetyResult.reason, factors, {
        stopped: true,
        nextStepRisk: 'danger_zone',
        // Issue #142: Include verification info (without displayCode) so LLM knows how to unblock
        verification: {
          verificationId: dzChallenge.challengeId,
          prompt: dzChallenge.prompt,
          // displayCode intentionally omitted — shown via OS dialog only
          challengeType: dzChallenge.challengeType,
          expiresAt: dzChallenge.expiresAt,
        },
      });
    }

    if (safetyResult.verification) {
      // Issue #142: Store code server-side, show via OS dialog, strip displayCode
      storeAndDisplayChallenge(
        {
          challengeId: safetyResult.verification.verificationId,
          displayCode: safetyResult.verification.displayCode,
          reason: `Verify action: ${(context.nextActionHint || context.currentStepDescription).substring(0, 100)}`,
          expiresAt: safetyResult.verification.expiresAt,
        },
        context
      );
      autonomyMetrics.recordPause(safetyResult.reason || 'verification_required', context.stepCount);
      autonomyMetrics.recordVerification();
      return buildDirective(false, safetyResult.reason, factors, {
        verification: {
          verificationId: safetyResult.verification.verificationId,
          prompt: safetyResult.verification.prompt,
          // displayCode intentionally omitted — shown via OS dialog only (Issue #142)
          challengeType: safetyResult.verification.challengeType,
          expiresAt: safetyResult.verification.expiresAt,
        },
        nextStepRisk: safetyResult.tier,
      });
    }

    if (!safetyResult.continue) {
      autonomyMetrics.recordPause(safetyResult.reason || 'safety_tier', context.stepCount);
      return buildDirective(false, safetyResult.reason, factors, {
        nextStepRisk: safetyResult.tier,
      });
    }
  }

  // Check 5: Risk score vs tolerance threshold
  if (context.riskScore !== undefined) {
    const thresholdResult = checkRiskThreshold(context.riskScore, config.riskTolerance);
    factors.push(thresholdResult.factor);
    if (!thresholdResult.continue) {
      autonomyMetrics.recordPause(thresholdResult.reason || 'risk_threshold', context.stepCount);
      return buildDirective(false, thresholdResult.reason, factors);
    }
  }

  // All checks passed - continue autonomously
  const stepsRemaining =
    config.maxAutonomousSteps > 0
      ? config.maxAutonomousSteps - context.stepCount - 1
      : undefined;

  factors.push('All autonomy checks passed');

  logger.debug('Autonomy evaluation complete: continue', {
    agentName: context.agentName,
    stepsRemaining,
    factors,
  });

  // Issue #391: Record metrics for continue outcome
  autonomyMetrics.recordContinue();

  return buildDirective(true, undefined, factors, { stepsRemaining });
}

/**
 * Check if step count has reached the maximum allowed autonomous steps.
 *
 * @param stepCount - Current zero-based step index
 * @param maxSteps - Maximum autonomous steps allowed (0 = unlimited)
 * @returns StepLimitResult with continue/pause decision and descriptive factor,
 *   or null if maxSteps is 0 (unlimited) — though in practice always returns a result
 */
function checkStepLimit(
  stepCount: number,
  maxSteps: number
): StepLimitResult | null {
  if (maxSteps === 0) {
    return { continue: true, factor: 'Unlimited autonomous steps configured' };
  }

  if (stepCount >= maxSteps) {
    return {
      continue: false,
      reason: `Maximum autonomous steps reached (${maxSteps})`,
      factor: `Step ${stepCount + 1} exceeds maxAutonomousSteps=${maxSteps}`,
    };
  }

  return {
    continue: true,
    factor: `Step ${stepCount + 1} of ${maxSteps} autonomous steps`,
  };
}

/**
 * Check an action string against requiresApproval and autoApprove glob patterns.
 *
 * requiresApproval patterns take precedence over autoApprove patterns.
 * If no pattern matches, the action is allowed by default.
 *
 * @param action - The proposed next action string (e.g. "delete user data")
 * @param requiresApproval - Glob patterns that force a pause (e.g. ["*delete*"])
 * @param autoApprove - Glob patterns that explicitly allow continuation (e.g. ["read*"])
 * @returns ActionPatternResult with continue/pause decision and matching factor strings
 */
function checkActionPatterns(
  action: string,
  requiresApproval: string[],
  autoApprove: string[]
): ActionPatternResult {
  const factors: string[] = [];
  const actionLower = action.toLowerCase();

  // requiresApproval takes precedence
  for (const pattern of requiresApproval) {
    if (matchesPattern(actionLower, pattern)) {
      factors.push(`Action matches requiresApproval pattern: ${pattern}`);
      return {
        continue: false,
        reason: `Action requires approval: matches pattern "${pattern}"`,
        factors,
      };
    }
  }

  // Check autoApprove patterns
  for (const pattern of autoApprove) {
    if (matchesPattern(actionLower, pattern)) {
      factors.push(`Action matches autoApprove pattern: ${pattern}`);
      return { continue: true, factors };
    }
  }

  factors.push('No pattern match - using default behavior');
  return { continue: true, factors };
}

// matchesPattern is imported from '../../utils/patternMatcher.js'

/**
 * Evaluate the safety tier for a proposed action and determine if it can proceed.
 *
 * Calls `determineSafetyTier()` from the safety package and maps the result
 * to a continue/pause decision. Tiers escalate: advisory → confirm → verify → danger_zone.
 *
 * Issue #389: Wraps determineSafetyTier() in try-catch. If the safety package throws,
 * logs the error and returns a conservative "pause" result (fail-safe: if we can't
 * evaluate safety, don't continue).
 *
 * @param action - Description of the proposed next action
 * @param riskScore - Numeric risk score (0-100, already sanitized)
 * @param riskTolerance - Agent's risk tolerance level ("conservative" | "moderate" | "aggressive")
 * @param verificationTimeoutMinutes - Expiry time for verification challenges (default: 5)
 * @returns SafetyTierResult with continue/pause decision, tier info, and optional verification challenge
 */
function checkSafetyTier(
  action: string,
  riskScore: number,
  riskTolerance: string,
  verificationTimeoutMinutes: number = 5
): SafetyTierResult {
  const factors: string[] = [];

  // Determine safety tier (Issue #389: fail-safe on errors)
  let tierResult;
  try {
    tierResult = determineSafetyTier(
      riskScore,
      [], // No security warnings for step evaluation
      action,
      DEFAULT_SAFETY_CONFIG
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Safety tier evaluation failed — returning conservative pause', {
      error: errorMsg,
      action: action.substring(0, 200),
      riskScore,
      riskTolerance,
    });
    SecurityMonitor.logSecurityEvent({
      type: 'SAFETY_EVALUATION_FAILURE',
      severity: 'HIGH',
      source: 'AutonomyEvaluator.checkSafetyTier',
      details: `determineSafetyTier() threw: ${errorMsg}`,
      additionalData: { action: action.substring(0, 200), riskScore, riskTolerance },
    });
    factors.push(`Safety tier evaluation failed: ${errorMsg}`);
    return {
      continue: false,
      reason: 'Safety evaluation failed — pausing for human review',
      factors,
    };
  }

  factors.push(`Safety tier: ${tierResult.tier}`);
  factors.push(...tierResult.factors.map((f) => `  - ${f}`));

  switch (tierResult.tier) {
    case 'advisory':
      return { continue: true, factors, tier: 'advisory' };

    case 'confirm':
      // For moderate+ tolerance, auto-approve confirm tier
      if (riskTolerance === 'aggressive') {
        factors.push('Aggressive risk tolerance: auto-approving CONFIRM tier');
        return { continue: true, factors, tier: 'confirm' };
      }
      return {
        continue: false,
        reason: 'Action requires confirmation before proceeding',
        factors,
        tier: 'confirm',
      };

    case 'verify': {
      // Create verification challenge
      const challenge = createVerificationChallenge(
        `Verify action: ${action.substring(0, 100)}`,
        'display_code',
        verificationTimeoutMinutes
      );
      return {
        continue: false,
        reason: 'Action requires verification before proceeding',
        factors,
        tier: 'verify',
        verification: {
          verificationId: challenge.challengeId,
          prompt: challenge.prompt,
          displayCode: challenge.displayCode,
          challengeType: challenge.challengeType,
          expiresAt: challenge.expiresAt,
        },
      };
    }

    case 'danger_zone':
      return {
        continue: false,
        reason: 'Action blocked: danger zone operation detected',
        factors,
        tier: 'danger_zone',
        stopped: true,
      };

    default:
      return { continue: true, factors, tier: tierResult.tier };
  }
}

/**
 * Check whether a risk score exceeds the threshold for the given tolerance level.
 *
 * Uses strict greater-than comparison: a score equal to the threshold is allowed.
 * Issue #390: Thresholds are now configurable via environment variables.
 *
 * @param riskScore - Numeric risk score (0-100, already sanitized)
 * @param riskTolerance - Agent's risk tolerance level ("conservative" | "moderate" | "aggressive")
 * @returns RiskThresholdResult with continue/pause decision and descriptive factor
 */
function checkRiskThreshold(
  riskScore: number,
  riskTolerance: string
): RiskThresholdResult {
  const thresholds = getAutonomyRiskThresholds();
  const threshold = thresholds[riskTolerance] ?? thresholds.moderate;

  if (riskScore > threshold) {
    return {
      continue: false,
      reason: `Risk score (${riskScore}) exceeds ${riskTolerance} threshold (${threshold})`,
      factor: `Risk ${riskScore} > threshold ${threshold} for ${riskTolerance} tolerance`,
    };
  }

  return {
    continue: true,
    factor: `Risk ${riskScore} within ${riskTolerance} threshold (${threshold})`,
  };
}

/**
 * Merge a partial user-provided autonomy config with defaults.
 *
 * Missing fields fall back to DEFAULT_AUTONOMY_CONFIG values, except
 * maxAutonomousSteps which reads the env-configurable default (Issue #390).
 *
 * @param config - Optional partial autonomy config from the agent definition
 * @returns Fully populated config with all fields guaranteed present
 */
function mergeWithDefaults(config?: AgentAutonomyConfig): Required<AgentAutonomyConfig> {
  return {
    riskTolerance: config?.riskTolerance ?? DEFAULT_AUTONOMY_CONFIG.riskTolerance,
    maxAutonomousSteps: config?.maxAutonomousSteps ?? getAutonomyMaxStepsDefault(),
    requiresApproval: config?.requiresApproval ?? DEFAULT_AUTONOMY_CONFIG.requiresApproval,
    autoApprove: config?.autoApprove ?? DEFAULT_AUTONOMY_CONFIG.autoApprove,
    verificationTimeoutMinutes: config?.verificationTimeoutMinutes ?? DEFAULT_AUTONOMY_CONFIG.verificationTimeoutMinutes,
  };
}

/**
 * Build a structured AutonomyDirective from components.
 *
 * @param shouldContinue - Whether the agent may continue autonomously
 * @param reason - Human-readable explanation when paused (undefined when continuing)
 * @param factors - Array of descriptive strings explaining each check's contribution
 * @param extras - Optional additional fields (stepsRemaining, stopped, verification, nextStepRisk)
 * @returns Complete AutonomyDirective ready for the LLM handoff
 */
function buildDirective(
  shouldContinue: boolean,
  reason: string | undefined,
  factors: string[],
  extras?: Partial<AutonomyDirective>
): AutonomyDirective {
  return {
    continue: shouldContinue,
    reason,
    factors,
    ...extras,
  };
}

/**
 * Quick check if an action would be auto-approved given an autonomy config.
 *
 * Utility function for pre-checking actions before execution.
 * Does NOT evaluate safety tiers or risk scores — only pattern matching.
 *
 * @param action - The proposed action string to check
 * @param config - Optional autonomy config (uses defaults if not provided)
 * @returns true if the action matches an autoApprove pattern or the agent
 *   uses aggressive tolerance; false if it matches requiresApproval or no match
 */
export function wouldAutoApprove(
  action: string,
  config?: AgentAutonomyConfig
): boolean {
  const mergedConfig = mergeWithDefaults(config);
  const actionLower = action.toLowerCase();

  // Check requiresApproval first (takes precedence)
  for (const pattern of mergedConfig.requiresApproval) {
    if (matchesPattern(actionLower, pattern)) {
      return false;
    }
  }

  // Check autoApprove
  for (const pattern of mergedConfig.autoApprove) {
    if (matchesPattern(actionLower, pattern)) {
      return true;
    }
  }

  // Default behavior depends on risk tolerance
  return mergedConfig.riskTolerance === 'aggressive';
}
