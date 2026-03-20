# MCP-AQL Adapter Test Suite Specification

This document defines the test suite requirements for validating MCP-AQL adapters. Any adapter that wraps an MCP server to expose it via MCP-AQL endpoints must pass these tests.

## Overview

When converting a discrete MCP tool interface to MCP-AQL (unified CRUD endpoints), there are multiple failure modes:

| Failure Mode | Symptom | Root Cause |
|--------------|---------|------------|
| Missing introspection | LLM doesn't know param exists | OPERATION_PARAMETERS incomplete |
| Wrong examples | LLM uses wrong format | OPERATION_EXAMPLES incorrect |
| Dispatch gap | Param sent but not passed | Dispatch doesn't extract param |
| Type mismatch | Runtime errors | Type transformation missing |
| Required mismatch | LLM skips required param | Introspection marks optional incorrectly |

## Test Suite Structure

```
tests/
├── adapter-validation/
│   ├── introspection.test.ts      # Parameter documentation tests
│   ├── passthrough.test.ts        # Param dispatch tests
│   ├── type-coercion.test.ts      # Type transformation tests
│   ├── llm-behavior.test.ts       # LLM integration tests
│   └── round-trip.test.ts         # End-to-end tests
└── fixtures/
    └── adapter-test-server/       # Mock MCP server for testing
```

## Test Categories

### 1. Schema Completeness Tests

Verify the adapter documents all parameters from the original tool:

```typescript
import { describe, it, expect } from '@jest/globals';

describe('Schema Completeness', () => {
  // Load original MCP server tool definitions
  const originalTools = loadOriginalToolDefinitions();
  const adapter = createAdapter();

  describe('Parameter Coverage', () => {
    for (const tool of originalTools) {
      it(`should document all params for ${tool.name}`, async () => {
        const introspection = await adapter.introspect({
          query: 'operations',
          name: mapToolToOperation(tool.name)
        });

        const originalParams = Object.keys(tool.inputSchema.properties || {});
        const documentedParams = introspection.data.parameters.map(p => p.name);

        for (const param of originalParams) {
          expect(documentedParams).toContain(param);
        }
      });

      it(`should correctly mark required params for ${tool.name}`, async () => {
        const introspection = await adapter.introspect({
          query: 'operations',
          name: mapToolToOperation(tool.name)
        });

        const requiredInOriginal = tool.inputSchema.required || [];

        for (const param of introspection.data.parameters) {
          const shouldBeRequired = requiredInOriginal.includes(param.name);
          expect(param.required).toBe(shouldBeRequired);
        }
      });
    }
  });

  describe('Type Mapping', () => {
    it('should map JSON Schema types to MCP-AQL types', () => {
      const typeMappings = {
        'string': 'string',
        'number': 'number',
        'integer': 'number',
        'boolean': 'boolean',
        'array': 'array',
        'object': 'object',
      };

      for (const tool of originalTools) {
        const introspection = adapter.introspect({
          query: 'operations',
          name: mapToolToOperation(tool.name)
        });

        for (const [paramName, schema] of Object.entries(tool.inputSchema.properties || {})) {
          const documented = introspection.data.parameters.find(p => p.name === paramName);
          const expectedType = typeMappings[schema.type] || 'unknown';
          expect(documented?.type).toBe(expectedType);
        }
      }
    });
  });
});
```

### 2. Dispatch Passthrough Tests

Verify all parameters are passed to the underlying tool:

```typescript
describe('Dispatch Passthrough', () => {
  let mockServer: MockMcpServer;
  let adapter: McpAqlAdapter;

  beforeEach(() => {
    mockServer = createMockMcpServer();
    adapter = createAdapter(mockServer);
  });

  describe('CREATE operations', () => {
    it('should pass all params to underlying create tool', async () => {
      const params = {
        name: 'test-item',
        description: 'Test description',
        optional_field: 'optional value',
        nested: { key: 'value' }
      };

      await adapter.handleCreate({
        operation: 'create_item',
        params
      });

      expect(mockServer.lastCall).toEqual({
        tool: 'original_create_item',
        args: params
      });
    });

    it('should not drop optional params when provided', async () => {
      const params = {
        name: 'test',
        optional1: 'provided',
        optional2: 'also provided'
      };

      await adapter.handleCreate({
        operation: 'create_item',
        params
      });

      expect(mockServer.lastCall.args.optional1).toBe('provided');
      expect(mockServer.lastCall.args.optional2).toBe('also provided');
    });
  });

  describe('READ operations', () => {
    it('should pass filter params correctly', async () => {
      const params = {
        type: 'widget',
        status: 'active',
        limit: 10
      };

      await adapter.handleRead({
        operation: 'list_items',
        elementType: 'widget',
        params
      });

      expect(mockServer.lastCall.args).toMatchObject(params);
    });
  });

  // Similar tests for UPDATE and DELETE
});
```

### 3. Type Coercion Tests

Verify type transformations work correctly:

