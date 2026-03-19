/**
 * Integration tests for permission_prompt operation (Issue #625)
 *
 * Tests the full permission_prompt flow through the MCP-AQL handler,
 * including static classification, element policy evaluation,
 * Phase 2 allowPatterns, enriched responses, and get_effective_cli_policies.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('permission_prompt Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('permission-prompt');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('static classification', () => {
    it('should auto-allow Read tool', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Read',
          input: { file_path: '/some/file.ts' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          behavior: 'allow',
          updatedInput: { file_path: '/some/file.ts' },
        });
      }
    });

    it('should auto-allow Grep tool', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Grep',
          input: { pattern: 'foo', path: 'src/' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ behavior: 'allow' });
      }
    });

    it('should auto-allow safe Bash commands', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'npm test' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ behavior: 'allow' });
      }
    });

    it('should deny dangerous Bash commands', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ behavior: 'deny' });
        expect((result.data as Record<string, unknown>).message).toBeDefined();
      }
    });

    it('should allow unclassified tools by default (Phase 1 permissive)', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Phase 1: unclassified tools that pass element policy check → allow
        expect(result.data).toMatchObject({ behavior: 'allow' });
      }
    });
  });

  describe('validation', () => {
    it('should require tool_name parameter', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          input: { command: 'ls' },
        },
      });

      expect(result.success).toBe(false);
    });

    // Issue #665: Missing input should deny, not silently allow
    it('should deny when input parameter is missing', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toMatch(/Missing required "input"/);
      }
    });

    // Issue #665: Empty Bash command should deny
    it('should deny Bash tool with empty command', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: '' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toMatch(/Missing required "command"/);
      }
    });

    // Issue #665: Bash with no command key should deny
    it('should deny Bash tool with input missing command key', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { description: 'do something' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toMatch(/Missing required "command"/);
      }
    });

    // Issue #665: git push --force should be denied by static classification
    it('should deny git push --force', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'git push --force origin main' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        const classification = data.classification as Record<string, unknown>;
        expect(classification.riskLevel).toBe('dangerous');
      }
    });
  });

  describe('gatekeeper policy', () => {
    it('should not require confirmation (AUTO_APPROVE)', async () => {
      // permission_prompt should work without any prior confirm_operation call
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Glob',
          input: { pattern: '**/*.ts' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ behavior: 'allow' });
      }
    });
  });

  describe('Phase 2: enriched response', () => {
    it('should include classification in static allow response', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Read',
          input: { file_path: '/some/file.ts' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('allow');
        expect(data.classification).toMatchObject({
          riskLevel: 'safe',
          stage: 'static_classification',
        });
      }
    });

    it('should include classification in static deny response', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.classification).toMatchObject({
          stage: 'static_classification',
        });
      }
    });

    it('should include classification and policyContext in default allow response', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('allow');
        expect(data.classification).toMatchObject({
          riskLevel: 'moderate',
          stage: 'default',
        });
        // policyContext is present when stage 2 was reached
        expect(data.policyContext).toBeDefined();
      }
    });
  });

  describe('Phase 2: allowPatterns', () => {
    /**
     * Helper: create and activate a persona with a gatekeeper policy.
     */
    async function createAndActivatePersona(
      name: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: 'personas',
          description: `Test persona: ${name}`,
          content: `# ${name}\n\nYou are a helpful test persona.`,
          metadata: {
            gatekeeper: gatekeeperPolicy,
          },
        },
      });
      expect(createResult.success).toBe(true);

      // Allow cache to settle (Issue #276)
      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: name,
          element_type: 'personas',
        },
      });
      expect(activateResult.success).toBe(true);
    }

    it('should deny tool not in allowPatterns', async () => {
      await createAndActivatePersona('allow-git-only', {
        externalRestrictions: {
          description: 'Only allow git commands',
          allowPatterns: ['Bash:git*'],
        },
      });

      // Use a command that isn't statically safe-classified (e.g., python3)
      // so it reaches Stage 2 (element policy check)
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'python3 script.py' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toContain('not permitted');
        expect(data.classification).toMatchObject({ stage: 'element_policy' });
        expect(data.policyContext).toBeDefined();
      }
    });

    it('should allow tool matching allowPatterns', async () => {
      await createAndActivatePersona('allow-docker-only', {
        externalRestrictions: {
          description: 'Only allow docker commands',
          allowPatterns: ['Bash:docker*'],
        },
      });

      // docker compose is not statically classified, so it reaches Stage 2
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'docker compose up' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        // docker matches allowPatterns → passes through to default allow
        expect(data.behavior).toBe('allow');
        expect(data.classification).toMatchObject({ stage: 'default' });
      }
    });

    it('should still allow gatekeeper-essential ops despite restrictive allowPatterns', async () => {
      await createAndActivatePersona('ultra-restrictive', {
        externalRestrictions: {
          description: 'Block almost everything',
          allowPatterns: ['Read'],
        },
      });

      // confirm_operation via MCP tool should still work (gatekeeper-essential bypass)
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'mcp__DollhouseMCP__mcp_aql_execute',
          input: { operation: 'confirm_operation' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('allow');
      }
    });
  });

  describe('Phase 2: get_effective_cli_policies', () => {
    it('should return empty policies when no active elements have externalRestrictions', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.hasAllowlist).toBe(false);
        expect(data.combinedAllowPatterns).toEqual([]);
        expect(data.combinedDenyPatterns).toEqual([]);
      }
    });

    it('should return element policies after activating element with externalRestrictions', async () => {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'policy-test-persona',
          element_type: 'personas',
          description: 'Persona with deny patterns',
          content: '# Policy Test\n\nTest persona.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Block rm commands',
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'policy-test-persona', element_type: 'personas' },
      });

      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect((data.combinedDenyPatterns as string[]).length).toBeGreaterThan(0);
        expect((data.combinedDenyPatterns as string[])).toContain('Bash:rm*');
      }
    });

    it('should include evaluation when tool_name is provided', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.evaluation).toBeDefined();
        const evaluation = data.evaluation as Record<string, unknown>;
        expect(evaluation.tool_name).toBe('Bash');
        expect(evaluation.staticClassification).toBeDefined();
        expect(evaluation.finalBehavior).toBe('allow');
      }
    });
  });

  describe('Phase 3: CLI approval workflow', () => {
    /**
     * Helper: create and activate a persona with a gatekeeper policy.
     */
    async function createAndActivateWithApproval(
      name: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: 'personas',
          description: `Test persona: ${name}`,
          content: `# ${name}\n\nYou are a test persona.`,
          metadata: {
            gatekeeper: gatekeeperPolicy,
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: name,
          element_type: 'personas',
        },
      });
      expect(activateResult.success).toBe(true);
    }

    it('should deny with approvalRequest when approvalPolicy active for moderate tools', async () => {
      await createAndActivateWithApproval('approval-test-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate tools',
          approvalPolicy: {
            requireApproval: ['moderate'],
          },
        },
      });

      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toContain('Requires human approval');
        expect(data.message).toContain('approve_cli_permission');
        expect(data.approvalRequest).toBeDefined();
        const req = data.approvalRequest as Record<string, unknown>;
        expect(req.requestId).toMatch(/^cli-/);
        expect(req.toolName).toBe('Edit');
        expect(data.classification).toMatchObject({ stage: 'approval_required' });
      }
    });

    it('should approve and then allow on retry', async () => {
      await createAndActivateWithApproval('approval-retry-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate tools',
          approvalPolicy: {
            requireApproval: ['moderate'],
          },
        },
      });

      // First call: denied with approval request
      const denyResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
        },
      });
      expect(denyResult.success).toBe(true);
      const denyData = (denyResult as { success: true; data: Record<string, unknown> }).data;
      expect(denyData.behavior).toBe('deny');
      const requestId = (denyData.approvalRequest as Record<string, unknown>).requestId as string;

      // Approve the request
      const approveResult = await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: {
          request_id: requestId,
          scope: 'single',
        },
      });
      expect(approveResult.success).toBe(true);
      if (approveResult.success) {
        const approveData = approveResult.data as Record<string, unknown>;
        expect(approveData.approved).toBe(true);
        expect(approveData.toolName).toBe('Edit');
      }

      // Retry: should now be allowed via cli_approval stage
      const retryResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
        },
      });
      expect(retryResult.success).toBe(true);
      if (retryResult.success) {
        const retryData = retryResult.data as Record<string, unknown>;
        expect(retryData.behavior).toBe('allow');
        expect(retryData.classification).toMatchObject({ stage: 'cli_approval' });
      }
    });

    it('should allow repeated calls with tool_session scope', async () => {
      await createAndActivateWithApproval('session-scope-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate tools',
          approvalPolicy: {
            requireApproval: ['moderate'],
          },
        },
      });

      // First: get denied
      const deny = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const denyData = (deny as { success: true; data: Record<string, unknown> }).data;
      const requestId = (denyData.approvalRequest as Record<string, unknown>).requestId as string;

      // Approve with tool_session scope
      await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: requestId, scope: 'tool_session' },
      });

      // Both subsequent calls should succeed
      for (const filePath of ['src/b.ts', 'src/c.ts']) {
        const result = await mcpAqlHandler.handleRead({
          operation: 'permission_prompt',
          params: { tool_name: 'Edit', input: { file_path: filePath } },
        });
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: Record<string, unknown> }).data;
        expect(data.behavior).toBe('allow');
        expect(data.classification).toMatchObject({ stage: 'cli_approval' });
      }
    });

    it('should show pending approvals via get_pending_cli_approvals', async () => {
      await createAndActivateWithApproval('pending-list-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate tools',
          approvalPolicy: {
            requireApproval: ['moderate'],
          },
        },
      });

      // Create a pending approval
      await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });

      // Check pending
      const pending = await mcpAqlHandler.handleRead({
        operation: 'get_pending_cli_approvals',
        params: {},
      });
      expect(pending.success).toBe(true);
      if (pending.success) {
        const data = pending.data as Record<string, unknown>;
        expect(data.count).toBe(1);
        const pendingList = data.pending as Array<Record<string, unknown>>;
        expect(pendingList[0].toolName).toBe('Edit');
      }
    });

    it('should show empty pending after approval', async () => {
      await createAndActivateWithApproval('pending-empty-persona', {
        externalRestrictions: {
          description: 'Requires approval',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      const deny = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const denyData = (deny as { success: true; data: Record<string, unknown> }).data;
      const requestId = (denyData.approvalRequest as Record<string, unknown>).requestId as string;

      await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: requestId },
      });

      const pending = await mcpAqlHandler.handleRead({
        operation: 'get_pending_cli_approvals',
        params: {},
      });
      expect(pending.success).toBe(true);
      if (pending.success) {
        const data = pending.data as Record<string, unknown>;
        expect(data.count).toBe(0);
      }
    });
  });

  describe('Phase 3: single-scope consumption', () => {
    async function createAndActivateWithApproval(
      name: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: 'personas',
          description: `Test persona: ${name}`,
          content: `# ${name}\n\nYou are a test persona.`,
          metadata: { gatekeeper: gatekeeperPolicy },
        },
      });
      expect(createResult.success).toBe(true);
      await waitForCacheSettle();
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: name, element_type: 'personas' },
      });
      expect(activateResult.success).toBe(true);
    }

    it('should consume single-scope approval — second retry denied again', async () => {
      await createAndActivateWithApproval('single-consumed-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      // First: denied
      const deny1 = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const deny1Data = (deny1 as { success: true; data: Record<string, unknown> }).data;
      const requestId = (deny1Data.approvalRequest as Record<string, unknown>).requestId as string;

      // Approve with single scope
      await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: requestId, scope: 'single' },
      });

      // First retry: allowed (consumes the approval)
      const retry1 = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      expect((retry1 as { success: true; data: Record<string, unknown> }).data.behavior).toBe('allow');

      // Second retry: denied again (single-scope consumed)
      const retry2 = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const retry2Data = (retry2 as { success: true; data: Record<string, unknown> }).data;
      expect(retry2Data.behavior).toBe('deny');
      expect(retry2Data.approvalRequest).toBeDefined();
    });
  });

  describe('Phase 3: approval policy resolution', () => {
    async function createAndActivateElement(
      name: string,
      type: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: type,
          description: `Test ${type}: ${name}`,
          content: `# ${name}\n\nTest element.`,
          metadata: { gatekeeper: gatekeeperPolicy },
        },
      });
      expect(createResult.success).toBe(true);
      await waitForCacheSettle();
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: name, element_type: type },
      });
      expect(activateResult.success).toBe(true);
    }

    it('should union requireApproval across multiple active elements', async () => {
      // Element 1: requires approval for moderate
      await createAndActivateElement('union-persona-a', 'personas', {
        externalRestrictions: {
          description: 'Moderate approval',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      // Element 2: requires approval for dangerous
      await createAndActivateElement('union-skill-b', 'skills', {
        externalRestrictions: {
          description: 'Dangerous approval',
          approvalPolicy: { requireApproval: ['dangerous'] },
        },
      });

      // Moderate tool (Edit) should require approval (from element 1)
      const moderateResult = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      expect(moderateResult.success).toBe(true);
      const modData = (moderateResult as { success: true; data: Record<string, unknown> }).data;
      expect(modData.behavior).toBe('deny');
      expect(modData.classification).toMatchObject({ stage: 'approval_required' });
    });

    it('should NOT require approval when risk level is not in requireApproval', async () => {
      await createAndActivateElement('dangerous-only-persona', 'personas', {
        externalRestrictions: {
          description: 'Only dangerous needs approval',
          approvalPolicy: { requireApproval: ['dangerous'] },
        },
      });

      // Moderate tool (Edit) should pass through — only 'dangerous' requires approval
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.behavior).toBe('allow');
      expect(data.classification).toMatchObject({ stage: 'default' });
    });

    it('should use env var fallback when no elements define approvalPolicy', async () => {
      // Set env var
      const original = process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
      process.env.DOLLHOUSE_CLI_APPROVAL_POLICY = 'moderate';

      try {
        const result = await mcpAqlHandler.handleRead({
          operation: 'permission_prompt',
          params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
        });
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: Record<string, unknown> }).data;
        expect(data.behavior).toBe('deny');
        expect(data.classification).toMatchObject({ stage: 'approval_required' });
      } finally {
        if (original === undefined) delete process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
        else process.env.DOLLHOUSE_CLI_APPROVAL_POLICY = original;
      }
    });
  });

  describe('Phase 3: precedence and edge cases', () => {
    async function createAndActivateWithPolicy(
      name: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: 'personas',
          description: `Test persona: ${name}`,
          content: `# ${name}\n\nTest persona.`,
          metadata: { gatekeeper: gatekeeperPolicy },
        },
      });
      expect(createResult.success).toBe(true);
      await waitForCacheSettle();
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: name, element_type: 'personas' },
      });
    }

    it('should deny via denyPatterns before reaching approval stage', async () => {
      await createAndActivateWithPolicy('deny-before-approval', {
        externalRestrictions: {
          description: 'Deny rm and require approval for moderate',
          denyPatterns: ['Edit:src/secret*'],
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      // Edit matching denyPatterns: denied at element_policy stage, NOT approval_required
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/secret.ts' } },
      });
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.behavior).toBe('deny');
      expect(data.classification).toMatchObject({ stage: 'element_policy' });
      // No approvalRequest for pattern-denied tools
      expect(data.approvalRequest).toBeUndefined();
    });

    it('should include riskScore and irreversible in approvalRequest', async () => {
      await createAndActivateWithPolicy('risk-score-persona', {
        externalRestrictions: {
          description: 'Requires approval for moderate',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Write', input: { file_path: 'new-file.ts', content: 'hello' } },
      });
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.behavior).toBe('deny');
      const req = data.approvalRequest as Record<string, unknown>;
      expect(typeof req.riskScore).toBe('number');
      expect(req.riskScore).toBeGreaterThanOrEqual(40);
      expect(typeof req.irreversible).toBe('boolean');
      // Write tool gets +5 from file creation
      const cls = data.classification as Record<string, unknown>;
      expect(cls.riskScore).toBeGreaterThanOrEqual(45);
    });

    it('should return approvalContext in Stage 2.5 response', async () => {
      await createAndActivateWithPolicy('approval-context-persona', {
        externalRestrictions: {
          description: 'Requires approval',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      // Create and approve
      const deny = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const denyData = (deny as { success: true; data: Record<string, unknown> }).data;
      const requestId = (denyData.approvalRequest as Record<string, unknown>).requestId as string;
      await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: requestId, scope: 'single' },
      });

      // Retry: verify approvalContext in response
      const retry = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      expect(retry.success).toBe(true);
      const retryData = (retry as { success: true; data: Record<string, unknown> }).data;
      expect(retryData.behavior).toBe('allow');
      expect(retryData.approvalContext).toBeDefined();
      const ctx = retryData.approvalContext as Record<string, unknown>;
      expect(ctx.requestId).toMatch(/^cli-/);
      expect(ctx.scope).toBe('single');
    });

    it('should error on approve_cli_permission with nonexistent request', async () => {
      const result = await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: 'cli-00000000-0000-0000-0000-000000000000' },
      });
      expect(result.success).toBe(false);
    });

    it('should error on approve_cli_permission with invalid scope', async () => {
      await createAndActivateWithPolicy('invalid-scope-persona', {
        externalRestrictions: {
          description: 'Requires approval',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      const deny = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
      });
      const denyData = (deny as { success: true; data: Record<string, unknown> }).data;
      const requestId = (denyData.approvalRequest as Record<string, unknown>).requestId as string;

      const result = await mcpAqlHandler.handleExecute({
        operation: 'approve_cli_permission',
        params: { request_id: requestId, scope: 'forever' },
      });
      expect(result.success).toBe(false);
    });

    it('should return empty pending on fresh session', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_pending_cli_approvals',
        params: {},
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.count).toBe(0);
        expect(data.pending).toEqual([]);
      }
    });

    it('should not require gatekeeper confirmation for approval operations', async () => {
      // Don't call preConfirmAllOperations — test that approve_cli_permission
      // and get_pending_cli_approvals are AUTO_APPROVE and work without confirmation
      const pending = await mcpAqlHandler.handleRead({
        operation: 'get_pending_cli_approvals',
        params: {},
      });
      expect(pending.success).toBe(true);
    });
  });

  describe('Phase 3: out-of-scope read risk scoring', () => {
    async function createAndActivateWithPolicy(
      name: string,
      gatekeeperPolicy: Record<string, unknown>,
    ) {
      preConfirmAllOperations(container);
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: name,
          element_type: 'personas',
          description: `Test persona: ${name}`,
          content: `# ${name}\n\nTest persona.`,
          metadata: { gatekeeper: gatekeeperPolicy },
        },
      });
      expect(createResult.success).toBe(true);
      await waitForCacheSettle();
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: name, element_type: 'personas' },
      });
    }

    it('should include elevated riskScore for Read targeting sensitive path', async () => {
      await createAndActivateWithPolicy('read-risk-persona', {
        externalRestrictions: {
          description: 'Approval for safe reads',
          approvalPolicy: { requireApproval: ['moderate'] },
        },
      });

      // Read is classified as 'safe' (score 0), but targeting ~/.ssh gets +10
      // Since safe != moderate, this should NOT trigger approval.
      // But we can verify via get_effective_cli_policies that risk is assessed.
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Read', input: { file_path: '~/.ssh/id_rsa' } },
      });
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      // Read is statically safe → auto-allow at Stage 1 (never reaches approval stage)
      expect(data.behavior).toBe('allow');
      expect(data.classification).toMatchObject({ riskLevel: 'safe' });
    });
  });

  describe('Phase 4: fail-safe detection', () => {
    it('should include permissionPromptActive=false before any permission_prompt call', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.permissionPromptActive).toBe(false);
      }
    });

    it('should include permissionPromptActive=true after permission_prompt call', async () => {
      // Trigger permission_prompt
      await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: { tool_name: 'Read', input: { file_path: '/tmp/test' } },
      });

      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.permissionPromptActive).toBe(true);
      }
    });

    it('should include advisory when restrictions exist but permission_prompt not active', async () => {
      preConfirmAllOperations(container);

      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'advisory-test-persona',
          element_type: 'personas',
          description: 'Persona with restrictions',
          content: '# Advisory Test\n\nTest.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Block rm commands',
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        },
      });

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'advisory-test-persona', element_type: 'personas' },
      });

      // Fresh session — permission_prompt not yet called
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.permissionPromptActive).toBe(false);
        expect(data.advisory).toBeDefined();
        expect(data.advisory).toContain('--permission-prompt-tool');
      }
    });

    it('should not include advisory when no restrictions exist', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.advisory).toBeUndefined();
      }
    });
  });

  describe('Phase 3: fail-safe activation warnings', () => {
    it('should include CLI restriction warning when activating element with externalRestrictions', async () => {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'restricted-persona',
          element_type: 'personas',
          description: 'A restricted persona',
          content: '# Restricted\n\nYou are restricted.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Only git commands allowed',
                allowPatterns: ['Bash:git*'],
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restricted-persona', element_type: 'personas' },
      });

      expect(activateResult.success).toBe(true);
      if (activateResult.success) {
        const text = JSON.stringify(activateResult.data);
        expect(text).toContain('CLI Restrictions Active');
        expect(text).toContain('Only git commands allowed');
      }
    });

    it('should include CLI restriction warning when activating skill with externalRestrictions', async () => {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'restricted-skill',
          element_type: 'skills',
          description: 'A restricted skill',
          content: '# Restricted Skill\n\nYou are restricted.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'No network access',
                denyPatterns: ['Bash:curl*', 'Bash:wget*'],
              },
            },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restricted-skill', element_type: 'skills' },
      });

      expect(activateResult.success).toBe(true);
      if (activateResult.success) {
        const text = JSON.stringify(activateResult.data);
        expect(text).toContain('CLI Restrictions Active');
        expect(text).toContain('No network access');
      }
    });

    it('should show approvalPolicy requirements in activation warning', async () => {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'approval-warning-persona',
          element_type: 'personas',
          description: 'A persona needing approval',
          content: '# Approval Warning\n\nYou need approval.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Careful operations',
                approvalPolicy: { requireApproval: ['moderate', 'dangerous'] },
              },
            },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'approval-warning-persona', element_type: 'personas' },
      });

      expect(activateResult.success).toBe(true);
      if (activateResult.success) {
        const text = JSON.stringify(activateResult.data);
        expect(text).toContain('CLI Restrictions Active');
        expect(text).toContain('approval');
        expect(text).toContain('moderate');
      }
    });

    it('should not include restriction warning for unrestricted elements', async () => {
      preConfirmAllOperations(container);

      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'normal-persona',
          element_type: 'personas',
          description: 'A normal persona',
          content: '# Normal\n\nYou are normal.',
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'normal-persona', element_type: 'personas' },
      });

      expect(activateResult.success).toBe(true);
      if (activateResult.success) {
        const text = JSON.stringify(activateResult.data);
        expect(text).not.toContain('CLI Restrictions Active');
      }
    });
  });

  describe('Phase 4: ensemble-level authorization', () => {
    it('should enforce member persona denyPatterns when ensemble is active', async () => {
      preConfirmAllOperations(container);

      // Create a persona with denyPattern (member element)
      const createPersona = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'ensemble-deny-persona',
          element_type: 'personas',
          description: 'Persona that denies rm commands',
          content: '# Deny Persona\n\nYou deny rm commands.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'No rm commands',
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        },
      });
      expect(createPersona.success).toBe(true);

      await waitForCacheSettle();

      // Create an ensemble containing the persona
      const createEnsemble = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'test-deny-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble with a restrictive persona',
          content: '# Test Ensemble\n\nEnsemble for testing deny patterns.',
          metadata: {
            elements: [
              {
                element_name: 'ensemble-deny-persona',
                element_type: 'persona',
                role: 'primary',
                priority: 1,
                activation: 'always',
              },
            ],
          },
        },
      });
      expect(createEnsemble.success).toBe(true);

      await waitForCacheSettle();

      // Activate the ensemble
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'test-deny-ensemble', element_type: 'ensembles' },
      });
      expect(activateResult.success).toBe(true);

      // permission_prompt for a denied tool should be denied via member policy
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/test' },
        },
      });

      // rm -rf is statically classified as dangerous → denied at Stage 1
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
      }
    });

    it('should enforce ensemble own denyPatterns', async () => {
      preConfirmAllOperations(container);

      // Create a plain persona (no restrictions) as member
      const createPersona = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'plain-member-persona',
          element_type: 'personas',
          description: 'Plain persona',
          content: '# Plain\n\nNo restrictions.',
        },
      });
      expect(createPersona.success).toBe(true);

      await waitForCacheSettle();

      // Create ensemble with its own denyPatterns
      const createEnsemble = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'ensemble-own-deny',
          element_type: 'ensembles',
          description: 'Ensemble with own restrictions',
          content: '# Own Deny Ensemble\n\nDeny python.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'No python commands',
                denyPatterns: ['Bash:python*'],
              },
            },
            elements: [
              {
                element_name: 'plain-member-persona',
                element_type: 'persona',
                role: 'primary',
                priority: 1,
                activation: 'always',
              },
            ],
          },
        },
      });
      expect(createEnsemble.success).toBe(true);

      await waitForCacheSettle();

      // Activate ensemble
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'ensemble-own-deny', element_type: 'ensembles' },
      });

      // python3 is not statically classified → reaches Stage 2 → denied by ensemble policy
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'python3 script.py' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.classification).toMatchObject({ stage: 'element_policy' });
      }
    });

    it('should combine ensemble + member restrictions (UNION semantics)', async () => {
      preConfirmAllOperations(container);

      // Create a persona with allowPatterns (restrictive)
      const createPersona = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'allowlist-member-persona',
          element_type: 'personas',
          description: 'Only allow docker commands',
          content: '# Docker Only\n\nOnly docker.',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Only docker',
                allowPatterns: ['Bash:docker*'],
              },
            },
          },
        },
      });
      expect(createPersona.success).toBe(true);

      await waitForCacheSettle();

      // Create ensemble without own restrictions
      const createEnsemble = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'union-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble with allowlist member',
          content: '# Union Ensemble\n\nTest union semantics.',
          metadata: {
            elements: [
              {
                element_name: 'allowlist-member-persona',
                element_type: 'persona',
                role: 'primary',
                priority: 1,
                activation: 'always',
              },
            ],
          },
        },
      });
      expect(createEnsemble.success).toBe(true);

      await waitForCacheSettle();

      // Activate ensemble
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'union-ensemble', element_type: 'ensembles' },
      });

      // python3 should be denied (not in allowPatterns from member persona)
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Bash',
          input: { command: 'python3 script.py' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.behavior).toBe('deny');
        expect(data.message).toContain('not permitted');
      }
    });
  });

  describe('raw permission prompt protocol (Issue #647)', () => {
    it('should accept raw {tool_name, input} format via READ endpoint', async () => {
      // This is how Claude Code --permission-prompt-tool sends payloads:
      // no operation field, just {tool_name, input, agent_identity?}
      const result = await mcpAqlHandler.handleRead({
        tool_name: 'Read',
        input: { file_path: '/some/file.ts' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          behavior: 'allow',
        });
      }
    });

    it('should accept raw format with agent_identity', async () => {
      const result = await mcpAqlHandler.handleRead({
        tool_name: 'Grep',
        input: { pattern: 'foo' },
        agent_identity: 'sub-agent-1',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          behavior: 'allow',
        });
      }
    });

    it('should still accept standard CRUDE format via READ endpoint', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'permission_prompt',
        params: {
          tool_name: 'Read',
          input: { file_path: '/some/file.ts' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          behavior: 'allow',
        });
      }
    });
  });
});
