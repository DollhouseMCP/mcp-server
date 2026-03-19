/**
 * GatheredData — Read-side aggregation over agent execution state.
 *
 * Provides structured views of agent execution data by querying existing
 * decision history and goal state. This is NOT a new write pipeline —
 * it aggregates data that's already captured by the agent state system
 * and decision recording.
 *
 * Part of the Agentic Loop Completion (Epic #380, Issue #68).
 *
 * @since v2.0.0
 */

import type { AgentState, AgentGoal, AgentDecision } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A single entry in the gathered data timeline.
 * Represents a discrete event during agent execution.
 */
export interface GatheredDataEntry {
  /** Entry type for filtering and presentation */
  type: 'decision' | 'goal_created' | 'goal_completed' | 'goal_failed' | 'finding' | 'metric';
  /** ISO 8601 timestamp of when this entry occurred */
  timestamp: string;
  /** Component or subsystem that generated this entry */
  source: string;
  /** Goal ID this entry relates to */
  goalId: string;
  /** Structured content */
  content: {
    /** Human-readable summary of the entry */
    summary: string;
    /** Additional structured details */
    details?: Record<string, unknown>;
  };
}

/**
 * Aggregated gathered data for a specific goal execution.
 */
export interface GatheredData {
  /** Goal ID the data was gathered for */
  goalId: string;
  /** Agent name */
  agentName: string;
  /** ISO 8601 timestamp when this data was gathered */
  gatheredAt: string;
  /** Timeline of events in chronological order */
  entries: GatheredDataEntry[];
  /** Summary statistics */
  summary: {
    totalSteps: number;
    successfulSteps: number;
    failedSteps: number;
    partialSteps: number;
    averageConfidence: number;
    /** Duration from goal creation to last decision (or now) */
    durationMs: number;
  };
  /** Goal metadata snapshot */
  goal: {
    description: string;
    status: string;
    createdAt: string;
    completedAt?: string;
  };
}

// =============================================================================
// Aggregation
// =============================================================================

/**
 * Build gathered data for a specific goalId from agent state.
 *
 * Queries the agent's decision history and goal state to produce
 * a chronological timeline of events. This is a read-side view —
 * the underlying data was already recorded by recordDecision() and
 * goal lifecycle methods.
 *
 * @param agentName - Name of the agent
 * @param goalId - Goal ID to gather data for
 * @param state - Agent's current state (from Agent.getState())
 * @returns GatheredData aggregation, or null if goal not found
 */
export function getGatheredData(
  agentName: string,
  goalId: string,
  state: Readonly<AgentState>
): GatheredData | null {
  // Find the target goal
  const goal = state.goals.find(g => g.id === goalId);
  if (!goal) {
    return null;
  }

  // Filter decisions for this goal
  const goalDecisions = state.decisions.filter(d => d.goalId === goalId);

  // Build the chronological timeline
  const entries: GatheredDataEntry[] = [];

  // 1. Goal creation event
  entries.push(buildGoalCreatedEntry(goal));

  // 2. Decision entries (chronological)
  for (const decision of goalDecisions) {
    entries.push(buildDecisionEntry(decision, goalId));

    // If the decision has findings in the reasoning, add a finding entry
    if (decision.reasoning && decision.reasoning.length > 0) {
      entries.push(buildFindingEntry(decision, goalId));
    }
  }

  // 3. Goal completion event (if completed or failed)
  if (goal.status === 'completed') {
    entries.push(buildGoalCompletedEntry(goal));
  } else if (goal.status === 'failed') {
    entries.push(buildGoalFailedEntry(goal));
  }

  // Sort by timestamp (chronological)
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Compute summary statistics
  const summary = computeSummary(goalDecisions, goal);

  return {
    goalId,
    agentName,
    gatheredAt: new Date().toISOString(),
    entries,
    summary,
    goal: {
      description: goal.description,
      status: goal.status,
      createdAt: goal.createdAt instanceof Date
        ? goal.createdAt.toISOString()
        : String(goal.createdAt),
      completedAt: goal.completedAt instanceof Date
        ? goal.completedAt.toISOString()
        : goal.completedAt ? String(goal.completedAt) : undefined,
    },
  };
}

// =============================================================================
// Entry Builders
// =============================================================================

