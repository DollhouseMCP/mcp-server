/**
 * Constants for Ensemble elements
 * 
 * Defines limits, defaults, and security constants following patterns from other elements
 */

/**
 * Resource limits to prevent DoS attacks
 */
export const ENSEMBLE_LIMITS = {
  MAX_ELEMENTS: 50,                    // Maximum elements in an ensemble
  MAX_NESTING_DEPTH: 5,                // Maximum depth of nested ensembles
  MAX_ACTIVATION_TIME: 30000,          // 30 seconds max activation time
  MAX_CONTEXT_SIZE: 1000,              // Maximum keys in shared context
  MAX_CONTEXT_VALUE_SIZE: 10000,       // Maximum size of a context value
  MAX_DEPENDENCIES: 10,                // Maximum dependencies per element
  MAX_CONDITION_LENGTH: 200,           // Maximum length of activation condition
  MIN_ACTIVATION_INTERVAL: 100         // Minimum ms between activations
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
  ACTIVATION_TIMEOUT: 5000             // 5 seconds per element
} as const;

/**
 * Supported activation strategies
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
 * Element roles
 */
export const ELEMENT_ROLES = [
  'primary',
  'support',
  'override',
  'monitor'
] as const;

/**
 * Security event types for ensemble operations
 */
export const ENSEMBLE_SECURITY_EVENTS = {
  CIRCULAR_DEPENDENCY: 'ENSEMBLE_CIRCULAR_DEPENDENCY',
  RESOURCE_LIMIT_EXCEEDED: 'ENSEMBLE_RESOURCE_LIMIT_EXCEEDED',
  ACTIVATION_TIMEOUT: 'ENSEMBLE_ACTIVATION_TIMEOUT',
  SUSPICIOUS_CONDITION: 'ENSEMBLE_SUSPICIOUS_CONDITION',
  NESTED_DEPTH_EXCEEDED: 'ENSEMBLE_NESTED_DEPTH_EXCEEDED',
  CONTEXT_SIZE_EXCEEDED: 'ENSEMBLE_CONTEXT_SIZE_EXCEEDED'
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
  ELEMENT_NOT_FOUND: 'Element not found in ensemble',
  ACTIVATION_TIMEOUT: 'Ensemble activation timed out',
  CONTEXT_OVERFLOW: 'Shared context size exceeded limits'
} as const;

/**
 * Regex patterns for validation
 */
export const ENSEMBLE_PATTERNS = {
  // Simple condition syntax: elementId.property == value
  CONDITION_PATTERN: /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\s*(==|!=|>|<|>=|<=)\s*[a-zA-Z0-9_"'-]+$/,
  // Element ID pattern
  ELEMENT_ID_PATTERN: /^[a-zA-Z0-9_-]+$/
} as const;