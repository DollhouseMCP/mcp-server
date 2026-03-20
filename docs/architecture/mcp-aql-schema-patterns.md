# MCP-AQL Schema Patterns

> **Reference Guide for Schema-Driven Operation Definitions**

This document catalogs the schema patterns discovered during MCP-AQL development. These patterns inform the MCP-AQL Adapter Spec for external MCP servers.

## Table of Contents

1. [Basic Schema Structure](#basic-schema-structure)
2. [Parameter Handling Patterns](#parameter-handling-patterns)
3. [Argument Building Patterns](#argument-building-patterns)
4. [Handler Patterns](#handler-patterns)
5. [Validation Patterns](#validation-patterns)
6. [Introspection Integration](#introspection-integration)
7. [Troubleshooting](#troubleshooting)

---

## Basic Schema Structure

Every schema-driven operation follows this structure:

```typescript
interface OperationDef {
  // CRUDE endpoint (CREATE, READ, UPDATE, DELETE, EXECUTE)
  endpoint: CRUDEndpoint;

  // Handler key in the registry
  handler: HandlerKey;

  // Method name to call on the handler
  method: string;

  // Parameter definitions
  params?: ParamSchema;

  // Human-readable description
  description: string;

  // Whether the handler is optional
  optional?: boolean;

  // How to build method arguments
  argBuilder?: 'single' | 'spread' | 'named' | 'namedWithType' | 'typeWithParams';

  // Whether operation needs full OperationInput for source resolution
  needsFullInput?: boolean;

  // Bulk parameter name conversion style
  paramStyle?: 'snakeToCamel';

  // Return type for introspection
  returns?: ReturnTypeDef;

  // Usage examples for introspection
  examples?: string[];
}
```

### Example: Simple Operation

```typescript
search_collection: {
  endpoint: 'READ',
  handler: 'collectionHandler',
  method: 'searchCollection',
  description: 'Search the community collection',
  optional: true,
  params: {
    query: { type: 'string', required: true, description: 'Search query' },
  },
  returns: { name: 'SearchResult', kind: 'object', description: 'Matching elements' },
  examples: ['{ operation: "search_collection", params: { query: "code review" } }'],
}
```

---

## Parameter Handling Patterns

### Pattern 1: Simple Parameters

Direct pass-through of parameters in schema order.

```typescript
// Schema
params: {
  query: { type: 'string', required: true },
}

// Usage: params passed in order
handler.searchCollection(params.query)
```

**When to use:** Simple operations with few parameters.

### Pattern 2: Parameter Mapping (mapTo)

Rename parameters during dispatch (e.g., snake_case API to camelCase internal).

```typescript
// Schema definition with mapTo for renaming
params: {
  element_name: { type: 'string', required: true, mapTo: 'elementName' },  // API name → handler name
  element_type: { type: 'string', mapTo: 'elementType' },                   // snake_case → camelCase
}

// Input from API: { element_name: 'test', element_type: 'persona' }
// Mapped result:  { elementName: 'test', elementType: 'persona' }
```

**When to use:** External API uses different naming than internal handlers.

### Pattern 3: Multi-Source Parameters (sources)

Resolve a parameter from multiple possible locations.

> **Note:** This pattern is implemented in Issue #251.

```typescript
// Schema with multi-source resolution
params: {
  type: {
    type: 'string',
    required: true,
    sources: ['input.elementType', 'params.type'],  // Check in order, use first defined
  },
}

// Resolution order:
// 1. Check input.elementType (from OperationInput)
// 2. Check params.type (from user params)
// 3. If neither found and required, throw error with sources checked
```

**When to use:** Same parameter can be provided at different levels (top-level vs params).

### Pattern 4: Style Conversion (paramStyle)

Bulk conversion of parameter names.

> **Note:** This pattern is implemented in Issue #252.

```typescript
// Schema with automatic style conversion
paramStyle: 'snakeToCamel',  // Applies to all params without explicit mapTo
params: {
  element_name: { type: 'string' },   // Converted: element_name → elementName
  target_path: { type: 'string' },    // Converted: target_path → targetPath
  type: { type: 'string', mapTo: 'elementType' },  // mapTo takes precedence over style
}

// Input:  { element_name: 'test', target_path: '/foo', type: 'persona' }
// Result: { elementName: 'test', targetPath: '/foo', elementType: 'persona' }
```

**When to use:** Handler uses camelCase but API uses snake_case consistently.

### Pattern 5: Default Values

Provide fallback values for optional parameters.

```typescript
// Schema with default values for optional params
params: {
  query: { type: 'string', required: true },        // Must be provided
  limit: { type: 'number', default: 20 },           // Optional, defaults to 20
  threshold: { type: 'number', default: 0.5 },      // Optional, defaults to 0.5
  include_metadata: { type: 'boolean', default: false },
}

// Input:  { query: 'test' }
// Result: { query: 'test', limit: 20, threshold: 0.5, include_metadata: false }
```

**When to use:** Optional parameters with sensible defaults.

---

## Argument Building Patterns

The `argBuilder` field controls how parameters are passed to handlers.

### Pattern: single (default)

Pass parameters in schema order as separate arguments.

```typescript
// Schema
argBuilder: 'single',  // or omit (default)
params: {
  name: { type: 'string' },
  variables: { type: 'object' },
}

// Call: handler.method(name, variables)
```

**When to use:** Handlers with ordered positional arguments.

### Pattern: spread

Pass query separately, then full params object.

```typescript
// Schema
argBuilder: 'spread',
params: {
  query: { type: 'string', required: true },
  limit: { type: 'number' },
}

// Call: handler.method(query, { query, limit })
```

**When to use:** Handlers that take `(query, options)` pattern.

### Pattern: named

Pass all mapped parameters as a single named object.

```typescript
// Schema
argBuilder: 'named',
params: {
  element_name: { type: 'string', mapTo: 'elementName' },
  limit: { type: 'number', default: 10 },
}

// Call: handler.method({ elementName, limit })
```

**When to use:** Handlers expecting a single config/options object.

### Pattern: namedWithType

Like `named`, but ensures `type` is included from resolved sources.

```typescript
// Schema
argBuilder: 'namedWithType',
needsFullInput: true,
params: {
  name: { type: 'string', required: true },
  type: { type: 'string', required: true, sources: ['input.elementType', 'params.type'] },
  field: { type: 'string', required: true },
  value: { type: 'unknown' },
}

// Call: handler.method({ name, type, field, value })
// type resolved from input.elementType or params.type
```

**When to use:** ElementCRUD operations where type comes from multiple sources.

### Pattern: typeWithParams

Pass resolved type as first argument, then full params object.

```typescript
// Schema
argBuilder: 'typeWithParams',
needsFullInput: true,
params: {
  type: { type: 'string', required: true, sources: ['input.elementType', 'params.type'] },
}

// Call: handler.method(resolvedType, fullParams)
```

**When to use:** Handlers like `listElements(type, paginationParams)`.

---

## Handler Patterns

### Pattern: Optional Handlers

Some handlers may not be configured in all environments.

```typescript
// Schema
optional: true,
handler: 'collectionHandler',

// Error if not configured:
// "CollectionHandler operations not available: collectionHandler not configured"
```

**When to use:** Features that require optional dependencies (GitHub, OAuth, etc.).

### Pattern: Special Methods

Internal operations that bypass normal dispatch.

```typescript
// Schema
method: '__introspect__',  // Calls IntrospectionResolver directly
method: '__buildInfo__',   // Special build info formatting
```

**When to use:** Operations that need special handling not suited to normal dispatch.

---

## Validation Patterns

### Required Parameter Validation

Parameters marked `required: true` must be present.

```typescript
params: {
  query: { type: 'string', required: true },
}

// Error: "Missing required parameter 'query' for operation 'search_collection'"
```

### Type Validation

> **Note:** This pattern is implemented in Issue #255.

Parameters are validated against their type definition.

```typescript
params: {
  limit: { type: 'number' },
  tags: { type: 'string[]' },
}

// Error: "Parameter 'limit' for operation 'search' must be a number, got string"
// Error: "Parameter 'tags[1]' for operation 'search' must be a string, got number"
```

**Supported types:**
- `string` - Must be typeof string
- `number` - Must be typeof number, not NaN
- `boolean` - Must be typeof boolean
- `object` - Must be plain object (not null, not array)
- `array` - Must be Array.isArray()
- `string[]` - Array where all elements are strings
- `unknown` - Any type allowed (no validation)

---

## Introspection Integration

> **Note:** This pattern is implemented in Issue #254.

Schema definitions serve as the source of truth for introspection.

### Return Types

```typescript
returns: {
  name: 'SearchResult',
  kind: 'object',
  description: 'Matching elements from collection',
}
```

### Examples

```typescript
examples: [
  '{ operation: "search_collection", params: { query: "code review" } }',
  '{ operation: "search_collection", params: { query: "persona", limit: 5 } }',
]
```

### Automatic Parameter Info

Parameters are automatically converted for introspection:

```typescript
// Schema params
{ query: { type: 'string', required: true, description: 'Search query' } }

// Becomes ParameterInfo
{ name: 'query', type: 'string', required: true, description: 'Search query' }
```

---

## Troubleshooting

### Common Issues

#### "No schema definition found for operation"

```
Error: No schema definition found for operation 'my_custom_operation'
```

The operation isn't registered in `SCHEMA_DRIVEN_OPERATIONS`.

**Solution:** Add the operation to the appropriate operations group in `OperationSchema.ts`.

#### "Missing required parameter"

```
Error: Missing required parameter 'type' for operation 'create_element'.
Sources checked (in order): [input.elementType → params.type] → params.type.
Provided params: {name, description}. input.elementType: undefined
```

A required parameter wasn't provided and couldn't be resolved from any source.

**Solution:** Provide the parameter either at the top level (`elementType`) or in params (`params.type`).

#### "Handler not available"

```
Error: CollectionHandler operations not available: collectionHandler not configured.
This is an optional handler that may not be available in all configurations.
```

An optional handler isn't configured in the registry.

**Solution:** Either configure the handler in the DI container or handle the feature being unavailable gracefully.

#### Type validation errors

```
// String type mismatch
Error: Parameter 'query' for operation 'search_collection' must be a string, got number

// Number type mismatch (including NaN)
Error: Parameter 'limit' for operation 'find_similar_elements' must be a number, got string

// Array element type mismatch
Error: Parameter 'tags[2]' for operation 'search' must be a string, got number

// Object type mismatch (null, array rejected)
Error: Parameter 'variables' for operation 'render' must be an object, got null
```

A parameter was passed with the wrong type.

**Solution:** Ensure parameters match their schema type definitions. Use `unknown` type for params that accept any type.

#### Method not found on handler

```
Error: Method 'searchItems' not found on handler 'collectionHandler' for operation 'search_collection'.
Available methods: [browseCollection, searchCollection, getContent]
```

The schema references a method that doesn't exist on the handler.

**Solution:** Verify the `method` field matches an actual method name on the handler class.

### Debugging Tips

1. **Check canDispatch()** - Verify the operation is schema-driven:
   ```typescript
   SchemaDispatcher.canDispatch('my_operation') // true if schema-driven
   ```

2. **Review the schema** - Inspect operation definition:
   ```typescript
   const schema = getOperationSchema('my_operation');
   console.log(schema.params, schema.argBuilder);
   ```

3. **Check handler registry** - Verify required handlers are configured:
   ```typescript
   console.log(Object.keys(registry)); // List available handlers
   ```

4. **Validate params first** - Type errors are caught before handler dispatch, check error message for specifics

---

## Related Documentation

- [MCP-AQL Executive Summary](./MCP_AQL_EXECUTIVE_SUMMARY.md) - High-level overview
- [MCP-AQL Token Economics](./MCP_AQL_TOKEN_ECONOMICS_RESEARCH.md) - Context efficiency analysis
- [Overview](./overview.md) - Architecture overview

## Related Issues

- #247 - Schema-driven operation definitions (infrastructure)
- #251 - Input normalization pattern (`sources`)
- #252 - Complex param mapping pattern (`paramStyle`)
- #254 - Introspection from schema (`returns`, `examples`)
- #255 - Runtime type validation
- #256 - This documentation
