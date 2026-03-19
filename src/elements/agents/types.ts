/**
 * Type definitions for Agent elements
 */

import { ElementType } from '../../portfolio/types.js';
// ElementType is used in AgentMetadataV2
import { IElementMetadata } from '../../types/elements/index.js';
import type { ElementGatekeeperPolicy } from '../../handlers/mcp-aql/GatekeeperTypes.js';
import {
  DecisionFramework,
  RiskTolerance,
  GoalPriority,
  GoalStatus,
  EisenhowerQuadrant,
  DecisionOutcome,
  RiskLevel
} from './constants.js';

// =============================================================================
// Tiered Safety System Types (RFC #97)
// Imported and re-exported from @dollhousemcp/safety package
// =============================================================================

import type {
  SafetyTier as _SafetyTier,
  VerificationChallengeType as _VerificationChallengeType,
  SafetyConfig as _SafetyConfig,
  VerificationChallenge as _VerificationChallenge,
  ConfirmationRequest as _ConfirmationRequest,
  DangerZoneOperation as _DangerZoneOperation,
  ExecutionContext as _ExecutionContext,
  SafetyTierResult as _SafetyTierResult,
} from '@dollhousemcp/safety';

import { DEFAULT_SAFETY_CONFIG as _DEFAULT_SAFETY_CONFIG } from '@dollhousemcp/safety';

// Re-export for consumers
export type SafetyTier = _SafetyTier;
export type VerificationChallengeType = _VerificationChallengeType;
export type SafetyConfig = _SafetyConfig;
export type VerificationChallenge = _VerificationChallenge;
export type ConfirmationRequest = _ConfirmationRequest;
export type DangerZoneOperation = _DangerZoneOperation;
export type ExecutionContext = _ExecutionContext;
export type SafetyTierResult = _SafetyTierResult;
export const DEFAULT_SAFETY_CONFIG = _DEFAULT_SAFETY_CONFIG;

// Re-export types from constants for convenience
// Using 'export type' to ensure proper ESM compatibility with Jest's cjs-module-lexer
export type {
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
  /**
   * Security warnings from goal validation (advisory, not blocking)
   * Informs LLM of potential security concerns without preventing goal creation
   * @since v2.0.0 - Advisory security pattern (Issue #112)
   */
  securityWarnings?: string[];
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
 *
 * IMPROVEMENT: Added version field for optimistic locking (Issue #24)
 */
export interface AgentState {
  goals: AgentGoal[];
  decisions: AgentDecision[];
  context: Record<string, any>;
  lastActive: Date;
  sessionCount: number;
  successRate?: number;
  averageDecisionTime?: number;
  /**
   * State version for optimistic locking
   * Incremented on each state update to detect concurrent modifications
   * @since Issue #24 - Medium Priority Fix
   */
  stateVersion?: number;
}

/**
 * Agent metadata extends base element metadata
 */
export interface AgentMetadata extends IElementMetadata {
  type?: ElementType.AGENT;           // Agent type constraint for type safety
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

// =============================================================================
// Agent v2.0 Types - LLM-First Agentic Loop
// =============================================================================

/**
 * Agent v2.0 goal configuration
 *
 * Defines a goal template with parameters that can be filled when executing
 * the agent. This replaces freeform goal strings with structured templates.
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface AgentGoalConfig {
  /** Goal template with {parameter} placeholders */
  template: string;
  /** Parameters that can be passed to fill the template */
  parameters: AgentGoalParameter[];
  /** Success criteria the LLM uses to determine goal completion */
  successCriteria?: string[];
}

/**
 * Parameter definition for goal templates
 */
export interface AgentGoalParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

/**
 * Agent v2.0 element activation configuration
 *
 * Defines which elements to activate when the agent executes.
 * Element-agnostic: supports any current or future element type.
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface AgentActivates {
  personas?: string[];
  skills?: string[];
  memories?: string[];
  templates?: string[];
  ensembles?: string[];
  /** Extensible for future element types */
  [key: string]: string[] | undefined;
}

/**
 * Agent v2.0 tool configuration
 *
 * Specifies which MCP-AQL tool endpoints an agent is allowed or denied access to.
 * Tool names follow the format `mcp_aql_{endpoint}` (e.g., `mcp_aql_read`,
 * `mcp_aql_create`, `mcp_aql_delete`).
 *
 * When no explicit {@link ElementGatekeeperPolicy} is provided on the agent,
 * this config is translated into an enforceable deny policy by
 * `AgentToolPolicyTranslator` during agent execution (Issue #449).
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface AgentToolConfig {
  /** MCP-AQL tool endpoint names the agent is allowed to use */
  allowed: string[];
  /** MCP-AQL tool endpoint names the agent should not use (translated to deny list) */
  denied?: string[];
}