```typescript
describe('Type Coercion', () => {
  describe('Array handling', () => {
    it('should accept comma-separated string as array', async () => {
      await adapter.handleCreate({
        operation: 'create_with_tags',
        params: {
          name: 'test',
          tags: 'tag1, tag2, tag3'  // String format
        }
      });

      expect(mockServer.lastCall.args.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should accept array directly', async () => {
      await adapter.handleCreate({
        operation: 'create_with_tags',
        params: {
          name: 'test',
          tags: ['tag1', 'tag2', 'tag3']  // Array format
        }
      });

      expect(mockServer.lastCall.args.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });
  });

  describe('Boolean handling', () => {
    it('should coerce string "true" to boolean', async () => {
      await adapter.handleCreate({
        operation: 'create_with_flag',
        params: { name: 'test', enabled: 'true' }
      });

      expect(mockServer.lastCall.args.enabled).toBe(true);
    });
  });

  describe('Number handling', () => {
    it('should coerce numeric string to number', async () => {
      await adapter.handleRead({
        operation: 'list_items',
        params: { limit: '50' }
      });

      expect(mockServer.lastCall.args.limit).toBe(50);
    });
  });
});
```

### 4. LLM Behavior Tests

Test with actual LLM to verify discoverability:

```typescript
describe('LLM Behavior', () => {
  // These tests require API key and run against Docker
  const runLlmTest = process.env.RUN_LLM_TESTS === 'true';

  (runLlmTest ? describe : describe.skip)('Discovery', () => {
    it('should allow LLM to discover operation via introspection', async () => {
      const result = await runInDocker(
        'Use mcp_aql_read with introspect to list available operations'
      );

      expect(result).toMatch(/create_item|list_items|update_item|delete_item/);
    });

    it('should allow LLM to discover required params', async () => {
      const result = await runInDocker(
        'Use introspect to show parameters for create_item operation'
      );

      expect(result).toMatch(/name.*required|required.*name/i);
    });
  });

  (runLlmTest ? describe : describe.skip)('Execution', () => {
    it('should successfully create item with discovered params', async () => {
      const result = await runInDocker(
        'First introspect create_item to learn params, then create an item named "LLMTest"'
      );

      expect(result).toMatch(/created|success/i);
      expect(result).not.toMatch(/missing|required|error/i);
    });
  });
});
```

### 5. Round-Trip Tests

Verify data integrity through the adapter:

```typescript
describe('Round-Trip Validation', () => {
  it('should preserve all fields through create-read cycle', async () => {
    const originalData = {
      name: 'RoundTripTest',
      description: 'Testing data preservation',
      custom_field: 'custom value',
      metadata: {
        nested: { deeply: 'nested value' },
        tags: ['tag1', 'tag2']
      }
    };

    // Create
    const createResult = await adapter.handleCreate({
      operation: 'create_item',
      params: originalData
    });
    expect(createResult.success).toBe(true);

    // Read back
    const readResult = await adapter.handleRead({
      operation: 'get_item',
      params: { name: 'RoundTripTest' }
    });

    // Verify all fields preserved
    expect(readResult.data.name).toBe(originalData.name);
    expect(readResult.data.description).toBe(originalData.description);
    expect(readResult.data.custom_field).toBe(originalData.custom_field);
    expect(readResult.data.metadata.nested.deeply).toBe('nested value');
    expect(readResult.data.metadata.tags).toEqual(['tag1', 'tag2']);
  });

  it('should preserve fields through update cycle', async () => {
    // Create
    await adapter.handleCreate({
      operation: 'create_item',
      params: { name: 'UpdateTest', field1: 'original', field2: 'keep this' }
    });

    // Update one field
    await adapter.handleUpdate({
      operation: 'edit_item',
      params: { name: 'UpdateTest', field: 'field1', value: 'updated' }
    });

    // Verify other field preserved
    const result = await adapter.handleRead({
      operation: 'get_item',
      params: { name: 'UpdateTest' }
    });

    expect(result.data.field1).toBe('updated');
    expect(result.data.field2).toBe('keep this');  // Not overwritten
  });
});
```

## Running the Test Suite

### For DollhouseMCP Internal Testing

```bash
# Unit tests (no Docker/API needed)
npm run test:adapter-validation

# LLM behavior tests (requires Docker + API key)
RUN_LLM_TESTS=true npm run test:adapter-validation:llm
```

### For External Adapter Developers

```bash
# Install the test suite
npm install @dollhousemcp/adapter-test-suite

# Run against your adapter
npx mcp-aql-adapter-test \
  --adapter ./path/to/your/adapter.js \
  --original-server ./path/to/original/server.js
```

## Adapter Certification Checklist

Before an MCP-AQL adapter can be considered production-ready:

- [ ] All schema completeness tests pass
- [ ] All dispatch passthrough tests pass
- [ ] All type coercion tests pass (or N/A documented)
- [ ] LLM behavior tests pass (at least 1 model)
- [ ] Round-trip tests pass for all operations
- [ ] Documentation generated for all operations
- [ ] Error messages are LLM-friendly

## Common Issues and Solutions

### Issue: LLM sends param but operation fails with "missing param"

**Check**: Dispatch passthrough
```typescript
// In adapter dispatch, ensure ALL params extracted:
case 'my_operation':
  return handler.myOperation({
    ...params,  // Don't forget to spread!
    // OR explicitly list all:
    name: params.name,
    field1: params.field1,
    field2: params.field2,  // <- Was this line missing?
  });
```

### Issue: LLM doesn't include required param in call

**Check**: Introspection
```typescript
// Verify OPERATION_PARAMETERS includes the param:
my_operation: [
  { name: 'name', required: true, ... },
  { name: 'missing_param', required: true, ... },  // <- Was this missing?
]
```

### Issue: Param arrives but wrong type

**Check**: Type coercion
```typescript
// Add type transformation in dispatch:
const myArray = typeof params.items === 'string'
  ? params.items.split(',').map(s => s.trim())
  : params.items;
```

---

*Specification created to support MCP-AQL adapter ecosystem development.*
