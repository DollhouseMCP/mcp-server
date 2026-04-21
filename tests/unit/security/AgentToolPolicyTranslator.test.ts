/**
 * Unit tests for AgentToolPolicyTranslator (Issue #449)
 *
 * Tests the translation of AgentToolConfig (allowed/denied tool endpoints)
 * into ElementGatekeeperPolicy (deny lists) for Gatekeeper enforcement.
 *
 * Covers:
 * - Allowlist → denylist inversion
 * - Denied endpoint translation
 * - Combined allowed + denied
 * - Lifecycle/safety operation exemptions
 * - Edge cases: unknown tools, empty configs, large-scale synthesis
 */

import { describe, it, expect } from '@jest/globals';
import { translateToolConfigToPolicy } from '../../../src/handlers/mcp-aql/policies/AgentToolPolicyTranslator.js';

describe('AgentToolPolicyTranslator', () => {
  describe('translateToolConfigToPolicy()', () => {
    describe('allowed endpoints', () => {
      it('should deny all non-READ operations when only mcp_aql_read is allowed', () => {
        const policy = translateToolConfigToPolicy({ allowed: ['mcp_aql_read'] });

        expect(policy).toBeDefined();
        expect(policy!.deny).toBeDefined();
        expect(policy!.deny!.length).toBeGreaterThan(0);

        // READ operations should NOT be in the deny list
        expect(policy!.deny).not.toContain('list_elements');
        expect(policy!.deny).not.toContain('get_element');
        expect(policy!.deny).not.toContain('search_elements');

        // Non-READ operations should be denied
        expect(policy!.deny).toContain('create_element');
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).toContain('edit_element');
      });

      it('should return undefined when all endpoints are allowed (no restrictions)', () => {
        const policy = translateToolConfigToPolicy({
          allowed: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_delete', 'mcp_aql_execute'],
        });

        expect(policy).toBeUndefined();
      });

      it('should deny only DELETE operations when all others are allowed', () => {
        const policy = translateToolConfigToPolicy({
          allowed: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_execute'],
        });

        expect(policy).toBeDefined();
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).toContain('clear');

        // Non-DELETE operations should NOT be denied
        expect(policy!.deny).not.toContain('create_element');
        expect(policy!.deny).not.toContain('list_elements');
        expect(policy!.deny).not.toContain('edit_element');
      });
    });

    describe('denied endpoints', () => {
      it('should deny all operations from a denied endpoint', () => {
        const policy = translateToolConfigToPolicy({
          allowed: [],
          denied: ['mcp_aql_delete'],
        });

        expect(policy).toBeDefined();
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).toContain('clear');
      });

      it('should deny operations from multiple denied endpoints', () => {
        const policy = translateToolConfigToPolicy({
          allowed: [],
          denied: ['mcp_aql_delete', 'mcp_aql_update'],
        });

        expect(policy).toBeDefined();
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).toContain('clear');
        expect(policy!.deny).toContain('edit_element');
      });
    });

    describe('combined allowed + denied', () => {
      it('should apply both allowed restrictions and denied restrictions cumulatively', () => {
        const policy = translateToolConfigToPolicy({
          allowed: ['mcp_aql_read', 'mcp_aql_create'],
          denied: ['mcp_aql_create'],
        });

        expect(policy).toBeDefined();
        // CREATE operations denied by `denied` even though in `allowed`
        expect(policy!.deny).toContain('create_element');
        // DELETE/UPDATE/EXECUTE denied because not in `allowed`
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).toContain('edit_element');
        // READ operations should NOT be denied
        expect(policy!.deny).not.toContain('list_elements');
        expect(policy!.deny).not.toContain('get_element');
      });
    });

    describe('lifecycle and safety exemptions', () => {
      it('should never deny execute_agent even when EXECUTE endpoint is not allowed', () => {
        const policy = translateToolConfigToPolicy({ allowed: ['mcp_aql_read'] });

        expect(policy).toBeDefined();
        expect(policy!.deny).not.toContain('execute_agent');
        expect(policy!.deny).not.toContain('complete_execution');
        expect(policy!.deny).not.toContain('get_execution_state');
        expect(policy!.deny).not.toContain('record_execution_step');
        expect(policy!.deny).not.toContain('continue_execution');
      });

      it('should never deny safety operations even when all endpoints are denied', () => {
        const policy = translateToolConfigToPolicy({
          allowed: [],
          denied: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_delete', 'mcp_aql_execute'],
        });

        expect(policy).toBeDefined();
        expect(policy!.deny).not.toContain('confirm_operation');
        expect(policy!.deny).not.toContain('verify_challenge');
      });

      it('should never deny lifecycle operations even when EXECUTE is explicitly denied', () => {
        const policy = translateToolConfigToPolicy({
          allowed: [],
          denied: ['mcp_aql_execute'],
        });

        // Lifecycle operations (execute_agent, complete_execution, etc.) are
        // exempt from EXECUTE denial. Non-lifecycle EXECUTE operations (like
        // migrate_portfolio_layout) ARE denied.
        if (policy) {
          expect(policy.deny).not.toContain('execute_agent');
          expect(policy.deny).not.toContain('complete_execution');
          expect(policy.deny).not.toContain('continue_execution');
          expect(policy.deny).not.toContain('abort_execution');
        }
      });
    });

    describe('edge cases', () => {
      it('should return undefined for empty allowed array with no denied', () => {
        const policy = translateToolConfigToPolicy({ allowed: [] });
        expect(policy).toBeUndefined();
      });

      it('should ignore unknown tool names in allowed list', () => {
        const policy = translateToolConfigToPolicy({
          allowed: ['unknown_tool', 'mcp_aql_read'],
        });

        expect(policy).toBeDefined();
        // Only READ is recognized as allowed, everything else denied
        expect(policy!.deny).toContain('create_element');
        expect(policy!.deny).toContain('delete_element');
        expect(policy!.deny).not.toContain('list_elements');
      });

      it('should ignore unknown tool names in denied list', () => {
        const policy = translateToolConfigToPolicy({
          allowed: [],
          denied: ['unknown_tool', 'nonexistent_endpoint'],
        });

        // Unknown tools produce no deny entries
        expect(policy).toBeUndefined();
      });

      it('should produce a sorted deny list for deterministic output', () => {
        const policy = translateToolConfigToPolicy({ allowed: ['mcp_aql_read'] });

        expect(policy).toBeDefined();
        const denySorted = [...policy!.deny!].sort();
        expect(policy!.deny).toEqual(denySorted);
      });

      it('should handle large-scale synthesis with all endpoints denied except one', () => {
        // Allow only CREATE — should deny all READ, UPDATE, DELETE ops (except lifecycle)
        const policy = translateToolConfigToPolicy({ allowed: ['mcp_aql_create'] });

        expect(policy).toBeDefined();
        // Should have many denied operations
        expect(policy!.deny!.length).toBeGreaterThan(10);
        // CREATE operations should not be denied
        expect(policy!.deny).not.toContain('create_element');
        expect(policy!.deny).not.toContain('import_element');
        // READ, UPDATE, DELETE ops should be denied
        expect(policy!.deny).toContain('list_elements');
        expect(policy!.deny).toContain('edit_element');
        expect(policy!.deny).toContain('delete_element');
      });
    });
  });
});
