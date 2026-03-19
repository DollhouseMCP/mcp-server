/**
 * Centralized configuration for active element limits
 *
 * Issue #83 (Phase 1): Makes active element limits configurable via environment variables.
 * Previously, each manager had hardcoded MAX_ACTIVE_* and ACTIVE_SET_CLEANUP_THRESHOLD constants.
 *
 * Environment variables follow the pattern: DOLLHOUSE_MAX_ACTIVE_{TYPE}
 * Values are clamped between safety floors and security ceilings.
 *
 * @example
 * // Override via environment variables (set before server starts)
 * // DOLLHOUSE_MAX_ACTIVE_SKILLS=300
 * // DOLLHOUSE_MAX_ACTIVE_AGENTS=150
 * // DOLLHOUSE_MAX_ACTIVE_MEMORIES=200
 * // DOLLHOUSE_MAX_ACTIVE_ENSEMBLES=75
 * // DOLLHOUSE_MAX_ACTIVE_PERSONAS=50
 */

import { parseEnvInt } from './env-utils.js';

// ==================== TYPES ====================

/** Element types that support active element limits */
export type ActiveLimitElementType = 'skills' | 'agents' | 'memories' | 'ensembles' | 'personas';

/** Configuration for a single element type's active limits */
export interface ActiveElementLimitConfig {
  /** Maximum number of active elements before warning/cleanup triggers */
  max: number;
  /** Threshold at which cleanup of stale references begins (typically floor(max * 0.9)) */
  cleanupThreshold: number;
}

// ==================== HARD LIMITS (Security Ceiling) ====================
/**
 * Absolute maximum values — cannot be exceeded even with environment variable overrides.
 * Prevents resource exhaustion and DoS via unbounded active sets.
 */
export const ACTIVE_ELEMENT_HARD_LIMITS: Record<ActiveLimitElementType, number> = {
  skills: 1000,
  agents: 500,
  memories: 500,
  ensembles: 200,
  personas: 100
};

// ==================== MIN LIMITS (Safety Floor) ====================
/**
 * Minimum values — configured values cannot go below these.
 * Ensures basic functionality is always available.
 */
export const ACTIVE_ELEMENT_MIN_LIMITS: Record<ActiveLimitElementType, number> = {
  skills: 5,
  agents: 5,
  memories: 5,
  ensembles: 2,
  personas: 2
};

// ==================== DEFAULTS ====================
/**
 * Default max active limits when no environment variable is set.
 * Increased from original hardcoded values for better out-of-box experience.
 */
export const ACTIVE_ELEMENT_DEFAULTS: Record<ActiveLimitElementType, number> = {
  skills: 200,    // was 100
  agents: 100,    // was 50
  memories: 100,  // was 30
  ensembles: 50,  // was 20
  personas: 20    // new (previously unlimited)
};

// ==================== ENVIRONMENT VARIABLE MAPPING ====================
/**
 * Maps element types to their environment variable names.
 * Exported for documentation and testing purposes.
 */
export const ACTIVE_LIMIT_ENV_VARS: Record<ActiveLimitElementType, string> = {
  skills: 'DOLLHOUSE_MAX_ACTIVE_SKILLS',
  agents: 'DOLLHOUSE_MAX_ACTIVE_AGENTS',
  memories: 'DOLLHOUSE_MAX_ACTIVE_MEMORIES',
  ensembles: 'DOLLHOUSE_MAX_ACTIVE_ENSEMBLES',
  personas: 'DOLLHOUSE_MAX_ACTIVE_PERSONAS'
};

// ==================== INTERNAL CONSTANTS ====================

/** Ratio of max at which stale-reference cleanup begins (90% of max) */
const CLEANUP_THRESHOLD_RATIO = 0.9;

// ==================== PUBLIC API ====================

/**
 * Get the maximum active element limit for a given element type.
 * Respects environment variable overrides with validation and clamping.
 *
 * @param type - Element type
 * @returns Maximum active elements allowed
 */
export function getMaxActiveLimit(type: ActiveLimitElementType): number {
  const envVar = ACTIVE_LIMIT_ENV_VARS[type];
  const defaultValue = ACTIVE_ELEMENT_DEFAULTS[type];
  const min = ACTIVE_ELEMENT_MIN_LIMITS[type];
  const max = ACTIVE_ELEMENT_HARD_LIMITS[type];

  return parseEnvInt(envVar, defaultValue, min, max, 'Active element limit');
}

/**
 * Get the full active element limit configuration for a given element type.
 * Returns both max limit and cleanup threshold (floor(max * 0.9)).
 *
 * @param type - Element type
 * @returns Configuration with max and cleanupThreshold
 */
export function getActiveElementLimitConfig(type: ActiveLimitElementType): ActiveElementLimitConfig {
  const max = getMaxActiveLimit(type);
  return {
    max,
    cleanupThreshold: Math.floor(max * CLEANUP_THRESHOLD_RATIO)
  };
}
