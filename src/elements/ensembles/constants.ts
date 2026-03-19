/**
 * Constants for Ensemble elements
 *
 * Defines limits, defaults, and security constants following patterns from other elements
 *
 * CONFIGURABILITY (Issue #368):
 * Limits can be configured via:
 * 1. Environment variables (e.g., ENSEMBLE_MAX_ELEMENTS=100)
 * 2. Global configuration object (setGlobalEnsembleLimits())
 * 3. Per-ensemble overrides via metadata.resourceLimits
 *
 * Priority: Per-ensemble > Global config > Environment variables > Defaults
 *
 * @example
 * // 1. Environment variables (set before server starts)
 * // ENSEMBLE_MAX_ELEMENTS=100
 * // ENSEMBLE_MAX_NESTING_DEPTH=3
 * // ENSEMBLE_MAX_ACTIVATION_TIME=60000
 *
 * @example
 * // 2. Global configuration (programmatic)
 * import { setGlobalEnsembleLimits } from './constants.js';
 * setGlobalEnsembleLimits({
 *   maxElements: 75,
 *   maxNestingDepth: 4,
 *   maxActivationTime: 45000
 * });
 *
 * @example
 * // 3. Per-ensemble override (in ensemble metadata)
 * const ensemble = new Ensemble({
 *   name: 'my-ensemble',
 *   resourceLimits: {
 *     maxActiveElements: 25,      // Maps to MAX_ELEMENTS
 *     maxExecutionTimeMs: 10000   // Maps to MAX_ACTIVATION_TIME
 *   }
 * }, elements, metadataService);
 */

import { logger } from '../../utils/logger.js';
import { parseEnvInt } from '../../config/env-utils.js';

// ==================== HARD LIMITS (Security) ====================
/**
 * Absolute maximum values for security - cannot be exceeded even with configuration
 * These prevent resource exhaustion and DoS attacks
 */
export const ENSEMBLE_HARD_LIMITS = {
  MAX_ELEMENTS: 500,                   // Absolute max elements (security ceiling)
  MAX_NESTING_DEPTH: 10,               // Absolute max nesting (prevent stack overflow)
  MAX_ACTIVATION_TIME: 300000,         // 5 minutes absolute max (300 seconds)
  MAX_CONTEXT_SIZE: 10000,             // Absolute max context keys
  MAX_CONTEXT_VALUE_SIZE: 1048576,     // 1MB absolute max per value
  MAX_DEPENDENCIES: 50,                // Absolute max dependencies per element
  MAX_CONDITION_LENGTH: 1000           // Absolute max condition length
} as const;

/**
 * Minimum values for safety - configured values cannot go below these
 */
export const ENSEMBLE_MIN_LIMITS = {
  MAX_ELEMENTS: 1,                     // Must allow at least 1 element
  MAX_NESTING_DEPTH: 0,                // 0 means no nesting allowed
  MAX_ACTIVATION_TIME: 1000,           // At least 1 second
  MAX_CONTEXT_SIZE: 10,                // At least 10 context keys
  MAX_CONTEXT_VALUE_SIZE: 100,         // At least 100 bytes per value
  MAX_DEPENDENCIES: 1,                 // At least 1 dependency allowed
  MAX_CONDITION_LENGTH: 10             // At least 10 chars for conditions
} as const;

// ==================== GLOBAL CONFIGURATION ====================
/**
 * Interface for configurable ensemble limits
 * All properties are optional - unset properties use defaults
 */
export interface EnsembleLimitsConfig {
  /** Maximum elements in an ensemble (default: 50, max: 500) */
  maxElements?: number;
  /** Maximum depth of nested ensembles (default: 5, max: 10) */
  maxNestingDepth?: number;
  /** Maximum activation time in ms (default: 30000, max: 300000) */
  maxActivationTime?: number;
  /** Maximum keys in shared context (default: 1000, max: 10000) */
  maxContextSize?: number;
  /** Maximum size of a context value in bytes (default: 10000, max: 1048576) */
  maxContextValueSize?: number;
  /** Maximum dependencies per element (default: 10, max: 50) */
  maxDependencies?: number;
  /** Maximum length of activation condition (default: 200, max: 1000) */
  maxConditionLength?: number;
}

