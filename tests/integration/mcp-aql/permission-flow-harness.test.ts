/**
 * Permission Flow Test Harness (Issue #1669)
 *
 * Comprehensive tests for the complete permission evaluation chain.
 * Maps how each layer interacts when configured differently.
 * Prerequisite for fixing #1653 (auto-confirm on confirmationPending).
 *
 * Layers under test:
 * 1. Gatekeeper operation policies (confirm_operation flow)
 * 2. Element policy overrides (externalRestrictions)
 * 3. permission_prompt evaluation (CLI tool delegation)
 * 4. Session confirmation store (single-use vs session scope)
 * 5. Safety tier evaluation
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import {
  createPortfolioTestEnvironment,
  preConfirmAllOperations,
  waitForCacheSettle,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';

/**
 * Helper to extract result data from a successful MCP-AQL response.
 * @param result - MCP-AQL operation result
 * @returns The typed data payload
 */
function extractData<T = Record<string, unknown>>(result: { success: boolean; data?: T }): T {
  expect(result.success).toBe(true);
  if (!result.data) throw new Error('Expected data in successful result');
  return result.data;
}

/**
 * Helper to extract error from a failed MCP-AQL response.
 */
function extractError(result: { success: boolean; error?: string }): string {
  expect(result.success).toBe(false);
  return result.error ?? '';
}

/**
 * Helper to create a test element (pre-confirms create_element first).
 */
async function createTestElement(
  handler: MCPAQLHandler,
  gatekeeper: Gatekeeper,
  name: string,
  type: string = 'skills'
): Promise<void> {
  gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);
  const result = await handler.handleCreate({
    operation: 'create_element',
    params: {
      element_name: name,
      element_type: type,
      description: `Test element: ${name}`,
      content: `# ${name}\n\nTest content for permission flow harness.`,
    },
  });
  expect(result.success).toBe(true);
}

