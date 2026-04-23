/**
 * Integration tests for Agent Execution Lifecycle Edge Cases
 *
 * Tests combinatorial edge cases — what happens when execution operations
 * are called in unexpected sequences:
 * 1. Operations without an active execution
 * 2. Operations after complete_execution
 * 3. Operations after abort_execution
 * 4. Immediate completion (no record_execution_step calls)
 * 5. Operations on nonexistent agents
 *
 * Complements happy-path coverage in agent-execution-lifecycle.test.ts
 * and resilience policy tests in agent-resilience.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Agent execution lifecycle edge cases', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let agentManager: AgentManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-edge-cases');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    agentManager = container.resolve<AgentManager>('AgentManager');
  });

  afterEach(async () => {
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

  async function completeAgent(name: string, outcome: 'success' | 'failure' | 'partial' = 'success') {
    return mcpAqlHandler.handleExecute({
      operation: 'complete_execution',
      params: { element_name: name, outcome, summary: `Agent ${name} completed with ${outcome}` },
    });
  }

  async function abortAgent(name: string, reason = 'Test abort') {
    return mcpAqlHandler.handleExecute({
      operation: 'abort_execution',
      params: { element_name: name, reason },
    });
  }

  async function continueAgent(name: string, params: Record<string, unknown> = {}) {
    return mcpAqlHandler.handleExecute({
      operation: 'continue_execution',
      params: { element_name: name, parameters: { task: 'continue-test', ...params } },
    });
  }

  async function getExecutionState(name: string) {
    return mcpAqlHandler.handleRead({
      operation: 'get_execution_state',
      params: { element_name: name },
    });
  }

  async function getGatheredData(name: string, goalId: string) {
    return mcpAqlHandler.handleRead({
      operation: 'get_gathered_data',
      params: { element_name: name, goalId },
    });
  }

  // ===========================================================================
  // 1. Operations without active execution
  // ===========================================================================

  describe('Operations without active execution', () => {
    it('should fail record_execution_step without execute_agent', async () => {
      await createAgent('edge-noexec-1');

      const result = await recordStep('edge-noexec-1', 'Should fail');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-noexec-1');
        expect(result.error).toContain('No active goal found');
      }
    });

    it('should fail complete_execution without execute_agent', async () => {
      await createAgent('edge-noexec-2');

      const result = await completeAgent('edge-noexec-2');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-noexec-2');
        expect(result.error).toContain('No in-progress goal found');
      }
    });

    it('should fail abort_execution without execute_agent', async () => {
      await createAgent('edge-noexec-3');

      const result = await abortAgent('edge-noexec-3');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-noexec-3');
        expect(result.error).toContain('No active execution found');
        expect(result.error).toContain('Nothing to abort');
      }
    });

    it('should succeed get_execution_state without execute_agent', async () => {
      await createAgent('edge-noexec-4');

      const result = await getExecutionState('edge-noexec-4');
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data._type).toBe('ExecutionState');
        expect(data.agentName).toBe('edge-noexec-4');
      }
    });

    it('should fail continue_execution before any recorded step with record_execution_step guidance', async () => {
      await createAgent('edge-noexec-5');
      await executeAgent('edge-noexec-5');

      const result = await continueAgent('edge-noexec-5');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-noexec-5');
        expect(result.error).toContain('record_execution_step');
        expect(result.error).toContain('After execute_agent');
      }
    });
  });

  // ===========================================================================
  // 2. Operations after complete_execution
  // ===========================================================================

  describe('Operations after complete_execution', () => {
    it('should fail record_execution_step after complete', async () => {
      await createAgent('edge-postcomplete-1');
      await executeAgent('edge-postcomplete-1');
      await recordStep('edge-postcomplete-1', 'Step 1');
      await completeAgent('edge-postcomplete-1');

      const result = await recordStep('edge-postcomplete-1', 'Should fail');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postcomplete-1');
        expect(result.error).toContain('No active goal found');
      }
    });

    it('should fail complete_execution after complete (double-complete)', async () => {
      await createAgent('edge-postcomplete-2');
      await executeAgent('edge-postcomplete-2');
      await completeAgent('edge-postcomplete-2');

      const result = await completeAgent('edge-postcomplete-2');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postcomplete-2');
        expect(result.error).toContain('No in-progress goal found');
      }
    });

    it('should fail abort_execution after complete', async () => {
      await createAgent('edge-postcomplete-3');
      await executeAgent('edge-postcomplete-3');
      await completeAgent('edge-postcomplete-3');

      const result = await abortAgent('edge-postcomplete-3');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postcomplete-3');
        expect(result.error).toContain('No active execution found');
      }
    });

    it('should fail continue_execution after complete with execute_agent guidance', async () => {
      await createAgent('edge-postcomplete-4');
      await executeAgent('edge-postcomplete-4');
      await completeAgent('edge-postcomplete-4');

      const result = await continueAgent('edge-postcomplete-4');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postcomplete-4');
        expect(result.error).toContain('execute_agent');
        expect(result.error).toContain('record_execution_step');
      }
    });

    it('should succeed execute_agent after complete (creates new execution)', async () => {
      await createAgent('edge-postcomplete-5');
      await executeAgent('edge-postcomplete-5');
      await completeAgent('edge-postcomplete-5');

      const result = await executeAgent('edge-postcomplete-5');
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data._type).toBe('ExecuteAgentResult');
        expect(data.goalId).toBeDefined();
      }

      // Clean up
      await completeAgent('edge-postcomplete-5');
    });
  });

  // ===========================================================================
  // 3. Operations after abort_execution
  // ===========================================================================

  describe('Operations after abort_execution', () => {
    it('should fail record_execution_step after abort', async () => {
      await createAgent('edge-postabort-1');
      await executeAgent('edge-postabort-1');
      await abortAgent('edge-postabort-1');

      const result = await recordStep('edge-postabort-1', 'Should fail');
      expect(result.success).toBe(false);
      if (!result.success) {
        // Error from abort check or "No active goal" — either way, mentions agent
        expect(result.error).toContain('edge-postabort-1');
      }
    });

    it('should fail complete_execution after abort', async () => {
      await createAgent('edge-postabort-2');
      await executeAgent('edge-postabort-2');
      await abortAgent('edge-postabort-2');

      const result = await completeAgent('edge-postabort-2');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postabort-2');
      }
    });

    it('should fail continue_execution after abort with execute_agent guidance', async () => {
      await createAgent('edge-postabort-3');
      await executeAgent('edge-postabort-3');
      await abortAgent('edge-postabort-3');

      const result = await continueAgent('edge-postabort-3');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-postabort-3');
        expect(result.error).toContain('execute_agent');
      }
    });

    it('should fail abort_execution after abort (double-abort)', async () => {
      await createAgent('edge-postabort-4');
      await executeAgent('edge-postabort-4');
      await abortAgent('edge-postabort-4');

      const result = await abortAgent('edge-postabort-4');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('No active execution found');
        expect(result.error).toContain('edge-postabort-4');
      }
    });

    it('should succeed execute_agent after abort (starts fresh execution)', async () => {
      await createAgent('edge-postabort-5');
      await executeAgent('edge-postabort-5');
      await abortAgent('edge-postabort-5');

      // execute_agent is exempt from abort check (method === 'execute')
      const result = await executeAgent('edge-postabort-5');
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data._type).toBe('ExecuteAgentResult');
        expect(data.goalId).toBeDefined();
      }

      // Clean up
      await completeAgent('edge-postabort-5');
    });

    it('should succeed get_execution_state after abort', async () => {
      await createAgent('edge-postabort-6');
      await executeAgent('edge-postabort-6');
      await abortAgent('edge-postabort-6');

      // get_execution_state is exempt from abort check (method === 'getState')
      const result = await getExecutionState('edge-postabort-6');
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data._type).toBe('ExecutionState');
        expect(data.agentName).toBe('edge-postabort-6');
      }
    });
  });

  // ===========================================================================
  // 4. Immediate completion (no steps)
  // ===========================================================================

  describe('Immediate completion (no steps)', () => {
    it('should succeed execute then immediately complete without recording steps', async () => {
      await createAgent('edge-immediate-1');

      const execResult = await executeAgent('edge-immediate-1');
      expect(execResult.success).toBe(true);

      const completeResult = await completeAgent('edge-immediate-1');
      expect(completeResult.success).toBe(true);
      if (completeResult.success) {
        const data = completeResult.data as any;
        expect(data._type).toBe('CompletionResult');
        expect(data.success).toBe(true);
      }
    });

    it('should return gathered data for immediate completion', async () => {
      await createAgent('edge-immediate-2');

      const execResult = await executeAgent('edge-immediate-2');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const goalId = (execResult.data as any).goalId;

      await completeAgent('edge-immediate-2');

      const gatherResult = await getGatheredData('edge-immediate-2', goalId);
      expect(gatherResult.success).toBe(true);
      if (gatherResult.success) {
        const data = gatherResult.data as any;
        expect(data._type).toBe('GatheredData');
        expect(data.goalId).toBe(goalId);
        expect(data.agentName).toBe('edge-immediate-2');
        expect(data.entries).toBeDefined();
        expect(Array.isArray(data.entries)).toBe(true);
        // At least goal_created and goal_completed decision entries
        expect(data.entries.length).toBeGreaterThanOrEqual(2);
        expect(data.summary).toBeDefined();
        expect(data.summary.totalSteps).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Evaluation regression coverage (#2165)', () => {
    it('should enumerate all missing continue_execution parameters for rubric-style agents', async () => {
      await createAgent('rubric-regression-agent', {
        goal: {
          template: 'Verify {deliverable_path} against {run_dir}',
          parameters: [
            { name: 'run_dir', type: 'string', required: true },
            { name: 'deliverable_path', type: 'string', required: true },
          ],
          successCriteria: ['Produce a verified attestation'],
        },
      });

      const executeResult = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: {
          element_name: 'rubric-regression-agent',
          parameters: {
            run_dir: '/app/run',
            deliverable_path: '/app/run/output.docx',
          },
        },
      });
      expect(executeResult.success).toBe(true);

      const recordResult = await mcpAqlHandler.handleCreate({
        operation: 'record_execution_step',
        params: {
          element_name: 'rubric-regression-agent',
          stepDescription: 'Loaded rubric checklist',
          outcome: 'success',
          findings: 'Checklist parsed',
        },
      });
      expect(recordResult.success).toBe(true);

      const continueResult = await mcpAqlHandler.handleExecute({
        operation: 'continue_execution',
        params: {
          element_name: 'rubric-regression-agent',
          previousStepResult: 'Checklist parsed',
          parameters: {},
        },
      });
      expect(continueResult.success).toBe(false);
      if (!continueResult.success) {
        expect(continueResult.error).toContain('run_dir');
        expect(continueResult.error).toContain('deliverable_path');
        expect(continueResult.error).toContain('introspect');
        expect(continueResult.error).toContain('record_execution_step');
      }
    });
  });

  // ===========================================================================
  // 5. Operations on nonexistent agent
  // ===========================================================================

  describe('Operations on nonexistent agent', () => {
    it('should fail execute_agent for nonexistent agent', async () => {
      const result = await executeAgent('edge-nonexistent-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-nonexistent-1');
        expect(result.error).toContain('not found');
      }
    });

    it('should fail record_execution_step for nonexistent agent', async () => {
      const result = await recordStep('edge-nonexistent-2', 'Should fail');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-nonexistent-2');
        expect(result.error).toContain('not found');
      }
    });

    it('should fail complete_execution for nonexistent agent', async () => {
      const result = await completeAgent('edge-nonexistent-3');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('edge-nonexistent-3');
        expect(result.error).toContain('not found');
      }
    });
  });
});
