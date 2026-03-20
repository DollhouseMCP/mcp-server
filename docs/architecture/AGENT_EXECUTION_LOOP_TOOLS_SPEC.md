# Agent Execution Loop MCP Tools Specification

**Version:** 1.0.0
**Date:** December 9, 2025
**Status:** Draft
**Branch:** `feature/agentic-loop-redesign`
**Related RFC:** [#97 - Tiered Safety System](https://github.com/DollhouseMCP/mcp-server-v2-refactor/issues/97)

---

## Overview

This specification defines four new MCP tools that close the agent execution loop in DollhouseMCP v2.0. These tools expose existing `Agent.ts` methods to the LLM, enabling the LLM to report progress, signal completion, query state, and continue from previous steps.

### Design Principles

1. **Temporary by Design**: These tools are stepping stones until MCP-AQL (Agent Query Language) is implemented
2. **Thin Wrappers**: Delegate to existing Agent.ts methods without adding business logic
3. **LLM-First**: All decisions come from the LLM; tools only record/retrieve state
4. **Simple State**: Avoid complex checkpoint systems; focus on essential progress tracking

### Architecture Context

```
┌─────────────┐
│     LLM     │ ◄──── Makes all decisions (intent, actions, reasoning)
└─────────────┘
      │ ▲
      │ │
      ▼ │
┌─────────────────────────────────────────────────┐
│         MCP Tools (This Spec)                    │
│  ┌─────────────────────────────────────────┐   │
│  │ • execute_agent         (existing)      │   │
│  │ • record_agent_step     (new)           │   │
│  │ • complete_agent_goal   (new)           │   │
│  │ • get_agent_state       (new)           │   │
│  │ • continue_agent_execution (new)        │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
      │ ▲
      │ │
      ▼ │
┌─────────────────────────────────────────────────┐
│         Agent.ts Methods                         │
│  ┌─────────────────────────────────────────┐   │
│  │ • executeAgent()        (AgentManager)  │   │
│  │ • recordDecision()      (Agent)         │   │
│  │ • completeGoal()        (Agent)         │   │
│  │ • getState()            (Agent)         │   │
│  │ • addGoal()             (Agent)         │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Tool 1: `record_agent_step`

### Purpose

Allow the LLM to report progress, findings, and intermediate results during agent execution. This creates an audit trail and enables resumption if interrupted.

### MCP Tool Schema

```typescript
{
  name: "record_agent_step",
  description: "Record a step in the agent's execution, including progress, findings, and outcome. Use this to document what the agent has done, what it learned, and whether the step succeeded. This creates an audit trail and enables resumption.",
  inputSchema: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the agent executing this step"
      },
      stepDescription: {
        type: "string",
        description: "Brief description of what this step accomplished (e.g., 'Analyzed codebase for security issues', 'Generated test cases')"
      },
      outcome: {
        type: "string",
        enum: ["success", "failure", "partial"],
        description: "Outcome of this step: 'success' (completed as intended), 'failure' (could not complete), 'partial' (made progress but not finished)"
      },
      findings: {
        type: "string",
        description: "Detailed findings, results, or observations from this step. Include relevant data, insights, or context for future steps."
      },
      confidence: {
        type: "number",
        description: "Confidence level in this step's outcome (0.0 to 1.0). Optional, defaults to 0.8",
        minimum: 0,
        maximum: 1
      }
    },
    required: ["agentName", "stepDescription", "outcome", "findings"]
  }
}
```

### Response Structure

```typescript
{
  success: boolean;
  message: string;
  decision: {
    id: string;                    // Unique decision ID
    goalId: string;                // Associated goal ID
    timestamp: string;             // ISO 8601 timestamp
    decision: string;              // Step description
    reasoning: string;             // Findings
    framework: "llm_driven";       // Always "llm_driven" for v2.0
    confidence: number;            // 0.0 to 1.0
    outcome: "success" | "failure" | "partial";
  };
  state: {
    goalCount: number;             // Number of active goals
    decisionCount: number;         // Number of recorded decisions
    lastActive: string;            // ISO 8601 timestamp
    stateVersion: number;          // State version for optimistic locking
  };
}
```

### Implementation Notes

**Handler Location:** `src/handlers/AgentExecutionTools.ts` (new file)

**Implementation:**
```typescript
async function recordAgentStep(params: {
  agentName: string;
  stepDescription: string;
  outcome: "success" | "failure" | "partial";
  findings: string;
  confidence?: number;
}): Promise<RecordStepResult> {
  // 1. Load agent by name
  const agent = await agentManager.read(params.agentName);
  if (!agent) {
    throw new Error(`Agent '${params.agentName}' not found`);
  }

  // 2. Get agent state to find active goals
  const state = agent.getState();
  const activeGoal = state.goals.find(g => g.status === 'in_progress');

  if (!activeGoal) {
    throw new Error(`No active goal found for agent '${params.agentName}'`);
  }

  // 3. Call Agent.recordDecision() to persist the step
  const decision = agent.recordDecision({
    goalId: activeGoal.id,
    decision: params.stepDescription,
    reasoning: params.findings,
    confidence: params.confidence ?? 0.8,
    outcome: params.outcome
  });

  // 4. Save agent state
  await agentManager.save(agent, agentManager.getFilename(params.agentName));

  // 5. Return decision and state summary
  return {
    success: true,
    message: `Step recorded for agent '${params.agentName}'`,
    decision: {
      id: decision.id,
      goalId: decision.goalId,
      timestamp: decision.timestamp.toISOString(),
      decision: decision.decision,
      reasoning: decision.reasoning,
      framework: decision.framework,
      confidence: decision.confidence,
      outcome: decision.outcome
    },
    state: {
      goalCount: state.goals.length,
      decisionCount: state.decisions.length,
      lastActive: state.lastActive.toISOString(),
      stateVersion: state.stateVersion || 1
    }
  };
}
```

**Error Cases:**
- Agent not found: Return 404-style error message
- No active goal: Return error prompting LLM to check agent state
- Invalid outcome: Validate enum before calling recordDecision()
- State persistence failure: Bubble up filesystem errors

---

## Tool 2: `complete_agent_goal`

### Purpose

Signal that the agent has completed its goal. This triggers cleanup, calculates metrics, and marks the agent as done.

### MCP Tool Schema

```typescript
{
  name: "complete_agent_goal",
  description: "Signal that the agent has completed its goal. This marks the goal as complete, updates decision outcomes, and calculates performance metrics. Use this when all success criteria have been met.",
  inputSchema: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the agent completing its goal"
      },
      goalId: {
        type: "string",
        description: "Optional specific goal ID to complete. If omitted, completes the most recent in-progress goal."
      },
      outcome: {
        type: "string",
        enum: ["success", "failure", "partial"],
        description: "Final outcome: 'success' (all criteria met), 'failure' (could not achieve goal), 'partial' (made progress but incomplete)"
      },
      summary: {
        type: "string",
        description: "Summary of what was accomplished, challenges faced, and any relevant context for future reference"
      }
    },
    required: ["agentName", "outcome", "summary"]
  }
}
```

### Response Structure

```typescript
{
  success: boolean;
  message: string;
  goal: {
    id: string;                    // Completed goal ID
    description: string;           // Goal description
    status: "completed" | "failed"; // Final status
    createdAt: string;             // ISO 8601 timestamp
    completedAt: string;           // ISO 8601 timestamp
    estimatedEffort?: number;      // Hours (if set)
    actualEffort?: number;         // Hours elapsed
  };
  metrics: {
    successRate: number;           // Overall success rate (0.0 to 1.0)
    goalsCompleted: number;        // Total goals completed
    goalsInProgress: number;       // Remaining active goals
    decisionAccuracy: number;      // Decision outcome accuracy (0.0 to 1.0)
    averageCompletionTime: number; // Average hours to complete goals
  };
  state: {
    goalCount: number;             // Remaining goals
    decisionCount: number;         // Total decisions
    lastActive: string;            // ISO 8601 timestamp
    stateVersion: number;          // State version
  };
}
```

### Implementation Notes

**Handler Location:** `src/handlers/AgentExecutionTools.ts` (same file as Tool 1)

**Implementation:**
```typescript
async function completeAgentGoal(params: {
  agentName: string;
  goalId?: string;
  outcome: "success" | "failure" | "partial";
  summary: string;
}): Promise<CompleteGoalResult> {
  // 1. Load agent by name
  const agent = await agentManager.read(params.agentName);
  if (!agent) {
    throw new Error(`Agent '${params.agentName}' not found`);
  }

  // 2. Find goal to complete
  const state = agent.getState();
  let goal: AgentGoal | undefined;

  if (params.goalId) {
    goal = state.goals.find(g => g.id === params.goalId);
  } else {
    // Find most recent in-progress goal
    goal = state.goals
      .filter(g => g.status === 'in_progress')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  if (!goal) {
    throw new Error(
      params.goalId
        ? `Goal '${params.goalId}' not found`
        : `No in-progress goal found for agent '${params.agentName}'`
    );
  }

  // 3. Record final decision with summary
  agent.recordDecision({
    goalId: goal.id,
    decision: 'goal_complete',
    reasoning: params.summary,
    confidence: 1.0,
    outcome: params.outcome
  });

  // 4. Call Agent.completeGoal()
  agent.completeGoal(goal.id, params.outcome);

  // 5. Get performance metrics
  const metrics = agent.getPerformanceMetrics();

  // 6. Save agent state
  await agentManager.save(agent, agentManager.getFilename(params.agentName));

  // 7. Return goal, metrics, and state
  const updatedState = agent.getState();
  const completedGoal = updatedState.goals.find(g => g.id === goal.id)!;

  return {
    success: true,
    message: `Goal completed for agent '${params.agentName}' with outcome: ${params.outcome}`,
    goal: {
      id: completedGoal.id,
      description: completedGoal.description,
      status: completedGoal.status,
      createdAt: completedGoal.createdAt.toISOString(),
      completedAt: completedGoal.completedAt!.toISOString(),
      estimatedEffort: completedGoal.estimatedEffort,
      actualEffort: completedGoal.actualEffort
    },
    metrics: {
      successRate: metrics.successRate,
      goalsCompleted: metrics.goalsCompleted,
      goalsInProgress: metrics.goalsInProgress,
      decisionAccuracy: metrics.decisionAccuracy,
      averageCompletionTime: metrics.averageCompletionTime
    },
    state: {
      goalCount: updatedState.goals.length,
      decisionCount: updatedState.decisions.length,
      lastActive: updatedState.lastActive.toISOString(),
      stateVersion: updatedState.stateVersion || 1
    }
  };
}
```

**Error Cases:**
- Agent not found: Return 404-style error
- Goal not found: Return error with guidance
- Goal already completed: Return error with current status
- State persistence failure: Bubble up errors

---

## Tool 3: `get_agent_state`

### Purpose

Query the current state of an agent, including goals, decisions, progress, and context. This allows the LLM to check what has been done and what remains.

### MCP Tool Schema

```typescript
{
  name: "get_agent_state",
  description: "Query the current state of an agent, including active goals, decision history, progress, and execution context. Use this to understand what the agent has done and what remains to be completed.",
  inputSchema: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the agent to query"
      },
      includeDecisionHistory: {
        type: "boolean",
        description: "Include full decision history in response. Default: false (only includes recent decisions)"
      },
      includeContext: {
        type: "boolean",
        description: "Include full execution context. Default: false (only includes summary)"
      }
    },
    required: ["agentName"]
  }
}
```

### Response Structure

```typescript
{
  success: boolean;
  agentName: string;
  state: {
    goals: Array<{
      id: string;
      description: string;
      priority: "critical" | "high" | "medium" | "low";
      status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
      importance: number;          // 1-10
      urgency: number;             // 1-10
      eisenhowerQuadrant: "do_first" | "schedule" | "delegate" | "eliminate";
      createdAt: string;           // ISO 8601
      updatedAt: string;           // ISO 8601
      completedAt?: string;        // ISO 8601 (if completed)
      dependencies?: string[];     // Goal IDs
      riskLevel?: "low" | "medium" | "high";
      estimatedEffort?: number;    // Hours
      actualEffort?: number;       // Hours
      notes?: string;
    }>;
    decisions: Array<{             // Recent decisions (or full if includeDecisionHistory=true)
      id: string;
      goalId: string;
      timestamp: string;           // ISO 8601
      decision: string;
      reasoning: string;
      framework: "llm_driven";
      confidence: number;          // 0.0 to 1.0
      outcome?: "success" | "failure" | "partial";
    }>;
    context?: Record<string, any>; // Full context if includeContext=true
    contextSummary: {              // Always included
      keys: string[];
      size: number;                // Bytes
    };
    lastActive: string;            // ISO 8601
    sessionCount: number;
    stateVersion: number;
  };
  metrics: {
    successRate: number;
    goalsCompleted: number;
    goalsInProgress: number;
    decisionAccuracy: number;
    averageCompletionTime: number;
  };
}
```

### Implementation Notes

**Handler Location:** `src/handlers/AgentExecutionTools.ts`

**Implementation:**
```typescript
async function getAgentState(params: {
  agentName: string;
  includeDecisionHistory?: boolean;
  includeContext?: boolean;
}): Promise<GetStateResult> {
  // 1. Load agent by name
  const agent = await agentManager.read(params.agentName);
  if (!agent) {
    throw new Error(`Agent '${params.agentName}' not found`);
  }

  // 2. Get agent state
  const state = agent.getState();

  // 3. Get performance metrics
  const metrics = agent.getPerformanceMetrics();

  // 4. Filter decisions based on includeDecisionHistory
  const decisions = params.includeDecisionHistory
    ? state.decisions
    : state.decisions.slice(-10); // Last 10 decisions

  // 5. Build context summary
  const contextKeys = Object.keys(state.context);
  const contextSize = JSON.stringify(state.context).length;

  // 6. Return state and metrics
  return {
    success: true,
    agentName: params.agentName,
    state: {
      goals: state.goals.map(g => ({
        id: g.id,
        description: g.description,
        priority: g.priority,
        status: g.status,
        importance: g.importance,
        urgency: g.urgency,
        eisenhowerQuadrant: g.eisenhowerQuadrant,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        completedAt: g.completedAt?.toISOString(),
        dependencies: g.dependencies,
        riskLevel: g.riskLevel,
        estimatedEffort: g.estimatedEffort,
        actualEffort: g.actualEffort,
        notes: g.notes
      })),
      decisions: decisions.map(d => ({
        id: d.id,
        goalId: d.goalId,
        timestamp: d.timestamp.toISOString(),
        decision: d.decision,
        reasoning: d.reasoning,
        framework: d.framework,
        confidence: d.confidence,
        outcome: d.outcome
      })),
      context: params.includeContext ? state.context : undefined,
      contextSummary: {
        keys: contextKeys,
        size: contextSize
      },
      lastActive: state.lastActive.toISOString(),
      sessionCount: state.sessionCount,
      stateVersion: state.stateVersion || 1
    },
    metrics: {
      successRate: metrics.successRate,
      goalsCompleted: metrics.goalsCompleted,
      goalsInProgress: metrics.goalsInProgress,
      decisionAccuracy: metrics.decisionAccuracy,
      averageCompletionTime: metrics.averageCompletionTime
    }
  };
}
```

**Error Cases:**
- Agent not found: Return 404-style error
- Agent state corrupted: Return error with recovery guidance
- Memory limits exceeded: Warn if context > threshold

---

## Tool 4: `continue_agent_execution`

### Purpose

Continue agent execution from a previous state. This is simpler than full checkpoint/restore and focuses on resuming after interruption or when starting a follow-up step.

### MCP Tool Schema

```typescript
{
  name: "continue_agent_execution",
  description: "Continue executing an agent from its current state. Use this to resume after interruption or start the next step in a multi-step workflow. Returns the agent's context including previous state, allowing the LLM to pick up where it left off.",
  inputSchema: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the agent to continue"
      },
      parameters: {
        type: "object",
        description: "Optional parameters to update the execution context (e.g., new data, changed requirements)"
      },
      previousStepResult: {
        type: "string",
        description: "Optional summary of the previous step's result to inform the next step"
      }
    },
    required: ["agentName"]
  }
}
```

### Response Structure

```typescript
{
  success: boolean;
  message: string;

  // Original execution context (same as execute_agent)
  agentName: string;
  goal: string;
  activeElements: Record<string, Array<{name: string; content: string}>>;
  availableTools: string[];
  successCriteria: string[];
  systemPrompt?: string;

  // Advisory signals
  securityWarnings?: string[];
  constraints?: ConstraintResult;
  riskAssessment?: RiskAssessmentResult;
  priorityScore?: PriorityScoreResult;

  // Safety tier information
  safetyTier: SafetyTier;
  safetyTierResult?: SafetyTierResult;
  confirmationRequired?: ConfirmationRequest;
  verificationRequired?: VerificationChallenge;
  dangerZoneBlocked?: DangerZoneOperation;
  executionContext?: ExecutionContext;

  // Previous state information (NEW)
  previousState: {
    goals: Array<{
      id: string;
      description: string;
      status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
      progress?: number;
    }>;
    recentDecisions: Array<{        // Last 5 decisions
      decision: string;
      reasoning: string;
      outcome?: "success" | "failure" | "partial";
      timestamp: string;
    }>;
    sessionCount: number;
    lastActive: string;
    stateVersion: number;
  };

  // Continuation context (NEW)
  continuation: {
    isResuming: boolean;              // True if resuming existing work
    previousStepResult?: string;       // From input parameter
    suggestedNextSteps?: string[];     // Based on current state
  };
}
```

### Implementation Notes

**Handler Location:** `src/handlers/AgentExecutionTools.ts`

**Implementation:**
```typescript
async function continueAgentExecution(params: {
  agentName: string;
  parameters?: Record<string, unknown>;
  previousStepResult?: string;
}): Promise<ContinueExecutionResult> {
  // 1. Load agent by name
  const agent = await agentManager.read(params.agentName);
  if (!agent) {
    throw new Error(`Agent '${params.agentName}' not found`);
  }

  // 2. Get current state
  const state = agent.getState();

  // 3. Check if agent has been executed before
  const isResuming = state.sessionCount > 0 || state.decisions.length > 0;

  // 4. Execute agent normally (this activates elements and gets context)
  // Note: For continuation, we re-run executeAgent with original or updated parameters
  const metadata = agent.metadata as AgentMetadataV2;

  // Use provided parameters or empty object for continuation
  const executionParams = params.parameters || {};

  const executionResult = await agentManager.executeAgent(
    params.agentName,
    executionParams
  );

  // 5. Build previous state summary
  const recentDecisions = state.decisions.slice(-5).map(d => ({
    decision: d.decision,
    reasoning: d.reasoning,
    outcome: d.outcome,
    timestamp: d.timestamp.toISOString()
  }));

  const goalSummary = state.goals.map(g => ({
    id: g.id,
    description: g.description,
    status: g.status,
    progress: undefined // Could add progress tracking in future
  }));

  // 6. Generate suggested next steps based on state
  const suggestedNextSteps = generateNextSteps(state);

  // 7. Merge execution result with continuation context
  return {
    success: true,
    message: isResuming
      ? `Resuming agent '${params.agentName}' from session ${state.sessionCount}`
      : `Starting agent '${params.agentName}'`,

    // Include all fields from execute_agent result
    ...executionResult,

    // Add previous state information
    previousState: {
      goals: goalSummary,
      recentDecisions,
      sessionCount: state.sessionCount,
      lastActive: state.lastActive.toISOString(),
      stateVersion: state.stateVersion || 1
    },

    // Add continuation context
    continuation: {
      isResuming,
      previousStepResult: params.previousStepResult,
      suggestedNextSteps
    }
  };
}

