/**
 * Centralized configuration for handoff payload size limits
 *
 * Issue #380 (Post-Review Hardening): Makes handoff size limits configurable
 * via environment variables. Previously, MAX_RECENT_ENTRIES and MAX_RECENT_DECISIONS
 * were hardcoded constants in handoff.ts.
 *
 * Environment variables follow the pattern: DOLLHOUSE_HANDOFF_*
 * Values are clamped between safety floors and security ceilings.
 *
 * @example
 * // Override via environment variables (set before server starts)
 * // DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES=50
 * // DOLLHOUSE_HANDOFF_MAX_RECENT_DECISIONS=25
 * // DOLLHOUSE_HANDOFF_WARN_PAYLOAD_BYTES=512000
 */

import { parseEnvInt } from './env-utils.js';

// ==================== HARD LIMITS (Security Ceiling) ====================
/**
 * Absolute maximum values — cannot be exceeded even with environment variable overrides.
 * Prevents resource exhaustion via unbounded handoff payloads.
 */
export const HANDOFF_HARD_LIMITS = {
  recentEntries: 100,
  recentDecisions: 50,
  warnPayloadBytes: 1_048_576,  // 1 MB
} as const;

// ==================== MIN LIMITS (Safety Floor) ====================
/**
 * Minimum values — configured values cannot go below these.
 * Ensures handoff blocks contain enough context to be useful.
 */
export const HANDOFF_MIN_LIMITS = {
  recentEntries: 5,
  recentDecisions: 3,
  warnPayloadBytes: 1_024,  // 1 KB
} as const;

// ==================== DEFAULTS ====================
/**
 * Default values when no environment variable is set.
 * Matches the original hardcoded constants.
 */
export const HANDOFF_DEFAULTS = {
  recentEntries: 20,
  recentDecisions: 10,
  warnPayloadBytes: 102_400,  // 100 KB
} as const;

// ==================== ENVIRONMENT VARIABLE MAPPING ====================
/**
 * Maps handoff config keys to their environment variable names.
 * Exported for documentation and testing purposes.
 */
export const HANDOFF_ENV_VARS = {
  recentEntries: 'DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES',
  recentDecisions: 'DOLLHOUSE_HANDOFF_MAX_RECENT_DECISIONS',
  warnPayloadBytes: 'DOLLHOUSE_HANDOFF_WARN_PAYLOAD_BYTES',
} as const;

// ==================== PUBLIC API ====================

/**
 * Get the maximum number of recent entries to include in a handoff payload.
 * Respects environment variable overrides with validation and clamping.
 */
export function getHandoffMaxRecentEntries(): number {
  return parseEnvInt(
    HANDOFF_ENV_VARS.recentEntries,
    HANDOFF_DEFAULTS.recentEntries,
    HANDOFF_MIN_LIMITS.recentEntries,
    HANDOFF_HARD_LIMITS.recentEntries,
    'Handoff limit'
  );
}

/**
 * Get the maximum number of recent decisions to include in a handoff payload.
 * Respects environment variable overrides with validation and clamping.
 */
export function getHandoffMaxRecentDecisions(): number {
  return parseEnvInt(
    HANDOFF_ENV_VARS.recentDecisions,
    HANDOFF_DEFAULTS.recentDecisions,
    HANDOFF_MIN_LIMITS.recentDecisions,
    HANDOFF_HARD_LIMITS.recentDecisions,
    'Handoff limit'
  );
}

/**
 * Get the payload size threshold (in bytes) at which a warning is logged.
 * Respects environment variable overrides with validation and clamping.
 */
export function getHandoffWarnPayloadBytes(): number {
  return parseEnvInt(
    HANDOFF_ENV_VARS.warnPayloadBytes,
    HANDOFF_DEFAULTS.warnPayloadBytes,
    HANDOFF_MIN_LIMITS.warnPayloadBytes,
    HANDOFF_HARD_LIMITS.warnPayloadBytes,
    'Handoff limit'
  );
}
