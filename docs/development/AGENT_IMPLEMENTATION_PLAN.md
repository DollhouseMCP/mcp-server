# Agent Element Implementation Plan

## Overview
The Agent element represents autonomous goal-oriented actors with decision-making capabilities. This document outlines the complete implementation plan for the Agent element type in DollhouseMCP.

## Core Concepts

### What is an Agent?
- **Autonomous actors** that can make decisions and take actions toward goals
- **Goal-oriented** with prioritization using the Eisenhower matrix
- **Stateful** maintaining context and history across sessions
- **Risk-aware** with assessment and mitigation capabilities
- **Learning-capable** improving decisions based on outcomes

### Key Features
1. **Goal Management System**
   - Create, prioritize, and track goals
   - Eisenhower matrix (importance × urgency)
   - Dependencies between goals
   - Risk assessment per goal

2. **Decision Frameworks**
   - Rule-based decisions
   - ML-based decisions (future)
   - Programmatic decisions
   - Hybrid approaches

3. **State Persistence**
   - Goals and their status
   - Decision history
   - Context information
   - Performance metrics

4. **Risk Assessment**
   - Evaluate potential negative outcomes
   - Suggest mitigations
   - Configurable risk tolerance

## Implementation Tasks

### Phase 1: Core Structure ✅
- [x] Create Agent.ts with base implementation
- [x] Define interfaces for goals, decisions, and state
- [x] Implement security measures (input validation, size limits)
- [x] Add Eisenhower matrix calculation
- [x] Basic goal management (add, update, complete)

### Phase 2: Decision Framework
- [ ] Enhance rule-based decision engine
- [ ] Add more sophisticated rules
- [ ] Implement decision confidence scoring
- [ ] Add decision outcome tracking
- [ ] Create decision audit trail

### Phase 3: AgentManager
- [ ] Create AgentManager.ts implementing IElementManager
- [ ] Implement CRUD operations for agents
- [ ] Add state persistence to .state directory
- [ ] Handle agent lifecycle (create, load, save, delete)
- [ ] Implement atomic file operations with FileLockManager

### Phase 4: State Management
- [ ] Design state file format (YAML with frontmatter)
- [ ] Implement state serialization/deserialization
- [ ] Add state versioning for migrations
- [ ] Create state backup mechanism
- [ ] Handle concurrent state access

### Phase 5: Testing
- [ ] Unit tests for Agent class
- [ ] Tests for goal management
- [ ] Tests for decision frameworks
- [ ] Tests for risk assessment
- [ ] Integration tests with AgentManager
- [ ] Security tests (injection, DoS, etc.)

### Phase 6: Integration
- [ ] Add MCP tools for agent operations
- [ ] Create agent-specific commands
- [ ] Integrate with existing element system
- [ ] Update PortfolioManager for agents directory
- [ ] Add agent activation/deactivation

### Phase 7: Documentation & PR
- [ ] Create user documentation
- [ ] Add code examples
- [ ] Document security considerations
- [ ] Create PR with comprehensive description

## Technical Architecture

### File Structure
```
src/elements/agents/
├── Agent.ts              # Main agent implementation ✅
├── AgentManager.ts       # CRUD operations
├── constants.ts          # Shared constants
├── types.ts              # Agent-specific types
└── index.ts              # Module exports

test/__tests__/unit/elements/agents/
├── Agent.test.ts         # Agent unit tests
└── AgentManager.test.ts  # Manager tests
```

### Data Models

#### AgentGoal
```typescript
{
  id: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  importance: number; // 1-10
  urgency: number;    // 1-10
  eisenhowerQuadrant?: 'do_first' | 'schedule' | 'delegate' | 'eliminate';
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  dependencies?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  estimatedEffort?: number;
  actualEffort?: number;
  notes?: string;
}
```

