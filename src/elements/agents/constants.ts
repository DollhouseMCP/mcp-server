/**
 * Shared constants for Agent elements
 */

// Internal symbols for cross-class communication (not exported from package)
// These provide runtime privacy for methods that need to be called between
// Agent and AgentManager but should not be accessible to external code.

/**
 * Symbol for committing persisted state version.
 * Used by AgentManager to sync Agent's internal stateVersion after successful save.
 * @internal
 */
export const COMMIT_PERSISTED_VERSION = Symbol('commitPersistedVersion');

// Security limits
export const AGENT_LIMITS = {
  MAX_GOALS: 50,
  MAX_GOAL_LENGTH: 1000,
  MAX_STATE_SIZE: 100 * 1024, // 100KB
  MAX_DECISION_HISTORY: 100,
  MAX_CONTEXT_LENGTH: 5000,
  MAX_RENDERED_GOAL_LENGTH: 5000,
  MAX_AGENT_NAME_LENGTH: 100,
  MAX_SPECIALIZATION_LENGTH: 50,
  MAX_CONCURRENT_GOALS_DEFAULT: 10,
  MAX_FILE_SIZE: 100 * 1024, // 100KB
  MAX_YAML_SIZE: 64 * 1024  // 64KB
} as const;

// File extensions
export const AGENT_FILE_EXTENSION = '.md';
export const STATE_FILE_EXTENSION = '.state.yaml';
export const STATE_DIRECTORY = '.state';

// Decision frameworks
export const DECISION_FRAMEWORKS = ['rule_based', 'ml_based', 'programmatic', 'hybrid', 'llm_driven'] as const;
export type DecisionFramework = typeof DECISION_FRAMEWORKS[number];

// Risk tolerance levels
export const RISK_TOLERANCE_LEVELS = ['conservative', 'moderate', 'aggressive'] as const;
export type RiskTolerance = typeof RISK_TOLERANCE_LEVELS[number];

// Resilience policy enums (Issue #727: shared between read and write validation)
export const STEP_LIMIT_ACTIONS = ['pause', 'continue', 'restart'] as const;
export type StepLimitAction = typeof STEP_LIMIT_ACTIONS[number];

export const EXECUTION_FAILURE_ACTIONS = ['pause', 'retry', 'restart-fresh'] as const;
export type ExecutionFailureAction = typeof EXECUTION_FAILURE_ACTIONS[number];

export const BACKOFF_STRATEGIES = ['none', 'linear', 'exponential'] as const;
export type BackoffStrategy = typeof BACKOFF_STRATEGIES[number];

// Goal priorities
export const GOAL_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type GoalPriority = typeof GOAL_PRIORITIES[number];

// Goal statuses
export const GOAL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];

// Eisenhower quadrants
export const EISENHOWER_QUADRANTS = ['do_first', 'schedule', 'delegate', 'eliminate'] as const;
export type EisenhowerQuadrant = typeof EISENHOWER_QUADRANTS[number];

// Eisenhower matrix thresholds for quadrant classification
// Importance and urgency are on a 1-10 scale
export const EISENHOWER_THRESHOLDS = {
  /** Threshold for high importance/urgency (>= this value is considered "high") */
  HIGH_PRIORITY: 7,
} as const;

// Agent behavior thresholds
export const AGENT_THRESHOLDS = {
  /** Percentage of max concurrent goals that triggers a risk warning (0.8 = 80%) */
  CONCURRENT_GOAL_WARNING: 0.8,
} as const;

// Decision outcomes
export const DECISION_OUTCOMES = ['success', 'failure', 'partial', 'unknown'] as const;
export type DecisionOutcome = typeof DECISION_OUTCOMES[number];

// Risk levels
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

// ============================================================================
// Issue #730: Shared validation & normalization helpers
// ============================================================================

/**
 * Type-safe membership check against a readonly string tuple.
 * Centralizes the `(ARRAY as readonly string[]).includes(value as string)` cast pattern.
 */
export function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === 'string' && options.includes(value);
}

/**
 * Promote a snake_case key to its camelCase equivalent on an object.
 * If the camelCase key already exists, the snake_case key is just deleted
 * (camelCase takes precedence, no clobber).
 */
function promoteSnakeCase(obj: Record<string, unknown>, snake: string, camel: string): void {
  if (obj[snake] !== undefined && obj[camel] === undefined) {
    obj[camel] = obj[snake];
  }
  delete obj[snake];
}

/**
 * Normalize snake_case keys in an autonomy config object to camelCase.
 * Mutates the object in place. Safe to call on already-normalized objects.
 */
export function normalizeAutonomyKeys(obj: Record<string, unknown>): void {
  promoteSnakeCase(obj, 'risk_tolerance', 'riskTolerance');
  // Order matters: max_autonomous_steps (canonical snake_case) takes precedence
  // over maxSteps (short form) when both are present — promoteSnakeCase is no-clobber.
  promoteSnakeCase(obj, 'max_autonomous_steps', 'maxAutonomousSteps');
  // Issue #697: LLMs and older agents may use the shorter `maxSteps` form
  promoteSnakeCase(obj, 'maxSteps', 'maxAutonomousSteps');
  promoteSnakeCase(obj, 'requires_approval', 'requiresApproval');
  promoteSnakeCase(obj, 'auto_approve', 'autoApprove');
}

/**
 * Normalize snake_case keys in a resilience config object to camelCase.
 * Mutates the object in place. Safe to call on already-normalized objects.
 */
export function normalizeResilienceKeys(obj: Record<string, unknown>): void {
  promoteSnakeCase(obj, 'on_step_limit_reached', 'onStepLimitReached');
  promoteSnakeCase(obj, 'on_execution_failure', 'onExecutionFailure');
  promoteSnakeCase(obj, 'max_retries', 'maxRetries');
  promoteSnakeCase(obj, 'max_continuations', 'maxContinuations');
  promoteSnakeCase(obj, 'retry_backoff', 'retryBackoff');
  promoteSnakeCase(obj, 'preserve_state', 'preserveState');
}

/**
 * Normalize snake_case keys in a goal config object to camelCase.
 * Mutates the object in place. Safe to call on already-normalized objects.
 */
export function normalizeGoalKeys(obj: Record<string, unknown>): void {
  promoteSnakeCase(obj, 'success_criteria', 'successCriteria');
}

// Default values
export const AGENT_DEFAULTS = {
  DECISION_FRAMEWORK: 'rule_based' as DecisionFramework,
  RISK_TOLERANCE: 'moderate' as RiskTolerance,
  LEARNING_ENABLED: true,
  MAX_CONCURRENT_GOALS: 10,
  GOAL_PRIORITY: 'medium' as GoalPriority,
  GOAL_IMPORTANCE: 5,
  GOAL_URGENCY: 5
} as const;
