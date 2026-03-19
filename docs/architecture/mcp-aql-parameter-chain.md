# MCP-AQL Parameter Chain Architecture

This document describes the complete chain of components that must be updated when adding, modifying, or mapping parameters in MCP-AQL operations. Understanding this chain is critical for:

1. Adding new parameters to existing DollhouseMCP operations
2. Creating MCP-AQL adapters for external MCP servers
3. Debugging parameter-related failures in LLM tool calls

## The Problem We Solved

When behavior tests showed LLMs couldn't create personas (missing `instructions` parameter), we discovered **5 separate layers** needed updates. The parameter existed in the underlying PersonaManager but wasn't exposed through the MCP-AQL chain.

## End-to-End Parameter Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LLM CONTEXT                                        │
│  Tool descriptions and parameter schemas visible to the LLM                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. TOOL DESCRIPTIONS (MCPAQLTools.ts)                                      │
│     - Quick start examples in tool description                               │
│     - Basic parameter hints                                                  │
│     - LLM reads this FIRST to understand capabilities                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. INTROSPECTION (IntrospectionResolver.ts)                                │
│     - OPERATION_PARAMETERS: Detailed param definitions                       │
│     - OPERATION_EXAMPLES: Working code examples                              │
│     - LLM queries this to discover required/optional params                  │
│     ⚠️  CRITICAL: If param missing here, LLM won't know to send it          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3. DISPATCH (MCPAQLHandler.ts → dispatchElementCRUD)                       │
│     - Extracts params from OperationInput                                    │
│     - Maps params to handler method arguments                                │
│     ⚠️  CRITICAL: Must explicitly pass each param to handler                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  4. HANDLER INTERFACE (ElementCRUDHandler.ts)                               │
│     - TypeScript interface for createElement/editElement/etc                 │
│     - Type safety for param passing                                          │
│     ⚠️  CRITICAL: Interface must include param or TypeScript errors         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  5. IMPLEMENTATION (createElement.ts, PersonaManager.ts, etc)               │
│     - CreateElementArgs interface                                            │
│     - Actual business logic using the parameter                              │
│     - Validation, transformation, persistence                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Files to Update (Checklist)

When adding a new parameter to an MCP-AQL operation:

### Required Updates

| Layer | File | What to Update |
|-------|------|----------------|
| 1. Tool Description | `src/server/tools/MCPAQLTools.ts` | Quick start examples (if prominent param) |
| 2. Introspection | `src/handlers/mcp-aql/IntrospectionResolver.ts` | `OPERATION_PARAMETERS[operation]` array |
| 2. Introspection | `src/handlers/mcp-aql/IntrospectionResolver.ts` | `OPERATION_EXAMPLES[operation]` array |
| 3. Dispatch | `src/handlers/mcp-aql/MCPAQLHandler.ts` | `dispatchElementCRUD()` or relevant dispatch method |
| 4. Handler Interface | `src/handlers/ElementCRUDHandler.ts` | Method signature type annotation |
| 5. Implementation | `src/handlers/element-crud/createElement.ts` | `CreateElementArgs` interface + destructuring |

### Example: Adding `instructions` Parameter

**IntrospectionResolver.ts** - OPERATION_PARAMETERS:
```typescript
create_element: [
  { name: 'name', type: 'string', required: true, description: 'Element name' },
  { name: 'type', type: 'ElementType', required: true, description: 'Element type' },
  { name: 'description', type: 'string', required: true, description: 'Element description' },
  // NEW: Added instructions parameter
  { name: 'instructions', type: 'string', required: true, description: 'Behavioral instructions (REQUIRED for personas)' },
  { name: 'content', type: 'string', required: false, description: 'Element content' },
  { name: 'metadata', type: 'object', required: false, description: 'Additional metadata' },
],
```

