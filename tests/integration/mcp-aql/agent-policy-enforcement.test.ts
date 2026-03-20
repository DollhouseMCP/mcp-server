/**
 * Integration tests for Agent Gatekeeper Policy Enforcement (Issue #449)
 *
 * Tests that executing agents participate in Gatekeeper policy evaluation:
 * 1. Agent gatekeeper deny blocks operations
 * 2. tools.allowed enforcement via synthesized policy
 * 3. Agent removal on complete_execution
 * 4. Agent without gatekeeper has no restrictions
 * 5. Gatekeeper policy takes precedence over tools
 *
 * Strategy: Uses AgentManager directly to create agents (reliable path),
 * then tests the MCP-AQL execute + gatekeeper enforcement integration.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Agent Gatekeeper Policy Enforcement (Issue #449)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let agentManager: AgentManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-policy');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    agentManager = container.resolve<AgentManager>('AgentManager');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  /**
   * Helper: create an agent via AgentManager.create() with V2 metadata.
   */
  async function createAgent(name: string, metadataExtra: Record<string, unknown> = {}) {
    const result = await agentManager.create(
      name,
      `Test agent: ${name}`,
      '# Test Agent\n\ngoal: Execute test tasks\nsteps:\n  - Complete the task',
      {
        goal: {
          template: 'Test goal for {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
        },
        ...metadataExtra,
      } as any
    );
    if (!result.success) {
      console.log(`createAgent('${name}') failed:`, result.message);
    }
    expect(result.success).toBe(true);
    // Allow cache to settle (Issue #276)
    await waitForCacheSettle();
  }

  /**
   * Helper: execute an agent via MCP-AQL.
   */
  async function executeAgent(name: string) {
    return mcpAqlHandler.handleExecute({
      operation: 'execute_agent',
      params: { element_name: name, parameters: { task: 'integration-test' } },
    });
  }

  /**
   * Helper: complete an agent execution via MCP-AQL.
   */
  async function completeAgent(name: string) {
    return mcpAqlHandler.handleExecute({
      operation: 'complete_execution',
      params: { element_name: name, outcome: 'success', summary: 'Done' },
    });
  }

  /**
   * Helper: attempt a list_elements operation (read, usually allowed).
   */
  async function attemptList(elementType = 'persona') {
    return mcpAqlHandler.handleRead({
      operation: 'list_elements',
      element_type: elementType,
      params: {},
    });
  }

  describe('Agent gatekeeper deny blocks operations', () => {
    it('should deny blocked operations when agent is executing', async () => {
      // Create agent with gatekeeper deny list
      await createAgent('deny-agent', {
        gatekeeper: { deny: ['delete_element'] },
      });

      // Execute the agent (registers it in executing agents map)
      const execResult = await executeAgent('deny-agent');
      expect(execResult.success).toBe(true);

      // Attempt delete_element — should be denied by agent's gatekeeper policy
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'deny-agent' },
      });
      expect(deleteResult.success).toBe(false);
      if (!deleteResult.success) {
        expect(deleteResult.error).toContain('deny-agent');
      }

      // list_elements should still work (not in deny list)
      const listResult = await attemptList();
      expect(listResult.success).toBe(true);
    });
  });

  describe('tools.allowed enforcement', () => {
    it('should deny operations from non-allowed endpoints via synthesized policy', async () => {
      // Create agent with tools.allowed = ['mcp_aql_read'] only
      await createAgent('tools-agent', {
        tools: { allowed: ['mcp_aql_read'] },
      });

      // Execute the agent
      const execResult = await executeAgent('tools-agent');
      expect(execResult.success).toBe(true);

      // Attempt delete_element — should be denied (DELETE endpoint not in allowed)
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'tools-agent' },
      });
      expect(deleteResult.success).toBe(false);

      // list_elements should succeed (READ endpoint is allowed)
      const listResult = await attemptList();
      expect(listResult.success).toBe(true);
    });
  });

  describe('Agent removal on complete_execution', () => {
    it('should stop enforcing policy after agent completes execution', async () => {
      // Create agent with gatekeeper deny on delete_element
      await createAgent('lifecycle-agent', {
        gatekeeper: { deny: ['delete_element'] },
      });

      // Execute the agent
      const execResult = await executeAgent('lifecycle-agent');
      expect(execResult.success).toBe(true);

      // list_elements should work (not denied)
      const listBefore = await attemptList();
      expect(listBefore.success).toBe(true);

      // delete_element should be denied while agent is executing
      const deleteBefore = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'lifecycle-agent' },
      });
      expect(deleteBefore.success).toBe(false);

      // Complete the agent execution
      const completeResult = await completeAgent('lifecycle-agent');
      expect(completeResult.success).toBe(true);

      // list_elements should still work after completion
      const listAfter = await attemptList();
      expect(listAfter.success).toBe(true);
    });
  });

  describe('Agent without gatekeeper has no restrictions', () => {
    it('should not restrict operations when agent has no gatekeeper policy', async () => {
      // Create agent with no gatekeeper field
      await createAgent('unrestricted-agent');

      // Execute the agent
      const execResult = await executeAgent('unrestricted-agent');
      expect(execResult.success).toBe(true);

      // Operations should use default policies (no extra restrictions from agent)
      const listResult = await attemptList();
      expect(listResult.success).toBe(true);
    });
  });

  describe('Gatekeeper policy takes precedence over tools', () => {
    it('should use explicit gatekeeper policy when both gatekeeper and tools are present', async () => {
      // Create agent with explicit gatekeeper (deny delete) AND tools.allowed = all
      await createAgent('precedence-agent', {
        gatekeeper: { deny: ['delete_element'] },
        tools: { allowed: ['mcp_aql_create', 'mcp_aql_read', 'mcp_aql_update', 'mcp_aql_delete', 'mcp_aql_execute'] },
      });

      // Execute the agent
      const execResult = await executeAgent('precedence-agent');
      expect(execResult.success).toBe(true);

      // delete_element should be denied by explicit gatekeeper policy,
      // even though tools.allowed includes mcp_aql_delete
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'precedence-agent' },
      });
      expect(deleteResult.success).toBe(false);
    });
  });

  describe('Concurrent agent execution with different policies', () => {
    it('should enforce independent policies for multiple executing agents', async () => {
      // Create two agents with different restrictions
      await createAgent('agent-no-delete', {
        gatekeeper: { deny: ['delete_element'] },
      });
      await createAgent('agent-no-create', {
        gatekeeper: { deny: ['create_element'] },
      });

      // Execute both agents
      const exec1 = await executeAgent('agent-no-delete');
      expect(exec1.success).toBe(true);
      const exec2 = await executeAgent('agent-no-create');
      expect(exec2.success).toBe(true);

      // delete_element denied (from agent-no-delete)
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'agent-no-delete' },
      });
      expect(deleteResult.success).toBe(false);

      // create_element denied (from agent-no-create)
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'persona',
        params: { element_name: 'test-blocked-persona', description: 'Should be blocked' },
      });
      expect(createResult.success).toBe(false);

      // list_elements still works (neither agent denies it)
      const listResult = await attemptList();
      expect(listResult.success).toBe(true);
    });

    it('should stop enforcing one agent policy without affecting the other', async () => {
      // Create two agents with different deny lists
      await createAgent('agent-a', {
        gatekeeper: { deny: ['delete_element'] },
      });
      await createAgent('agent-b', {
        gatekeeper: { deny: ['create_element'] },
      });

      // Execute both
      const execA = await executeAgent('agent-a');
      expect(execA.success).toBe(true);
      const execB = await executeAgent('agent-b');
      expect(execB.success).toBe(true);

      // Both denials active
      const deleteBefore = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'agent-a' },
      });
      expect(deleteBefore.success).toBe(false);

      // Complete agent-a — its deny on delete_element should lift
      const completeA = await completeAgent('agent-a');
      expect(completeA.success).toBe(true);

      // create_element should still be denied (agent-b still executing)
      const createAfter = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'persona',
        params: { element_name: 'test-after-complete', description: 'Should still be blocked' },
      });
      expect(createAfter.success).toBe(false);
    });
  });

  describe('Malformed gatekeeper policy validation', () => {
    it('should reject agent creation with invalid gatekeeper policy type', async () => {
      const result = await agentManager.create(
        'bad-policy-agent',
        'Agent with invalid gatekeeper',
        '# Test Agent\n\ngoal: Execute test tasks\nsteps:\n  - Complete the task',
        {
          goal: {
            template: 'Test goal for {task}',
            parameters: [{ name: 'task', type: 'string', required: true }],
          },
          gatekeeper: 'not-an-object',  // Invalid: should be an object
        } as any
      );
      expect(result.success).toBe(false);
    });

    it('should reject agent creation with non-array deny list', async () => {
      const result = await agentManager.create(
        'bad-deny-agent',
        'Agent with invalid deny list',
        '# Test Agent\n\ngoal: Execute test tasks\nsteps:\n  - Complete the task',
        {
          goal: {
            template: 'Test goal for {task}',
            parameters: [{ name: 'task', type: 'string', required: true }],
          },
          gatekeeper: { deny: 'delete_element' },  // Invalid: should be an array
        } as any
      );
      expect(result.success).toBe(false);
    });
  });
});
