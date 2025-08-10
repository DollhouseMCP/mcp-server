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
import { IElement, ElementValidationResult, ValidationError, ValidationWarning, ElementStatus } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { ErrorHandler, ErrorCategory } from '../../utils/ErrorHandler.js';
import { ValidationErrorCodes, SystemErrorCodes } from '../../utils/errorCodes.js';
import { 
  AgentGoal, 
  AgentDecision, 
  AgentState, 
  AgentMetadata 
} from './types.js';
import { 
  AGENT_LIMITS, 
  AGENT_DEFAULTS,
  DECISION_FRAMEWORKS,
  RISK_TOLERANCE_LEVELS
} from './constants.js';
import { 
  RuleEngineConfig, 
  DEFAULT_RULE_ENGINE_CONFIG, 
  validateRuleEngineConfig 
} from './ruleEngineConfig.js';
import { 
  applyGoalTemplate, 
  recommendGoalTemplate, 
  validateGoalAgainstTemplate 
} from './goalTemplates.js';

export class Agent extends BaseElement implements IElement {
  private state: AgentState;
  private isDirtyState: boolean = false;
  private ruleEngineConfig: RuleEngineConfig;

  constructor(metadata: Partial<AgentMetadata>) {
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

    super(ElementType.AGENT, sanitizedMetadata);

    // Initialize state
    this.state = {
      goals: [],
      decisions: [],
      context: {},
      lastActive: new Date(),
      sessionCount: 0
    };

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
   */
  public addGoal(goal: Partial<AgentGoal>): AgentGoal {
    // Validate goal count
    if (this.state.goals.length >= AGENT_LIMITS.MAX_GOALS) {
      throw ErrorHandler.createError(`Maximum number of goals (${AGENT_LIMITS.MAX_GOALS}) reached`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.MAX_GOALS_EXCEEDED);
    }

    // Sanitize goal description
    const sanitizedDescription = sanitizeInput(
      UnicodeValidator.normalize(goal.description || '').normalizedContent,
      AGENT_LIMITS.MAX_GOAL_LENGTH
    );

    if (!sanitizedDescription || sanitizedDescription.length < 3) {
      throw ErrorHandler.createError('Goal description must be at least 3 characters', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.GOAL_TOO_SHORT);
    }

    // Validate goal for security threats
    const securityCheck = this.validateGoalSecurity(sanitizedDescription);
    if (!securityCheck.safe) {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'Agent.addGoal',
        details: `Potentially malicious goal rejected: ${securityCheck.reason}`,
        additionalData: { agentId: this.id }
      });
      throw ErrorHandler.createError(`Goal contains potentially harmful content: ${securityCheck.reason}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.HARMFUL_CONTENT);
    }

    // Calculate Eisenhower quadrant
    const importance = goal.importance || 5;
    const urgency = goal.urgency || 5;
    const eisenhowerQuadrant = this.calculateEisenhowerQuadrant(importance, urgency);

    // Create new goal
    const newGoal: AgentGoal = {
      id: `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
      notes: goal.notes ? sanitizeInput(goal.notes, 500) : undefined
    };

    // MEDIUM PRIORITY IMPROVEMENT: Detect dependency cycles before adding goal
    if (newGoal.dependencies && newGoal.dependencies.length > 0) {
      const cycleCheck = this.detectDependencyCycle(newGoal.id, newGoal.dependencies);
      if (cycleCheck.hasCycle) {
        throw ErrorHandler.createError(`Dependency cycle detected: ${cycleCheck.path.join(' → ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.DEPENDENCY_CYCLE);
      }
    }

    this.state.goals.push(newGoal);
    this.isDirtyState = true;
    this.markDirty();

    logger.info(`Goal added to agent ${this.metadata.name}`, { goalId: newGoal.id });

    return newGoal;
  }

  /**
   * Make a decision for a goal
   */
  public async makeDecision(goalId: string, context?: Record<string, any>): Promise<AgentDecision> {
    // MEDIUM PRIORITY IMPROVEMENT: Track performance metrics for decision making
    const startTime = Date.now();
    const performanceMetrics: {
      decisionTimeMs?: number;
      frameworkTimeMs?: number;
      riskAssessmentTimeMs?: number;
    } = {};

    const goal = this.state.goals.find(g => g.id === goalId);
    if (!goal) {
      throw ErrorHandler.createError(`Goal ${goalId} not found`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.GOAL_NOT_FOUND);
    }

    if (goal.status === 'completed' || goal.status === 'cancelled') {
      throw ErrorHandler.createError(`Cannot make decision for ${goal.status} goal`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_GOAL_STATUS);
    }

    // Update goal status
    goal.status = 'in_progress';
    goal.updatedAt = new Date();

    // Prepare decision context
    const decisionContext = {
      ...this.state.context,
      ...context,
      goal,
      agentMetadata: this.metadata,
      previousDecisions: this.state.decisions.filter(d => d.goalId === goalId)
    };

    // Make decision based on framework (with timing)
    const frameworkStart = Date.now();
    const decision = await this.executeDecisionFramework(goal, decisionContext);
    performanceMetrics.frameworkTimeMs = Date.now() - frameworkStart;

    // Risk assessment (with timing)
    const riskStart = Date.now();
    const riskAssessment = this.assessRisk(decision, goal, decisionContext);
    performanceMetrics.riskAssessmentTimeMs = Date.now() - riskStart;

    // Calculate total decision time
    performanceMetrics.decisionTimeMs = Date.now() - startTime;

    // Create decision record
    const decisionRecord: AgentDecision = {
      id: `decision_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      goalId,
      timestamp: new Date(),
      decision: decision.action,
      reasoning: decision.reasoning,
      framework: this.extensions?.decisionFramework || AGENT_DEFAULTS.DECISION_FRAMEWORK,
      confidence: decision.confidence,
      riskAssessment,
      performanceMetrics  // Add performance tracking
    };

    // OPTIMIZATION: Use efficient circular buffer pattern
    // Add to history with limit (avoid array slicing for better performance)
    if (this.state.decisions.length >= AGENT_LIMITS.MAX_DECISION_HISTORY) {
      // Remove oldest entry before adding new one (O(n) but happens infrequently)
      this.state.decisions.shift();
    }
    this.state.decisions.push(decisionRecord);

    this.isDirtyState = true;
    this.markDirty();

    // Log decision for audit
    SecurityMonitor.logSecurityEvent({
      type: 'AGENT_DECISION',
      severity: 'LOW',
      source: 'Agent.makeDecision',
      details: `Agent ${this.metadata.name} made decision for goal ${goalId}`,
      additionalData: {
        agentId: this.id,
        goalId,
        framework: decisionRecord.framework,
        riskLevel: riskAssessment.level
      }
    });

    return decisionRecord;
  }

  /**
   * Execute decision framework
   */
  private async executeDecisionFramework(
    goal: AgentGoal,
    context: Record<string, any>
  ): Promise<{ action: string; reasoning: string; confidence: number }> {
    const framework = this.extensions?.decisionFramework || AGENT_DEFAULTS.DECISION_FRAMEWORK;

    switch (framework) {
      case 'rule_based':
        return this.ruleBasedDecision(goal, context);
      
      case 'ml_based':
        // Placeholder for ML-based decisions
        logger.warn('ML-based decisions not yet implemented, falling back to rule-based');
        return this.ruleBasedDecision(goal, context);
      
      case 'programmatic':
        return this.programmaticDecision(goal, context);
      
      case 'hybrid':
        // Combine multiple frameworks
        const ruleDecision = await this.ruleBasedDecision(goal, context);
        const progDecision = await this.programmaticDecision(goal, context);
        
        // Average confidence and combine reasoning
        return {
          action: ruleDecision.confidence > progDecision.confidence ? ruleDecision.action : progDecision.action,
          reasoning: `Rule-based: ${ruleDecision.reasoning}\nProgrammatic: ${progDecision.reasoning}`,
          confidence: (ruleDecision.confidence + progDecision.confidence) / 2
        };
      
      default:
        throw ErrorHandler.createError(`Unknown decision framework: ${framework}`, ErrorCategory.SYSTEM_ERROR, SystemErrorCodes.UNKNOWN_FRAMEWORK);
    }
  }

  /**
   * Rule-based decision making
   */
  private async ruleBasedDecision(
    goal: AgentGoal,
    context: Record<string, any>
  ): Promise<{ action: string; reasoning: string; confidence: number }> {
    const rules: Array<{
      condition: (g: AgentGoal, ctx: Record<string, any>) => boolean;
      action: string;
      reasoning: string;
      confidence: number;
    }> = [
      // High priority + high urgency = immediate action
      {
        condition: (g) => g.priority === this.ruleEngineConfig.ruleBased.priority.critical && 
                           g.urgency > this.ruleEngineConfig.ruleBased.urgencyThresholds.immediate,
        action: this.ruleEngineConfig.actions.executeImmediately,
        reasoning: 'Critical priority with high urgency requires immediate action',
        confidence: this.ruleEngineConfig.ruleBased.confidence.critical
      },
      // Blocked by dependencies
      {
        condition: (g, ctx) => {
          if (!g.dependencies || g.dependencies.length === 0) return false;
          const blockedDeps = g.dependencies.filter(depId => {
            const dep = this.state.goals.find(goal => goal.id === depId);
            return dep && dep.status !== 'completed';
          });
          return blockedDeps.length > 0;
        },
        action: this.ruleEngineConfig.actions.waitForDependencies,
        reasoning: 'Goal has incomplete dependencies',
        confidence: this.ruleEngineConfig.ruleBased.confidence.blocked
      },
      // Risk assessment
      {
        condition: (g) => g.riskLevel === 'high' && this.extensions?.riskTolerance === 'conservative',
        action: this.ruleEngineConfig.actions.requestApproval,
        reasoning: 'High risk goal requires approval in conservative mode',
        confidence: this.ruleEngineConfig.ruleBased.confidence.riskApproval
      },
      // Resource availability
      {
        condition: (g, ctx) => {
          const activeGoals = this.state.goals.filter(goal => goal.status === 'in_progress').length;
          const maxConcurrent = (this.metadata as AgentMetadata).maxConcurrentGoals || AGENT_DEFAULTS.MAX_CONCURRENT_GOALS;
          return activeGoals >= maxConcurrent;
        },
        action: this.ruleEngineConfig.actions.queueForLater,
        reasoning: 'Maximum concurrent goals reached',
        confidence: this.ruleEngineConfig.ruleBased.confidence.resourceLimit
      },
      // Default action
      {
        condition: () => true,
        action: this.ruleEngineConfig.actions.proceedWithGoal,
        reasoning: 'No blocking conditions found',
        confidence: this.ruleEngineConfig.ruleBased.confidence.default
      }
    ];

    // Evaluate rules in order
    for (const rule of rules) {
      if (rule.condition(goal, context)) {
        return {
          action: rule.action,
          reasoning: rule.reasoning,
          confidence: rule.confidence
        };
      }
    }

    // Fallback (should not reach here)
    return {
      action: this.ruleEngineConfig.actions.reviewManually,
      reasoning: 'No applicable rules found',
      confidence: 0.5
    };
  }

  /**
   * Programmatic decision making
   */
  private async programmaticDecision(
    goal: AgentGoal,
    context: Record<string, any>
  ): Promise<{ action: string; reasoning: string; confidence: number }> {
    // Calculate decision score based on multiple factors
    let score = 0;
    const factors: string[] = [];

    // Factor 1: Eisenhower matrix
    if (goal.eisenhowerQuadrant === 'do_first') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.doFirst;
      factors.push('High importance and urgency (Do First quadrant)');
    } else if (goal.eisenhowerQuadrant === 'schedule') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.schedule;
      factors.push('High importance, low urgency (Schedule quadrant)');
    } else if (goal.eisenhowerQuadrant === 'delegate') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.eisenhower.delegate;
      factors.push('Low importance, high urgency (Delegate quadrant)');
    }