// Global configuration storage (module-level singleton)
let globalConfig: EnsembleLimitsConfig = {};

/**
 * Set global ensemble limits configuration
 * Values are validated against hard limits
 *
 * @param config - Configuration object with desired limits
 * @example
 * setGlobalEnsembleLimits({
 *   maxElements: 100,
 *   maxNestingDepth: 3,
 *   maxActivationTime: 60000
 * });
 */
export function setGlobalEnsembleLimits(config: EnsembleLimitsConfig): void {
  const previousConfig = { ...globalConfig };
  const previousKeys = Object.keys(previousConfig);
  globalConfig = { ...config };
  const newKeys = Object.keys(config);

  // Determine what changed for the audit trail
  const addedKeys = newKeys.filter(k => !previousKeys.includes(k));
  const removedKeys = previousKeys.filter(k => !newKeys.includes(k));
  const modifiedKeys = newKeys.filter(k =>
    previousKeys.includes(k) &&
    previousConfig[k as keyof EnsembleLimitsConfig] !== config[k as keyof EnsembleLimitsConfig]
  );

  const timestamp = new Date().toISOString();
  const summary = `${addedKeys.length} added, ${removedKeys.length} removed, ${modifiedKeys.length} modified`;

  // Info level: concise summary for normal operation
  logger.info('Global ensemble limits configuration updated', {
    timestamp,
    summary,
    configuredKeys: newKeys
  });

  // Debug level: complete audit trail for troubleshooting
  logger.debug('Global ensemble limits configuration audit trail', {
    timestamp,
    previousConfig: previousKeys.length > 0 ? previousConfig : '(no previous configuration)',
    newConfig: config,
    changes: {
      added: addedKeys.length > 0 ? addedKeys : undefined,
      removed: removedKeys.length > 0 ? removedKeys : undefined,
      modified: modifiedKeys.length > 0 ? modifiedKeys.map(k => ({
        key: k,
        from: previousConfig[k as keyof EnsembleLimitsConfig],
        to: config[k as keyof EnsembleLimitsConfig]
      })) : undefined
    },
    summary,
    impact: 'New limits apply to ensembles created or activated after this change. Existing cached limits are not affected until invalidateLimitsCache() is called.'
  });
}

/**
 * Get current global ensemble limits configuration
 * @returns Copy of current global config
 */
export function getGlobalEnsembleLimits(): Readonly<EnsembleLimitsConfig> {
  return { ...globalConfig };
}

/**
 * Reset global ensemble limits to defaults (clears all overrides)
 */
export function resetGlobalEnsembleLimits(): void {
  const previousConfig = { ...globalConfig };
  const hadPreviousConfig = Object.keys(previousConfig).length > 0;
  globalConfig = {};

  const timestamp = new Date().toISOString();
  const clearedKeys = hadPreviousConfig ? Object.keys(previousConfig) : [];

  // Info level: concise summary for normal operation
  logger.info('Global ensemble limits configuration reset to defaults', {
    timestamp,
    clearedCount: clearedKeys.length
  });

  // Debug level: complete audit trail for troubleshooting
  if (hadPreviousConfig) {
    logger.debug('Global ensemble limits reset audit trail', {
      timestamp,
      previousConfig,
      clearedKeys,
      newConfig: '(using defaults - environment variables and per-ensemble overrides still apply)',
      impact: 'Ensembles will now use environment variables or built-in defaults. Existing cached limits are not affected until invalidateLimitsCache() is called.'
    });
  }
}

// ==================== EFFECTIVE LIMITS CALCULATION ====================
/**
 * Resolved ensemble limits structure
 * Uses number type (not literal types) since values are computed at runtime
 */