function buildGoalCreatedEntry(goal: AgentGoal): GatheredDataEntry {
  const timestamp = goal.createdAt instanceof Date
    ? goal.createdAt.toISOString()
    : String(goal.createdAt);

  return {
    type: 'goal_created',
    timestamp,
    source: 'AgentManager.executeAgent',
    goalId: goal.id,
    content: {
      summary: `Goal created: ${goal.description.substring(0, 100)}`,
      details: {
        priority: goal.priority,
        importance: goal.importance,
        urgency: goal.urgency,
      },
    },
  };
}

function buildDecisionEntry(decision: AgentDecision, goalId: string): GatheredDataEntry {
  const timestamp = decision.timestamp instanceof Date
    ? decision.timestamp.toISOString()
    : String(decision.timestamp);

  return {
    type: 'decision',
    timestamp,
    source: 'Agent.recordDecision',
    goalId,
    content: {
      summary: decision.decision,
      details: {
        confidence: decision.confidence,
        outcome: decision.outcome,
        framework: decision.framework,
        riskLevel: decision.riskAssessment?.level,
      },
    },
  };
}

function buildFindingEntry(decision: AgentDecision, goalId: string): GatheredDataEntry {
  const timestamp = decision.timestamp instanceof Date
    ? decision.timestamp.toISOString()
    : String(decision.timestamp);

  return {
    type: 'finding',
    timestamp,
    source: 'Agent.recordDecision',
    goalId,
    content: {
      summary: decision.reasoning.substring(0, 200),
      details: {
        fullReasoning: decision.reasoning,
        decisionId: decision.id,
      },
    },
  };
}

function buildGoalCompletedEntry(goal: AgentGoal): GatheredDataEntry {
  const timestamp = goal.completedAt instanceof Date
    ? goal.completedAt.toISOString()
    : goal.completedAt ? String(goal.completedAt) : new Date().toISOString();

  return {
    type: 'goal_completed',
    timestamp,
    source: 'AgentManager.completeAgentGoal',
    goalId: goal.id,
    content: {
      summary: `Goal completed: ${goal.description.substring(0, 100)}`,
      details: {
        actualEffort: goal.actualEffort,
        estimatedEffort: goal.estimatedEffort,
      },
    },
  };
}

function buildGoalFailedEntry(goal: AgentGoal): GatheredDataEntry {
  const timestamp = goal.completedAt instanceof Date
    ? goal.completedAt.toISOString()
    : goal.completedAt ? String(goal.completedAt) : new Date().toISOString();

  return {
    type: 'goal_failed',
    timestamp,
    source: 'AgentManager.completeAgentGoal',
    goalId: goal.id,
    content: {
      summary: `Goal failed: ${goal.description.substring(0, 100)}`,
      details: {
        notes: goal.notes,
      },
    },
  };
}

// =============================================================================
// Summary Statistics
// =============================================================================

function computeSummary(
  decisions: AgentDecision[],
  goal: AgentGoal
): GatheredData['summary'] {
  const successfulSteps = decisions.filter(d => d.outcome === 'success').length;
  const failedSteps = decisions.filter(d => d.outcome === 'failure').length;
  const partialSteps = decisions.filter(d => d.outcome === 'partial').length;

  const confidences = decisions.map(d => d.confidence).filter(c => typeof c === 'number');
  const averageConfidence = confidences.length > 0
    ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
    : 0;

  // Duration from goal creation to last decision or completion
  const createdAt = goal.createdAt instanceof Date
    ? goal.createdAt.getTime()
    : new Date(String(goal.createdAt)).getTime();

  let endTime: number;
  if (goal.completedAt) {
    endTime = goal.completedAt instanceof Date
      ? goal.completedAt.getTime()
      : new Date(String(goal.completedAt)).getTime();
  } else if (decisions.length > 0) {
    const lastDecision = decisions[decisions.length - 1];
    endTime = lastDecision.timestamp instanceof Date
      ? lastDecision.timestamp.getTime()
      : new Date(String(lastDecision.timestamp)).getTime();
  } else {
    endTime = Date.now();
  }

  return {
    totalSteps: decisions.length,
    successfulSteps,
    failedSteps,
    partialSteps,
    averageConfidence: parseFloat(averageConfidence.toFixed(3)),
    durationMs: Math.max(0, endTime - createdAt),
  };
}
