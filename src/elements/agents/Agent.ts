/**
 * Agent element implementation.
 * Autonomous goal-oriented actors with decision-making capabilities.
 *
 * SECURITY MEASURES IMPLEMENTED:
 * 1. Goal validation to prevent malicious objectives
 * 2. Decision framework sandboxing
 * 3. State size limits to prevent DoS
 * 4. Risk assessment for damage prevention
 * 5. Audit logging for all decisions and actions
 */

import { BaseElement } from '../BaseElement.js';
import { IElement, ElementValidationResult, ValidationError, ValidationWarning } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { randomBytes } from 'node:crypto';
import { sanitizeInput } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { ErrorHandler, ErrorCategory } from '../../utils/ErrorHandler.js';
import { EvictingQueue } from '../../utils/EvictingQueue.js';
import { ValidationErrorCodes } from '../../utils/errorCodes.js';
import { MetadataService } from '../../services/MetadataService.js';
import {
  AgentGoal,
  AgentDecision,
  AgentState,
  AgentMetadata,
  SecurityValidationResult,
  ConstraintResult,
  RiskAssessmentResult,
  PriorityScoreResult,
  DecisionOutcome
} from './types.js';
import {
  AGENT_LIMITS,
  AGENT_DEFAULTS,
  AGENT_THRESHOLDS,
  DECISION_FRAMEWORKS,
  RISK_TOLERANCE_LEVELS,
  COMMIT_PERSISTED_VERSION
} from './constants.js';
import {
  RuleEngineConfig,
  validateRuleEngineConfig
} from './ruleEngineConfig.js';
import {
  applyGoalTemplate,
  calculateEisenhowerQuadrant,
  recommendGoalTemplate,
  validateGoalAgainstTemplate
} from './goalTemplates.js';

export class Agent extends BaseElement implements IElement {
  public declare metadata: AgentMetadata;
  // instructions and content inherited from BaseElement (v2.0 dual-field architecture)
  private state: AgentState;
  private isDirtyState: boolean = false;
  private ruleEngineConfig: RuleEngineConfig;
  private _decisionHistory: EvictingQueue<AgentDecision>;

  constructor(metadata: Partial<AgentMetadata>, metadataService: MetadataService) {
    // Sanitize all inputs
    const sanitizedMetadata: Partial<AgentMetadata> = {
      ...metadata,
      name: metadata.name ? sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : undefined,
      description: metadata.description ? sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, 500) : undefined,
      specializations: metadata.specializations?.map(s => sanitizeInput(s, 50)),
      decisionFramework: metadata.decisionFramework || AGENT_DEFAULTS.DECISION_FRAMEWORK,
      riskTolerance: metadata.riskTolerance || AGENT_DEFAULTS.RISK_TOLERANCE,
      learningEnabled: metadata.learningEnabled ?? AGENT_DEFAULTS.LEARNING_ENABLED,
      maxConcurrentGoals: metadata.maxConcurrentGoals ?? AGENT_DEFAULTS.MAX_CONCURRENT_GOALS
    };