/**
 * Generate suggested next steps based on current state
 * @private
 */
function generateNextSteps(state: AgentState): string[] {
  const suggestions: string[] = [];

  // Check for pending goals
  const pendingGoals = state.goals.filter(g => g.status === 'pending');
  if (pendingGoals.length > 0) {
    suggestions.push(`Start work on ${pendingGoals.length} pending goal(s)`);
  }

  // Check for in-progress goals
  const inProgressGoals = state.goals.filter(g => g.status === 'in_progress');
  if (inProgressGoals.length > 0) {
    suggestions.push(`Continue ${inProgressGoals.length} in-progress goal(s)`);
  }

  // Check for blocked goals (dependencies)
  const blockedGoals = state.goals.filter(g =>
    g.dependencies && g.dependencies.length > 0 && g.status === 'pending'
  );
  if (blockedGoals.length > 0) {
    suggestions.push(`Resolve dependencies for ${blockedGoals.length} blocked goal(s)`);
  }

  // Check decision history for failures
  const recentFailures = state.decisions
    .slice(-10)
    .filter(d => d.outcome === 'failure');
  if (recentFailures.length > 0) {
    suggestions.push(`Review and address ${recentFailures.length} recent failure(s)`);
  }

  return suggestions;
}
```

**Error Cases:**
- Agent not found: Return 404-style error
- Agent state corrupted: Attempt recovery or return error
- Execution fails: Bubble up errors from executeAgent()
- Parameters invalid: Validate before passing to executeAgent()

---

## Usage Examples

### Example 1: Recording Progress During Execution

```typescript
// LLM executes agent
const execution = await execute_agent("code-reviewer", {
  parameters: { repository: "mcp-server" }
});

