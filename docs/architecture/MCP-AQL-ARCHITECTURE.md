# MCP-AQL Architecture

**Version:** 2.0.0
**Last Updated:** 2026-01-03

## Overview

MCP-AQL (Model Context Protocol - Agent Query Language) is a protocol layer on top of MCP, created by Dollhouse Research. In DollhouseMCP, it serves as the unified interface for LLM-to-server communication. It consolidates 50+ discrete tools into 5 semantic endpoints, achieving ~96% token reduction while maintaining full functionality.

Those endpoints are semantic rather than tool-by-tool functional endpoints. Instead of forcing an LLM to choose among dozens of narrowly scoped tools first, MCP-AQL lets the model reason about intent at the endpoint level first: create, read, update, delete, or execute.

## Design Principles

### 1. Schema-Driven Operations

All operations are defined declaratively in `OperationSchema.ts`. The schema specifies:
- Parameter names, types, and validation rules
- Source resolution order (where to find parameter values)
- Handler mapping and endpoint classification

```typescript
// Example: create_element operation schema
create_element: {
  endpoint: 'create',
  handler: 'createHandler',
  builder: 'namedWithType',
  params: {
    element_name: {
      required: true,
      type: 'string',
      mapTo: 'elementName',
      sources: ['params.element_name', 'params.name']
    },
    element_type: {
      required: true,
      type: 'string',
      sources: ['input.element_type', 'params.element_type']
    }
  }
}
```

### 2. Multi-Source Parameter Resolution

Parameters can come from multiple locations, resolved in order:

1. `input.element_type` - Top-level input object
2. `params.element_name` - Nested params object
3. Fallback sources for backward compatibility

The `SchemaDispatcher` handles resolution automatically.

### 3. Introspection-First Discovery

LLMs discover available operations via introspection rather than parsing tool schemas:

```json
// Query all operations
{ "operation": "introspect", "params": { "query": "operations" } }

// Query specific operation details
{ "operation": "introspect", "params": { "query": "operation", "name": "create_element" } }

// Query element type schemas
{ "operation": "introspect", "params": { "query": "type", "name": "persona" } }
```

### 4. Consistent Parameter Naming

All operations use snake_case for external parameters (Issue #290):
- `element_name` (not `name`)
- `element_type` (not `type` or `elementType`)

Internal handlers receive camelCase via `mapTo` transformation.

## Architecture Components

### Request Flow

```
LLM Request
    ↓
┌───────────────────┐
│   MCP Transport   │  (stdio/HTTP)
└─────────┬─────────┘
          ↓
┌───────────────────┐
│  MCPAQLHandler    │  Routes to correct endpoint
└─────────┬─────────┘
          ↓
┌───────────────────┐
│ SchemaDispatcher  │  Validates & normalizes input
└─────────┬─────────┘
          ↓
┌───────────────────┐
│ OperationSchema   │  Defines operation structure
└─────────┬─────────┘
          ↓
┌───────────────────┐
│  Handler Layer    │  Executes business logic
└─────────┬─────────┘
          ↓
┌───────────────────┐
│ Element Managers  │  Persona, Skill, Template, etc.
└───────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/handlers/mcp-aql/MCPAQLHandler.ts` | Main entry point, endpoint routing |
| `src/handlers/mcp-aql/OperationSchema.ts` | Declarative operation definitions |
| `src/handlers/mcp-aql/SchemaDispatcher.ts` | Parameter validation and normalization |
| `src/handlers/mcp-aql/IntrospectionResolver.ts` | Generates introspection responses |
| `src/handlers/mcp-aql/types.ts` | TypeScript type definitions |
| `src/server/tools/MCPAQLTools.ts` | Tool registration with examples |

### Endpoint Classification

Operations are classified by the CRUDE protocol (see [ADR-001](./ADR-001-CRUDE-PROTOCOL.md)):

| Endpoint | Safety Level | Operations |
|----------|--------------|------------|
| `mcp_aql_create` | Additive | create_element, import_element, activate_element, addEntry |
| `mcp_aql_read` | Safe | list_elements, get_element, search, introspect, render |
| `mcp_aql_update` | Modifying | edit_element |
| `mcp_aql_delete` | Destructive | delete_element, clear |
| `mcp_aql_execute` | Non-idempotent | execute_agent, get_execution_state |

## Adding New Operations

### Step 1: Define Schema

Add to `OperationSchema.ts`:

```typescript
my_new_operation: {
  endpoint: 'read',  // or create/update/delete/execute
  handler: 'myHandler',
  builder: 'simple',  // or namedWithType, namedOnly, etc.
  params: {
    my_param: {
      required: true,
      type: 'string',
      description: 'What this parameter does'
    }
  }
}
```

### Step 2: Implement Handler

Add handler function to the appropriate handler registry:

```typescript
async function myHandler(params: MyParams, registry: HandlerRegistry) {
  // Implementation
  return { success: true, data: result };
}
```

### Step 3: Update Introspection (Automatic)

The `IntrospectionResolver` automatically picks up new operations from the schema.

### Step 4: Add Tests

```typescript
describe('my_new_operation', () => {
  it('should perform expected action', async () => {
    const result = await handler.handle({
      operation: 'my_new_operation',
      params: { my_param: 'value' }
    });
    expect(result.success).toBe(true);
  });
});
```

## Security Considerations

### Path Validation

The `SchemaDispatcher` includes prototype pollution protection:

```typescript
const SAFE_PATH_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/;
const FORBIDDEN_PATHS = new Set(['__proto__', 'constructor', 'prototype']);
```

### Input Validation

All parameters are validated against their schema definitions:
- Type checking (string, number, boolean, array, object)
- Required field enforcement
- Unknown property warnings (for LLM feedback)

### YAML Parsing

Use `SecureYamlParser.parseRawYaml()` for any YAML content:
- Size limits enforced
- CORE_SCHEMA only (no custom types/code execution)
- Security event logging

## Token Efficiency

### Before MCP-AQL
- 50+ discrete tools registered
- Each tool: ~200-500 tokens for schema
- Total: ~15,000-25,000 tokens

### After MCP-AQL
- 5 CRUDE endpoints registered
- Each endpoint: ~150 tokens for schema
- Introspection: ~300 tokens when queried
- Total: ~1,000 tokens base + on-demand introspection

**Savings: ~96% reduction in tool registration tokens**

## Testing Strategy

### Unit Tests
- `OperationSchema.test.ts` - Schema validation
- `SchemaDispatcher.test.ts` - Parameter resolution, security
- `MCPAQLHandler.test.ts` - Endpoint routing

### Integration Tests
- `tests/integration/mcp-aql/` - Full operation flows

### Behavioral Tests
- Docker-based LLM integration tests
- Verify LLM uses correct parameter names
- Stream-json output capture for debugging

## Related Documentation

- [ADR-001: CRUDE Protocol](./ADR-001-CRUDE-PROTOCOL.md)
- [Gatekeeper Product Strategy](./GATEKEEPER_PRODUCT_STRATEGY.md)
- [Security Guide for Contributors](../security/CONTRIBUTOR-SECURITY-GUIDE.md)
- [API Reference](../reference/api-reference.md)
