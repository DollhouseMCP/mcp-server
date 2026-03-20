/**
 * Centralized configuration for autonomy evaluation thresholds
 *
 * Issue #390 (Post-Review Improvement): Makes risk thresholds and step limits
 * configurable via environment variables. Previously, RISK_THRESHOLDS and
 * maxAutonomousSteps were hardcoded constants in autonomyEvaluator.ts.
 *
 * Environment variables follow the pattern: DOLLHOUSE_AUTONOMY_*
 * Values are clamped between safety floors and security ceilings.
 *
 * @example
 * // Override via environment variables (set before server starts)
 * // DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE=20
 * // DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE=40
 * // DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE=70
 * // DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT=15
 */

import { parseEnvInt } from './env-utils.js';

// ==================== HARD LIMITS (Security Ceiling) ====================
/**
 * Absolute maximum values — cannot be exceeded even with environment variable overrides.
 * Prevents nonsensical or dangerous configurations.
 */
export const AUTONOMY_HARD_LIMITS = {
  /** Max conservative threshold. Prevents it from being set so high it never triggers. */
  thresholdConservative: 50,
  /** Max moderate threshold. */
  thresholdModerate: 80,
  /** Max aggressive threshold. Must stay below 100 to retain some safety margin. */
  thresholdAggressive: 95,
  /** Max step limit. Prevents runaway agents even with misconfiguration. */
  maxStepsDefault: 100,
} as const;

// ==================== MIN LIMITS (Safety Floor) ====================
/**
 * Minimum values — configured values cannot go below these.
 * Ensures thresholds remain meaningful and agents don't immediately pause.
 */
export const AUTONOMY_MIN_LIMITS = {
  /** Min conservative threshold. Must be positive to allow very-low-risk actions. */
  thresholdConservative: 5,
  /** Min moderate threshold. Must be above conservative floor. */
  thresholdModerate: 20,
  /** Min aggressive threshold. Must be above moderate floor. */
  thresholdAggressive: 40,
  /** Min step limit. Agents need at least 1 step to do anything. */
  maxStepsDefault: 1,
} as const;

// ==================== DEFAULTS ====================
/**
 * Default values when no environment variable is set.
 * Matches the original hardcoded constants from autonomyEvaluator.ts.
 */
export const AUTONOMY_DEFAULTS = {
  /**
   * Conservative threshold (25): Pauses on any moderate risk.
   * Suitable for production, financial, or security-sensitive agents.
   */
  thresholdConservative: 25,
  /**
   * Moderate threshold (50): Balances autonomy and safety.
   * Default for most agents.
   */
  thresholdModerate: 50,
  /**
   * Aggressive threshold (75): Only pauses on high-risk actions.
   * For trusted, well-tested agents in controlled environments.
   */
  thresholdAggressive: 75,
  /**
   * Default max autonomous steps (10): How many steps an agent can
   * take before requiring human check-in.
   */
  maxStepsDefault: 10,
} as const;

// ==================== ENVIRONMENT VARIABLE MAPPING ====================
/**
 * Maps autonomy config keys to their environment variable names.
 * Exported for documentation and testing purposes.
 */
export const AUTONOMY_ENV_VARS = {
  thresholdConservative: 'DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE',
  thresholdModerate: 'DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE',
  thresholdAggressive: 'DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE',
  maxStepsDefault: 'DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT',
} as const;

// ==================== PUBLIC API ====================

/**
 * Get the conservative risk threshold.
 *
 * Actions with risk scores above this threshold require human approval
 * when an agent uses conservative risk tolerance. Low value means the
 * agent pauses on even moderate-risk actions.
 *
 * Suitable for production, financial, or security-sensitive agents.
 */
export function getAutonomyThresholdConservative(): number {
  return parseEnvInt(
    AUTONOMY_ENV_VARS.thresholdConservative,
    AUTONOMY_DEFAULTS.thresholdConservative,
    AUTONOMY_MIN_LIMITS.thresholdConservative,
    AUTONOMY_HARD_LIMITS.thresholdConservative,
    'Autonomy threshold'
  );
}

/**
 * Get the moderate risk threshold.
 *
 * Balances autonomy and safety. Default for most agents.
 * Actions with risk scores above this value trigger a pause.
 */
export function getAutonomyThresholdModerate(): number {
  return parseEnvInt(
    AUTONOMY_ENV_VARS.thresholdModerate,
    AUTONOMY_DEFAULTS.thresholdModerate,
    AUTONOMY_MIN_LIMITS.thresholdModerate,
    AUTONOMY_HARD_LIMITS.thresholdModerate,
    'Autonomy threshold'
  );
}

/**
 * Get the aggressive risk threshold.
 *
 * Only pauses on high-risk actions. For trusted, well-tested agents
 * in controlled environments where speed is prioritized.
 */
export function getAutonomyThresholdAggressive(): number {
  return parseEnvInt(
    AUTONOMY_ENV_VARS.thresholdAggressive,
    AUTONOMY_DEFAULTS.thresholdAggressive,
    AUTONOMY_MIN_LIMITS.thresholdAggressive,
    AUTONOMY_HARD_LIMITS.thresholdAggressive,
    'Autonomy threshold'
  );
}

/**
 * Get the default maximum autonomous steps.
 *
 * Controls how many steps an agent can take before requiring
 * human check-in, when the agent doesn't specify its own limit.
 */
export function getAutonomyMaxStepsDefault(): number {
  return parseEnvInt(
    AUTONOMY_ENV_VARS.maxStepsDefault,
    AUTONOMY_DEFAULTS.maxStepsDefault,
    AUTONOMY_MIN_LIMITS.maxStepsDefault,
    AUTONOMY_HARD_LIMITS.maxStepsDefault,
    'Autonomy limit'
  );
}

/**
 * Get all risk thresholds as a record keyed by tolerance level.
 *
 * Convenience function for callers that need the full threshold map
 * (e.g., the autonomy evaluator's checkRiskThreshold function).
 *
 * @returns Object with keys `conservative`, `moderate`, and `aggressive`,
 *   each mapping to a risk score threshold (0–100). These keys correspond
 *   to the `riskTolerance` field on `AgentAutonomyConfig`. Actions with
 *   risk scores above the agent's tolerance threshold trigger a pause.
 */
export function getAutonomyRiskThresholds(): Record<string, number> {
  return {
    conservative: getAutonomyThresholdConservative(),
    moderate: getAutonomyThresholdModerate(),
    aggressive: getAutonomyThresholdAggressive(),
  };
}
