/**
 * Unit tests for IntrospectionResolver
 *
 * Tests the GraphQL-style introspection capabilities for MCP-AQL
 * that enable LLMs to discover available operations and types.
 */

import { describe, it, expect } from '@jest/globals';
import { IntrospectionResolver } from '../../../../src/handlers/mcp-aql/IntrospectionResolver.js';
import { getOperationSchema, getAnyOperationSchema } from '../../../../src/handlers/mcp-aql/OperationSchema.js';

describe('IntrospectionResolver', () => {
  describe('resolve()', () => {
    describe('operations query', () => {
      it('should list all operations when query is "operations" with no name', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });

        expect(result.operations).toBeDefined();
        expect(Array.isArray(result.operations)).toBe(true);
        expect(result.operations!.length).toBeGreaterThan(0);

        // Verify each operation has required fields
        for (const op of result.operations!) {
          expect(op).toHaveProperty('name');
          expect(op).toHaveProperty('endpoint');
          expect(op).toHaveProperty('description');
          expect(typeof op.name).toBe('string');
          expect(['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE']).toContain(op.endpoint);
        }
      });

      it('should default to "operations" query when no query specified', () => {
        const result = IntrospectionResolver.resolve({});

        expect(result.operations).toBeDefined();
        expect(Array.isArray(result.operations)).toBe(true);
      });

      it('should include core CRUD operations', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });
        const operationNames = result.operations!.map((op) => op.name);

        // CREATE operations
        expect(operationNames).toContain('create_element');
        expect(operationNames).toContain('import_element');
        expect(operationNames).toContain('addEntry');

        // READ operations
        expect(operationNames).toContain('activate_element');
        expect(operationNames).toContain('list_elements');
        expect(operationNames).toContain('get_element');
        expect(operationNames).toContain('search_elements');
        expect(operationNames).toContain('validate_element');
        expect(operationNames).toContain('introspect');

        // UPDATE operations
        expect(operationNames).toContain('edit_element');

        // DELETE operations
        expect(operationNames).toContain('delete_element');
        expect(operationNames).toContain('execute_agent');
        expect(operationNames).toContain('clear');
      });

      it('should sort operations by endpoint then name', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });
        const ops = result.operations!;

        // Find index boundaries for each endpoint
        const createOps = ops.filter((o) => o.endpoint === 'CREATE');
        const readOps = ops.filter((o) => o.endpoint === 'READ');
        const updateOps = ops.filter((o) => o.endpoint === 'UPDATE');
        const deleteOps = ops.filter((o) => o.endpoint === 'DELETE');

        // Verify CREATE comes before READ
        const lastCreateIndex = ops.findIndex(
          (o) => o.name === createOps[createOps.length - 1].name
        );
        const firstReadIndex = ops.findIndex((o) => o.name === readOps[0].name);
        expect(lastCreateIndex).toBeLessThan(firstReadIndex);

        // Verify READ comes before UPDATE
        const lastReadIndex = ops.findIndex(
          (o) => o.name === readOps[readOps.length - 1].name
        );
        const firstUpdateIndex = ops.findIndex(
          (o) => o.name === updateOps[0].name
        );
        expect(lastReadIndex).toBeLessThan(firstUpdateIndex);

        // Verify UPDATE comes before DELETE
        const lastUpdateIndex = ops.findIndex(
          (o) => o.name === updateOps[updateOps.length - 1].name
        );
        const firstDeleteIndex = ops.findIndex(
          (o) => o.name === deleteOps[0].name
        );
        expect(lastUpdateIndex).toBeLessThan(firstDeleteIndex);
      });
    });

    describe('operation(name) query', () => {
      it('should return operation details for a valid operation name', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'create_element',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation).not.toBeNull();
        expect(result.operation!.name).toBe('create_element');
        expect(result.operation!.endpoint).toBe('CREATE');
        expect(result.operation!.mcpTool).toBe('mcp_aql_create');
      });

      it('should include parameters for operation details', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'create_element',
        });

        const op = result.operation!;
        expect(op.parameters).toBeDefined();
        expect(Array.isArray(op.parameters)).toBe(true);
        expect(op.parameters.length).toBeGreaterThan(0);

        // Check parameter structure (uses new element_name convention per Issue #290)
        const nameParam = op.parameters.find((p) => p.name === 'element_name');
        expect(nameParam).toBeDefined();
        expect(nameParam!.type).toBe('string');
        expect(nameParam!.required).toBe(true);
        expect(nameParam!.description).toBeDefined();
      });

      it('should include permissions for operation details', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'list_elements',
        });

        const op = result.operation!;
        expect(op.permissions).toBeDefined();
        expect(op.permissions.readOnly).toBe(true);
        expect(op.permissions.destructive).toBe(false);
      });

      it('should include examples for operation details', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'create_element',
        });

        const op = result.operation!;
        expect(op.examples).toBeDefined();
        expect(Array.isArray(op.examples)).toBe(true);
        expect(op.examples.length).toBeGreaterThan(0);
      });

      it('should return null for unknown operation', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'nonexistent_operation',
        });

        expect(result.operation).toBeNull();
      });

      it('should return introspect operation details', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'introspect',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.name).toBe('introspect');
        expect(result.operation!.endpoint).toBe('READ');
        expect(result.operation!.mcpTool).toBe('mcp_aql_read');
        expect(result.operation!.parameters).toBeDefined();
      });
    });

    describe('types query', () => {
      it('should list all types when query is "types" with no name', () => {
        const result = IntrospectionResolver.resolve({ query: 'types' });

        expect(result.types).toBeDefined();
        expect(Array.isArray(result.types)).toBe(true);
        expect(result.types!.length).toBeGreaterThan(0);

        // Verify each type has required fields
        for (const type of result.types!) {
          expect(type).toHaveProperty('name');
          expect(type).toHaveProperty('kind');
          expect(['enum', 'object', 'scalar', 'union']).toContain(type.kind);
        }
      });

      it('should include core types', () => {
        const result = IntrospectionResolver.resolve({ query: 'types' });
        const typeNames = result.types!.map((t) => t.name);

        expect(typeNames).toContain('ElementType');
        expect(typeNames).toContain('CRUDEndpoint');
        expect(typeNames).toContain('OperationInput');
        expect(typeNames).toContain('OperationResult');
        expect(typeNames).toContain('EndpointPermissions');
      });
    });

    describe('type(name) query', () => {
      it('should return type details for ElementType enum', () => {
        const result = IntrospectionResolver.resolve({
          query: 'types',
          name: 'ElementType',
        });

        expect(result.type).toBeDefined();
        expect(result.type!.name).toBe('ElementType');
        expect(result.type!.kind).toBe('enum');
        expect(result.type!.values).toBeDefined();
        expect(result.type!.values).toContain('persona');
        expect(result.type!.values).toContain('skill');
        expect(result.type!.values).toContain('template');
        expect(result.type!.values).toContain('agent');
        expect(result.type!.values).toContain('memory');
        expect(result.type!.values).toContain('ensemble');
      });

      it('should return type details for CRUDEndpoint enum', () => {
        const result = IntrospectionResolver.resolve({
          query: 'types',
          name: 'CRUDEndpoint',
        });

        expect(result.type).toBeDefined();
        expect(result.type!.kind).toBe('enum');
        expect(result.type!.values).toEqual(['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE']);
      });

      it('should return type details for OperationInput object', () => {
        const result = IntrospectionResolver.resolve({
          query: 'types',
          name: 'OperationInput',
        });

        expect(result.type).toBeDefined();
        expect(result.type!.kind).toBe('object');
        expect(result.type!.fields).toBeDefined();

        const operationField = result.type!.fields!.find(
          (f) => f.name === 'operation'
        );
        expect(operationField).toBeDefined();
        expect(operationField!.required).toBe(true);
      });

      it('should return type details for union type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'types',
          name: 'OperationResult',
        });

        expect(result.type).toBeDefined();
        expect(result.type!.kind).toBe('union');
        expect(result.type!.members).toBeDefined();
        expect(result.type!.members).toContain('OperationSuccess');
        expect(result.type!.members).toContain('OperationFailure');
      });

      it('should return null for unknown type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'types',
          name: 'NonexistentType',
        });

        expect(result.type).toBeNull();
      });
    });

    describe('unknown query', () => {
      it('should return empty result for unknown query type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'invalid_query',
        });

        expect(result).toEqual({});
      });
    });
  });

  describe('getOperationsByEndpoint()', () => {
    it('should return operations grouped by endpoint', () => {
      const grouped = IntrospectionResolver.getOperationsByEndpoint();

      expect(grouped).toHaveProperty('CREATE');
      expect(grouped).toHaveProperty('READ');
      expect(grouped).toHaveProperty('UPDATE');
      expect(grouped).toHaveProperty('DELETE');

      // Verify CREATE operations
      const createNames = grouped.CREATE.map((o) => o.name);
      expect(createNames).toContain('create_element');

      // Verify READ operations
      const readNames = grouped.READ.map((o) => o.name);
      expect(readNames).toContain('list_elements');
      expect(readNames).toContain('introspect');

      // Verify UPDATE operations
      const updateNames = grouped.UPDATE.map((o) => o.name);
      expect(updateNames).toContain('edit_element');

      // Verify DELETE operations
      const deleteNames = grouped.DELETE.map((o) => o.name);
      expect(deleteNames).toContain('delete_element');
    });
  });

  describe('getSummary()', () => {
    it('should return a compact summary string', () => {
      const summary = IntrospectionResolver.getSummary();

      expect(typeof summary).toBe('string');
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toContain('MCP-AQL Operations:');
      expect(summary).toContain('CREATE:');
      expect(summary).toContain('READ:');
      expect(summary).toContain('UPDATE:');
      expect(summary).toContain('DELETE:');
      expect(summary).toContain('Types:');
    });

    it('should be token-efficient (under 2000 chars)', () => {
      const summary = IntrospectionResolver.getSummary();
      expect(summary.length).toBeLessThan(2000);
    });
  });

  describe('Operation parameter completeness', () => {
    it('should have parameters defined for all operations', () => {
      const result = IntrospectionResolver.resolve({ query: 'operations' });

      for (const op of result.operations!) {
        const details = IntrospectionResolver.resolve({
          query: 'operations',
          name: op.name,
        });

        // All operations should have a parameters array (may be empty)
        expect(details.operation).not.toBeNull();
        expect(details.operation!.parameters).toBeDefined();
        expect(Array.isArray(details.operation!.parameters)).toBe(true);
      }
    });

    it('should have examples defined for all operations', () => {
      const result = IntrospectionResolver.resolve({ query: 'operations' });

      for (const op of result.operations!) {
        const details = IntrospectionResolver.resolve({
          query: 'operations',
          name: op.name,
        });

        expect(details.operation).not.toBeNull();
        expect(details.operation!.examples).toBeDefined();
        expect(Array.isArray(details.operation!.examples)).toBe(true);
      }
    });
  });

  describe('Permission validation', () => {
    it('should return correct permissions for CREATE operations', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      expect(result.operation!.permissions).toEqual({
        readOnly: false,
        destructive: false,
      });
    });

    it('should return correct permissions for READ operations', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'list_elements',
      });

      expect(result.operation!.permissions).toEqual({
        readOnly: true,
        destructive: false,
      });
    });

    it('should return correct permissions for UPDATE operations', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'edit_element',
      });

      expect(result.operation!.permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });

    it('should return correct permissions for DELETE operations', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'delete_element',
      });

      expect(result.operation!.permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });
  });

  /**
   * Issue #254 - Schema-driven introspection
   * Tests that schema-driven operations get their metadata from OperationSchema
   */
  describe('Schema-driven introspection (Issue #254)', () => {
    describe('schema-driven operations use schema metadata', () => {
      it('should return schema description for browse_collection', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'browse_collection',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.description).toBe(
          'Browse the DollhouseMCP community collection by section and type'
        );
      });

      it('should return schema parameters for search_collection', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'search_collection',
        });

        expect(result.operation).toBeDefined();
        const params = result.operation!.parameters;
        expect(params).toHaveLength(1);
        expect(params[0].name).toBe('query');
        expect(params[0].required).toBe(true);
      });

      it('should return schema examples for introspect', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'introspect',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.examples.length).toBeGreaterThan(0);
        expect(result.operation!.examples[0]).toContain('introspect');
      });

      it('should return schema return type for render', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'render',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.returns.name).toBe('RenderResult');
        expect(result.operation!.returns.kind).toBe('object');
      });
    });

    describe('schema operations have consistent metadata', () => {
      it('should have matching endpoint between schema and introspection', () => {
        const schemaOps = [
          'browse_collection',
          'setup_github_auth',
          'find_similar_elements',
          'render',
          'introspect',
        ];

        for (const opName of schemaOps) {
          const schema = getOperationSchema(opName);
          const result = IntrospectionResolver.resolve({
            query: 'operations',
            name: opName,
          });

          expect(result.operation).toBeDefined();
          expect(result.operation!.endpoint).toBe(schema!.endpoint);
        }
      });

      it('should have matching descriptions between schema and introspection', () => {
        const schemaOps = ['search_collection', 'check_github_auth', 'get_build_info'];

        for (const opName of schemaOps) {
          const schema = getOperationSchema(opName);
          const result = IntrospectionResolver.resolve({
            query: 'operations',
            name: opName,
          });

          expect(result.operation).toBeDefined();
          expect(result.operation!.description).toBe(schema!.description);
        }
      });
    });

    describe('schema operations in operation list', () => {
      it('should include schema-driven operations in list', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });
        const opNames = result.operations!.map((o) => o.name);

        expect(opNames).toContain('browse_collection');
        expect(opNames).toContain('search_collection');
        expect(opNames).toContain('setup_github_auth');
        expect(opNames).toContain('render');
        expect(opNames).toContain('introspect');
      });

      it('should use schema descriptions in operation list', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });
        const browseOp = result.operations!.find((o) => o.name === 'browse_collection');

        expect(browseOp).toBeDefined();
        expect(browseOp!.description).toBe(
          'Browse the DollhouseMCP community collection by section and type'
        );
      });
    });

    describe('default return types', () => {
      it('should use OperationResult as default return type when not specified', () => {
        // Get a schema-driven operation without explicit returns
        // In our implementation, all schema ops have returns, but we test the fallback
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'clear_github_auth',
        });

        expect(result.operation).toBeDefined();
        // clear_github_auth has explicit returns, so it should use that
        expect(result.operation!.returns.name).toBe('OperationResult');
      });
    });
  });

  /**
   * Issue #602 - Unified 'content' field, no 'instructions' in API
   * Ensures the API surface is unambiguous: 'content' for body text, 'goal' for agents.
   */
  describe('Issue #602 - Unified content field in introspection', () => {
    it('should expose instructions as a create_element parameter (dual-field)', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const paramNames = result.operation!.parameters.map(p => p.name);
      expect(paramNames).toContain('instructions');
    });

    it('should expose content and goal as create_element parameters', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const paramNames = result.operation!.parameters.map(p => p.name);
      expect(paramNames).toContain('content');
      expect(paramNames).toContain('goal');
    });

    it('should describe content as usable for ALL element types including personas', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const contentParam = result.operation!.parameters.find(p => p.name === 'content');
      expect(contentParam).toBeDefined();
      expect(contentParam!.description).toMatch(/persona/i);
      expect(contentParam!.description).toMatch(/skill/i);
      expect(contentParam!.description).toMatch(/template/i);
    });

    it('should describe goal as recommended for agents', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const goalParam = result.operation!.parameters.find(p => p.name === 'goal');
      expect(goalParam).toBeDefined();
      expect(goalParam!.description).toMatch(/agent/i);
      expect(goalParam!.description).toMatch(/REQUIRED for execute_agent/i);
    });

    it('should use instructions in persona examples (dual-field)', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const personaExample = result.operation!.examples.find(e => e.includes('"persona"'));
      expect(personaExample).toBeDefined();
      expect(personaExample).toContain('instructions');
    });

    it('should include goal and instructions in agent examples', () => {
      const result = IntrospectionResolver.resolve({
        query: 'operations',
        name: 'create_element',
      });

      const agentExample = result.operation!.examples.find(e => e.includes('"agent"'));
      expect(agentExample).toBeDefined();
      expect(agentExample).toContain('goal');
      expect(agentExample).toContain('instructions');
    });
  });

  /**
   * Drift Prevention Tests
   *
   * These tests ensure that introspection metadata stays in sync with
   * the actual handler implementation. If a parameter is added to a handler
   * but not to introspection, these tests will fail.
   *
   * Issue: PR #385 review identified that nextActionHint and riskScore
   * were added to MCPAQLHandler but not documented in introspection.
   */
  describe('Drift Prevention - Introspection/Handler Sync', () => {
    describe('record_execution_step parameters', () => {
      it('should document all parameters accepted by MCPAQLHandler', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'record_execution_step',
        });

        expect(result.operation).toBeDefined();
        const paramNames = result.operation!.parameters.map(p => p.name);

        // Core required params
        expect(paramNames).toContain('element_name');
        expect(paramNames).toContain('stepDescription');
        expect(paramNames).toContain('outcome');

        // Optional params that MCPAQLHandler accepts
        expect(paramNames).toContain('findings');
        expect(paramNames).toContain('confidence');

        // Autonomy-related params (added in Phase 2)
        expect(paramNames).toContain('nextActionHint');
        expect(paramNames).toContain('riskScore');
      });

      it('should mark nextActionHint as optional', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'record_execution_step',
        });

        const nextActionHintParam = result.operation!.parameters.find(
          p => p.name === 'nextActionHint'
        );
        expect(nextActionHintParam).toBeDefined();
        expect(nextActionHintParam!.required).toBe(false);
      });

      it('should mark riskScore as optional with correct type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'record_execution_step',
        });

        const riskScoreParam = result.operation!.parameters.find(
          p => p.name === 'riskScore'
        );
        expect(riskScoreParam).toBeDefined();
        expect(riskScoreParam!.required).toBe(false);
        expect(riskScoreParam!.type).toBe('number');
      });

      it('should mark findings as optional (not required)', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'record_execution_step',
        });

        const findingsParam = result.operation!.parameters.find(
          p => p.name === 'findings'
        );
        expect(findingsParam).toBeDefined();
        expect(findingsParam!.required).toBe(false);
      });
    });

    describe('execute operations parameter completeness', () => {
      it('should have 7 parameters for record_execution_step', () => {
        // This test will fail if new params are added to handler but not introspection
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'record_execution_step',
        });

        // element_name, stepDescription, outcome, findings, confidence, nextActionHint, riskScore
        expect(result.operation!.parameters).toHaveLength(7);
      });
    });
  });

  /**
   * Issue #594 - Introspection-only schemas
   * Verifies that operations previously invisible to introspect now return
   * schema-quality metadata (params, examples, return types).
   */
  describe('Introspection-only schema coverage (Issue #594)', () => {
    describe('confirm_operation introspection', () => {
      it('should return schema-quality details', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'confirm_operation',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.endpoint).toBe('EXECUTE');
        expect(result.operation!.mcpTool).toBe('mcp_aql_execute');
      });

      it('should have params from schema (not empty fallback)', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'confirm_operation',
        });

        const paramNames = result.operation!.parameters.map(p => p.name);
        expect(paramNames).toContain('operation');
        expect(paramNames).toContain('element_type');

        const opParam = result.operation!.parameters.find(p => p.name === 'operation');
        expect(opParam!.required).toBe(true);
      });

      it('should have examples and return type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'confirm_operation',
        });

        expect(result.operation!.examples.length).toBeGreaterThan(0);
        expect(result.operation!.returns.name).toBe('ConfirmResult');
      });
    });

    describe('query_logs introspection', () => {
      it('should return all filter params', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'query_logs',
        });

        expect(result.operation).toBeDefined();
        const paramNames = result.operation!.parameters.map(p => p.name);
        expect(paramNames).toContain('category');
        expect(paramNames).toContain('level');
        expect(paramNames).toContain('source');
        expect(paramNames).toContain('limit');
        expect(paramNames).toContain('correlationId');

        // All params should be optional
        for (const param of result.operation!.parameters) {
          expect(param.required).toBe(false);
        }
      });

      it('should have return type from schema', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'query_logs',
        });

        expect(result.operation!.returns.name).toBe('LogQueryResult');
      });
    });

    describe('execute_agent introspection', () => {
      it('should return schema-quality params (not legacy fallback)', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'execute_agent',
        });

        expect(result.operation).toBeDefined();
        const paramNames = result.operation!.parameters.map(p => p.name);
        expect(paramNames).toContain('element_name');
        expect(paramNames).toContain('parameters');
        expect(paramNames).toContain('maxAutonomousSteps');

        // maxAutonomousSteps was NOT in the legacy OPERATION_PARAMETERS — schema adds it
        const maxStepsParam = result.operation!.parameters.find(p => p.name === 'maxAutonomousSteps');
        expect(maxStepsParam).toBeDefined();
        expect(maxStepsParam!.required).toBe(false);
      });

      it('should have schema return type with response shape', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'execute_agent',
        });

        expect(result.operation!.returns.name).toBe('ExecuteAgentResult');
        expect(result.operation!.returns.description).toContain('goalId');
        expect(result.operation!.returns.description).toContain('stateVersion');
      });

      it('should expose the canonical lifecycle loop in introspection', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'execute_agent',
        });

        expect(result.operation!.description).toContain('record_execution_step');
        expect(result.operation!.description).toContain('mcp_aql_create');
        expect(result.operation!.description).toContain('complete_execution');
      });
    });

    describe('continue_execution introspection', () => {
      it('should explain paused-only semantics and full-parameter resume', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'continue_execution',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.description).toContain('paused');
        expect(result.operation!.description).toContain('same goal parameters');
        expect(result.operation!.examples[0]).toContain('run_dir');
        expect(result.operation!.examples[0]).toContain('deliverable_path');
      });
    });

    describe('addEntry introspection', () => {
      it('should return params with response shape in return type', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'addEntry',
        });

        expect(result.operation).toBeDefined();
        const paramNames = result.operation!.parameters.map(p => p.name);
        expect(paramNames).toContain('element_name');
        expect(paramNames).toContain('content');
        expect(paramNames).toContain('tags');
        expect(paramNames).toContain('metadata');

        expect(result.operation!.returns.name).toBe('MemoryEntry');
        expect(result.operation!.examples.length).toBeGreaterThanOrEqual(3);
      });
    });

    describe('all 15 migrated operations have schema metadata via introspect', () => {
      const migratedOps = [
        'addEntry', 'clear',
        'execute_agent', 'get_execution_state', 'record_execution_step',
        'complete_execution', 'continue_execution', 'abort_execution',
        'get_gathered_data', 'prepare_handoff', 'resume_from_handoff',
        'confirm_operation', 'verify_challenge', 'release_deadlock', 'beetlejuice_beetlejuice_beetlejuice',
        'query_logs',
      ];

      it.each(migratedOps)('%s should have non-empty params', (opName) => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: opName,
        });

        expect(result.operation).not.toBeNull();
        // Schema-sourced metadata should match getAnyOperationSchema
        const schema = getAnyOperationSchema(opName);
        expect(schema).toBeDefined();
        expect(result.operation!.description).toBe(schema!.description);
        expect(result.operation!.returns.name).toBe(schema!.returns!.name);
      });

      it.each(migratedOps)('%s should have examples', (opName) => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: opName,
        });

        expect(result.operation!.examples.length).toBeGreaterThan(0);
      });
    });
  });

  /**
   * Issue #715 - Format query for element creation guidance
   * Tests the introspect query: "format" which returns element format specifications.
   */
  describe('Format query (Issue #715)', () => {
    describe('overview (no name)', () => {
      it('should return all 6 format specs when name is omitted', () => {
        const result = IntrospectionResolver.resolve({ query: 'format' });

        expect(result.formatSpec).toBeDefined();
        expect(Array.isArray(result.formatSpec)).toBe(true);
        const specs = result.formatSpec as Array<Record<string, unknown>>;
        expect(specs).toHaveLength(6);

        const types = specs.map(s => s.elementType);
        expect(types).toContain('persona');
        expect(types).toContain('skill');
        expect(types).toContain('template');
        expect(types).toContain('agent');
        expect(types).toContain('memory');
        expect(types).toContain('ensemble');
      });
    });

    describe('per-type specs', () => {
      const elementTypes = ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'];

      it.each(elementTypes)('should return format spec for %s', (typeName) => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: typeName });

        expect(result.formatSpec).toBeDefined();
        expect(result.formatSpec).not.toBeNull();
        expect(Array.isArray(result.formatSpec)).toBe(false);

        const spec = result.formatSpec as Record<string, unknown>;
        expect(spec.elementType).toBe(typeName);
        expect(spec.fileFormat).toBeDefined();
        expect(Array.isArray(spec.requiredFields)).toBe(true);
        expect(Array.isArray(spec.optionalFields)).toBe(true);
        expect(typeof spec.dualFieldGuidance).toBe('string');
        expect(Array.isArray(spec.syntaxNotes)).toBe(true);
        expect(typeof spec.minimalExample).toBe('string');
        expect(typeof spec.fullExample).toBe('string');
        expect(Array.isArray(spec.namingConventions)).toBe(true);
      });
    });

    describe('plural and case normalization', () => {
      it('should handle plural "templates"', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'templates' });
        expect(result.formatSpec).toBeDefined();
        expect((result.formatSpec as Record<string, unknown>).elementType).toBe('template');
      });

      it('should handle plural "memories" (not "memorie")', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'memories' });
        expect(result.formatSpec).toBeDefined();
        expect((result.formatSpec as Record<string, unknown>).elementType).toBe('memory');
      });

      it('should handle uppercase "PERSONA"', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'PERSONA' });
        expect(result.formatSpec).toBeDefined();
        expect((result.formatSpec as Record<string, unknown>).elementType).toBe('persona');
      });

      it('should handle mixed case "Agents"', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'Agents' });
        expect(result.formatSpec).toBeDefined();
        expect((result.formatSpec as Record<string, unknown>).elementType).toBe('agent');
      });

      it('should handle whitespace " skill "', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: ' skill ' });
        expect(result.formatSpec).toBeDefined();
        expect((result.formatSpec as Record<string, unknown>).elementType).toBe('skill');
      });
    });

    describe('unknown and invalid input', () => {
      it('should return null for unknown element type', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'widget' });
        expect(result.formatSpec).toBeNull();
      });

      it('should return null for numeric name', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 42 as unknown as string });
        expect(result.formatSpec).toBeNull();
      });

      it('should return overview for empty string name', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: '' });
        // Empty string is falsy, treated as "no name" -> overview
        expect(Array.isArray(result.formatSpec)).toBe(true);
      });
    });

    describe('template syntax notes', () => {
      it('should document that Handlebars syntax is NOT supported', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'template' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('NOT supported') || n.includes('not supported'))).toBe(true);
      });

      it('should document section format for page templates', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'template' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('<template>') && n.includes('<style>'))).toBe(true);
      });

      it('should document variable syntax', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'template' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('{{variable_name}}'))).toBe(true);
      });
    });

    describe('agent goal structure', () => {
      it('should document goal.template uses single braces', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('{param}') && n.includes('single braces'))).toBe(true);
      });

      it('should list goal in optionalFields', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        expect((spec.optionalFields as string[])).toContain('goal');
      });
    });

    describe('memory naming patterns', () => {
      it('should include agent-linked naming convention', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'memory' });
        const spec = result.formatSpec as Record<string, unknown>;
        const conventions = spec.namingConventions as string[];
        expect(conventions.some(c => c.includes('agent-{agent-name}'))).toBe(true);
      });

      it('should include persona-linked naming convention', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'memory' });
        const spec = result.formatSpec as Record<string, unknown>;
        const conventions = spec.namingConventions as string[];
        expect(conventions.some(c => c.includes('persona-{persona-name}'))).toBe(true);
      });
    });

    describe('ensemble elements array', () => {
      it('should require metadata.elements in requiredFields', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'ensemble' });
        const spec = result.formatSpec as Record<string, unknown>;
        expect((spec.requiredFields as string[])).toContain('metadata.elements');
      });

      it('should document role values in syntaxNotes', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'ensemble' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('primary') && n.includes('support'))).toBe(true);
      });
    });

    describe('gatekeeper field visibility (Issue #726)', () => {
      const elementTypes = ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'];

      it.each(elementTypes)('should include gatekeeper in %s optionalFields', (type) => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: type });
        const spec = result.formatSpec as Record<string, unknown>;
        expect((spec.optionalFields as string[])).toContain('gatekeeper');
      });

      it('should document gatekeeper structure in agent syntaxNotes', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        expect(notes.some(n => n.includes('gatekeeper') && n.includes('allow') && n.includes('deny'))).toBe(true);
      });

      it.each(elementTypes)('should explain operation rules versus externalRestrictions in %s syntaxNotes', (type) => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: type });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = (spec.syntaxNotes as string[]).join('\n');
        expect(notes).toContain('externalRestrictions');
        expect(notes).toContain('read_*');
        expect(notes).toContain('Bash:git status*');
      });

      it('should include gatekeeper in agent fullExample with allow/confirm/deny', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const example = spec.fullExample as string;
        expect(example).toContain('gatekeeper:');
        expect(example).toContain('allow:');
        expect(example).toContain('confirm:');
        expect(example).toContain('deny: [delete_element]');
      });

      it('should include externalRestrictions in skill fullExample', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'skill' });
        const spec = result.formatSpec as Record<string, unknown>;
        const example = spec.fullExample as string;
        expect(example).toContain('externalRestrictions:');
        expect(example).toContain('Read:*');
        expect(example).toContain('Bash:rm *');
      });
    });

    describe('resilience and activates documentation (Issue #736)', () => {
      it('should document correct resilience fields in agent syntaxNotes', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        const resilienceNote = notes.find(n => n.startsWith('resilience:'));
        expect(resilienceNote).toBeDefined();
        expect(resilienceNote).toContain('onStepLimitReached');
        expect(resilienceNote).toContain('onExecutionFailure');
        expect(resilienceNote).toContain('maxRetries');
        expect(resilienceNote).toContain('maxContinuations');
        expect(resilienceNote).toContain('retryBackoff');
        expect(resilienceNote).toContain('preserveState');
      });

      it('should document activates lifecycle in agent syntaxNotes', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        const activatesNote = notes.find(n => n.includes('activates lifecycle'));
        expect(activatesNote).toBeDefined();
        expect(activatesNote).toContain('automatically activated');
        expect(activatesNote).toContain('execute_agent');
      });

      it('should include autonomy and resilience in agent fullExample', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const example = spec.fullExample as string;
        expect(example).toContain('autonomy:');
        expect(example).toContain('maxAutonomousSteps:');
        expect(example).toContain('resilience:');
        expect(example).toContain('onStepLimitReached: continue');
        expect(example).toContain('onExecutionFailure: retry');
      });

      it('should use correct autonomy field name in syntaxNotes (maxAutonomousSteps not maxSteps)', () => {
        const result = IntrospectionResolver.resolve({ query: 'format', name: 'agent' });
        const spec = result.formatSpec as Record<string, unknown>;
        const notes = spec.syntaxNotes as string[];
        const autonomyNote = notes.find(n => n.startsWith('autonomy:'));
        expect(autonomyNote).toContain('maxAutonomousSteps');
        // Should NOT use abbreviated 'maxSteps' — LLMs need the exact field name
        expect(autonomyNote).not.toContain('maxSteps,');
      });
    });

    describe('category discovery (Issue #631)', () => {
      it('should return category info for query: "categories"', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        expect(result.categories).toBeDefined();
        const info = result.categories as Record<string, unknown>;
        expect(info.formatRules).toBeDefined();
        expect(info.supportedTypes).toBeDefined();
        expect(info.allowedGroupByFields).toBeDefined();
        expect(info.discovery).toBeDefined();
      });

      it('should include category format pattern and examples', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        const info = result.categories as Record<string, unknown>;
        const rules = info.formatRules as Record<string, unknown>;
        expect(rules.pattern).toContain('^[a-zA-Z]');
        expect(rules.examples).toEqual(expect.arrayContaining(['development', 'security']));
      });

      it('should list allowed group_by fields from AggregationService', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        const info = result.categories as Record<string, unknown>;
        const fields = info.allowedGroupByFields as string[];
        expect(fields).toContain('category');
        expect(fields).toContain('author');
        expect(fields).toContain('tags');
      });

      it('should provide query_elements discovery examples', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        const info = result.categories as Record<string, unknown>;
        const discovery = info.discovery as Record<string, unknown>;
        const examples = discovery.examples as string[];
        expect(examples.some(e => e.includes('group_by') && e.includes('category'))).toBe(true);
        expect(examples.some(e => e.includes('filters') && e.includes('category'))).toBe(true);
      });

      it('should list supported element types for categories', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        const info = result.categories as Record<string, unknown>;
        const types = info.supportedTypes as string[];
        expect(types).toContain('persona');
        expect(types).toContain('skill');
        expect(types).toContain('template');
        expect(types).toContain('memory');
      });

      it('should derive format pattern from VALIDATION_PATTERNS.SAFE_CATEGORY (single source of truth)', () => {
        const result = IntrospectionResolver.resolve({ query: 'categories' });
        const info = result.categories as Record<string, unknown>;
        const rules = info.formatRules as Record<string, unknown>;
        // Pattern must match the actual validation regex source — not a hardcoded duplicate
        expect(rules.pattern).toBe('^[a-zA-Z][a-zA-Z0-9\\-_]{0,20}$');
      });
    });

    describe('introspect schema updated for format', () => {
      it('should include format examples in introspect operation', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'introspect',
        });

        expect(result.operation).toBeDefined();
        const formatExample = result.operation!.examples.find(e => e.includes('format'));
        expect(formatExample).toBeDefined();
      });

      it('should mention format in introspect description', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'introspect',
        });

        expect(result.operation).toBeDefined();
        expect(result.operation!.description).toMatch(/format/i);
      });

      it('should include categories in introspect self-documentation (Gap #1)', () => {
        const result = IntrospectionResolver.resolve({
          query: 'operations',
          name: 'introspect',
        });

        expect(result.operation).toBeDefined();
        // Schema-driven operations expose type as 'string', but the description
        // must mention 'categories' so LLMs discover it via introspection
        const queryParam = result.operation!.parameters.find(p => p.name === 'query');
        expect(queryParam).toBeDefined();
        expect(queryParam!.description).toContain('categories');
        // Also verify the operation-level description mentions categories
        expect(result.operation!.description).toContain('format');
      });
    });
  });

  // ==========================================================================
  // getCapabilities() tests (Issue #1760)
  // ==========================================================================

  describe('getCapabilities()', () => {
    describe('unfiltered results', () => {
      it('should return all categories when no filter specified', () => {
        const result = IntrospectionResolver.getCapabilities({});
        expect(result.categories).toBeDefined();
        expect(Object.keys(result.categories as object).length).toBeGreaterThan(0);
        expect(result.totalCapabilities).toBeGreaterThan(0);
        expect(result.sources).toEqual(['server']);
        expect(result.hint).toBeDefined();
      });

      it('should include all expected categories', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categoryNames = Object.keys(result.categories as object);

        const expectedCategories = [
          'Activation',
          'Agent Execution',
          'Community Collection',
          'Configuration & Diagnostics',
          'Element Discovery',
          'Element Lifecycle',
          'GitHub Authentication',
          'Intelligence',
          'Management Console',
          'Memory',
          'Portfolio Management',
          'Security & Permissions',
          'System Introspection',
          'Template Rendering',
        ];

        for (const expected of expectedCategories) {
          expect(categoryNames).toContain(expected);
        }
      });

      it('should not have an "Other" category when all operations are categorized', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categoryNames = Object.keys(result.categories as object);
        expect(categoryNames).not.toContain('Other');
      });

      it('every category should have a description and non-empty capabilities array', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categories = result.categories as Record<string, { description: string; capabilities: unknown[] }>;

        for (const cat of Object.values(categories)) {
          expect(cat.description).toBeTruthy();
          expect(cat.capabilities.length).toBeGreaterThan(0);
        }
      });

      it('each capability entry should have name, brief, source, and status', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categories = result.categories as Record<string, { capabilities: Array<{ name: string; brief: string; source: string; status: string }> }>;

        for (const cat of Object.values(categories)) {
          for (const entry of cat.capabilities) {
            expect(entry.name).toBeTruthy();
            expect(entry.brief).toBeTruthy();
            expect(entry.source).toBe('server');
            expect(entry.status).toBe('active');
            expect(entry.endpoint).toBeTruthy();
          }
        }
      });

      it('capabilities within each category should be sorted alphabetically', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categories = result.categories as Record<string, { capabilities: Array<{ name: string }> }>;

        for (const cat of Object.values(categories)) {
          const names = cat.capabilities.map(c => c.name);
          const sorted = [...names].sort((a, b) => a.localeCompare(b));
          expect(names).toEqual(sorted);
        }
      });

      it('categories should be sorted alphabetically', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const names = Object.keys(result.categories as object);
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names).toEqual(sorted);
      });

      it('get_capabilities should include itself in System Introspection', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categories = result.categories as Record<string, { capabilities: Array<{ name: string }> }>;
        const introspectionCat = categories['System Introspection'];
        expect(introspectionCat).toBeDefined();
        const names = introspectionCat.capabilities.map(c => c.name);
        expect(names).toContain('get_capabilities');
        expect(names).toContain('introspect');
      });
    });

    describe('category filter', () => {
      it('should return only the matching category when filtered', () => {
        const result = IntrospectionResolver.getCapabilities({ category: 'Memory' });
        const categories = result.categories as Record<string, { capabilities: Array<{ name: string }> }>;
        expect(Object.keys(categories)).toEqual(['Memory']);
        const names = categories['Memory'].capabilities.map(c => c.name);
        expect(names).toContain('addEntry');
        expect(names).toContain('clear');
      });

      it('should be case-insensitive', () => {
        const result = IntrospectionResolver.getCapabilities({ category: 'memory' });
        const categories = result.categories as Record<string, unknown>;
        expect(Object.keys(categories)).toEqual(['Memory']);
      });

      it('should return empty categories with availableCategories for unknown filter', () => {
        const result = IntrospectionResolver.getCapabilities({ category: 'Nonexistent' });
        const categories = result.categories as Record<string, unknown>;
        expect(Object.keys(categories)).toEqual([]);
        expect(result.availableCategories).toBeDefined();
        expect((result.availableCategories as string[]).length).toBeGreaterThan(0);
        expect(result.hint).toContain('Nonexistent');
      });
    });

    describe('brief descriptions', () => {
      it('should truncate long descriptions to one sentence', () => {
        const result = IntrospectionResolver.getCapabilities({});
        const categories = result.categories as Record<string, { capabilities: Array<{ brief: string }> }>;

        for (const cat of Object.values(categories)) {
          for (const entry of cat.capabilities) {
            expect(entry.brief.length).toBeLessThanOrEqual(120);
          }
        }
      });
    });

    describe('introspect includes get_capabilities', () => {
      it('should list get_capabilities in the operations list', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations' });
        const opNames = result.operations!.map(o => o.name);
        expect(opNames).toContain('get_capabilities');
      });

      it('should return valid details for get_capabilities', () => {
        const result = IntrospectionResolver.resolve({ query: 'operations', name: 'get_capabilities' });
        expect(result.operation).toBeDefined();
        expect(result.operation!.name).toBe('get_capabilities');
        expect(result.operation!.endpoint).toBe('READ');
        expect(result.operation!.parameters.length).toBeGreaterThan(0);
      });
    });
  });
});