    // Factor 2: Risk level
    if (goal.riskLevel === 'low') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.low;
      factors.push('Low risk');
    } else if (goal.riskLevel === 'medium') {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.medium;
      factors.push('Medium risk');
    } else {
      score += this.ruleEngineConfig.programmatic.scoreWeights.risk.high;
      factors.push('High risk penalty');
    }

    // Factor 3: Dependencies
    if (!goal.dependencies || goal.dependencies.length === 0) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.noDependencies;
      factors.push('No dependencies');
    }

    // Factor 4: Estimated effort
    if (goal.estimatedEffort && goal.estimatedEffort <= this.ruleEngineConfig.programmatic.quickWinHours) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.quickWin;
      factors.push(`Quick win (≤${this.ruleEngineConfig.programmatic.quickWinHours} hours)`);
    }

    // Factor 5: Previous success rate
    const previousDecisions = this.state.decisions.filter(d => d.outcome === 'success');
    const successRate = previousDecisions.length / Math.max(this.state.decisions.length, 1);
    if (successRate > this.ruleEngineConfig.programmatic.successRateThreshold) {
      score += this.ruleEngineConfig.programmatic.scoreWeights.successBonus;
      factors.push(`High success rate (${(successRate * 100).toFixed(0)}%)`);
    }

    // Determine action based on score
    let action: string;
    let confidence: number;

    if (score >= this.ruleEngineConfig.programmatic.actionThresholds.executeImmediately) {
      action = this.ruleEngineConfig.actions.executeImmediately;
      confidence = this.ruleEngineConfig.programmatic.confidenceLevels.executeImmediately;
    } else if (score >= this.ruleEngineConfig.programmatic.actionThresholds.proceed) {
      action = this.ruleEngineConfig.actions.proceedWithGoal;
      confidence = this.ruleEngineConfig.programmatic.confidenceLevels.proceed;
    } else if (score >= this.ruleEngineConfig.programmatic.actionThresholds.schedule) {
      action = this.ruleEngineConfig.actions.scheduleForLater;
      confidence = this.ruleEngineConfig.programmatic.confidenceLevels.schedule;
    } else {
      action = this.ruleEngineConfig.actions.reviewAndRevise;
      confidence = this.ruleEngineConfig.programmatic.confidenceLevels.review;
    }

    return {
      action,
      reasoning: `Score: ${score}. Factors: ${factors.join(', ')}`,
      confidence
    };
  }

  /**
   * Assess risk for a decision
   */
  private assessRisk(
    decision: { action: string; reasoning: string; confidence: number },
    goal: AgentGoal,
    context: Record<string, any>
  ): AgentDecision['riskAssessment'] {
    const factors: string[] = [];
    let riskScore = 0;

    // Check for immediate execution with high risk
    if (decision.action === 'execute_immediately' && goal.riskLevel === 'high') {
      factors.push('Immediate execution of high-risk goal');
      riskScore += 30;
    }

    // Check for low confidence decisions
    if (decision.confidence < 0.6) {
      factors.push('Low decision confidence');
      riskScore += 20;
    }

    // Check for complex dependencies
    if (goal.dependencies && goal.dependencies.length > 3) {
      factors.push('Complex dependency chain');
      riskScore += 15;
    }

    // Check for aggressive risk tolerance with high-risk goal
    if (this.extensions?.riskTolerance === 'aggressive' && goal.riskLevel === 'high') {
      factors.push('Aggressive risk tolerance with high-risk goal');
      riskScore += 25;
    }

    // Determine risk level
    let level: 'low' | 'medium' | 'high';
    const mitigations: string[] = [];

    if (riskScore >= 50) {
      level = 'high';
      mitigations.push('Request human approval');
      mitigations.push('Create backup plan');
      mitigations.push('Monitor closely');
    } else if (riskScore >= 25) {
      level = 'medium';
      mitigations.push('Add checkpoints');
      mitigations.push('Review after completion');
    } else {
      level = 'low';
      mitigations.push('Standard monitoring');
    }

    return {
      level,
      factors,
      mitigations: mitigations.length > 0 ? mitigations : undefined
    };
  }

  /**
   * Calculate Eisenhower quadrant
   */
  private calculateEisenhowerQuadrant(importance: number, urgency: number): AgentGoal['eisenhowerQuadrant'] {
    if (importance >= 7 && urgency >= 7) {
      return 'do_first';
    } else if (importance >= 7 && urgency < 7) {
      return 'schedule';
    } else if (importance < 7 && urgency >= 7) {
      return 'delegate';
    } else {
      return 'eliminate';
    }
  }

  /**
   * Validate goal for security threats
   */
  private validateGoalSecurity(goal: string): { safe: boolean; reason?: string } {
    // Check for command injection patterns
    const dangerousPatterns = [
      /system\s*\(/i,
      /exec\s*\(/i,
      /eval\s*\(/i,
      /require\s*\(/i,
      /import\s*\(/i,
      /\$\{.*\}/,
      /`.*`/,
      /process\.\w+/i,
      /child_process/i
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(goal)) {
        return { safe: false, reason: 'Contains potentially dangerous code patterns' };
      }
    }

    // Check for social engineering attempts
    const socialEngineeringPatterns = [
      /password|credential|secret|token|key/i,
      /hack|exploit|breach|attack/i,
      /delete\s+all|destroy|wipe|erase\s+everything/i,
      /steal|theft|rob/i
    ];

    for (const pattern of socialEngineeringPatterns) {
      if (pattern.test(goal)) {
        return { safe: false, reason: 'Contains potentially harmful intent' };
      }
    }

    return { safe: true };
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
      // Only pop from path if we're not returning a cycle
      if (!deps.some(depId => recursionStack.has(depId))) {
        path.pop();
      }
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
    if (this.state.goals.length === 0) {
      suggestions.push('Add some goals to make the agent functional');
    }

    if (!this.extensions?.specializations || this.extensions.specializations.length === 0) {
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