**IntrospectionResolver.ts** - OPERATION_EXAMPLES:
```typescript
create_element: [
  // Example MUST include the new parameter
  '{ operation: "create_element", elementType: "persona", params: { name: "My Persona", description: "A helpful assistant", instructions: "You are helpful..." } }',
],
```

**MCPAQLHandler.ts** - dispatchElementCRUD:
```typescript
case 'create':
  return handler.createElement({
    name: p.name as string,
    type: elementType || (p.type as string),
    description: p.description as string,
    content: p.content as string | undefined,
    instructions: p.instructions as string | undefined,  // NEW: Pass through
    metadata: p.metadata as Record<string, unknown> | undefined,
  });
```

**ElementCRUDHandler.ts** - Method signature:
```typescript
async createElement(args: {
  name: string;
  type: string;
  description: string;
  content?: string;
  instructions?: string;  // NEW: Add to interface
  metadata?: Record<string, any>;
})
```

**createElement.ts** - Interface and destructuring:
```typescript
export interface CreateElementArgs {
  name: string;
  type: string;
  description: string;
  content?: string;
  instructions?: string;  // NEW: Add to interface
  metadata?: Record<string, any>;
}

// In function:
const { name, type, description, content, instructions, metadata } = args;
```

## MCP-AQL Adapter Implications

When creating an MCP-AQL adapter for an external MCP server, you must:

### 1. Generate Complete Introspection Data

The adapter generator must analyze each tool's inputSchema and produce:

```typescript
// For each tool being adapted:
OPERATION_PARAMETERS['tool_name'] = inputSchema.properties.map(prop => ({
  name: prop.name,
  type: mapJsonSchemaType(prop.type),
  required: inputSchema.required.includes(prop.name),
  description: prop.description || `Parameter: ${prop.name}`,
}));
```

### 2. Generate Accurate Examples

Examples are **critical** for LLM understanding:

```typescript
OPERATION_EXAMPLES['tool_name'] = [
  generateExampleFromSchema(inputSchema),
];
```

### 3. Generate Complete Dispatch Logic

The dispatch must pass ALL parameters:

```typescript
// Auto-generated dispatch for adapted tool
case 'adapted_tool':
  return originalMcpServer.callTool('original_tool_name', {
    // ALL params from inputSchema must be mapped here
    ...params
  });
```

### 4. Handle Type Transformations

Some parameters may need transformation between MCP-AQL format and the target tool:

```typescript
// Example: Array params might come as comma-separated strings
const tags = typeof p.tags === 'string'
  ? p.tags.split(',').map(t => t.trim())
  : p.tags;
```

## MCP-AQL Adapter Test Suite Requirements

An adapter test suite must verify:

### 1. Introspection Completeness

```typescript
describe('Introspection Coverage', () => {
  it('should document all parameters from original tool schema', () => {
    for (const tool of originalTools) {
      const introspection = adapter.introspect({ query: 'operations', name: tool.name });
      const originalParams = Object.keys(tool.inputSchema.properties);
      const documentedParams = introspection.parameters.map(p => p.name);

      expect(documentedParams).toEqual(expect.arrayContaining(originalParams));
    }
  });

  it('should mark required parameters correctly', () => {
    // Verify required flags match original schema
  });
});
```

### 2. Parameter Passthrough

```typescript
describe('Parameter Passthrough', () => {
  it('should pass all parameters to underlying tool', async () => {
    const mockServer = createMockMcpServer();
    const adapter = createAdapter(mockServer);

    await adapter.handleCreate({
      operation: 'create_something',
      params: { name: 'test', required_param: 'value', optional_param: 'other' }
    });

    expect(mockServer.callTool).toHaveBeenCalledWith('create_something', {
      name: 'test',
      required_param: 'value',
      optional_param: 'other'
    });
  });
});
```

### 3. LLM Behavior Tests

