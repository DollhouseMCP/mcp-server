# Agent Element Quick Reference

## What's Already Done ✅
1. **Agent.ts created** with complete base implementation
2. **Security measures** implemented throughout
3. **Goal management** system with Eisenhower matrix
4. **Decision frameworks** (rule-based and programmatic)
5. **Risk assessment** system
6. **State management** structure defined

## Key Code Locations
- `/src/elements/agents/Agent.ts` - Main implementation (created)
- `/src/elements/agents/AgentManager.ts` - CRUD operations (TODO)
- `/test/__tests__/unit/elements/agents/` - Tests (TODO)

## Next Immediate Steps
1. Create `AgentManager.ts` implementing `IElementManager`
2. Add state persistence to `.state` directory
3. Create comprehensive tests
4. Add MCP tool integration

## Important Patterns to Follow

### From PersonaElementManager
```typescript
// Use FileLockManager for atomic operations
await FileLockManager.atomicWriteFile(filePath, content, { encoding: 'utf-8' });

// Use SecureYamlParser for YAML operations
const parsed = SecureYamlParser.parse(yamlContent, {
  maxYamlSize: 64 * 1024,
  validateContent: true
});
```

### From Memory/Template Examples
```typescript
// Constants in separate file
export const AGENT_LIMITS = {
  MAX_GOALS: 50,
  MAX_STATE_SIZE: 100 * 1024,
  // ...
} as const;

// Comprehensive error handling
if (!goal) {
  throw new Error(`Goal ${goalId} not found in agent ${this.id}`);
}
```

## Security Checklist
- ✅ Input sanitization with `sanitizeInput()`
- ✅ Unicode normalization with `UnicodeValidator`
- ✅ Size limits on all collections
- ✅ Security event logging with `SecurityMonitor`
- ✅ Goal content validation
- ✅ Risk assessment system

## Testing Requirements
- Unit tests for all public methods
- Security tests for injection/DoS
- Integration tests with AgentManager
- State persistence tests
- Concurrent access tests

## Agent-Specific Features
1. **Goals** - Prioritized tasks with dependencies
2. **Decisions** - Recorded with reasoning and confidence
3. **State** - Persisted between sessions
4. **Metrics** - Success rate, completion time, accuracy
5. **Risk** - Assessment and mitigation strategies

## File Format Example
```yaml
---
name: Project Manager
type: agent
version: 1.0.0
decisionFramework: hybrid
riskTolerance: moderate
specializations:
  - project management
  - resource allocation
---
# Agent instructions/description
This agent manages software development projects...
```

## Common Operations
```typescript
// Create agent
const agent = new Agent({ name: 'Project Manager', ... });

// Add goal
const goal = agent.addGoal({
  description: 'Complete API documentation',
  priority: 'high',
  importance: 8,
  urgency: 7
});

// Make decision
const decision = await agent.makeDecision(goal.id, { context });

// Complete goal
agent.completeGoal(goal.id, 'success');

// Get metrics
const metrics = agent.getPerformanceMetrics();
```