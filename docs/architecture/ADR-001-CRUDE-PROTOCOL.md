# ADR-001: CRUDE Protocol for MCP-AQL Endpoints

**Status:** Accepted
**Date:** 2026-01-03
**Authors:** DollhouseMCP Team

## Context

When designing the unified MCP-AQL (Model Context Protocol - Agent Query Language) interface, we needed to decide how to categorize and organize operations for LLM consumption. The traditional CRUD (Create, Read, Update, Delete) model was considered, but we chose to extend it.

### Problem Statement

1. **LLMs need semantic clarity** - Operations must be clearly categorized so LLMs can select the right endpoint
2. **Idempotency matters for safety** - LLMs may retry operations; understanding idempotency is crucial
3. **Execute operations are distinct** - Actions like "run workflow" or "deploy" don't fit CRUD categories
4. **Token efficiency requires consolidation** - 50+ discrete tools must become 5 semantic endpoints

## Decision

We adopt the **CRUDE protocol** - an extension of CRUD that adds **Execute** as a first-class operation category.

### The Five CRUDE Endpoints

| Endpoint | Idempotent | Description | Examples |
|----------|------------|-------------|----------|
| **C**reate | No | Create new resources | `create_element`, `import_element`, `addEntry` |
| **R**ead | Yes | Query without side effects | `list_elements`, `get_element`, `introspect`, `search` |
| **U**pdate | Yes | Modify existing resources | `edit_element` |
| **D**elete | Yes | Remove resources | `delete_element`, `clear` |
| **E**xecute | No | Trigger actions/workflows | `execute_agent`, `get_execution_state` |

### Why Not Pure CRUD?

1. **Execute is semantically distinct** - "Run this agent" is not create, read, update, or delete
2. **Safety classification** - Execute operations are non-idempotent and potentially destructive
3. **LLM understanding** - Clear separation helps LLMs reason about operation effects
4. **Gatekeeper integration** - Security policies can treat Execute differently (higher scrutiny)

## Implementation

### Endpoint Tool Names

```typescript
mcp_aql_create  // Create operations - additive, non-destructive
mcp_aql_read    // Read operations - safe, idempotent
mcp_aql_update  // Update operations - modifying, overwrites data
mcp_aql_delete  // Delete operations - destructive, removes data
mcp_aql_execute // Execute operations - triggers actions, non-idempotent
```

### Schema-Driven Dispatch

Each operation is defined declaratively in `OperationSchema.ts`:

```typescript
const operationSchemas: Record<string, OperationDef> = {
  create_element: {
    endpoint: 'create',
    handler: 'createHandler',
    builder: 'namedWithType',
    params: {
      element_name: { required: true, type: 'string', mapTo: 'elementName' },
      element_type: { required: true, type: 'string', sources: ['input.element_type'] },
      // ...
    }
  },
  // ...
};
```

### Introspection Discovery

LLMs discover operations via the `introspect` operation:

```json
{
  "operation": "introspect",
  "params": { "query": "operations" }
}
```

Returns all available operations grouped by endpoint, with parameter schemas.

## Consequences

### Benefits

1. **Semantic clarity** - LLMs understand operation intent from endpoint name
2. **Safety reasoning** - Clear idempotency classification for retry logic
3. **Token efficiency** - 5 endpoints vs 50+ discrete tools (~96% reduction)
4. **Gatekeeper integration** - Permission policies can be endpoint-specific
5. **Schema evolution** - Adding operations doesn't require new tool registration

### Trade-offs

1. **Learning curve** - Developers familiar with CRUD must learn CRUDE
2. **Execute ambiguity** - Some operations could arguably be Create or Execute
3. **Introspection dependency** - LLMs must query for operation details

### Guiding Principles for Classification

When classifying a new operation:

1. **Does it create a new persistent resource?** → Create
2. **Does it only read without side effects?** → Read
3. **Does it modify an existing resource?** → Update
4. **Does it remove a resource?** → Delete
5. **Does it trigger an action or workflow?** → Execute

Edge cases:
- `activate_element` → Create (establishes new active state)
- `deactivate_element` → Read (removing from active set is a query operation)
- `execute_agent` → Execute (triggers workflow, non-idempotent)

## Related Documents

- [MCP-AQL Architecture](./MCP-AQL-ARCHITECTURE.md)
- [Gatekeeper Product Strategy](./GATEKEEPER_PRODUCT_STRATEGY.md)
- [Security Guide](../security/CONTRIBUTOR-SECURITY-GUIDE.md)

## References

- Issue #247: Schema-driven operation definitions
- Issue #290: Parameter naming standardization
- PR #292: Unified MCP-AQL Single Endpoint Architecture
