/**
 * Integration tests for Agent Execution Resilience (Issue #526)
 *
 * Tests that resilience policies correctly override autonomy directives:
 * 1. Auto-continuation when step limit reached with onStepLimitReached: 'continue'
 * 2. Continuation cap (maxContinuations) enforced
 * 3. Default policy (pause) preserves existing behavior
 * 4. Retry with backoff on execution failure
 * 5. complete_execution overrides resilience
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

/**
 * Extract the data payload from an OperationResult.
 * The result shape is { success: true, data: { _type, ...fields }, _meta }.
 */
function getData(result: Record<string, unknown>): Record<string, any> {
  return (result as any).data ?? result;
}

describe('Agent Execution Resilience (Issue #526)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let agentManager: AgentManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-resilience');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    agentManager = container.resolve<AgentManager>('AgentManager');
    SecurityMonitor.clearAllEventsForTesting();
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
    SecurityMonitor.clearAllEventsForTesting();
  });

  /**
   * Helper: create an agent with V2 metadata including optional resilience policy.
   */
  async function createAgent(
    name: string,
    metadataExtra: Record<string, unknown> = {}
  ) {
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
   * Helper: record a step for an executing agent. Returns the data payload.
   */
  async function updateState(
    name: string,
    step: string,
    outcome: 'success' | 'failure' | 'partial' = 'success'
  ): Promise<Record<string, any>> {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'record_execution_step',
      params: {
        element_name: name,
        stepDescription: step,
        outcome,
        findings: `Results for: ${step}`,
        confidence: 0.9,
      },
    });
    expect(result.success).toBe(true);
    return getData(result as Record<string, unknown>);
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

  // ==========================================================================
  // Auto-continuation on step limit
  // ==========================================================================

  describe('auto-continuation on step limit', () => {
    it('should auto-continue when step limit reached with onStepLimitReached: continue', async () => {
      await createAgent('resilient-agent', {
        autonomy: {
          maxAutonomousSteps: 2,
        },
        resilience: {
          onStepLimitReached: 'continue',
          maxContinuations: 5,
        },
      });

      const execResult = await executeAgent('resilient-agent');
      expect(execResult.success).toBe(true);

      // Step 1: Should continue normally
      const step1Data = await updateState('resilient-agent', 'Step 1');
      expect(step1Data.autonomy?.continue).toBe(true);

      // Step 2: Hits step limit, but resilience should auto-continue
      const step2Data = await updateState('resilient-agent', 'Step 2');
      expect(step2Data.autonomy?.continue).toBe(true);
      expect(step2Data.autonomy?.resilienceAction).toBeDefined();
      expect(step2Data.autonomy?.resilienceAction?.action).toBe('continue');

      // Verify security event was logged
      const events = SecurityMonitor.getEventsByType('AGENT_AUTO_CONTINUED');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].additionalData?.agentName).toBe('resilient-agent');

      await completeAgent('resilient-agent');
    });
  });

  // ==========================================================================
  // Continuation cap enforcement
  // ==========================================================================

  describe('continuation cap enforcement', () => {
    it('should pause when maxContinuations is reached', async () => {
      await createAgent('capped-agent', {
        autonomy: {
          maxAutonomousSteps: 1, // Trigger step limit after every step
        },
        resilience: {
          onStepLimitReached: 'continue',
          maxContinuations: 2,
        },
      });

      const execResult = await executeAgent('capped-agent');
      expect(execResult.success).toBe(true);

      // Step 1: Hits step limit -> auto-continue (continuation 1/2)
      const step1Data = await updateState('capped-agent', 'Step 1');
      expect(step1Data.autonomy?.continue).toBe(true);
      expect(step1Data.autonomy?.resilienceAction?.continuationCount).toBe(1);

      // Step 2: Hits step limit -> auto-continue (continuation 2/2)
      const step2Data = await updateState('capped-agent', 'Step 2');
      expect(step2Data.autonomy?.continue).toBe(true);
      expect(step2Data.autonomy?.resilienceAction?.continuationCount).toBe(2);

      // Step 3: Hits step limit -> cap reached, should pause
      const step3Data = await updateState('capped-agent', 'Step 3');
      // Resilience evaluator returns pause (cap exhausted),
      // so evaluateResilience returns null and original directive is used
      expect(step3Data.autonomy?.continue).toBe(false);

      await completeAgent('capped-agent');
    });
  });

  // ==========================================================================
  // Default policy preserves existing behavior
  // ==========================================================================

  describe('default resilience policy', () => {
    it('should pause at step limit with no resilience policy', async () => {
      await createAgent('default-agent', {
        autonomy: {
          maxAutonomousSteps: 2,
          // No resilience policy — default behavior
        },
      });

      const execResult = await executeAgent('default-agent');
      expect(execResult.success).toBe(true);

      // Step 1: Should continue
      const step1Data = await updateState('default-agent', 'Step 1');
      expect(step1Data.autonomy?.continue).toBe(true);

      // Step 2: Hits step limit — should pause (default behavior)
      const step2Data = await updateState('default-agent', 'Step 2');
      expect(step2Data.autonomy?.continue).toBe(false);
      // No resilience action on the result
      expect(step2Data.autonomy?.resilienceAction).toBeUndefined();

      await completeAgent('default-agent');
    });
  });

  // ==========================================================================
  // Failure retry
  // ==========================================================================

  describe('failure retry with backoff', () => {
    it('should retry when step fails and onExecutionFailure is retry', async () => {
      await createAgent('retry-agent', {
        autonomy: {
          maxAutonomousSteps: 10,
        },
        resilience: {
          onExecutionFailure: 'retry',
          maxRetries: 3,
          retryBackoff: 'exponential',
        },
      });

      const execResult = await executeAgent('retry-agent');
      expect(execResult.success).toBe(true);

      // Step 1 fails: should trigger retry
      const step1Data = await updateState('retry-agent', 'Failing step', 'failure');
      expect(step1Data.autonomy?.continue).toBe(true);
      expect(step1Data.autonomy?.resilienceAction?.action).toBe('retry');
      expect(step1Data.autonomy?.resilienceAction?.backoffMs).toBeDefined();

      // Verify security event
      const events = SecurityMonitor.getEventsByType('AGENT_STEP_RETRIED');
      expect(events.length).toBeGreaterThanOrEqual(1);

      await completeAgent('retry-agent');
    });
  });

  // ==========================================================================
  // complete_execution overrides resilience
  // ==========================================================================

  describe('complete_execution overrides resilience', () => {
    it('should clean up resilience state on complete', async () => {
      await createAgent('complete-override-agent', {
        autonomy: {
          maxAutonomousSteps: 2,
        },
        resilience: {
          onStepLimitReached: 'continue',
          maxContinuations: 10,
        },
      });

      const execResult = await executeAgent('complete-override-agent');
      expect(execResult.success).toBe(true);

      // Record one step
      await updateState('complete-override-agent', 'Step 1');

      // Complete the execution — should succeed and clean up
      const completeResult = await completeAgent('complete-override-agent');
      expect(completeResult.success).toBe(true);

      // Re-executing should work with fresh resilience state
      const execResult2 = await executeAgent('complete-override-agent');
      expect(execResult2.success).toBe(true);

      await completeAgent('complete-override-agent');
    });
  });
});
