# Memory Naming Conventions

This document describes recommended naming patterns for memory elements in DollhouseMCP. Following these conventions improves discoverability, organization, and makes the relationship between memories and other elements clear.

## Naming Pattern Table

| Naming Pattern | Example Name | Purpose | Use Case |
|----------------|--------------|---------|----------|
| `agent-{agent-name}-context` | `agent-code-reviewer-context` | Execution state, learned behaviors | Store agent-specific context that persists across executions |
| `persona-{persona-name}-preferences` | `persona-teacher-preferences` | Personalization data | Store user preferences learned while using a specific persona |
| `session-{purpose}` | `session-context` | Cross-cutting session data | Shared data accessible to all active elements during a session |
| `project-{project-name}-{purpose}` | `project-webapp-decisions` | Project-scoped knowledge | Store decisions, context, or notes specific to a project |

## Detailed Examples

### Agent-Linked Memory

Use this pattern to store context that should persist for a specific agent across multiple executions.

```javascript
// Create memory for agent context
{
  operation: "create_element",
  element_type: "memory",
  params: {
    element_name: "agent-code-reviewer-context",
    description: "Stores context and learned preferences for code-reviewer agent"
  }
}

// Add agent-relevant entries with appropriate tags
{
  operation: "addEntry",
  params: {
    element_name: "agent-code-reviewer-context",
    content: "User prefers detailed explanations with code examples",
    tags: ["preference", "communication-style"]
  }
}

// Add execution context
{
  operation: "addEntry",
  params: {
    element_name: "agent-code-reviewer-context",
    content: "Last reviewed: src/handlers/ - found 3 issues related to error handling",
    tags: ["execution-history", "findings"]
  }
}
```

### Persona-Linked Memory

Use this pattern to store learned preferences that customize a persona's behavior for a specific user.

```javascript
// Create memory for persona preferences
{
  operation: "create_element",
  element_type: "memory",
  params: {
    element_name: "persona-teacher-preferences",
    description: "Learned preferences for teacher persona behavior"
  }
}

// Store learned user preferences
{
  operation: "addEntry",
  params: {
    element_name: "persona-teacher-preferences",
    content: "User is intermediate level, avoid over-explaining basics",
    tags: ["skill-level", "learned"]
  }
}

// Store communication preferences
{
  operation: "addEntry",
  params: {
    element_name: "persona-teacher-preferences",
    content: "User prefers visual examples and diagrams over lengthy text",
    tags: ["communication", "learned"]
  }
}
```

### Shared/Session Memory

Use this pattern for cross-cutting context that multiple elements may need to access.

```javascript
// Create session-level shared memory
{
  operation: "create_element",
  element_type: "memory",
  params: {
    element_name: "session-context",
    description: "Shared context accessible to all active elements"
  }
}

// Store session-relevant data
{
  operation: "addEntry",
  params: {
    element_name: "session-context",
    content: "Current task: Refactoring authentication module",
    tags: ["task", "current"]
  }
}

// Store user context
{
  operation: "addEntry",
  params: {
    element_name: "session-context",
    content: "User timezone: PST, prefers brief responses during work hours",
    tags: ["user-context"]
  }
}
```

### Project-Scoped Memory

Use this pattern to store knowledge specific to a particular project.

```javascript
// Create project-scoped memory
{
  operation: "create_element",
  element_type: "memory",
  params: {
    element_name: "project-webapp-decisions",
    description: "Architecture decisions for the webapp project"
  }
}

// Store architecture decisions
{
  operation: "addEntry",
  params: {
    element_name: "project-webapp-decisions",
    content: "Decision: Use React Query for server state management instead of Redux",
    tags: ["architecture", "state-management"],
    metadata: { date: "2024-01-15", rationale: "Simpler API, better caching" }
  }
}

// Store project-specific conventions
{
  operation: "addEntry",
  params: {
    element_name: "project-webapp-decisions",
    content: "Convention: All API calls go through src/api/ with typed responses",
    tags: ["convention", "api"]
  }
}
```

## Best Practices

1. **Use descriptive names**: The memory name should clearly indicate its purpose and relationship to other elements.

2. **Use consistent tags**: Establish a tagging convention within each memory type:
   - Agent memories: `execution-history`, `findings`, `preference`, `learned`
   - Persona memories: `skill-level`, `communication`, `learned`
   - Session memories: `task`, `user-context`, `current`
   - Project memories: `architecture`, `convention`, `decision`

3. **Include metadata when relevant**: Use the `metadata` field for structured data like dates, sources, or correlation IDs.

4. **Set appropriate retention**: Use `metadata.retentionDays` when creating memories that should expire:
   - Session memories: Short retention (1-7 days)
   - Project memories: Long retention (365+ days)
   - Agent/Persona memories: Medium retention (30-90 days)

## Searching by Pattern

Use the unified search operation with filters to find related memories:

```javascript
// Find all memories for a specific agent
{ operation: "search", params: { query: "agent-code-reviewer-*", type: "memory" } }

// Find memories with specific tags
{ operation: "search", params: { query: "*", type: "memory", filters: { tags: ["learned"] } } }

// Find project-related memories
{ operation: "search", params: { query: "project-webapp-*", type: "memory" } }
```

## Related Documentation

- [Element Types](./element-types.md) - Overview of all element types
- [API Reference](./api-reference.md) - Complete MCP-AQL operation reference
- [Conventions](./conventions.md) - General naming and content conventions
