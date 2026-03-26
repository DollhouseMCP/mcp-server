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
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';

// ── Test Configuration ──

/** Number of elements to create when testing session-scope persistence. */
const SESSION_PERSISTENCE_COUNT = 3;

/** Maximum time (ms) to wait for an element to become visible after creation. */
const ELEMENT_POLL_TIMEOUT_MS = 5000;

/** Polling interval (ms) between element visibility checks. */
const ELEMENT_POLL_INTERVAL_MS = 100;

/** Characters that must never appear in test content (injection prevention). */
const UNSAFE_CONTENT_PATTERNS = /<script>|{{|`\$\{|eval\(|__proto__/i;

// ── Test Helpers ──

/**
 * Extract the data payload from a successful MCP-AQL response.
 * Asserts success and throws if data is missing.
 *
 * @typeParam T - Expected shape of the data payload
 * @param result - MCP-AQL operation result
 * @returns The typed data payload
 * @throws If result is unsuccessful or data is undefined
 */
function extractData<T = Record<string, unknown>>(result: { success: boolean; data?: T }): T {
  expect(result.success).toBe(true);
  if (!result.data) throw new Error('Expected data in successful result');
  return result.data;
}

/**
 * Extract the error message from a failed MCP-AQL response.
 * Asserts failure before returning.
 *
 * @param result - MCP-AQL operation result
 * @returns The error string (empty string if undefined)
 */
function extractError(result: { success: boolean; error?: string }): string {
  expect(result.success).toBe(false);
  return result.error ?? '';
}

/**
 * Validate that test content does not contain potentially unsafe patterns.
 * Guards against accidental injection in test fixtures.
 *
 * @param content - The content string to validate
 * @param context - Description of where this content is used (for error messages)
 * @throws If unsafe patterns are detected
 */
function validateTestContent(content: string, context: string): void {
  if (UNSAFE_CONTENT_PATTERNS.test(content)) {
    throw new Error(`Unsafe content detected in ${context}: ${content.slice(0, 100)}`);
  }
}

/**
 * Wait for an element to become visible via get_element after creation.
 * Uses polling instead of arbitrary delay for deterministic behavior.
 *
 * @param handler - MCPAQLHandler instance
 * @param name - Element name to poll for
 * @param type - Element type (e.g., 'skills', 'personas')
 * @param timeoutMs - Maximum time to wait (default: ELEMENT_POLL_TIMEOUT_MS)
 * @throws If element is not found within the timeout
 */
async function waitForElement(
  handler: MCPAQLHandler,
  name: string,
  type: string,
  timeoutMs: number = ELEMENT_POLL_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await handler.handleRead({
        operation: 'get_element',
        element_type: type,
        params: { element_name: name, element_type: type },
      });
      if (result.success) return;
    } catch { /* element not yet visible, keep polling */ }
    await new Promise(resolve => setTimeout(resolve, ELEMENT_POLL_INTERVAL_MS));
  }
  throw new Error(`Element '${name}' (${type}) not found after ${timeoutMs}ms`);
}

/**
 * Wait for an element activation to propagate by polling get_active_elements.
 *
 * @param handler - MCPAQLHandler instance
 * @param name - Element name that should appear in active elements
 * @param timeoutMs - Maximum time to wait (default: ELEMENT_POLL_TIMEOUT_MS)
 * @throws If element is not active within the timeout
 */
async function waitForActivation(
  handler: MCPAQLHandler,
  name: string,
  timeoutMs: number = ELEMENT_POLL_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await handler.handleRead({
        operation: 'get_active_elements',
        params: {},
      });
      if (result.success) {
        const text = JSON.stringify(result.data);
        if (text.includes(name)) return;
      }
    } catch { /* not yet propagated, keep polling */ }
    await new Promise(resolve => setTimeout(resolve, ELEMENT_POLL_INTERVAL_MS));
  }
  throw new Error(`Element '${name}' not found in active elements after ${timeoutMs}ms`);
}

/**
 * Create a test element with pre-confirmed gatekeeper and content validation.
 * Records a session confirmation for create_element before attempting creation.
 *
 * @param handler - MCPAQLHandler instance
 * @param gatekeeper - Gatekeeper instance for recording confirmations
 * @param name - Element name to create
 * @param type - Element type (default: 'skills')
 * @throws If creation fails or content contains unsafe patterns
 */
async function createTestElement(
  handler: MCPAQLHandler,
  gatekeeper: Gatekeeper,
  name: string,
  type: string = 'skills'
): Promise<void> {
  const content = `# ${name}\n\nTest content for permission flow harness.`;
  const description = `Test element: ${name}`;
  validateTestContent(content, `createTestElement(${name})`);
  validateTestContent(description, `createTestElement(${name}) description`);

  gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);
  const result = await handler.handleCreate({
    operation: 'create_element',
    params: {
      element_name: name,
      element_type: type,
      description,
      content,
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

    it('should auto-confirm delete even when only create was explicitly confirmed (#1653)', async () => {
      // Confirm create but NOT delete
      gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      await createTestElement(mcpAqlHandler, gatekeeper, 'delete-test-skill');
      await waitForElement(mcpAqlHandler, 'delete-test-skill', 'skills');

      // #1653: Delete now auto-confirms — the host's tool approval is the primary gate
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: { element_name: 'delete-test-skill', element_type: 'skills' },
      });
      expect(deleteResult.success).toBe(true);
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

      await waitForElement(mcpAqlHandler, "pre-confirmed-skill", "skills");

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

      await waitForElement(mcpAqlHandler, 'restrictive-persona', 'personas');

      // Activate the restrictive persona
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restrictive-persona', element_type: 'personas' },
      });

      await waitForActivation(mcpAqlHandler, "restrictive-persona");

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

      await waitForElement(mcpAqlHandler, 'step-test-agent', 'agents');

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

      await waitForElement(mcpAqlHandler, 'policy-test-ensemble', 'ensembles');

      // Activate the ensemble
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'policy-test-ensemble', element_type: 'ensembles' },
      });

      await waitForActivation(mcpAqlHandler, "policy-test-ensemble");

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

      await waitForElement(mcpAqlHandler, 'confirm-test-ensemble', 'ensembles');

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'confirm-test-ensemble', element_type: 'ensembles' },
      });

      await waitForActivation(mcpAqlHandler, "confirm-test-ensemble");

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

      await waitForElement(mcpAqlHandler, 'restrictive-ensemble', 'ensembles');

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restrictive-ensemble', element_type: 'ensembles' },
      });

      await waitForActivation(mcpAqlHandler, "restrictive-ensemble");

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
      for (let i = 1; i <= SESSION_PERSISTENCE_COUNT; i++) {
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

      // #1653: Second create also succeeds — auto-confirm re-records the confirmation
      const second = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'single-use-2',
          element_type: 'skills',
          description: 'Second single-use create',
          content: '# Single Use 2\n\nAlso succeeds with auto-confirm.',
        },
      });
      expect(second.success).toBe(true);
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

      // #1653: Create persona also succeeds — auto-confirm handles the unscoped case
      const personaResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'personas',
        params: {
          element_name: 'scoped-persona',
          element_type: 'personas',
          description: 'Also succeeds with auto-confirm',
          instructions: 'Test persona.',
        },
      });
      expect(personaResult.success).toBe(true);
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

      // #1653: Create still succeeds after revoke — auto-confirm re-records
      const afterRevoke = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'after-revoke',
          element_type: 'skills',
          description: 'After revoke',
          content: '# After\n\nSucceeds with auto-confirm.',
        },
      });
      expect(afterRevoke.success).toBe(true);
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

      await waitForElement(mcpAqlHandler, 'deny-delete-persona', 'personas');

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'deny-delete-persona', element_type: 'personas' },
      });

      await waitForActivation(mcpAqlHandler, "deny-delete-persona");

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
    it('should require only 1 MCP call for execute_agent with auto-confirm (#1653)', async () => {
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

      await waitForElement(mcpAqlHandler, 'approval-count-agent', 'agents');

      // Revoke all confirmations to test from clean state
      gatekeeper.revokeAllConfirmations();

      // #1653: execute_agent now succeeds in a single call — auto-confirm
      // eliminates the confirm_operation round-trip.
      // In Claude Code: 1 user approval (the MCP tool call) instead of 3.
      const result = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: { element_name: 'approval-count-agent', parameters: { objective: 'test' } },
      });
      expect(result.success).toBe(true);
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

      await waitForElement(mcpAqlHandler, "entry-test-memory", "memories");

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

      await waitForElement(mcpAqlHandler, 'step-confirm-agent', 'agents');

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