// LLM analyzes codebase and records finding
const step1 = await record_agent_step({
  agentName: "code-reviewer",
  stepDescription: "Analyzed authentication module",
  outcome: "success",
  findings: "Found 3 security issues: SQL injection risk in login handler, weak password hashing, missing rate limiting",
  confidence: 0.9
});

// LLM creates fixes and records another step
const step2 = await record_agent_step({
  agentName: "code-reviewer",
  stepDescription: "Generated security patches",
  outcome: "success",
  findings: "Created PRs #123, #124, #125 with fixes for identified issues",
  confidence: 0.85
});

// LLM completes the goal
const completion = await complete_agent_goal({
  agentName: "code-reviewer",
  outcome: "success",
  summary: "Completed security review of authentication module. Found and patched 3 critical issues. All tests passing."
});
```

### Example 2: Resuming After Interruption

```typescript
// LLM was interrupted mid-execution
// On next session, query state first
const state = await get_agent_state({
  agentName: "release-coordinator",
  includeDecisionHistory: true
});

// LLM sees: 2 goals completed, 1 in-progress
// Continue from where it left off
const continuation = await continue_agent_execution({
  agentName: "release-coordinator",
  previousStepResult: "Database migration completed successfully"
});

// LLM sees previous context and continues
// continuation.previousState shows what was done
// continuation.suggestedNextSteps provides guidance
```

### Example 3: Multi-Step Workflow

```typescript
// Initial execution
const exec = await execute_agent("test-generator", {
  parameters: { module: "auth" }
});