export interface ResolvedEnsembleLimits {
  readonly MAX_ELEMENTS: number;
  readonly MAX_NESTING_DEPTH: number;
  readonly MAX_ACTIVATION_TIME: number;
  readonly MAX_CONTEXT_SIZE: number;
  readonly MAX_CONTEXT_VALUE_SIZE: number;
  readonly MAX_DEPENDENCIES: number;
  readonly MAX_CONDITION_LENGTH: number;
}

/**
 * Get effective limits with proper priority:
 * Per-ensemble override > Global config > Environment variable > Default
 *
 * @param perEnsembleOverrides - Optional per-ensemble limit overrides
 * @returns Resolved limits object
 */
export function getEffectiveLimits(perEnsembleOverrides?: Partial<EnsembleLimitsConfig>): ResolvedEnsembleLimits {
  // Helper to resolve a single limit value
  const resolveLimit = (
    key: keyof EnsembleLimitsConfig,
    envVar: string,
    defaultVal: number,
    minVal: number,
    maxVal: number
  ): number => {
    // Priority: per-ensemble > global > env > default
    let value = defaultVal;

    // Check environment variable
    const envValue = parseEnvInt(envVar, defaultVal, minVal, maxVal, 'Ensemble limit');
    if (process.env[envVar] !== undefined) {
      value = envValue;
    }

    // Check global config
    if (globalConfig[key] !== undefined) {
      value = Math.max(minVal, Math.min(maxVal, globalConfig[key]!));
    }

    // Check per-ensemble override
    if (perEnsembleOverrides?.[key] !== undefined) {
      value = Math.max(minVal, Math.min(maxVal, perEnsembleOverrides[key]!));
    }

    return value;
  };

  return {
    MAX_ELEMENTS: resolveLimit('maxElements', 'ENSEMBLE_MAX_ELEMENTS', 50,
      ENSEMBLE_MIN_LIMITS.MAX_ELEMENTS, ENSEMBLE_HARD_LIMITS.MAX_ELEMENTS),
    MAX_NESTING_DEPTH: resolveLimit('maxNestingDepth', 'ENSEMBLE_MAX_NESTING_DEPTH', 5,
      ENSEMBLE_MIN_LIMITS.MAX_NESTING_DEPTH, ENSEMBLE_HARD_LIMITS.MAX_NESTING_DEPTH),
    MAX_ACTIVATION_TIME: resolveLimit('maxActivationTime', 'ENSEMBLE_MAX_ACTIVATION_TIME', 30000,
      ENSEMBLE_MIN_LIMITS.MAX_ACTIVATION_TIME, ENSEMBLE_HARD_LIMITS.MAX_ACTIVATION_TIME),
    MAX_CONTEXT_SIZE: resolveLimit('maxContextSize', 'ENSEMBLE_MAX_CONTEXT_SIZE', 1000,
      ENSEMBLE_MIN_LIMITS.MAX_CONTEXT_SIZE, ENSEMBLE_HARD_LIMITS.MAX_CONTEXT_SIZE),
    MAX_CONTEXT_VALUE_SIZE: resolveLimit('maxContextValueSize', 'ENSEMBLE_MAX_CONTEXT_VALUE_SIZE', 10000,
      ENSEMBLE_MIN_LIMITS.MAX_CONTEXT_VALUE_SIZE, ENSEMBLE_HARD_LIMITS.MAX_CONTEXT_VALUE_SIZE),
    MAX_DEPENDENCIES: resolveLimit('maxDependencies', 'ENSEMBLE_MAX_DEPENDENCIES', 10,
      ENSEMBLE_MIN_LIMITS.MAX_DEPENDENCIES, ENSEMBLE_HARD_LIMITS.MAX_DEPENDENCIES),
    MAX_CONDITION_LENGTH: resolveLimit('maxConditionLength', 'ENSEMBLE_MAX_CONDITION_LENGTH', 200,
      ENSEMBLE_MIN_LIMITS.MAX_CONDITION_LENGTH, ENSEMBLE_HARD_LIMITS.MAX_CONDITION_LENGTH)
  };
}