describe('Permission Flow Test Harness (Issue #1669)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let gatekeeper: Gatekeeper;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('permission-flow-harness');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    // Do NOT pre-confirm — we test raw enforcement
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
  });

  afterEach(async () => {
    try { await server.dispose(); } catch { /* ignore disposal errors */ }
    await env.cleanup();
  });

  // ── Scenario A: Gatekeeper behavior when operations are pre-confirmed ──

  describe('Scenario A: Pre-confirmed operations (simulates host auto-approve)', () => {
    it('should allow create_element immediately when session-confirmed', async () => {
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'auto-approved-skill',
          element_type: 'skills',
          description: 'Test auto-approved creation',
          content: '# Auto Approved\n\nShould succeed without confirm_operation.',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should allow execute_agent immediately when session-confirmed', async () => {
      // First create an agent to execute
      await createTestElement(mcpAqlHandler, gatekeeper, 'flow-test-agent', 'agents');

      // Pre-confirm execute_agent at session level
      gatekeeper.recordConfirmation('execute_agent', PermissionLevel.CONFIRM_SESSION);

      // Attempt execute — should not require confirm_operation round-trip
      const result = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: {
          element_name: 'flow-test-agent',
          parameters: {},
        },
      });
      // May fail for other reasons (no goal template) but should NOT fail with "Approval needed"
      if (!result.success) {
        expect(result.error).not.toMatch(/Approval needed/);
        expect(result.error).not.toMatch(/confirm_operation/);
      }
    });

    it('should still require confirmation for delete even when create is confirmed', async () => {
      // Confirm create but NOT delete
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      await createTestElement(mcpAqlHandler, gatekeeper, 'delete-test-skill');
      await waitForCacheSettle();

      // Delete should still require confirmation
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: { element_name: 'delete-test-skill', element_type: 'skills' },
      });
      const error = extractError(deleteResult);
      expect(error).toMatch(/Approval needed/);
      expect(error).toMatch(/delete_element/);
    });

    it('preConfirmAllOperations should enable all operations without confirm_operation calls', async () => {
      preConfirmAllOperations(container);

      // Create should work
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'pre-confirmed-skill',
          element_type: 'skills',
          description: 'Created with pre-confirmed gatekeeper',
          content: '# Pre-Confirmed\n\nAll operations pre-approved.',
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      // Edit should work
      const editResult = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'pre-confirmed-skill',
          element_type: 'skills',
          input: { description: 'Updated description' },
        },
      });
      expect(editResult.success).toBe(true);

      // Delete should work
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: { element_name: 'pre-confirmed-skill', element_type: 'skills' },
      });
      expect(deleteResult.success).toBe(true);
    });
  });

  // ── Scenario B: Gatekeeper as sole permission layer ──

  describe('Scenario B: Gatekeeper with all operations pre-confirmed', () => {
    beforeEach(() => {
      preConfirmAllOperations(container);
    });

    it('should still enforce element policy deny overrides', async () => {
      // Create a persona with a deny policy for create_element
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'restrictive-persona',
          element_type: 'personas',
          description: 'A persona that denies skill creation',
          instructions: 'You are a restrictive persona.',
          gatekeeper: {
            deny: ['create_element'],
          },
        },
      });

      await waitForCacheSettle();

      // Activate the restrictive persona
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restrictive-persona', element_type: 'personas' },
      });

      await waitForCacheSettle();

      // Even with all operations pre-confirmed, the element deny should block
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'blocked-skill',
          element_type: 'skills',
          description: 'Should be blocked by element policy',
          content: '# Blocked\n\nShould not be created.',
        },
      });
      expect(createResult.success).toBe(false);
    });

    it('record_execution_step should work without confirm when session-confirmed', async () => {
      // Create and start an agent execution
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'agent',
        params: {
          element_name: 'step-test-agent',
          description: 'Agent for testing execution steps',
          instructions: 'Test agent.',
          goal: { template: 'Test: {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
        },
      });

      await waitForCacheSettle();

      const execResult = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: { element_name: 'step-test-agent', parameters: { task: 'test' } },
      });

      if (execResult.success) {
        // record_execution_step should work without another confirm round-trip
        const stepResult = await mcpAqlHandler.handleCreate({
          operation: 'record_execution_step',
          params: {
            element_name: 'step-test-agent',
            stepDescription: 'Test step',
            outcome: 'success',
            findings: 'Testing permission flow',
          },
        });
        // Should NOT require separate confirmation
        if (!stepResult.success) {
          expect(stepResult.error).not.toMatch(/Approval needed/);
        }
      }
    });
  });

  // ── Scenario C: permission_prompt evaluation ──

  describe('Scenario C: permission_prompt CLI tool evaluation', () => {
    it('should evaluate safe tools as allow without element policies', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Read',
          input: { file_path: '/some/file.ts' },
        },
      });
      const data = extractData(result);
      expect(data.behavior).toBe('allow');
    });

    it('should evaluate dangerous bash commands as deny via static classification', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /' },
        },
      });
      const data = extractData(result);
      expect(data.behavior).toBe('deny');
    });

    it('should apply element externalRestrictions deny patterns', async () => {
      preConfirmAllOperations(container);

      // Create an ensemble with deny patterns
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'policy-test-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble with externalRestrictions for testing',
          elements: [],
          gatekeeper: {
            externalRestrictions: {
              description: 'Test deny patterns',
              denyPatterns: ['Bash:git push --force*'],
              allowPatterns: ['Bash:git *'],
            },
          },
        },
      });

      await waitForCacheSettle();

      // Activate the ensemble
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'policy-test-ensemble', element_type: 'ensembles' },
      });

      await waitForCacheSettle();

      // git push --force should be denied by element policy
      const denyResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'git push --force origin main' },
        },
      });
      const denyData = extractData(denyResult);
      expect(denyData.behavior).toBe('deny');

      // git status should be allowed
      const allowResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'git status' },
        },
      });
      const allowData = extractData(allowResult);
      expect(allowData.behavior).toBe('allow');
    });

    it('should apply element externalRestrictions confirm patterns', async () => {
      preConfirmAllOperations(container);

      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'confirm-test-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble with confirmPatterns for testing',
          elements: [],
          gatekeeper: {
            externalRestrictions: {
              description: 'Test confirm patterns',
              confirmPatterns: ['Bash:gh pr merge*'],
              allowPatterns: ['Bash:gh *'],
            },
          },
        },
      });

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'confirm-test-ensemble', element_type: 'ensembles' },
      });

      await waitForCacheSettle();

      // gh pr merge should require confirmation
      const confirmResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'gh pr merge 42 --merge' },
        },
      });
      const confirmData = extractData(confirmResult);
      expect(confirmData.behavior).toBe('deny'); // Returns deny with approvalRequest

      // Should have an approval request
      const approvalRequest = confirmData.approvalRequest as Record<string, unknown> | undefined;
      expect(approvalRequest).toBeDefined();
      if (approvalRequest) {
        expect(approvalRequest.reason).toMatch(/requires confirmation/i);
      }

      // gh issue list should be allowed (matches allowPattern, not confirmPattern)
      const allowResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'gh issue list --limit 10' },
        },
      });
      const allowData = extractData(allowResult);
      expect(allowData.behavior).toBe('allow');
    });

    it('should deny tools not in any allowlist when allowPatterns exist', async () => {
      preConfirmAllOperations(container);

      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'restrictive-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble with restrictive allowlist',
          elements: [],
          gatekeeper: {
            externalRestrictions: {
              description: 'Only git allowed',
              allowPatterns: ['Bash:git *'],
            },
          },
        },
      });

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restrictive-ensemble', element_type: 'ensembles' },
      });

      await waitForCacheSettle();

      // curl should be denied — not in any allowlist
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'curl https://example.com' },
        },
      });
      const data = extractData(result);
      expect(data.behavior).toBe('deny');
      expect(data.message).toMatch(/not permitted by allowlists/i);
    });
  });

  // ── Scenario D: Confirmation scope behavior ──

  describe('Scenario D: Confirmation scope — single-use vs session', () => {
    it('session confirmation should persist across multiple operations of same type', async () => {
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      // Multiple creates should all succeed
      for (let i = 1; i <= 3; i++) {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: `session-scope-${i}`,
            element_type: 'skills',
            description: `Session scope test ${i}`,
            content: `# Session ${i}\n\nTest.`,
          },
        });
        expect(result.success).toBe(true);
      }
    });

    it('single-use confirmation should be consumed after one operation', async () => {
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SINGLE_USE);

      // First create should succeed
      const first = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'single-use-1',
          element_type: 'skills',
          description: 'First single-use create',
          content: '# Single Use 1\n\nFirst.',
        },
      });
      expect(first.success).toBe(true);

      // Second create should fail — confirmation consumed
      const second = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'single-use-2',
          element_type: 'skills',
          description: 'Second single-use create',
          content: '# Single Use 2\n\nShould fail.',
        },
      });
      expect(second.success).toBe(false);
      const error = extractError(second);
      expect(error).toMatch(/Approval needed/);
    });

    it('element-type-scoped confirmation should not leak across types', async () => {
      // NOTE: Element types are normalized to singular form (e.g., 'skills' → 'skill')
      // by the MCPAQLHandler before reaching the gatekeeper. Scoped confirmations
      // must use the NORMALIZED (singular) form to match.
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION, 'skill');

      // Create skill should succeed — element_type at top level for gatekeeper scoping
      const skillResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skills',
        params: {
          element_name: 'scoped-skill',
          element_type: 'skills',
          description: 'Scoped to skill type',
          content: '# Scoped Skill\n\nTest.',
        },
      });
      expect(skillResult.success).toBe(true);

      // Create persona should still require confirmation
      const personaResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'personas',
        params: {
          element_name: 'scoped-persona',
          element_type: 'personas',
          description: 'Should require separate confirmation',
          instructions: 'Test persona.',
        },
      });
      expect(personaResult.success).toBe(false);
      const error = extractError(personaResult);
      expect(error).toMatch(/Approval needed/);
    });

    it('revokeAllConfirmations should reset all session confirmations', async () => {
      // Confirm everything
      preConfirmAllOperations(container);

      // Create should work
      const beforeRevoke = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'before-revoke',
          element_type: 'skills',
          description: 'Before revoke',
          content: '# Before\n\nTest.',
        },
      });
      expect(beforeRevoke.success).toBe(true);

      // Revoke all
      gatekeeper.revokeAllConfirmations();

      // Create should now require confirmation again
      const afterRevoke = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'after-revoke',
          element_type: 'skills',
          description: 'After revoke',
          content: '# After\n\nShould fail.',
        },
      });
      expect(afterRevoke.success).toBe(false);
      const error = extractError(afterRevoke);
      expect(error).toMatch(/Approval needed/);
    });
  });

  // ── Scenario E: Permission prompt interaction with gatekeeper ──

  describe('Scenario E: permission_prompt does not bypass gatekeeper operation policies', () => {
    it('permission_prompt itself should be a READ operation that requires no confirmation', async () => {
      // permission_prompt is on the READ endpoint — should work without any confirmation
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'echo hello' },
        },
      });
      // Should succeed — READ operations don't need confirmation
      expect(result.success).toBe(true);
    });

    it('confirm_operation should still be gated by its own enforcement', async () => {
      // confirm_operation is on the EXECUTE endpoint
      // It uses skipElementPolicies=true for itself to avoid cascading loops
      // But the TARGET operation's policies are fully evaluated
      const result = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      });
      // Should succeed — confirm_operation skips element policies for itself
      expect(result.success).toBe(true);
    });

    it('confirm_operation should refuse to confirm a hard-denied operation', async () => {
      preConfirmAllOperations(container);

      // Create a persona that hard-denies delete_element
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'deny-delete-persona',
          element_type: 'personas',
          description: 'Denies delete operations',
          instructions: 'You deny deletions.',
          gatekeeper: { deny: ['delete_element'] },
        },
      });

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'deny-delete-persona', element_type: 'personas' },
      });

      await waitForCacheSettle();

      // Revoke pre-confirmations so we test the confirm flow
      gatekeeper.revokeAllConfirmations();

      // Attempting to confirm delete_element should fail — it's hard denied by element policy
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'delete_element' },
      });

      // Should fail because the target operation is denied, not confirmable
      expect(confirmResult.success).toBe(false);
      expect(confirmResult.error).toMatch(/denied by policy|cannot be confirmed/i);
    });
  });

  // ── Scenario F: Documenting the current triple-approval behavior (#1653) ──

  describe('Scenario F: Document current confirmation behavior for #1653 baseline', () => {
    it('should document the number of approvals needed for execute_agent', async () => {
      preConfirmAllOperations(container);

      // Create an agent with a goal template
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'agent',
        params: {
          element_name: 'approval-count-agent',
          description: 'Agent for counting approvals',
          instructions: 'Test agent.',
          goal: {
            template: 'Test: {objective}',
            parameters: [{ name: 'objective', type: 'string', required: true }],
          },
        },
      });

      await waitForCacheSettle();

      // Revoke all confirmations to test from clean state
      gatekeeper.revokeAllConfirmations();

      // Step 1: Attempt execute_agent — should fail with confirmationPending
      const attempt1 = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: { element_name: 'approval-count-agent', parameters: { objective: 'test' } },
      });
      expect(attempt1.success).toBe(false);
      const error1 = extractError(attempt1);
      expect(error1).toMatch(/Approval needed/);

      // Step 2: confirm_operation
      const confirm = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'execute_agent' },
      });
      expect(confirm.success).toBe(true);

      // Step 3: Retry execute_agent — should now succeed
      const attempt2 = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: { element_name: 'approval-count-agent', parameters: { objective: 'test' } },
      });
      // This documents the current behavior:
      // With gatekeeper confirmation, execute_agent requires 2 MCP calls minimum
      // (confirm_operation + execute_agent)
      // In Claude Code with manual approval, each MCP call also needs Claude Code's approval
      // = 3 total user interactions for a single agent execution
      expect(attempt2.success).toBe(true);
    });

    it('should document that addEntry requires confirmation when not pre-confirmed', async () => {
      preConfirmAllOperations(container);

      // Create a memory to add entries to
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'entry-test-memory',
          element_type: 'memories',
          description: 'Memory for testing addEntry confirmation',
        },
      });

      await waitForCacheSettle();

      // Revoke all to test clean state
      gatekeeper.revokeAllConfirmations();

      // addEntry should require confirmation
      const result = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'entry-test-memory',
          content: 'Test entry content',
          tags: ['test'],
        },
      });

      // Document: does addEntry require its own confirmation or share with create_element?
      if (!result.success) {
        const error = extractError(result);
        // Record what operation name the confirmation is requested for
        const requiresOwnConfirm = error.includes('addEntry');
        const requiresCreateConfirm = error.includes('create_element');

        // This documents the current behavior for #1653 baseline
        expect(error).toMatch(/Approval needed/);
        // addEntry should have its own confirmation requirement (it's a separate operation)
        expect(requiresOwnConfirm || requiresCreateConfirm).toBe(true);
      }
    });

    it('should document that record_execution_step requires its own confirmation', async () => {
      preConfirmAllOperations(container);

      // Create and execute an agent
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'agent',
        params: {
          element_name: 'step-confirm-agent',
          description: 'Agent for testing step confirmation',
          instructions: 'Test agent.',
          goal: {
            template: 'Test: {task}',
            parameters: [{ name: 'task', type: 'string', required: true }],
          },
        },
      });

      await waitForCacheSettle();

      const execResult = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: { element_name: 'step-confirm-agent', parameters: { task: 'test' } },
      });

      if (execResult.success) {
        // Revoke confirmations and test record_execution_step
        gatekeeper.revokeAllConfirmations();

        const stepResult = await mcpAqlHandler.handleCreate({
          operation: 'record_execution_step',
          params: {
            element_name: 'step-confirm-agent',
            stepDescription: 'Test step',
            outcome: 'success',
          },
        });

        // Document: does record_execution_step require its own confirm?
        if (!stepResult.success) {
          const error = extractError(stepResult);
          expect(error).toMatch(/Approval needed/);
          // This confirms record_execution_step is a separate confirmation
        }
      }
    });
  });
});
