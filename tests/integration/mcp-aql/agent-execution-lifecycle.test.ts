/**
 * Integration tests for Agent Execution Lifecycle (Issues #106, #122)
 *
 * Tests full agent execution flows through MCP-AQL:
 * 1. Execute → update_state → complete flow
 * 2. Abort flow: execute → abort → verify rejection
 * 3. Gathered data: execute → update_state → get_gathered_data
 * 4. Handoff flow: execute → prepare_handoff → resume_from_handoff
 * 5. Agent chaining: execute Agent A → execute Agent B → verify isolation
 *
 * Part of Epic #380 — Agentic Loop Completion for Beta 4.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Agent Execution Lifecycle (Issues #106, #122)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let agentManager: AgentManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-lifecycle');
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
    // Allow cache to settle (Issue #276)
    await waitForCacheSettle();
  }

  async function executeAgent(name: string, params: Record<string, unknown> = {}) {
    return mcpAqlHandler.handleExecute({
      operation: 'execute_agent',
      params: { element_name: name, parameters: { task: 'integration-test', ...params } },
    });
  }

  async function updateState(name: string, step: string, outcome: 'success' | 'failure' | 'partial' = 'success') {
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

  // ===========================================================================
  // #106 — Execute → Update → Complete Flow
  // ===========================================================================

  describe('Execute → Update → Complete flow (#106)', () => {
    it('should complete full execution lifecycle', async () => {
      await createAgent('lifecycle-agent');

      // 1. Execute
      const execResult = await executeAgent('lifecycle-agent');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const execData = execResult.data as any;
      expect(execData._type).toBe('ExecuteAgentResult');
      expect(execData.goalId).toBeDefined();

      // 2. Update state
      const stepResult = await updateState('lifecycle-agent', 'Analyzed source code');
      expect(stepResult.success).toBe(true);
      if (!stepResult.success) return;
      const stepData = stepResult.data as any;
      expect(stepData._type).toBe('StepResult');

      // 3. Complete
      const completeResult = await completeAgent('lifecycle-agent');
      expect(completeResult.success).toBe(true);
      if (!completeResult.success) return;
      const completeData = completeResult.data as any;
      expect(completeData._type).toBe('CompletionResult');
    });

    it('should record multiple steps and reflect in state', async () => {
      await createAgent('multi-step-agent');

      const execResult = await executeAgent('multi-step-agent');
      expect(execResult.success).toBe(true);

      // Record multiple steps
      await updateState('multi-step-agent', 'Step 1: Analyze');
      await updateState('multi-step-agent', 'Step 2: Implement');
      await updateState('multi-step-agent', 'Step 3: Test', 'partial');

      // Verify execution state reflects the steps
      const stateResult = await mcpAqlHandler.handleRead({
        operation: 'get_execution_state',
        params: { element_name: 'multi-step-agent', includeDecisionHistory: true },
      });
      expect(stateResult.success).toBe(true);
      if (!stateResult.success) return;
      const stateData = stateResult.data as any;
      expect(stateData._type).toBe('ExecutionState');

      await completeAgent('multi-step-agent');
    });
  });

  // ===========================================================================
  // #106 — Abort Flow
  // ===========================================================================

  describe('Abort flow (#106)', () => {
    it('should abort execution and reject further operations', async () => {
      await createAgent('abort-agent');

      // 1. Execute
      const execResult = await executeAgent('abort-agent');
      expect(execResult.success).toBe(true);

      // 2. Abort
      const abortResult = await abortAgent('abort-agent', 'User cancelled');
      expect(abortResult.success).toBe(true);
      if (!abortResult.success) return;
      const abortData = abortResult.data as any;
      expect(abortData._type).toBe('AbortResult');
      expect(abortData.agentName).toBe('abort-agent');
      expect(abortData.abortedGoalIds.length).toBeGreaterThan(0);

      // 3. Further update_state should be rejected
      // After abort, the goal is marked 'failed' and abortedGoals set is checked.
      // The error can come from either the abortedGoals check or from the state layer
      // finding no active goal.
      const updateResult = await updateState('abort-agent', 'Should fail');
      expect(updateResult.success).toBe(false);
    });

    it('should allow re-execution after abort', async () => {
      await createAgent('reexec-agent');

      // Execute and abort
      await executeAgent('reexec-agent');
      await abortAgent('reexec-agent');

      // New execution should work
      const reExecResult = await executeAgent('reexec-agent');
      expect(reExecResult.success).toBe(true);
      if (!reExecResult.success) return;
      expect((reExecResult.data as any)._type).toBe('ExecuteAgentResult');

      await completeAgent('reexec-agent');
    });
  });

  // ===========================================================================
  // #68 — Gathered Data
  // ===========================================================================

  describe('Gathered data (#68)', () => {
    it('should return gathered data for a goal with steps', async () => {
      await createAgent('gather-agent');

      // Execute and record steps
      const execResult = await executeAgent('gather-agent');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const goalId = (execResult.data as any).goalId;

      await updateState('gather-agent', 'Analyzed files');
      await updateState('gather-agent', 'Found issues', 'partial');
      await completeAgent('gather-agent');

      // Get gathered data
      const gatherResult = await mcpAqlHandler.handleRead({
        operation: 'get_gathered_data',
        params: { element_name: 'gather-agent', goalId },
      });
      expect(gatherResult.success).toBe(true);
      if (!gatherResult.success) return;
      const gatherData = gatherResult.data as any;
      expect(gatherData._type).toBe('GatheredData');
      expect(gatherData.goalId).toBe(goalId);
      expect(gatherData.agentName).toBe('gather-agent');
      expect(gatherData.entries).toBeDefined();
      expect(gatherData.summary).toBeDefined();
      expect(gatherData.summary.totalSteps).toBeGreaterThanOrEqual(2);
    });

    it('should fail for unknown goalId', async () => {
      await createAgent('gather-fail-agent');

      const gatherResult = await mcpAqlHandler.handleRead({
        operation: 'get_gathered_data',
        params: { element_name: 'gather-fail-agent', goalId: 'nonexistent-goal' },
      });
      expect(gatherResult.success).toBe(false);
    });
  });

  // ===========================================================================
  // #69 + #71 — Handoff Flow
  // ===========================================================================

  describe('Handoff flow (#69, #71)', () => {
    it('should prepare handoff and generate handoff block', async () => {
      await createAgent('handoff-agent');

      // Execute and record some work
      const execResult = await executeAgent('handoff-agent');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const goalId = (execResult.data as any).goalId;

      await updateState('handoff-agent', 'Analyzed codebase');
      await updateState('handoff-agent', 'Identified patterns');

      // Prepare handoff
      const handoffResult = await mcpAqlHandler.handleExecute({
        operation: 'prepare_handoff',
        params: { element_name: 'handoff-agent', goalId },
      });
      expect(handoffResult.success).toBe(true);
      if (!handoffResult.success) return;
      const handoffData = handoffResult.data as any;
      expect(handoffData._type).toBe('HandoffResult');
      expect(handoffData.handoffState).toBeDefined();
      expect(handoffData.handoffState.agentName).toBe('handoff-agent');
      expect(handoffData.handoffState.goalId).toBe(goalId);
      expect(handoffData.handoffState.checksum).toBeDefined();
      expect(handoffData.handoffState.version).toBe('1.0.0');

      // Handoff block should be a formatted string with markers
      expect(handoffData.handoffBlock).toBeDefined();
      expect(typeof handoffData.handoffBlock).toBe('string');
      expect(handoffData.handoffBlock).toContain('AGENT HANDOFF');
      expect(handoffData.handoffBlock).toContain('HANDOFF PAYLOAD START');
      expect(handoffData.handoffBlock).toContain('HANDOFF PAYLOAD END');
    });

    it('should resume from handoff block', async () => {
      await createAgent('resume-agent');

      // Execute and record steps (agent stays mid-execution)
      const execResult = await executeAgent('resume-agent');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const goalId = (execResult.data as any).goalId;

      await updateState('resume-agent', 'Did some work');

      // Prepare handoff while agent is still executing
      const handoffResult = await mcpAqlHandler.handleExecute({
        operation: 'prepare_handoff',
        params: { element_name: 'resume-agent', goalId },
      });
      expect(handoffResult.success).toBe(true);
      if (!handoffResult.success) return;
      const handoffBlock = (handoffResult.data as any).handoffBlock;

      // Resume from handoff (continues the in-progress execution)
      // Must pass required goal template parameters (task) for re-execution
      const resumeResult = await mcpAqlHandler.handleExecute({
        operation: 'resume_from_handoff',
        params: { element_name: 'resume-agent', handoffBlock, parameters: { task: 'resumed-test' } },
      });
      expect(resumeResult.success).toBe(true);
      if (!resumeResult.success) return;
      const resumeData = resumeResult.data as any;
      expect(resumeData._type).toBe('ResumeResult');
      expect(resumeData.restoredFrom).toBeDefined();
      expect(resumeData.restoredFrom.agentName).toBe('resume-agent');
      expect(resumeData.restoredFrom.goalId).toBe(goalId);

      // Clean up: complete the resumed execution
      await completeAgent('resume-agent');
    });

    it('should reject handoff block with mismatched agent name', async () => {
      await createAgent('handoff-src');
      await createAgent('handoff-dst');

      // Execute and prepare handoff for agent A
      const execResult = await executeAgent('handoff-src');
      expect(execResult.success).toBe(true);
      if (!execResult.success) return;
      const goalId = (execResult.data as any).goalId;

      await completeAgent('handoff-src');

      const handoffResult = await mcpAqlHandler.handleExecute({
        operation: 'prepare_handoff',
        params: { element_name: 'handoff-src', goalId },
      });
      expect(handoffResult.success).toBe(true);
      if (!handoffResult.success) return;
      const handoffBlock = (handoffResult.data as any).handoffBlock;

      // Try to resume on a different agent — should fail
      const resumeResult = await mcpAqlHandler.handleExecute({
        operation: 'resume_from_handoff',
        params: { element_name: 'handoff-dst', handoffBlock },
      });
      expect(resumeResult.success).toBe(false);
      if (!resumeResult.success) {
        expect(resumeResult.error).toContain('mismatch');
      }
    });

    it('should reject corrupted handoff block', async () => {
      await createAgent('corrupt-agent');

      const resumeResult = await mcpAqlHandler.handleExecute({
        operation: 'resume_from_handoff',
        params: { element_name: 'corrupt-agent', handoffBlock: 'this is not a valid handoff block' },
      });
      expect(resumeResult.success).toBe(false);
      if (!resumeResult.success) {
        expect(resumeResult.error).toContain('handoff');
      }
    });
  });

  // ===========================================================================
  // #122 — Agent Chaining / State Isolation
  // ===========================================================================

  describe('Agent chaining and state isolation (#122)', () => {
    it('should allow two agents to execute concurrently with isolated state', async () => {
      await createAgent('chain-alpha');
      await createAgent('chain-beta');

      // Execute both
      const execA = await executeAgent('chain-alpha');
      const execB = await executeAgent('chain-beta');
      expect(execA.success).toBe(true);
      expect(execB.success).toBe(true);

      // Update state independently
      await updateState('chain-alpha', 'Alpha step 1');
      await updateState('chain-beta', 'Beta step 1');
      await updateState('chain-alpha', 'Alpha step 2');

      // Complete independently
      const completeA = await completeAgent('chain-alpha');
      const completeB = await completeAgent('chain-beta');
      expect(completeA.success).toBe(true);
      expect(completeB.success).toBe(true);
    });

    it('should not allow aborting one agent to affect another', async () => {
      await createAgent('iso-agent-a');
      await createAgent('iso-agent-b');

      // Execute both
      await executeAgent('iso-agent-a');
      await executeAgent('iso-agent-b');

      // Abort A
      const abortA = await abortAgent('iso-agent-a');
      expect(abortA.success).toBe(true);

      // B should still be operable
      const updateB = await updateState('iso-agent-b', 'Still running');
      expect(updateB.success).toBe(true);

      const completeB = await completeAgent('iso-agent-b');
      expect(completeB.success).toBe(true);
    });

    it('should reject update on aborted agent while sibling continues', async () => {
      await createAgent('abort-iso-a');
      await createAgent('abort-iso-b');

      await executeAgent('abort-iso-a');
      await executeAgent('abort-iso-b');

      // Abort A
      await abortAgent('abort-iso-a');

      // A should be rejected
      const updateA = await updateState('abort-iso-a', 'Should fail');
      expect(updateA.success).toBe(false);

      // B should succeed
      const updateB = await updateState('abort-iso-b', 'Should succeed');
      expect(updateB.success).toBe(true);

      await completeAgent('abort-iso-b');
    });
  });
});