// ==================== DEFAULT LIMITS (Backwards Compatible) ====================
/**
 * Resource limits to prevent DoS attacks and ensure system stability
 *
 * Note: Rate limiting is not implemented at the Ensemble level because:
 * 1. The activationInProgress flag already prevents concurrent activations
 * 2. Rate limiting should be handled at the handler/API level, not in the domain model
 * 3. Different deployment scenarios may have different rate limiting requirements
 *
 * CONFIGURABILITY: Use getEffectiveLimits() to get limits that respect
 * environment variables, global config, and per-ensemble overrides.
 * This constant provides the base defaults for backwards compatibility.
 */
export const ENSEMBLE_LIMITS = {
  MAX_ELEMENTS: 50,                    // Maximum elements in an ensemble
  MAX_NESTING_DEPTH: 5,                // Maximum depth of nested ensembles
  MAX_ACTIVATION_TIME: 30000,          // 30 seconds max activation time
  MAX_CONTEXT_SIZE: 1000,              // Maximum keys in shared context
  MAX_CONTEXT_VALUE_SIZE: 10000,       // Maximum size of a context value (bytes)
  MAX_DEPENDENCIES: 10,                // Maximum dependencies per element
  MAX_CONDITION_LENGTH: 200            // Maximum length of activation condition
} as const;

/**
 * Default values for ensemble configuration
 */
export const ENSEMBLE_DEFAULTS = {
  ACTIVATION_STRATEGY: 'sequential' as const,
  CONFLICT_RESOLUTION: 'last-write' as const,
  ELEMENT_ROLE: 'support' as const,
  PRIORITY: 50,                        // Mid-range priority (0-100)
  ALLOW_NESTED: true,
  ACTIVATION_TIMEOUT: 5000,            // 5 seconds per element
  MAX_NESTING_DEPTH: 5,
  CONTEXT_SHARING: 'selective' as const
} as const;

/**
 * Supported activation strategies
 * Must match ActivationStrategy type in types.ts
 */
export const ACTIVATION_STRATEGIES = [
  'all',
  'sequential',
  'lazy',
  'conditional',
  'priority'
] as const;

/**
 * Supported conflict resolution strategies
 */
export const CONFLICT_STRATEGIES = [
  'last-write',
  'first-write',
  'priority',
  'merge',
  'error'
] as const;

/**
 * Element roles within an ensemble
 */
export const ELEMENT_ROLES = [
  'primary',
  'support',
  'override',
  'monitor',
  'core'   // Legacy alias for 'primary' — accepted for backwards compatibility
] as const;

/**
 * Activation modes for elements
 */
export const ACTIVATION_MODES = [
  'always',
  'on-demand',
  'conditional'
] as const;

/**
 * Security event types for ensemble operations
 * These are logged via SecurityMonitor for audit trails
 */
export const ENSEMBLE_SECURITY_EVENTS = {
  CIRCULAR_DEPENDENCY: 'ENSEMBLE_CIRCULAR_DEPENDENCY',
  RESOURCE_LIMIT_EXCEEDED: 'ENSEMBLE_RESOURCE_LIMIT_EXCEEDED',
  ACTIVATION_TIMEOUT: 'ENSEMBLE_ACTIVATION_TIMEOUT',
  ACTIVATION_FAILED: 'ENSEMBLE_ACTIVATION_FAILED',
  SUSPICIOUS_CONDITION: 'ENSEMBLE_SUSPICIOUS_CONDITION',
  CONDITION_EVALUATION_FAILED: 'ENSEMBLE_CONDITION_EVALUATION_FAILED',
  NESTED_DEPTH_EXCEEDED: 'ENSEMBLE_NESTED_DEPTH_EXCEEDED',
  CONTEXT_SIZE_EXCEEDED: 'ENSEMBLE_CONTEXT_SIZE_EXCEEDED',
  CONTEXT_VALUE_TOO_LARGE: 'ENSEMBLE_CONTEXT_VALUE_TOO_LARGE',
  SAVED: 'ENSEMBLE_SAVED',
  IMPORTED: 'ENSEMBLE_IMPORTED',
  DELETED: 'ENSEMBLE_DELETED',
  ACTIVATED: 'ENSEMBLE_ACTIVATED',
  DEACTIVATED: 'ENSEMBLE_DEACTIVATED'
} as const;

