/**
 * Type definitions for Agent elements
 */

import { IElementMetadata } from '../../types/elements/index.js';
import { 
  DecisionFramework, 
  RiskTolerance, 
  GoalPriority, 
  GoalStatus, 
  EisenhowerQuadrant,
  DecisionOutcome,
  RiskLevel
} from './constants.js';

// Re-export types from constants for convenience
export { 
  DecisionFramework, 
  RiskTolerance, 
  GoalPriority, 
  GoalStatus, 
  EisenhowerQuadrant,
  DecisionOutcome,
  RiskLevel
} from './constants.js';

/**
 * Agent goal structure
 */
export interface AgentGoal {
  id: string;
  description: string;
  priority: GoalPriority;
  status: GoalStatus;
  importance: number; // 1-10
  urgency: number;    // 1-10
  eisenhowerQuadrant?: EisenhowerQuadrant;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  dependencies?: string[]; // IDs of other goals
  riskLevel?: RiskLevel;
  estimatedEffort?: number; // hours
  actualEffort?: number;
  notes?: string;
}

/**
 * Agent decision structure
 */
export interface AgentDecision {
  id: string;
  goalId: string;
  timestamp: Date;
  decision: string;
  reasoning: string;
  framework: DecisionFramework;
  confidence: number; // 0-1
  riskAssessment: {
    level: RiskLevel;
    factors: string[];
    mitigations?: string[];
  };
  outcome?: DecisionOutcome;
  impact?: string;
  performanceMetrics?: {
    decisionTimeMs?: number;
    frameworkTimeMs?: number;
    riskAssessmentTimeMs?: number;
  };
}

/**
 * Agent state structure
 */
export interface AgentState {
  goals: AgentGoal[];
  decisions: AgentDecision[];
  context: Record<string, any>;
  lastActive: Date;
  sessionCount: number;
  successRate?: number;
  averageDecisionTime?: number;
}

/**
 * Agent metadata extends base element metadata
 */
export interface AgentMetadata extends IElementMetadata {
  decisionFramework?: DecisionFramework;
  specializations?: string[];
  riskTolerance?: RiskTolerance;
  learningEnabled?: boolean;
  maxConcurrentGoals?: number;
  ruleEngineConfig?: any; // Partial<RuleEngineConfig> - using any to avoid circular dependency

  /**
   * Action verbs that trigger this agent (e.g., "automate", "orchestrate", "delegate")
   * Used by Enhanced Capability Index for intelligent agent suggestions
   * @since v1.9.10
   */
  triggers?: string[];
}

/**
 * Performance metrics for agents
 */
export interface AgentPerformanceMetrics {
  successRate: number;
  averageCompletionTime: number;
  goalsCompleted: number;
  goalsInProgress: number;
  decisionAccuracy: number;
}

/**
 * Input structure for creating goals
 */
export interface AgentGoalInput {
  description: string;
  priority?: GoalPriority;
  importance?: number;
  urgency?: number;
  dependencies?: string[];
  riskLevel?: RiskLevel;
  estimatedEffort?: number;
  notes?: string;
}