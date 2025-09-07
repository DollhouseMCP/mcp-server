# Workflow Element Implementation Plan

## Overview
Implementing a new "Workflow" element type for DollhouseMCP that allows users to define and execute sequences of element activations and operations.

## Multi-PR Strategy

To keep PRs manageable and avoid bloating index.ts, we'll break this into 4 focused PRs:

### PR 1: Core Workflow Element (No index.ts changes)
**Branch**: `feature/workflow-element-core`
**Files**:
```
src/elements/workflows/
├── Workflow.ts           # Main workflow class extending BaseElement
├── WorkflowManager.ts    # CRUD operations
├── WorkflowExecutor.ts   # Execution engine
├── types.ts             # TypeScript interfaces
└── index.ts             # Module exports
```

**Key Points**:
- Implements IElement interface
- Extends BaseElement
- Self-contained in workflows directory
- No changes to main index.ts yet

### PR 2: MCP Integration (Minimal index.ts changes)
**Branch**: `feature/workflow-mcp-integration`
**Strategy to minimize index.ts changes**:

1. **Create a registration helper**:
```typescript
// src/elements/workflows/register.ts
export function registerWorkflowType(validTypes: string[]) {
  if (!validTypes.includes('workflows')) {
    validTypes.push('workflows');
  }
}
```

2. **In index.ts, just one line**:
```typescript
import { registerWorkflowType } from './elements/workflows/register.js';
// ... later in constructor
registerWorkflowType(this.validTypes);
```

3. **Workflow-specific tools in separate file**:
```typescript
// src/elements/workflows/tools.ts
export function registerWorkflowTools(server: DollhouseMCPServer) {
  server.addTool('execute_workflow', executeWorkflowHandler);
  server.addTool('list_workflow_steps', listWorkflowStepsHandler);
}
```

This keeps index.ts changes to 2-3 lines maximum!

### PR 3: Comprehensive Tests
**Branch**: `feature/workflow-tests`
**Files**:
```
test/__tests__/unit/elements/workflows/
├── Workflow.test.ts
├── WorkflowManager.test.ts
├── WorkflowExecutor.test.ts
└── integration.test.ts
```

**Coverage Goals**:
- Unit tests: >90% coverage
- Integration tests: Full execution flows
- Edge cases: Error handling, circular dependencies
- Performance tests: Large workflow handling

### PR 4: Documentation & Examples
**Branch**: `feature/workflow-docs-examples`
**Files**:
```
docs/elements/
└── WORKFLOW_ELEMENT_GUIDE.md

~/.dollhouse/portfolio/workflows/
├── development-setup.md
├── pr-review-workflow.md
├── documentation-update.md
└── test-and-verify.md
```

## Workflow Element Design

### Core Concepts

#### Workflow Structure
```yaml
---
name: PR Review Workflow
description: Complete PR review with verification
type: workflow
version: 1.0.0
author: dollhousemcp
---

steps:
  - id: setup
    type: activate_element
    element_type: personas
    element_name: alex-sterling
    
  - id: review
    type: activate_element
    element_type: skills
    element_name: code-review
    depends_on: [setup]
    
  - id: verify
    type: launch_agent
    agent: verification-specialist
    params:
      target: "current PR"
    depends_on: [review]
    
  - id: report
    type: launch_agent
    agent: session-notes-writer
    depends_on: [verify]
    when: "verify.status == 'complete'"
```

### Execution Features

1. **Sequential Execution**: Steps run in order
2. **Parallel Execution**: Steps without dependencies run simultaneously
3. **Conditional Logic**: `when` clauses for conditional execution
4. **Parameter Passing**: Pass outputs between steps
5. **Error Handling**: Rollback on failure
6. **Nested Workflows**: Workflows can call other workflows

### Integration Points

#### With Existing Elements
- Can activate any persona/skill
- Can launch any agent
- Can use any template
- Can access memories
- Can trigger ensembles

#### With MCP Tools
- Generic tools work with workflows (list_elements, get_element_details)
- New workflow-specific tools (execute_workflow, get_workflow_status)
- Minimal changes to existing code

## Implementation Timeline

### Week 1
- [ ] PR 1: Core implementation
- [ ] Initial testing locally
- [ ] Code review and merge

### Week 2  
- [ ] PR 2: MCP integration
- [ ] Update from develop (get orchestration framework)
- [ ] Integration testing

### Week 3
- [ ] PR 3: Comprehensive tests
- [ ] Coverage analysis
- [ ] Performance testing

### Week 4
- [ ] PR 4: Documentation
- [ ] Example workflows
- [ ] User guide

## Success Criteria

1. **Functionality**
   - Can define multi-step workflows
   - Can execute workflows reliably
   - Supports conditional logic
   - Handles errors gracefully

2. **Code Quality**
   - Follows DollhouseMCP patterns
   - >90% test coverage
   - TypeScript fully typed
   - No index.ts bloat

3. **User Value**
   - Simplifies complex operations
   - Enables automation
   - Shareable workflow files
   - Clear documentation

## Risk Mitigation

### Risk: index.ts becomes more bloated
**Mitigation**: Use registration pattern, keep workflow logic separate

### Risk: Complex execution logic
**Mitigation**: Start simple (sequential), add features incrementally

### Risk: Breaking existing functionality
**Mitigation**: Comprehensive tests, careful integration

### Risk: Poor adoption
**Mitigation**: Provide valuable example workflows from day 1

## Next Steps

1. Wait for PR #875 (orchestration framework) to merge
2. Update workflow branch from develop
3. Start PR 1: Core implementation
4. Use orchestration framework to coordinate the implementation!

---

*This plan ensures clean, manageable PRs without bloating index.ts*