/**
 * Agent resilience policy configuration
 *
 * Defines how an agent recovers from step limits and execution failures.
 * When not specified, all behaviors default to 'pause' (current behavior).
 *
 * @since v2.1.0 - Agent Execution Resilience (Issue #526)
 *
 * @example Auto-continue with limited continuations
 * ```typescript
 * const policy: AgentResiliencePolicy = {
 *   onStepLimitReached: 'continue',
 *   maxContinuations: 5,
 *   preserveState: true,
 * };
 * ```
 *
 * @example Retry failures with exponential backoff
 * ```typescript
 * const policy: AgentResiliencePolicy = {
 *   onExecutionFailure: 'retry',
 *   maxRetries: 3,
 *   retryBackoff: 'exponential',
 * };
 * ```
 *
 * @example Aggressive: auto-continue + retry + high limits
 * ```typescript
 * const policy: AgentResiliencePolicy = {
 *   onStepLimitReached: 'continue',
 *   onExecutionFailure: 'retry',
 *   maxRetries: 5,
 *   maxContinuations: 0, // unlimited
 *   retryBackoff: 'exponential',
 *   preserveState: true,
 * };
 * ```
 */
export interface AgentResiliencePolicy {
  /** Behavior when maxAutonomousSteps is reached (default: 'pause') */
  onStepLimitReached?: 'pause' | 'continue' | 'restart';
  /** Behavior when a step fails (default: 'pause') */
  onExecutionFailure?: 'pause' | 'retry' | 'restart-fresh';
  /** Maximum retry attempts for failed steps (default: 3) */
  maxRetries?: number;
  /** Maximum auto-continuations before mandatory pause (default: 10, 0 = unlimited) */
  maxContinuations?: number;
  /** Backoff strategy for retries (default: 'exponential') */
  retryBackoff?: 'none' | 'linear' | 'exponential';
  /** Whether to preserve gathered data across continuations (default: true) */
  preserveState?: boolean;
}

/**
 * Agent v2.0 autonomy configuration
 *
 * Defines when an agent should continue autonomously vs pause for human input.
 * Used by AutonomyEvaluator to determine continue/pause decisions.
 *
 * @since v2.0.0 - Agentic Loop Redesign (Epic #380)
 */
export interface AgentAutonomyConfig {
  /** Risk tolerance level for autonomous decisions */
  riskTolerance?: RiskTolerance;
  /** Maximum steps before mandatory pause (0 = unlimited) */
  maxAutonomousSteps?: number;
  /** Action patterns that always require human approval (glob patterns) */
  requiresApproval?: string[];
  /** Action patterns that are auto-approved (glob patterns, overridden by requiresApproval) */
  autoApprove?: string[];
  /** Minutes before a verification challenge expires (default: 5). Issue #142. */
  verificationTimeoutMinutes?: number;
}