    // MEDIUM PRIORITY IMPROVEMENT: Validate decision framework configuration
    // Ensures only supported frameworks are used
    if (sanitizedMetadata.decisionFramework &&
        !DECISION_FRAMEWORKS.includes(sanitizedMetadata.decisionFramework)) {
      throw ErrorHandler.createError(`Invalid decision framework: ${sanitizedMetadata.decisionFramework}. ` +
        `Supported frameworks: ${DECISION_FRAMEWORKS.join(', ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_FRAMEWORK);
    }

    // Validate risk tolerance level
    if (sanitizedMetadata.riskTolerance &&
        !RISK_TOLERANCE_LEVELS.includes(sanitizedMetadata.riskTolerance)) {
      throw ErrorHandler.createError(`Invalid risk tolerance: ${sanitizedMetadata.riskTolerance}. ` +
        `Supported levels: ${RISK_TOLERANCE_LEVELS.join(', ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_RISK_TOLERANCE);
    }

    // Validate max concurrent goals
    if (sanitizedMetadata.maxConcurrentGoals !== undefined) {
      const maxGoals = sanitizedMetadata.maxConcurrentGoals;
      if (!Number.isInteger(maxGoals) || maxGoals < 1 || maxGoals > AGENT_LIMITS.MAX_GOALS) {
        throw ErrorHandler.createError(`maxConcurrentGoals must be between 1 and ${AGENT_LIMITS.MAX_GOALS}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_RANGE);
      }
    }

    super(ElementType.AGENT, sanitizedMetadata, metadataService);

    // Initialize state with version tracking for optimistic locking (Issue #24)
    this.state = {
      goals: [],
      decisions: [],
      context: {},
      lastActive: new Date(),
      sessionCount: 0,
      stateVersion: 1  // Start at version 1
    };

    // Bounded FIFO queue for decision history
    this._decisionHistory = new EvictingQueue<AgentDecision>(AGENT_LIMITS.MAX_DECISION_HISTORY);

    // Set agent-specific extensions
    this.extensions = {
      decisionFramework: sanitizedMetadata.decisionFramework,
      riskTolerance: sanitizedMetadata.riskTolerance,
      learningEnabled: sanitizedMetadata.learningEnabled,
      specializations: sanitizedMetadata.specializations || [],
      ruleEngineConfig: metadata.ruleEngineConfig
    };

    // Initialize rule engine configuration (with validation)
    this.ruleEngineConfig = validateRuleEngineConfig(
      this.extensions.ruleEngineConfig || {}
    );
  }

  /**
   * Add a new goal with security validation
   *
   * @param goal - Goal configuration
   * @param options - Optional configuration for strict validation mode
   * @returns The created goal with any security warnings attached
   *
   * @since v2.0.0 - Security validation is advisory by default (Issue #112)
   */
  public addGoal(goal: Partial<AgentGoal>, options?: { strict?: boolean }): AgentGoal {
    // Validate goal count
    if (this.state.goals.length >= AGENT_LIMITS.MAX_GOALS) {
      throw ErrorHandler.createError(`Maximum number of goals (${AGENT_LIMITS.MAX_GOALS}) reached`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.MAX_GOALS_EXCEEDED);
    }

    // Normalize and validate BEFORE sanitization (Issue #112)
    const normalizedDescription = UnicodeValidator.normalize(goal.description || '').normalizedContent;

    // Validate goal for security threats on ORIGINAL input before sanitization
    // This ensures patterns like backticks, $, etc. are detected before being stripped
    const securityCheck = this.validateGoalSecurity(normalizedDescription);

    // Now sanitize for storage (removes shell metacharacters)
    const sanitizedDescription = sanitizeInput(
      normalizedDescription,
      AGENT_LIMITS.MAX_GOAL_LENGTH
    );

    if (!sanitizedDescription || sanitizedDescription.length < 3) {
      throw ErrorHandler.createError('Goal description must be at least 3 characters', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.GOAL_TOO_SHORT);
    }

    // Handle security validation results (advisory by default, blocking if strict mode enabled)
    if (!securityCheck.safe) {
      // Log security event for audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: options?.strict ? 'HIGH' : 'MEDIUM',
        source: 'Agent.addGoal',
        details: `Goal with security warnings ${options?.strict ? 'rejected' : 'created'}: ${securityCheck.warnings?.join(', ')}`,
        additionalData: { agentId: this.id, strict: options?.strict }
      });

      // In strict mode, throw error (backward compatible behavior)
      if (options?.strict) {
        throw ErrorHandler.createError(
          `Goal contains potentially harmful content: ${securityCheck.warnings?.join(', ')}`,
          ErrorCategory.VALIDATION_ERROR,
          ValidationErrorCodes.HARMFUL_CONTENT
        );
      }
      // Otherwise, continue with advisory warnings attached to goal
    }

    // Calculate Eisenhower quadrant
    const importance = goal.importance || 5;
    const urgency = goal.urgency || 5;
    const eisenhowerQuadrant = calculateEisenhowerQuadrant(importance, urgency);

    // Create new goal with security warnings (if any)
    const newGoal: AgentGoal = {
      id: `goal_${Date.now()}_${randomBytes(6).toString('hex')}`,
      description: sanitizedDescription,
      priority: goal.priority || AGENT_DEFAULTS.GOAL_PRIORITY,
      status: 'pending',
      importance,
      urgency,
      eisenhowerQuadrant,
      createdAt: new Date(),
      updatedAt: new Date(),
      dependencies: goal.dependencies || [],
      riskLevel: goal.riskLevel || 'low',
      estimatedEffort: goal.estimatedEffort,
      notes: goal.notes ? sanitizeInput(goal.notes, 500) : undefined,
      // Store security warnings for LLM review (advisory pattern)
      securityWarnings: securityCheck.warnings && securityCheck.warnings.length > 0
        ? securityCheck.warnings
        : undefined
    };

    // MEDIUM PRIORITY IMPROVEMENT: Detect dependency cycles before adding goal
    if (newGoal.dependencies && newGoal.dependencies.length > 0) {
      const cycleCheck = this.detectDependencyCycle(newGoal.id, newGoal.dependencies);
      if (cycleCheck.hasCycle) {
        throw ErrorHandler.createError(`Dependency cycle detected: ${cycleCheck.path.join(' → ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.DEPENDENCY_CYCLE);
      }
    }

    this.state.goals.push(newGoal);
    // Note: stateVersion is incremented on successful save, not here (Issue #123 fix)
    this.isDirtyState = true;
    this.markDirty();

    logger.info(`Goal added to agent ${this.metadata.name}`, { goalId: newGoal.id });

    return newGoal;
  }

  /**
   * Record a decision made by the LLM (or programmatic guardrail)
   *
   * This is NOT a decision-maker, it's a decision RECORDER.
   * The LLM makes decisions, this method just persists them for audit trail.
   *
   * @since v2.0.0 - Agentic Loop Redesign
   */
  public recordDecision(decision: {
    goalId: string;
    decision: string;
    reasoning: string;
    confidence: number;
    riskAssessment?: RiskAssessmentResult;
    outcome?: DecisionOutcome;
  }): AgentDecision {
    const goal = this.state.goals.find(g => g.id === decision.goalId);
    if (!goal) {
      throw ErrorHandler.createError(
        `Goal ${decision.goalId} not found`,
        ErrorCategory.VALIDATION_ERROR,
        ValidationErrorCodes.GOAL_NOT_FOUND
      );
    }

    // Create decision record
    const decisionRecord: AgentDecision = {
      id: `decision_${Date.now()}_${randomBytes(6).toString('hex')}`,
      goalId: decision.goalId,
      timestamp: new Date(),
      decision: sanitizeInput(decision.decision, 500),
      reasoning: sanitizeInput(decision.reasoning, 1000),
      framework: 'llm_driven',  // v2.0 agents are LLM-driven
      confidence: Math.max(0, Math.min(1, decision.confidence)),
      riskAssessment: decision.riskAssessment || {
        level: 'low',
        score: 0,
        factors: [],
        mitigations: []
      },
      outcome: decision.outcome
    };

    // Bounded FIFO eviction — EvictingQueue handles capacity
    this._decisionHistory.push(decisionRecord);
    this.state.decisions = this._decisionHistory.toJSON();

    // Note: stateVersion is incremented on successful save, not here (Issue #123 fix)
    this.isDirtyState = true;
    this.markDirty();

    // Log for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'AGENT_DECISION',
      severity: 'LOW',
      source: 'Agent.recordDecision',
      details: `Agent ${this.metadata.name} recorded decision for goal ${decision.goalId}`,
      additionalData: {
        agentId: this.id,
        goalId: decision.goalId,
        framework: 'llm_driven',
        riskLevel: decisionRecord.riskAssessment.level
      }
    });

    logger.info(`Decision recorded for agent ${this.metadata.name}`, {
      goalId: decision.goalId,
      decision: decision.decision
    });

    return decisionRecord;
  }




  /**
   * Assess risk for a decision or action
   *
   * This is a CHECKLIST, not a decision maker. It flags known risk factors
   * that the LLM should consider when making decisions.
   *
   * Similar to how GitHub flags "this file is large" or "this PR changes many files" -
   * programmatic signals that inform semantic judgment.
   *
   * @since v2.0.0 - Refactored for LLM-first agentic loop
   */
  public assessRisk(
    action: string,
    goal: AgentGoal,
    context: Record<string, any>
  ): RiskAssessmentResult {
    const factors: string[] = [];
    let riskScore = 0;

    // Factor: Immediate execution of high-risk goal
    if (action === 'execute_immediately' && goal.riskLevel === 'high') {
      factors.push('Immediate execution requested for high-risk goal');
      riskScore += 30;
    }

    // Factor: Low confidence in decision
    const confidence = context.decisionConfidence || 1.0;
    if (confidence < 0.6) {
      factors.push(`Low confidence in decision (${(confidence * 100).toFixed(0)}%)`);
      riskScore += 20;
    }

    // Factor: Complex dependency chains
    if (goal.dependencies && goal.dependencies.length > 3) {
      factors.push(`Complex dependency chain (${goal.dependencies.length} dependencies)`);
      riskScore += 15;
    }

    // Factor: Risk tolerance mismatch
    if (this.extensions?.riskTolerance === 'aggressive' && goal.riskLevel === 'high') {
      factors.push('Aggressive risk tolerance combined with high-risk goal');
      riskScore += 25;
    }

    // Factor: Concurrent goals at limit
    const activeGoals = this.state.goals.filter(g => g.status === 'in_progress').length;
    const maxConcurrent = (this.metadata as AgentMetadata).maxConcurrentGoals || AGENT_DEFAULTS.MAX_CONCURRENT_GOALS;
    if (activeGoals >= maxConcurrent * AGENT_THRESHOLDS.CONCURRENT_GOAL_WARNING) {
      factors.push(`High concurrent goal load (${activeGoals}/${maxConcurrent})`);
      riskScore += 10;
    }

    // Map score to level
    let level: 'low' | 'medium' | 'high';
    const mitigations: string[] = [];

    if (riskScore >= 50) {
      level = 'high';
      mitigations.push('Request human approval before proceeding');
      mitigations.push('Create backup/rollback plan');
      mitigations.push('Enable detailed monitoring and logging');
      mitigations.push('Consider breaking into smaller steps');
    } else if (riskScore >= 25) {
      level = 'medium';
      mitigations.push('Add progress checkpoints');
      mitigations.push('Review results after completion');
      mitigations.push('Monitor for unexpected outcomes');
    } else {
      level = 'low';
      mitigations.push('Standard monitoring sufficient');
    }

    return {
      level,
      score: riskScore,  // Expose numeric score for transparency
      factors,
      mitigations
    };
  }

  /**
   * Evaluate programmatic constraints on a goal
   *
   * Returns blocking constraints that MUST be satisfied before proceeding.
   * The LLM can see these and decide how to handle them.
   *
   * @since v2.0.0 - Extracted from ruleBasedDecision for LLM-first agentic loop
   */
  public evaluateConstraints(goal: AgentGoal): ConstraintResult {
    const blockers: string[] = [];
    const warnings: string[] = [];

    // HARD CONSTRAINT: Incomplete dependencies
    if (goal.dependencies && goal.dependencies.length > 0) {
      const incompleteDeps = goal.dependencies.filter(depId => {
        const dep = this.state.goals.find(g => g.id === depId);
        return dep && dep.status !== 'completed';
      });
      if (incompleteDeps.length > 0) {
        blockers.push(`${incompleteDeps.length} incomplete dependencies`);
      }
    }

    // HARD CONSTRAINT: Max concurrent goals
    const activeGoals = this.state.goals.filter(g => g.status === 'in_progress').length;
    const maxConcurrent = (this.metadata as AgentMetadata).maxConcurrentGoals || AGENT_DEFAULTS.MAX_CONCURRENT_GOALS;
    if (activeGoals >= maxConcurrent) {
      blockers.push(`Maximum concurrent goals reached (${maxConcurrent})`);
    }

    // SOFT CONSTRAINT: Risk + tolerance mismatch
    if (goal.riskLevel === 'high' && this.extensions?.riskTolerance === 'conservative') {
      warnings.push('High-risk goal with conservative risk tolerance - approval recommended');
    }

    return {
      canProceed: blockers.length === 0,
      blockers,
      warnings
    };
  }

  /**
   * Calculate a programmatic "priority score" for a goal
   *
   * This is a simple heuristic the LLM can consider when prioritizing.
   * The LLM is free to ignore this score if it has better judgment.
   *
   * @since v2.0.0 - Extracted from programmaticDecision for LLM-first agentic loop
   */
  public calculatePriorityScore(goal: AgentGoal): PriorityScoreResult {
    let score = 0;
    const factors: string[] = [];
    const breakdown: Record<string, number> = {};

    // Factor 1: Eisenhower matrix
    if (goal.eisenhowerQuadrant === 'do_first') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.doFirst;
      breakdown['eisenhower'] = this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.doFirst;
      factors.push('High importance and urgency (Do First quadrant)');
    } else if (goal.eisenhowerQuadrant === 'schedule') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.schedule;
      breakdown['eisenhower'] = this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.schedule;
      factors.push('High importance, low urgency (Schedule quadrant)');
    } else if (goal.eisenhowerQuadrant === 'delegate') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.delegate;
      breakdown['eisenhower'] = this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.delegate;
      factors.push('Low importance, high urgency (Delegate quadrant)');
    }

    // Factor 2: Risk level
    if (goal.riskLevel === 'low') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.low;
      breakdown['risk'] = this.ruleEngineConfig.programmatic.scoreWeights.risk.low;
      factors.push('Low risk');
    } else if (goal.riskLevel === 'medium') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.medium;
      breakdown['risk'] = this.ruleEngineConfig.programmatic.scoreWeights.risk.medium;
      factors.push('Medium risk');
    } else {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.high;
      breakdown['risk'] = this.ruleEngineConfig.programmatic.scoreWeights.risk.high;
      factors.push('High risk penalty');
    }

    // Factor 3: Dependencies
    if (!goal.dependencies || goal.dependencies.length === 0) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.noDependencies;
      breakdown['dependencies'] = this.ruleEngineConfig.programmatic.scoreWeights.noDependencies;
      factors.push('No dependencies');
    }

    // Factor 4: Estimated effort
    if (goal.estimatedEffort && goal.estimatedEffort <= this.ruleEngineConfig.programmatic.quickWinHours) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.quickWin;
      breakdown['effort'] = this.ruleEngineConfig.programmatic.scoreWeights.quickWin;
      factors.push(`Quick win (≤${this.ruleEngineConfig.programmatic.quickWinHours} hours)`);
    }

    // Factor 5: Previous success rate
    const previousDecisions = this.state.decisions.filter(d => d.outcome === 'success');
    const successRate = previousDecisions.length / Math.max(this.state.decisions.length, 1);
    if (successRate > this.ruleEngineConfig.programmatic.successRateThreshold) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.successBonus;
      breakdown['successRate'] = this.ruleEngineConfig.programmatic.scoreWeights.successBonus;
      factors.push(`High success rate (${(successRate * 100).toFixed(0)}%)`);
    }

    return { score, factors, breakdown };
  }

  /**
   * Validate goal for security threats
   *
   * IMPORTANT: This is a FIRST LINE OF DEFENSE, not a replacement for LLM judgment.
   * False positives are acceptable - this flags potential issues for LLM review.
   *
   * Think of this like a spam filter: it catches obvious bad content but
   * the LLM still needs to make final judgment calls.
   *
   * @since v2.0.0 - Refactored to return warnings instead of throwing errors
   * @since v2.0.0 - Made public for use in AgentManager.executeAgent()
   */
  public validateGoalSecurity(goal: string): SecurityValidationResult {
    const warnings: string[] = [];
    const flagged: string[] = [];

    // CATEGORY 1: Code injection patterns (high confidence)
    const codeInjectionPatterns: Record<string, RegExp> = {
      'system() call': /system\s*\(/i,
      'exec() call': /exec\s*\(/i,
      'eval() call': /eval\s*\(/i,
      'require() call': /require\s*\(/i,
      'dynamic import': /import\s*\(/i,
      'template literal': /\$\{.*\}/,
      'backticks': /`.*`/,
      'process access': /process\.\w+/i,
      'child_process': /child_process/i
    };

    for (const [name, pattern] of Object.entries(codeInjectionPatterns)) {
      if (pattern.test(goal)) {
        warnings.push(`Possible code injection: ${name}`);
        flagged.push(name);
      }
    }

    // CATEGORY 2: Suspicious keywords (lower confidence - advisory only)
    const suspiciousKeywords: Record<string, RegExp> = {
      'credentials': /password|credential|secret|token|api[_-]?key/i,
      'malicious intent': /hack|exploit|breach|attack/i,
      'destructive action': /delete\s+all|destroy|wipe|erase\s+everything/i,
      'theft keywords': /steal|theft|rob/i
    };

    for (const [name, pattern] of Object.entries(suspiciousKeywords)) {
      if (pattern.test(goal)) {
        warnings.push(`Suspicious keyword: ${name}`);
        flagged.push(name);
      }
    }

    // Return warnings but don't block - let LLM decide
    return {
      safe: warnings.length === 0,
      warnings: warnings.length > 0 ? warnings : undefined,
      flagged: flagged.length > 0 ? flagged : undefined
    };
  }

  /**
   * Commit persisted state version after successful save.
   *
   * This Symbol-keyed method provides runtime privacy - it can only be called
   * by code that has access to the COMMIT_PERSISTED_VERSION symbol (i.e., AgentManager).
   * External code cannot call this method without the Symbol.
   *
   * @param version - The new version number to set
   * @see Issue #24 - Optimistic locking implementation
   * @see Issue #123 - Option C pattern: version increments only on successful save
   */
  public [COMMIT_PERSISTED_VERSION](version: number): void {
    this.state.stateVersion = version;
  }

  /**
   * Get agent state
   */
  public getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  /**
   * Update agent context
   */
  public updateContext(key: string, value: any): void {
    const sanitizedKey = sanitizeInput(key, 50);

    // Validate context size
    const contextStr = JSON.stringify({ ...this.state.context, [sanitizedKey]: value });
    if (contextStr.length > AGENT_LIMITS.MAX_CONTEXT_LENGTH) {
      throw ErrorHandler.createError(`Context size exceeds maximum of ${AGENT_LIMITS.MAX_CONTEXT_LENGTH} characters`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.CONTEXT_TOO_LARGE);
    }

    this.state.context[sanitizedKey] = value;
    // Note: stateVersion is incremented on successful save, not here (Issue #123 fix)
    this.isDirtyState = true;
    this.markDirty();
  }

  /**
   * Complete a goal
   */
  public completeGoal(goalId: string, outcome: 'success' | 'failure' | 'partial' = 'success'): void {
    const goal = this.state.goals.find(g => g.id === goalId);
    if (!goal) {
      throw ErrorHandler.createError(`Goal ${goalId} not found`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.GOAL_NOT_FOUND);
    }

    goal.status = outcome === 'success' ? 'completed' : 'failed';
    goal.completedAt = new Date();
    goal.updatedAt = new Date();

    // Update actual effort if it was being tracked
    if (goal.estimatedEffort && goal.createdAt) {
      const hoursElapsed = (goal.completedAt.getTime() - goal.createdAt.getTime()) / (1000 * 60 * 60);
      goal.actualEffort = Math.round(hoursElapsed * 10) / 10;
    }

    // Update decision outcomes
    const decisions = this.state.decisions.filter(d => d.goalId === goalId);
    decisions.forEach(d => {
      if (!d.outcome) {
        d.outcome = outcome;
      }
    });

    // Note: stateVersion is incremented on successful save, not here (Issue #123 fix)
    this.isDirtyState = true;
    this.markDirty();

    logger.info(`Goal ${goalId} completed with outcome: ${outcome}`);
  }

  /**
   * Detect dependency cycles in goal dependencies
   * MEDIUM PRIORITY IMPROVEMENT: Prevents circular dependencies between goals
   */
  private detectDependencyCycle(
    newGoalId: string,
    dependencies: string[]
  ): { hasCycle: boolean; path: string[] } {
    // Build dependency graph including the new goal
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    // Helper function to perform DFS
    const hasCycleDFS = (goalId: string): boolean => {
      visited.add(goalId);
      recursionStack.add(goalId);
      path.push(goalId);

      // Get dependencies for current goal
      let deps: string[] = [];
      if (goalId === newGoalId) {
        // For the new goal being added, use provided dependencies
        deps = dependencies;
      } else {
        // For existing goals, get from state
        const goal = this.state.goals.find(g => g.id === goalId);
        deps = goal?.dependencies || [];
      }

      // Check each dependency
      for (const depId of deps) {
        if (!visited.has(depId)) {
          if (hasCycleDFS(depId)) {
            return true;
          }
        } else if (recursionStack.has(depId)) {
          // Found a cycle - add the repeated node to show the cycle
          path.push(depId);
          return true;
        }
      }

      recursionStack.delete(goalId);
      path.pop();
      return false;
    };

    // Check if adding this goal would create a cycle
    const hasCycle = hasCycleDFS(newGoalId);

    return {
      hasCycle,
      path: hasCycle ? path : []
    };
  }

  /**
   * Get goals by status
   */
  public getGoalsByStatus(status: AgentGoal['status']): AgentGoal[] {
    return this.state.goals.filter(g => g.status === status);
  }

  /**
   * Get goals by quadrant
   */
  public getGoalsByQuadrant(quadrant: AgentGoal['eisenhowerQuadrant']): AgentGoal[] {
    return this.state.goals.filter(g => g.eisenhowerQuadrant === quadrant);
  }

  /**
   * Calculate agent performance metrics
   * MEDIUM PRIORITY IMPROVEMENT: Enhanced to include decision timing metrics
   */
  public getPerformanceMetrics(): {
    successRate: number;
    averageCompletionTime: number;
    goalsCompleted: number;
    goalsInProgress: number;
    decisionAccuracy: number;
    averageDecisionTimeMs?: number;
    averageFrameworkTimeMs?: number;
    averageRiskAssessmentTimeMs?: number;
  } {
    const completedGoals = this.state.goals.filter(g => g.status === 'completed');
    const failedGoals = this.state.goals.filter(g => g.status === 'failed');
    const inProgressGoals = this.state.goals.filter(g => g.status === 'in_progress');

    const totalCompleted = completedGoals.length + failedGoals.length;
    const successRate = totalCompleted > 0 ? completedGoals.length / totalCompleted : 0;

    // Calculate average completion time
    let totalTime = 0;
    let timeCount = 0;
    completedGoals.forEach(goal => {
      if (goal.completedAt && goal.createdAt) {
        totalTime += goal.completedAt.getTime() - goal.createdAt.getTime();
        timeCount++;
      }
    });
    const averageCompletionTime = timeCount > 0 ? totalTime / timeCount / (1000 * 60 * 60) : 0; // in hours

    // Calculate decision accuracy
    const decisionsWithOutcome = this.state.decisions.filter(d => d.outcome);
    const successfulDecisions = decisionsWithOutcome.filter(d => d.outcome === 'success');
    const decisionAccuracy = decisionsWithOutcome.length > 0
      ? successfulDecisions.length / decisionsWithOutcome.length
      : 0;

    // Calculate average decision timing metrics
    const decisionsWithMetrics = this.state.decisions.filter(d => d.performanceMetrics);
    let avgDecisionTime = 0;
    let avgFrameworkTime = 0;
    let avgRiskTime = 0;

    if (decisionsWithMetrics.length > 0) {
      const totalDecisionTime = decisionsWithMetrics.reduce(
        (sum, d) => sum + (d.performanceMetrics?.decisionTimeMs || 0), 0
      );
      const totalFrameworkTime = decisionsWithMetrics.reduce(
        (sum, d) => sum + (d.performanceMetrics?.frameworkTimeMs || 0), 0
      );
      const totalRiskTime = decisionsWithMetrics.reduce(
        (sum, d) => sum + (d.performanceMetrics?.riskAssessmentTimeMs || 0), 0
      );

      avgDecisionTime = totalDecisionTime / decisionsWithMetrics.length;
      avgFrameworkTime = totalFrameworkTime / decisionsWithMetrics.length;
      avgRiskTime = totalRiskTime / decisionsWithMetrics.length;
    }

    return {
      successRate,
      averageCompletionTime,
      goalsCompleted: completedGoals.length,
      goalsInProgress: inProgressGoals.length,
      decisionAccuracy,
      averageDecisionTimeMs: decisionsWithMetrics.length > 0 ? avgDecisionTime : undefined,
      averageFrameworkTimeMs: decisionsWithMetrics.length > 0 ? avgFrameworkTime : undefined,
      averageRiskAssessmentTimeMs: decisionsWithMetrics.length > 0 ? avgRiskTime : undefined
    };
  }

  /**
   * Validate the agent
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();
    const errors: ValidationError[] = result.errors || [];
    const warnings: ValidationWarning[] = result.warnings || [];
    const suggestions: string[] = result.suggestions || [];

    // Validate decision framework
    if (this.extensions?.decisionFramework && !DECISION_FRAMEWORKS.includes(this.extensions.decisionFramework as any)) {
      errors.push({
        field: 'extensions.decisionFramework',
        message: `Invalid decision framework. Must be one of: ${DECISION_FRAMEWORKS.join(', ')}`
      });
    }

    // Validate risk tolerance
    if (this.extensions?.riskTolerance && !RISK_TOLERANCE_LEVELS.includes(this.extensions.riskTolerance as any)) {
      errors.push({
        field: 'extensions.riskTolerance',
        message: `Invalid risk tolerance. Must be one of: ${RISK_TOLERANCE_LEVELS.join(', ')}`
      });
    }

    // Validate state size
    const stateSize = JSON.stringify(this.state).length;
    if (stateSize > AGENT_LIMITS.MAX_STATE_SIZE) {
      errors.push({
        field: 'state',
        message: `State size (${stateSize} bytes) exceeds maximum of ${AGENT_LIMITS.MAX_STATE_SIZE} bytes`
      });
    }

    // Check for orphaned dependencies
    const allGoalIds = new Set(this.state.goals.map(g => g.id));
    this.state.goals.forEach(goal => {
      if (goal.dependencies) {
        goal.dependencies.forEach(depId => {
          if (!allGoalIds.has(depId)) {
            warnings.push({
              field: `goal.${goal.id}.dependencies`,
              message: `Dependency ${depId} not found`,
              severity: 'medium'
            });
          }
        });
      }
    });

    // Suggestions
    // Issue #749: Check both v1 runtime goals and v2 metadata goal template
    const hasV2Goal = 'goal' in this.metadata && !!this.metadata.goal;
    if (this.state.goals.length === 0 && !hasV2Goal) {
      suggestions.push('Add some goals to make the agent functional');
    }

    // Issue #749: Don't suggest deprecated v1 fields on v2 agents
    if (!hasV2Goal && (!this.extensions?.specializations || this.extensions.specializations.length === 0)) {
      suggestions.push('Consider adding specializations to improve agent focus');
    }

    const metrics = this.getPerformanceMetrics();
    if (metrics.successRate < 0.5 && metrics.goalsCompleted > 5) {
      suggestions.push('Low success rate detected. Consider reviewing goal difficulty or decision framework');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Serialize to JSON format for internal use and testing
   */
  public override serializeToJSON(): string {
    const data = {
      ...JSON.parse(super.serializeToJSON()),
      state: this.state
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Get content for serialization
   */
  protected override getContent(): string {
    let content = `# ${this.metadata.name}\n\n`;
    content += `${this.metadata.description}\n\n`;

    if (this.state.goals.length > 0) {
      content += `## Current Goals\n\n`;
      this.state.goals.forEach(goal => {
        content += `### ${goal.description}\n`;
        content += `- **Priority**: ${goal.priority}\n`;
        content += `- **Status**: ${goal.status}\n`;
        // Progress tracking could be added in future
        // if (goal.progress !== undefined) {
        //   content += `- **Progress**: ${goal.progress}%\n`;
        // }
        content += '\n';
      });
    }

    if (this.state.context && Object.keys(this.state.context).length > 0) {
      content += `## Context\n\n`;
      for (const [key, value] of Object.entries(this.state.context)) {
        content += `- **${key}**: ${JSON.stringify(value)}\n`;
      }
      content += '\n';
    }

    return content;
  }

  /**
   * Serialize agent to markdown format with YAML frontmatter
   * FIX: Changed from JSON to markdown for GitHub portfolio compatibility
   */
  public override serialize(): string {
    // Add agent state to extensions for frontmatter
    const originalExtensions = this.extensions;
    this.extensions = {
      ...originalExtensions,
      state: this.state
    };

    // Use base class serialize which now outputs markdown
    const result = super.serialize();

    // Restore original extensions
    this.extensions = originalExtensions;

    return result;
  }

  /**
   * Deserialize agent including state
   */
  public override deserialize(data: string): void {
    const validationResult = UnicodeValidator.normalize(data);
    const parsed = JSON.parse(validationResult.normalizedContent);

    // Deserialize base properties
    super.deserialize(JSON.stringify({
      id: parsed.id,
      type: parsed.type,
      version: parsed.version,
      metadata: parsed.metadata,
      references: parsed.references,
      extensions: parsed.extensions,
      ratings: parsed.ratings
    }));

    // Deserialize state with validation
    if (parsed.state) {
      // Validate state size
      const stateStr = JSON.stringify(parsed.state);
      if (stateStr.length > AGENT_LIMITS.MAX_STATE_SIZE) {
        throw ErrorHandler.createError(`State size exceeds maximum of ${AGENT_LIMITS.MAX_STATE_SIZE} bytes`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.STATE_TOO_LARGE);
      }

      // Restore dates
      if (parsed.state.goals) {
        parsed.state.goals.forEach((goal: any) => {
          goal.createdAt = new Date(goal.createdAt);
          goal.updatedAt = new Date(goal.updatedAt);
          if (goal.completedAt) {
            goal.completedAt = new Date(goal.completedAt);
          }
        });
      }

      if (parsed.state.decisions) {
        parsed.state.decisions.forEach((decision: any) => {
          decision.timestamp = new Date(decision.timestamp);
        });
      }

      if (parsed.state.lastActive) {
        parsed.state.lastActive = new Date(parsed.state.lastActive);
      }

      this.state = parsed.state;

      // Reconstruct EvictingQueue from deserialized decisions
      this._decisionHistory = new EvictingQueue<AgentDecision>(AGENT_LIMITS.MAX_DECISION_HISTORY);
      this._decisionHistory.reset(this.state.decisions || []);
    }

    this.isDirtyState = false;
  }

  /**
   * Agent activation
   */
  public override async activate(): Promise<void> {
    await super.activate();

    // Update session tracking
    this.state.sessionCount++;
    this.state.lastActive = new Date();
    // Note: stateVersion is incremented on successful save, not here (Issue #123 fix)
    this.isDirtyState = true;

    // Log activation
    logger.info(`Agent ${this.metadata.name} activated`, {
      sessionCount: this.state.sessionCount,
      activeGoals: this.getGoalsByStatus('in_progress').length
    });
  }

  /**
   * Agent deactivation
   */
  public override async deactivate(): Promise<void> {
    // Save any pending state
    if (this.isDirtyState) {
      logger.debug(`Agent ${this.metadata.name} has unsaved state changes`);
    }

    await super.deactivate();
  }

  /**
   * Check if agent needs state persistence
   */
  public needsStatePersistence(): boolean {
    return this.isDirtyState;
  }

  /**
   * Mark state as persisted
   */
  public markStatePersisted(): void {
    this.isDirtyState = false;
  }

  /**
   * Create a goal from a template
   * LOW PRIORITY IMPROVEMENT: Goal template system for common patterns
   */
  public addGoalFromTemplate(
    templateId: string,
    customFields: Record<string, any>
  ): AgentGoal {
    // Apply template to get goal data
    const goalData = applyGoalTemplate(templateId, customFields);

    // Create goal using the template data
    return this.addGoal(goalData);
  }

  /**
   * Get template recommendations based on goal description
   */
  public getGoalTemplateRecommendations(description: string): string[] {
    return recommendGoalTemplate(description);
  }

  /**
   * Validate a goal against its template
   */
  public validateGoalTemplate(goalId: string): { valid: boolean; errors: string[] } {
    const goal = this.state.goals.find(g => g.id === goalId);
    if (!goal) {
      return { valid: false, errors: ['Goal not found'] };
    }

    // If goal was created from template, validate against it
    const templateId = (goal as any).templateId;
    return validateGoalAgainstTemplate(goal, templateId);
  }

  /**
   * Update rule engine configuration
   */
  public updateRuleEngineConfig(config: Partial<RuleEngineConfig>): void {
    this.ruleEngineConfig = validateRuleEngineConfig({
      ...this.ruleEngineConfig,
      ...config
    });

    // Update extensions
    this.extensions = {
      ...this.extensions,
      ruleEngineConfig: this.ruleEngineConfig
    };

    this.markDirty();
  }

  /**
   * Get current rule engine configuration
   */
  public getRuleEngineConfig(): Readonly<RuleEngineConfig> {
    return { ...this.ruleEngineConfig };
  }
}