// Step 1: Analyze code
await record_agent_step({
  agentName: "test-generator",
  stepDescription: "Analyzed auth module structure",
  outcome: "success",
  findings: "Identified 5 untested functions, 3 edge cases"
});

// Step 2: Generate tests
await record_agent_step({
  agentName: "test-generator",
  stepDescription: "Generated unit tests",
  outcome: "success",
  findings: "Created 12 test cases covering all identified gaps"
});

// Step 3: Run tests
await record_agent_step({
  agentName: "test-generator",
  stepDescription: "Executed test suite",
  outcome: "partial",
  findings: "11/12 tests passing. One test failing due to mock setup issue."
});

// Step 4: Fix and complete
await record_agent_step({
  agentName: "test-generator",
  stepDescription: "Fixed mock configuration",
  outcome: "success",
  findings: "All tests now passing. Coverage increased from 65% to 94%."
});

// Complete goal
await complete_agent_goal({
  agentName: "test-generator",
  outcome: "success",
  summary: "Generated comprehensive test suite for auth module. Achieved 94% coverage with 12 new test cases."
});
```

---

## Implementation Checklist

### Phase 1: Core Implementation
- [ ] Create `src/handlers/AgentExecutionTools.ts`
- [ ] Implement `record_agent_step` handler
- [ ] Implement `complete_agent_goal` handler
- [ ] Implement `get_agent_state` handler
- [ ] Implement `continue_agent_execution` handler
- [ ] Add MCP tool registrations in `src/index.ts`

### Phase 2: Testing
- [ ] Unit tests for each handler
- [ ] Integration tests with real agent files
- [ ] Test error cases and edge conditions
- [ ] Test state persistence and recovery
- [ ] Test optimistic locking conflicts

### Phase 3: Documentation
- [ ] Add tools to `docs/reference/api-reference.md`
- [ ] Create usage guide in `docs/guides/`
- [ ] Update agent architecture docs
- [ ] Add examples to README

### Phase 4: Validation
- [ ] Test with Claude Code in Docker environment
- [ ] Verify LLM can successfully use tools
- [ ] Test interruption and resumption scenarios
- [ ] Validate audit trail completeness

---

## Security Considerations

### Input Validation
- Sanitize `agentName` to prevent directory traversal
- Validate `outcome` enum values
- Limit `findings` and `summary` string lengths
- Validate `confidence` is in range [0, 1]

### State Integrity
- Use optimistic locking (stateVersion) to prevent race conditions
- Validate agent exists before recording steps
- Ensure active goal exists before recording decisions
- Atomic file operations for state persistence

### Audit Trail
- All decisions logged via SecurityMonitor
- Include agent name, goal ID, timestamp in logs
- Track who/what initiated the execution
- Preserve decision history for forensics

---

## Future Enhancements (Post-MCP-AQL)

These tools are temporary until MCP-AQL is implemented. Future improvements include:

1. **Structured Query Language**: Replace individual tools with AQL queries
   - `AQL: GET agent.state WHERE name = "code-reviewer"`
   - `AQL: RECORD agent.decision SET outcome = "success"`

2. **Batch Operations**: Record multiple steps in one call
3. **Transaction Support**: Rollback failed step sequences
4. **Advanced Resumption**: Checkpoint/restore at arbitrary points
5. **Streaming Updates**: Real-time state updates during execution
6. **Agent Chains**: Track and resume multi-agent workflows

---

## Related Documents

| Document | Purpose |
|----------|---------|
| `docs/architecture/AGENT_ARCHITECTURE_SPECIFICATION.md` | Agent architecture overview |
| `docs/agent/development/SESSION_NOTES_2025-12-09_TIERED_SAFETY_SYSTEM.md` | Tiered safety implementation |
| `docs/reference/api-reference.md` | MCP tool catalog |
| `src/elements/agents/Agent.ts` | Agent class implementation |
| `src/elements/agents/AgentManager.ts` | Agent manager implementation |

---

*Specification prepared by Claude Code - December 9, 2025*