```typescript
describe('LLM Behavior', () => {
  it('should allow LLM to discover and use all parameters', async () => {
    // 1. LLM introspects the operation
    const introspection = await llmCall('What parameters does create_something need?');

    // 2. Verify LLM includes all required params in its call
    const result = await llmCall('Create something with name "test"');

    // 3. Verify the call succeeded (not missing params error)
    expect(result).not.toContain('missing');
    expect(result).not.toContain('required');
  });
});
```

### 4. Round-Trip Validation

```typescript
describe('Round-Trip', () => {
  it('should create and retrieve element with all fields intact', async () => {
    const created = await adapter.handleCreate({
      operation: 'create_element',
      params: { name: 'Test', description: 'Desc', custom_field: 'value' }
    });

    const retrieved = await adapter.handleRead({
      operation: 'get_element',
      params: { name: 'Test' }
    });

    expect(retrieved.data.custom_field).toBe('value');
  });
});
```

## Debugging Parameter Issues

When LLM fails with "missing parameter" or similar:

1. **Check Introspection First**
   ```bash
   # In behavior test, ask LLM to introspect
   "Use introspect to show parameters for create_element"
   ```

2. **Verify Dispatch Passthrough**
   - Add logging in `dispatchElementCRUD` to see what params arrive
   - Check if param is being passed to handler

3. **Check Interface Alignment**
   - TypeScript will error if dispatch passes param not in interface
   - But runtime issues occur if interface has param but dispatch doesn't pass it

4. **Test with Verbose Mode**
   ```bash
   MCP_AQL_VERBOSE=true ./tests/scripts/docker/mcp-aql-behavior-tests.sh
   ```

## Parameter Precedence Rules

When multiple parameters can serve similar purposes, establish clear precedence rules and document them for LLMs and developers.

### Example: Persona Instructions

For persona creation, behavioral instructions can come from two parameters:

| Parameter | Purpose | Precedence |
|-----------|---------|------------|
| `instructions` | Dedicated field for persona behavioral instructions | **Primary** (preferred) |
| `content` | Generic content field used by other element types | Fallback |

**Implementation** (`createElement.ts`):
```typescript
// Parameter precedence: instructions > content > empty string
if (instructions && content && instructions !== content) {
  logger.warn(
    `Both 'instructions' and 'content' provided for persona. ` +
    `Using 'instructions' (preferred).`
  );
}
const personaInstructions = instructions ?? content ?? '';
```

### Why Precedence Matters

1. **Backward Compatibility**: Old code using `content` still works
2. **Forward Clarity**: New code should use `instructions` for personas
3. **LLM Guidance**: Introspection marks `instructions` as required, guiding LLMs to use it
4. **Debugging**: Warning log helps identify mixed-usage issues

### Adapter Considerations

When creating MCP-AQL adapters, document parameter precedence:

```typescript
// In IntrospectionResolver or adapter config
PARAMETER_PRECEDENCE: {
  create_element: {
    persona: {
      // When both provided, which wins?
      instructions: { precedence: 1, preferred: true },
      content: { precedence: 2, fallback: true },
    }
  }
}
```

### Anti-Pattern: Silent Override

**Don't** silently use one parameter and ignore another:

```typescript
// ❌ Bad: Silent override, confusing behavior
const value = paramA || paramB;
```

**Do** log when precedence is applied:

```typescript
// ✅ Good: Warn on ambiguous input
if (paramA && paramB && paramA !== paramB) {
  logger.warn(`Both paramA and paramB provided. Using paramA (preferred).`);
}
const value = paramA ?? paramB;
```

## Related Documentation

- [MCP-AQL Architecture](./mcp-aql-architecture.md)
- [Behavior Test Suite](../testing/mcp-aql-behavior-tests.md)
- [Adapter Generator Design](./mcp-aql-adapter-generator.md) (TODO)
- [jsdom Version Strategy](./jsdom-version-strategy.md)

---

*Document created after fixing Issue #240 - behavior test failures due to missing `instructions` parameter passthrough.*
