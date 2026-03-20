# Operation Development Guide

Standard for creating new MCP-AQL operations. Every operation must have a schema entry so it is discoverable via `introspect`.

## Required: Schema Entry in OperationSchema.ts

Every new operation **MUST** have a schema definition in `src/handlers/mcp-aql/OperationSchema.ts`.

### Required Schema Fields

| Field | Purpose |
|-------|---------|
| `endpoint` | CRUDE endpoint: `CREATE`, `READ`, `UPDATE`, `DELETE`, or `EXECUTE` |
| `handler` | `HandlerKey` value (e.g. `'elementCRUD'`, `'mcpAqlHandler'`) |
| `method` | Method name on the handler |
| `description` | Human-readable description of what the operation does |
| `params` | Parameter definitions with types, required flags, and descriptions |
| `returns` | Return type with `name`, `kind`, and `description` including response shape hints |
| `examples` | At least one usage example with a `// Response:` comment |

### Example Schema Entry

```typescript
myOperation: {
  endpoint: 'READ',
  handler: 'myHandler',
  method: 'handleMyOperation',
  description: 'Describe what this operation does',
  params: {
    element_name: { type: 'string', required: true, description: 'Element name' },
    verbose: { type: 'boolean', description: 'Include verbose output' },
  },
  returns: {
    name: 'MyResult',
    kind: 'object',
    description: 'Result shape: { field1, field2, details? }',
  },
  examples: [
    '{ operation: "myOperation", params: { element_name: "test" } }',
    // Response: { field1: "value", field2: 42 }
  ],
},
```

## Schema Placement: Dispatch vs Introspection-Only

### SCHEMA_DRIVEN_OPERATIONS

Add here if the operation can be dispatched through `SchemaDispatcher`:
- Simple handler delegation (no complex pre-processing)
- Parameter mapping handled by schema `mapTo` / `sources`

### INTROSPECTION_ONLY_SCHEMAS

Add here if the operation requires custom dispatch logic:
- Memory operations (instance lookup by name)
- Execution operations (agent state management, autonomy evaluation)
- Gatekeeper operations (session confirmation tracking)
- Any operation with pre-processing that can't be expressed in schema

Both categories provide identical introspection quality via `ALL_OPERATION_SCHEMAS`.

## Checklist

1. Add schema entry to appropriate block in `OperationSchema.ts`
2. Add route entry in `OperationRouter.ts` with description
3. Add gatekeeper policy in `OperationPolicies.ts`
4. Register in `HandlerRegistry` if using a new handler
5. Verify via `introspect`: `{ operation: "introspect", params: { query: "operations", name: "myOperation" } }`
6. Update tool descriptions in `MCPAQLTools.ts` if the operation should be highlighted

## References

- `src/handlers/mcp-aql/OperationSchema.ts` - Schema definitions
- `src/handlers/mcp-aql/OperationRouter.ts` - Route table
- `src/handlers/mcp-aql/IntrospectionResolver.ts` - Introspection engine
- Issue #594 - Introspection-only schema architecture
- Issue #596 - Full SchemaDispatcher migration for introspection-only operations