/**
 * Agent v2.0 metadata (simplified for LLM-first approach)
 *
 * Extends base element metadata with v2.0 fields.
 * v1.x fields remain optional for backward compatibility.
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface AgentMetadataV2 extends IElementMetadata {
  type?: ElementType.AGENT;

  // v2.0 required fields
  /** Goal configuration with template and parameters */
  goal: AgentGoalConfig;

  // v2.0 optional fields
  /** Elements to activate when agent executes */
  activates?: AgentActivates;
  /** Tool configuration — enforced via AgentToolPolicyTranslator when no explicit gatekeeper policy */
  tools?: AgentToolConfig;
  /** Custom system prompt for LLM context */
  systemPrompt?: string;
  /** Autonomy configuration for continue/pause decisions */
  autonomy?: AgentAutonomyConfig;
  /** Gatekeeper policy for restricting operations during agent execution (Issue #449) */
  gatekeeper?: ElementGatekeeperPolicy;
  /** Resilience policy for automatic recovery from step limits and failures (Issue #526) */
  resilience?: AgentResiliencePolicy;

  // v1.x optional fields (backward compatibility)
  /** @deprecated v1.x - Use LLM judgment instead */
  decisionFramework?: DecisionFramework;
  specializations?: string[];
  riskTolerance?: RiskTolerance;
  /** @deprecated v1.x - LLM handles learning naturally */
  learningEnabled?: boolean;
  maxConcurrentGoals?: number;
  /** @deprecated v1.x - Constraints handled by evaluateConstraints() */
  ruleEngineConfig?: unknown;
  triggers?: string[];
}

/**
 * Result returned by execute_agent tool
 *
 * Provides all context the LLM needs to drive the agentic loop.
 * Includes the goal, active elements, advisory signals, and safety tier.
 *
 * @since v2.0.0 - Agentic Loop Redesign
 * @since v2.0.0 - Tiered Safety System (RFC #97)
 */
export interface ExecuteAgentResult {
  /** Name of the executed agent */
  agentName: string;
  /** Rendered goal with parameters filled in */
  goal: string;
  /** ID of the persisted goal (for tracking with record_agent_step) */
  goalId?: string;

  /** State version after execution for optimistic locking (Issue #445) */
  stateVersion?: number;

  /** Active elements and their context contributions */
  activeElements: Record<string, Array<{ name: string; content: string }>>;

  /** Tools available for this agent (informational) */
  availableTools: string[];

  /** Success criteria from goal definition */
  successCriteria: string[];

  // Advisory signals (all optional)

  /** Security warnings from validateGoalSecurity() */
  securityWarnings?: string[];

  /** Template rendering warnings (e.g. unmatched placeholders) (Issue #126) */
  templateWarnings?: string[];

  /**
   * Element activation failures that occurred during setup (#116).
   *
   * When present, one or more elements failed to activate. The agent
   * execution continues with available elements, but context may be
   * incomplete. Circular activation errors are NOT included here —
   * they throw immediately as configuration errors.
   */
  activationWarnings?: Array<{
    /** Type of element that failed (e.g., "personas", "skills", "memories") */
    elementType: string;
    /** Name of the specific element that failed */
    elementName: string;
    /** Error message describing why activation failed */
    error: string;
  }>;

  /** Constraint evaluation from evaluateConstraints() */
  constraints?: ConstraintResult;

  /** Risk assessment from assessRisk() */
  riskAssessment?: RiskAssessmentResult;

  /** Priority score from calculatePriorityScore() */
  priorityScore?: PriorityScoreResult;

  /** Custom system prompt for LLM context */
  systemPrompt?: string;

  // Tiered Safety System fields (RFC #97)

  /** Safety tier for this execution */
  safetyTier: SafetyTier;

  /** Safety tier determination details */
  safetyTierResult?: SafetyTierResult;

  /** For CONFIRM tier: confirmation request details */
  confirmationRequired?: ConfirmationRequest;

  /** For VERIFY tier: verification challenge details */
  verificationRequired?: VerificationChallenge;

  /** For DANGER_ZONE tier: danger zone operation details */
  dangerZoneBlocked?: DangerZoneOperation;

  /** Execution context for agent chain tracking */
  executionContext?: ExecutionContext;
}