/**
 * Error messages for validation
 */
export const ENSEMBLE_ERRORS = {
  TOO_MANY_ELEMENTS: `Ensemble cannot contain more than ${ENSEMBLE_LIMITS.MAX_ELEMENTS} elements`,
  NESTING_TOO_DEEP: `Ensemble nesting depth cannot exceed ${ENSEMBLE_LIMITS.MAX_NESTING_DEPTH}`,
  CIRCULAR_DEPENDENCY: 'Circular dependency detected in ensemble',
  INVALID_STRATEGY: 'Invalid activation strategy',
  INVALID_CONFLICT_RESOLUTION: 'Invalid conflict resolution strategy',
  INVALID_ELEMENT_ROLE: 'Invalid element role',
  INVALID_ACTIVATION_MODE: 'Invalid activation mode',
  ELEMENT_NOT_FOUND: 'Element not found in ensemble',
  ACTIVATION_TIMEOUT: 'Ensemble activation timed out',
  CONTEXT_OVERFLOW: 'Shared context size exceeded limits',
  ELEMENT_LOAD_FAILED: 'Failed to load element',
  CONDITION_EVALUATION_FAILED: 'Failed to evaluate activation condition'
} as const;

/**
 * Regex patterns for validation
 */
export const ENSEMBLE_PATTERNS = {
  // Condition pattern - allows safe comparison expressions
  // Allows almost any character EXCEPT obviously dangerous ones (backticks, $, braces)
  // The real security enforcement happens in:
  // 1. DANGEROUS_CONDITION_PATTERNS check (blocks eval, require, etc.)
  // 2. VM sandbox execution (prevents code injection)
  //
  // This pattern just prevents template literals (`), variable interpolation (${}),
  // and code blocks ({}). Everything else is allowed and will be safely evaluated in the VM.
  CONDITION_PATTERN: /^[^`${}]+$/,

  // Element name pattern (alphanumeric, hyphens, underscores)
  ELEMENT_NAME_PATTERN: /^[a-zA-Z0-9_-]+$/
} as const;

/**
 * Dangerous keywords that should be rejected in conditions
 *
 * These patterns are checked separately from CONDITION_PATTERN for security.
 * Note: We focus on dangerous code execution patterns rather than unsupported
 * operators, since condition evaluation isn't implemented yet. When it is
 * implemented, the evaluator will handle operator support properly.
 */
export const DANGEROUS_CONDITION_PATTERNS = [
  // Function calls and code execution
  /\beval\b/i,
  /\bFunction\b/i,
  /\brequire\b/i,
  /\bimport\b/i,
  /\bexport\b/i,

  // Process and global access
  /\bprocess\b/i,
  /\bglobal\b/i,
  /\bwindow\b/i,
  /\bdocument\b/i,

  // Prototype pollution
  /__proto__/i,
  /\bconstructor\b/i,
  /\.prototype\b/i,

  // Dangerous operators
  /[;,?:]/,                    // Semicolon, comma, ternary
  /(?<![=!<>])=(?![=])/,       // Assignment (but allow ==, !=, ===, !==, <=, >=)
  /\+=|-=|\*=|\/=|%=/,         // Compound assignment

  // Empty or whitespace only
  /^\s*$/
] as const;
