/**
 * Shared constants for Agent elements
 */

// Security limits
export const AGENT_LIMITS = {
  MAX_GOALS: 50,
  MAX_GOAL_LENGTH: 1000,
  MAX_STATE_SIZE: 100 * 1024, // 100KB
  MAX_DECISION_HISTORY: 100,
  MAX_CONTEXT_LENGTH: 5000,
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
export const DECISION_FRAMEWORKS = ['rule_based', 'ml_based', 'programmatic', 'hybrid'] as const;
export type DecisionFramework = typeof DECISION_FRAMEWORKS[number];

// Risk tolerance levels
export const RISK_TOLERANCE_LEVELS = ['conservative', 'moderate', 'aggressive'] as const;
export type RiskTolerance = typeof RISK_TOLERANCE_LEVELS[number];

// Goal priorities
export const GOAL_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type GoalPriority = typeof GOAL_PRIORITIES[number];

// Goal statuses
export const GOAL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];

// Eisenhower quadrants
export const EISENHOWER_QUADRANTS = ['do_first', 'schedule', 'delegate', 'eliminate'] as const;
export type EisenhowerQuadrant = typeof EISENHOWER_QUADRANTS[number];

// Decision outcomes
export const DECISION_OUTCOMES = ['success', 'failure', 'partial', 'unknown'] as const;
export type DecisionOutcome = typeof DECISION_OUTCOMES[number];

// Risk levels
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

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