#### AgentDecision
```typescript
{
  id: string;
  goalId: string;
  timestamp: Date;
  decision: string;
  reasoning: string;
  framework: 'rule_based' | 'ml_based' | 'programmatic' | 'hybrid';
  confidence: number;
  riskAssessment: {
    level: 'low' | 'medium' | 'high';
    factors: string[];
    mitigations?: string[];
  };
  outcome?: 'success' | 'failure' | 'partial' | 'unknown';
  impact?: string;
}
```

### State Persistence Format
```yaml
---
# Agent metadata (standard element format)
name: Project Manager
type: agent
version: 1.0.0
author: user123
created: 2025-07-22T10:00:00Z
modified: 2025-07-22T14:30:00Z

# Agent-specific metadata
decisionFramework: hybrid
riskTolerance: moderate
learningEnabled: true
maxConcurrentGoals: 10
specializations:
  - project management
  - resource allocation
  - timeline optimization
---

# Agent State (stored separately in .state/agent_id.state.yaml)
goals:
  - id: goal_1234567890_abc
    description: Complete API documentation
    priority: high
    status: in_progress
    importance: 8
    urgency: 7
    eisenhowerQuadrant: do_first
    createdAt: 2025-07-22T10:00:00Z
    updatedAt: 2025-07-22T14:00:00Z
    riskLevel: low
    estimatedEffort: 4

decisions:
  - id: decision_1234567890_xyz
    goalId: goal_1234567890_abc
    timestamp: 2025-07-22T14:00:00Z
    decision: proceed_with_goal
    reasoning: "High priority with no blockers"
    framework: rule_based
    confidence: 0.85
    riskAssessment:
      level: low
      factors:
        - "Well-defined requirements"
        - "Team has expertise"

context:
  teamSize: 5
  sprintDuration: 14
  currentSprint: 3

sessionCount: 12
lastActive: 2025-07-22T14:30:00Z
```

## Security Considerations

### Input Validation
- All text inputs sanitized with `sanitizeInput()`
- Unicode normalization to prevent homograph attacks
- Length limits on all string fields
- Goal description security validation

### Size Limits
- MAX_GOALS = 50
- MAX_GOAL_LENGTH = 1000
- MAX_STATE_SIZE = 100KB
- MAX_DECISION_HISTORY = 100
- MAX_CONTEXT_LENGTH = 5000

### Risk Prevention
- Command injection pattern detection
- Social engineering pattern detection
- Audit logging for all decisions
- State size validation

## MCP Tools

### New Tools for Agents
```typescript
// Goal management
create_agent_goal(agentName: string, goal: AgentGoalInput)
update_agent_goal(agentName: string, goalId: string, updates: Partial<AgentGoal>)
complete_agent_goal(agentName: string, goalId: string, outcome: 'success' | 'failure' | 'partial')

// Decision making
make_agent_decision(agentName: string, goalId: string, context?: Record<string, any>)
get_agent_recommendations(agentName: string)

// State management
get_agent_state(agentName: string)
get_agent_metrics(agentName: string)
update_agent_context(agentName: string, key: string, value: any)

// Generic element tools will also work
activate_element("Project Manager", "agent")
get_element_details("Project Manager", "agent")
```

## Testing Strategy

### Unit Tests
1. Goal CRUD operations
2. Eisenhower matrix calculation
3. Decision framework logic
4. Risk assessment
5. State serialization/deserialization
6. Performance metrics calculation

### Integration Tests
1. Agent creation and loading
2. State persistence
3. Concurrent access handling
4. File locking with AgentManager

### Security Tests
1. Goal injection attempts
2. State size DoS prevention
3. Path traversal in state files
4. Unicode attack prevention

## Success Criteria
- [ ] All tests passing (aim for 95%+ coverage)
- [ ] Security audit passing
- [ ] State persistence working reliably
- [ ] Decision frameworks producing logical outputs
- [ ] Performance metrics accurate
- [ ] Documentation complete
- [ ] PR approved and merged

## Future Enhancements
1. ML-based decision framework
2. Multi-agent collaboration
3. Goal templates and presets
4. Advanced learning algorithms
5. Integration with external task systems
6. Visual goal/decision trees
7. Real-time decision explanations