/**
 * Result of constraint evaluation
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface ConstraintResult {
  /** Whether the agent can proceed (no blockers) */
  canProceed: boolean;
  /** Hard blockers that prevent execution */
  blockers: string[];
  /** Soft warnings to consider */
  warnings: string[];
}

/**
 * Result of risk assessment
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface RiskAssessmentResult {
  /** Risk level category */
  level: 'low' | 'medium' | 'high';
  /** Numeric risk score (0-100) */
  score: number;
  /** Factors contributing to the risk score */
  factors: string[];
  /** Suggested mitigations */
  mitigations: string[];
}

/**
 * Result of priority scoring
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface PriorityScoreResult {
  /** Overall priority score */
  score: number;
  /** Factors that contributed to the score */
  factors: string[];
  /** Score breakdown by category */
  breakdown: Record<string, number>;
}

/**
 * Security validation result
 *
 * @since v2.0.0 - Agentic Loop Redesign
 */
export interface SecurityValidationResult {
  /** Whether the goal passed security validation */
  safe: boolean;
  /** Warning messages for flagged patterns */
  warnings?: string[];
  /** Names of patterns that were flagged */
  flagged?: string[];
}

// =============================================================================
// Autonomy Evaluation Types (Epic #380)
// =============================================================================

/**
 * Minimal interface for danger zone enforcement (DI decoupling).
 * Allows autonomy evaluator to block agents without depending on
 * the full DangerZoneEnforcer class.
 *
 * @since v2.1.0 - Issue #402
 */
export interface DangerZoneBlocker {
  block(
    agentName: string,
    reason: string,
    triggeredPatterns: string[],
    verificationId?: string,
    /** Audit context for post-hoc investigation (Issue #404).
     *  Must stay structurally in sync with DangerZoneAuditContext in DangerZoneEnforcer.ts */
    auditContext?: {
      stepNumber?: number;
      currentStepDescription?: string;
      currentStepOutcome?: string;
      nextActionHint?: string;
      riskScore?: number;
      goalDescription?: string;
      goalId?: string;
      safetyFactors?: string[];
    }
  ): void;
}

/**
 * Context for autonomy evaluation
 *
 * Provides all information needed to determine whether an agent
 * should continue autonomously or pause for human input.
 *
 * @since v2.0.0 - Agentic Loop Completion (Epic #380)
 */
export interface AutonomyContext {
  /** The agent being evaluated */
  agentName: string;
  /** Agent's autonomy configuration */
  autonomyConfig?: AgentAutonomyConfig;
  /** Current step count in this execution */
  stepCount: number;
  /** Description of the just-completed step */
  currentStepDescription: string;
  /** Outcome of the just-completed step */
  currentStepOutcome: 'success' | 'failure' | 'partial';
  /** Optional hint about what the LLM plans to do next */
  nextActionHint?: string;
  /** Current safety tier from the last evaluation */
  currentSafetyTier?: SafetyTier;
  /** Risk score from current step (0-100) */
  riskScore?: number;
  /** DI-injected danger zone enforcer for blocking agents (Issue #402) */
  dangerZoneEnforcer?: DangerZoneBlocker;
  /** Server-side verification store for challenge codes (Issue #142) */
  verificationStore?: {
    set: (id: string, challenge: { code: string; expiresAt: number; reason: string }) => void;
  };
  /** Active goal description (Issue #404: forwarded for audit context) */
  goalDescription?: string;
  /** Active goal ID (Issue #404: forwarded for audit context) */
  goalId?: string;
}

/**
 * Verification request for VERIFY tier actions
 *
 * @since v2.0.0 - Agentic Loop Completion (Epic #380)
 */
export interface AutonomyVerification {
  /** Unique identifier for this verification request */
  verificationId: string;
  /** Human-readable prompt for the user */
  prompt: string;
  /**
   * Display code for verification — intentionally stripped before returning to LLM.
   * Only present internally during challenge creation; shown via OS dialog only (Issue #142).
   * @internal
   */
  displayCode?: string;
  /** Type of verification required */
  challengeType: VerificationChallengeType;
  /** When this verification expires */
  expiresAt: string;
}

