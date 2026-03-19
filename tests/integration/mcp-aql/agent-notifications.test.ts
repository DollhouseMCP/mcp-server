/**
 * Integration tests for Agent Notification System
 *
 * Tests that the AutonomyDirective response from record_execution_step
 * includes notifications about gatekeeper blocks, autonomy pauses, and
 * danger zone triggers. Enables bridge agents to discover and relay
 * events to human operators.
 *
 * @since v2.1.0 - Agent Notification System
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Agent Notification System', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let agentManager: AgentManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-notifications');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    agentManager = container.resolve<AgentManager>('AgentManager');

    // Ensure persisted DangerZone state from prior suites/sessions does not leak into this suite.
    try {
      const dangerZone = container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      dangerZone.clearAll();
    } catch {
      // Non-fatal: enforcer may not be registered
    }
  });

  afterEach(async () => {
    // Clean up any DangerZone blocks to prevent cross-test leakage via persisted file
    try {
      const dangerZone = container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      dangerZone.clearAll();
    } catch {
      // Non-fatal: enforcer may not be registered
    }
    await server.dispose();
    await env.cleanup();
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  async function createAgent(name: string, metadataExtra: Record<string, unknown> = {}) {
    const result = await agentManager.create(
      name,
      `Test agent: ${name}`,
      '# Test Agent\n\ngoal: Execute test tasks\nsteps:\n  - Complete the task',
      {
        goal: {
          template: 'Test goal for {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
          successCriteria: ['Task completed successfully'],
        },
        ...metadataExtra,
      } as any
    );
    if (!result.success) {
      console.log(`createAgent('${name}') failed:`, result.message);
    }
    expect(result.success).toBe(true);
    // Issue #276: Allow cache to settle
    await waitForCacheSettle();
  }

  async function executeAgent(name: string, params: Record<string, unknown> = {}) {
    return mcpAqlHandler.handleExecute({
      operation: 'execute_agent',
      params: { element_name: name, parameters: { task: 'integration-test', ...params } },
    });
  }

  async function recordStep(name: string, step: string, outcome: 'success' | 'failure' | 'partial' = 'success') {
    return mcpAqlHandler.handleCreate({
      operation: 'record_execution_step',
      params: {
        element_name: name,
        stepDescription: step,
        outcome,
        findings: `Results for: ${step}`,
        confidence: 0.85,
      },
    });
  }

  /**
   * Extract notifications from a record_execution_step result.
   */
  function getNotifications(result: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
    const data = result.data as Record<string, unknown> | undefined;
    const autonomy = data?.autonomy as Record<string, unknown> | undefined;
    return autonomy?.notifications as Array<Record<string, unknown>> | undefined;
  }

  // ===========================================================================
  // Tests
  // ===========================================================================

  describe('Gatekeeper block notifications', () => {
    it('should include permission_pending notification after gatekeeper block', async () => {
      // Create agent with gatekeeper deny list — denied operations trigger recording
      await createAgent('block-agent', {
        gatekeeper: { deny: ['delete_element'] },
      });

      // Execute agent (registers in executingAgents with recentBlocks)
      const execResult = await executeAgent('block-agent');
      expect(execResult.success).toBe(true);

      // Attempt delete_element — triggers gatekeeper block, recorded to recentBlocks
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'block-agent' },
      });
      expect(deleteResult.success).toBe(false);

      // Call record_execution_step — should include the block as a notification
      const stepResult = await recordStep('block-agent', 'Attempted operation');
      expect(stepResult.success).toBe(true);

      const notifications = getNotifications(stepResult);
      expect(notifications).toBeDefined();
      expect(notifications!.length).toBeGreaterThanOrEqual(1);

      const permissionNotification = notifications!.find(
        (n: Record<string, unknown>) => n.type === 'permission_pending'
      );
      expect(permissionNotification).toBeDefined();
      expect(permissionNotification!.message).toContain('delete_element');
      expect(permissionNotification!.timestamp).toBeDefined();

      const metadata = permissionNotification!.metadata as Record<string, unknown>;
      expect(metadata.operation).toBe('delete_element');
    });
  });

  describe('Clean execution (no notifications)', () => {
    it('should not include notifications when no blocks or pauses occur', async () => {
      // Create agent with permissive policy
      await createAgent('clean-agent', {
        gatekeeper: { allow: ['*'] },
        autonomy: { maxAutonomousSteps: 0 },  // unlimited
      });

      // Execute agent
      const execResult = await executeAgent('clean-agent');
      expect(execResult.success).toBe(true);

      // Perform allowed operation
      const listResult = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        element_type: 'persona',
        params: {},
      });
      expect(listResult.success).toBe(true);

      // Record step — should have no notifications
      const stepResult = await recordStep('clean-agent', 'Listed personas');
      expect(stepResult.success).toBe(true);

      const notifications = getNotifications(stepResult);
      // Notifications should be undefined (not attached when empty)
      expect(notifications).toBeUndefined();
    });
  });

  describe('Autonomy pause notification', () => {
    it('should include autonomy_pause notification when step limit is reached', async () => {
      // Create agent with low step limit
      await createAgent('pause-agent', {
        gatekeeper: { allow: ['*'] },
        autonomy: { maxAutonomousSteps: 2 },
      });

      // Execute agent
      const execResult = await executeAgent('pause-agent');
      expect(execResult.success).toBe(true);

      // Record steps up to and past the limit
      const step1 = await recordStep('pause-agent', 'Step 1');
      expect(step1.success).toBe(true);
      const step1Notifications = getNotifications(step1);
      // Step 1 should not have autonomy_pause
      const step1Pause = step1Notifications?.find(
        (n: Record<string, unknown>) => n.type === 'autonomy_pause'
      );
      expect(step1Pause).toBeUndefined();

      const step2 = await recordStep('pause-agent', 'Step 2');
      expect(step2.success).toBe(true);

      // Step 2 might or might not pause depending on implementation (limit=2 means 2 steps allowed)
      // Step 3 should definitely cause a pause
      const step3 = await recordStep('pause-agent', 'Step 3');
      expect(step3.success).toBe(true);

      const step3Data = step3.data as Record<string, unknown>;
      const step3Autonomy = step3Data?.autonomy as Record<string, unknown>;

      // By step 3, the agent should be paused (continue=false)
      expect(step3Autonomy?.continue).toBe(false);

      const step3Notifications = getNotifications(step3);
      expect(step3Notifications).toBeDefined();

      const pauseNotification = step3Notifications!.find(
        (n: Record<string, unknown>) => n.type === 'autonomy_pause'
      );
      expect(pauseNotification).toBeDefined();
      expect(pauseNotification!.message).toContain('paused');

      const metadata = pauseNotification!.metadata as Record<string, unknown>;
      expect(metadata.reason).toBeDefined();
    });
  });

  describe('Idempotent reporting', () => {
    it('should only report gatekeeper blocks once (first record_execution_step call)', async () => {
      // Create agent with deny policy
      await createAgent('idempotent-agent', {
        gatekeeper: { deny: ['delete_element'] },
      });

      // Execute agent
      const execResult = await executeAgent('idempotent-agent');
      expect(execResult.success).toBe(true);

      // Trigger gatekeeper block
      await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'idempotent-agent' },
      });

      // First record_execution_step — should include the notification
      const step1 = await recordStep('idempotent-agent', 'First step after block');
      expect(step1.success).toBe(true);
      const step1Notifications = getNotifications(step1);
      const step1Permission = step1Notifications?.find(
        (n: Record<string, unknown>) => n.type === 'permission_pending'
      );
      expect(step1Permission).toBeDefined();

      // Second record_execution_step — same block should NOT appear again
      const step2 = await recordStep('idempotent-agent', 'Second step after block');
      expect(step2.success).toBe(true);
      const step2Notifications = getNotifications(step2);
      const step2Permission = step2Notifications?.find(
        (n: Record<string, unknown>) => n.type === 'permission_pending'
      );
      expect(step2Permission).toBeUndefined();
    });
  });

  describe('Multiple notifications', () => {
    it('should report multiple gatekeeper blocks in a single response', async () => {
      // Create agent with deny on multiple operations
      await createAgent('multi-agent', {
        gatekeeper: { deny: ['delete_element', 'edit_element'] },
      });

      // Execute agent
      const execResult = await executeAgent('multi-agent');
      expect(execResult.success).toBe(true);

      // Trigger two different gatekeeper blocks
      await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        element_type: 'agent',
        params: { element_name: 'multi-agent' },
      });
      await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        element_type: 'agent',
        params: { element_name: 'multi-agent', input: { description: 'modified' } },
      });

      // Record step — should include both blocks as notifications
      const stepResult = await recordStep('multi-agent', 'Step after blocks');
      expect(stepResult.success).toBe(true);

      const notifications = getNotifications(stepResult);
      expect(notifications).toBeDefined();

      const permissionNotifications = notifications!.filter(
        (n: Record<string, unknown>) => n.type === 'permission_pending'
      );
      expect(permissionNotifications.length).toBeGreaterThanOrEqual(2);

      const operations = permissionNotifications.map(
        (n: Record<string, unknown>) => (n.metadata as Record<string, unknown>)?.operation
      );
      expect(operations).toContain('delete_element');
      expect(operations).toContain('edit_element');
    });
  });

  describe('DangerZone broadcast', () => {
    it('should broadcast danger_zone notification to other executing agents', async () => {
      const dangerZone = container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');

      // Ensure no stale blocks from prior runs
      dangerZone.clearAll();

      // Create two agents
      await createAgent('dz-blocked-agent', {
        gatekeeper: { allow: ['*'] },
      });
      await createAgent('dz-observer-agent', {
        gatekeeper: { allow: ['*'] },
        autonomy: { maxAutonomousSteps: 0 },
      });

      // Execute both agents
      const exec1 = await executeAgent('dz-blocked-agent');
      expect(exec1.success).toBe(true);
      const exec2 = await executeAgent('dz-observer-agent');
      expect(exec2.success).toBe(true);

      try {
        // Block the first agent via DangerZoneEnforcer directly
        dangerZone.block(
          'dz-blocked-agent',
          'Dangerous pattern detected in agent actions',
          ['rm -rf /'],
          'verify-test-123'
        );

        // Record step on the OBSERVER agent — should receive danger_zone notification
        const stepResult = await recordStep('dz-observer-agent', 'Checking for alerts');
        expect(stepResult.success).toBe(true);

        const notifications = getNotifications(stepResult);
        expect(notifications).toBeDefined();

        const dangerNotification = notifications!.find(
          (n: Record<string, unknown>) => n.type === 'danger_zone'
        );
        expect(dangerNotification).toBeDefined();
        expect(dangerNotification!.message).toContain('dz-blocked-agent');
        expect(dangerNotification!.message).toContain('danger zone');

        const metadata = dangerNotification!.metadata as Record<string, unknown>;
        expect(metadata.agentName).toBe('dz-blocked-agent');
        expect(metadata.reason).toContain('Dangerous pattern');
        expect(metadata.verificationId).toBe('verify-test-123');
      } finally {
        // Always clean up the block regardless of test outcome
        dangerZone.unblock('dz-blocked-agent');
      }
    });
  });
});