/**
 * Result of autonomy evaluation
 *
 * Tells the LLM whether to continue autonomously or pause for human input.
 * Returned by AutonomyEvaluator.evaluate() and included in record_agent_step response.
 *
 * @since v2.0.0 - Agentic Loop Completion (Epic #380)
 */
export interface AutonomyDirective {
  /** Whether the LLM can proceed autonomously */
  continue: boolean;
  /** Reason for pausing (if continue=false) */
  reason?: string;
  /** Safety tier of the next likely action */
  nextStepRisk?: SafetyTier;
  /** Steps remaining before mandatory pause (if maxAutonomousSteps configured) */
  stepsRemaining?: number;
  /** Verification required (if VERIFY tier triggered) */
  verification?: AutonomyVerification;
  /** Whether the agent was stopped due to DENY tier */
  stopped?: boolean;
  /** Factors that influenced the decision */
  factors: string[];
  /** Resilience action metadata when auto-continuation or retry is triggered (Issue #526) */
  resilienceAction?: ResilienceAction;
  /**
   * Notifications about execution events (gatekeeper blocks, autonomy pauses, danger zone alerts).
   * Present only when there are events to report. Bridge agents should check this array on
   * every record_execution_step response to discover and relay events to human operators.
   *
   * @since v2.1.0 - Agent Notification System
   */
  notifications?: AgentNotification[];
}

/**
 * Resilience action returned by the resilience evaluator
 *
 * Describes what recovery action the server took (or recommends the LLM take)
 * when a step limit or failure triggers the resilience policy.
 *
 * @since v2.1.0 - Agent Execution Resilience (Issue #526)
 *
 * @example Continue action (step limit reached)
 * ```typescript
 * const action: ResilienceAction = {
 *   action: 'continue',
 *   reason: 'Step limit reached; auto-continuing per policy',
 *   continuationCount: 2,
 *   maxContinuations: 5,
 * };
 * ```
 *
 * @example Retry action (step failure with backoff)
 * ```typescript
 * const action: ResilienceAction = {
 *   action: 'retry',
 *   reason: 'Step failed; retrying with exponential backoff',
 *   retryCount: 1,
 *   backoffMs: 2000,
 * };
 * ```
 */
export interface ResilienceAction {
  /** The action type */
  action: 'pause' | 'continue' | 'retry' | 'restart';
  /** Human-readable reason for the action */
  reason: string;
  /** For retry actions: recommended backoff in milliseconds */
  backoffMs?: number;
  /** Current retry count (for retry actions) */
  retryCount?: number;
  /** Current continuation count (for continue/restart actions) */
  continuationCount?: number;
  /** Maximum continuations allowed (0 = unlimited) */
  maxContinuations?: number;
}

/**
 * Notification for agent execution events
 *
 * Enables bridge agents to discover gatekeeper blocks, autonomy pauses,
 * danger zone triggers, and other execution events without polling.
 * Notifications are included in the AutonomyDirective response from
 * record_execution_step.
 *
 * @since v2.1.0 - Agent Notification System
 */
export interface AgentNotification {
  /** Notification category */
  type: 'permission_pending' | 'autonomy_pause' | 'danger_zone' | 'status' | 'error';
  /** Human-readable message describing the event */
  message: string;
  /** Structured metadata for programmatic consumption */
  metadata?: {
    /** The MCP-AQL operation that was blocked */
    operation?: string;
    /** Element type involved in the block */
    element_type?: string;
    /** Reason for the block/pause */
    reason?: string;
    /** Permission level that caused the block (DENY, CONFIRM_SESSION, CONFIRM_SINGLE_USE) */
    level?: string;
    /** Verification ID (for danger_zone blocks) */
    verificationId?: string;
    /** Agent name (used in danger_zone broadcasts to identify which agent is blocked) */
    agentName?: string;
  };
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;
}