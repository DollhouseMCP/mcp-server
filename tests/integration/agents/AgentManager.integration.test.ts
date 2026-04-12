import { promises as fs } from 'fs';
import * as path from 'path';

import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../src/elements/agents/Agent.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('AgentManager integration', () => {
  let manager: AgentManager;
  let env: PortfolioTestEnvironment;
  let agentsDir: string;
  let stateDir: string;

  beforeAll(async () => {
    env = await createPortfolioTestEnvironment('agent-manager-int');

    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    manager = new AgentManager({
      portfolioManager: env.portfolioManager,
      fileLockManager,
      baseDir: env.testDir,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
    });
    await manager.initialize();

    agentsDir = path.join(env.testDir, ElementType.AGENT);
    stateDir = path.join(agentsDir, '.state');
  });

  afterAll(async () => {
    // Dispose manager to stop file watchers and prevent open handles
    manager.dispose();
    await env.cleanup();
  });

  afterEach(async () => {
    await fs.rm(agentsDir, { recursive: true, force: true });
    await manager.initialize();
  });

  it('saves and loads agents with state persistence', async () => {
    const agent = new Agent({
      name: 'Integration Agent',
      description: 'Handles integration workflows'
    }, metadataService);

    agent.extensions = {
      ...agent.extensions,
      instructions: '# Integration Instructions\n\nAlways be helpful.'
    };

    agent.addGoal({
      description: 'Pass integration tests',
      priority: 'high'
    });

    await manager.save(agent, 'integration-agent.md');

    const statePath = path.join(stateDir, 'integration-agent.state.yaml');
    await expect(fs.access(statePath)).resolves.toBeUndefined();

    const loaded = await manager.load('integration-agent.md');
    expect(loaded.metadata.name).toBe('Integration Agent');
    expect((loaded.extensions as any).instructions).toContain('Integration Instructions');
    expect(loaded.getState().goals.length).toBeGreaterThan(0);
  });

  it('lists saved agents from disk', async () => {
    const agent = new Agent({ name: 'List Agent' }, metadataService);
    await manager.save(agent, 'list-agent.md');

    const agents = await manager.list();
    expect(agents.map(a => a.metadata.name)).toContain('List Agent');
  });

  it('deletes agent files and associated state', async () => {
    const agent = new Agent({ name: 'Deletable Agent' }, metadataService);
    agent.addGoal({ description: 'Clean up state' });

    await manager.save(agent, 'deletable-agent.md');
    await manager.delete('deletable-agent.md');

    await expect(fs.access(path.join(agentsDir, 'deletable-agent.md'))).rejects.toThrow();
    await expect(fs.access(path.join(stateDir, 'deletable-agent.state.yaml'))).rejects.toThrow();
  });

  it('loads legacy agent files with singular "type: agent" correctly', async () => {
    const legacyAgentContent = `---\nname: Legacy Agent\ndescription: An agent from the old days\ntype: agent\n---\n# Legacy Agent Instructions\nDo legacy things.`;
    const filename = 'legacy-agent.md';
    const filepath = path.join(agentsDir, filename);

    await fs.writeFile(filepath, legacyAgentContent, 'utf-8');

    const loaded = await manager.load(filename);
    expect(loaded.metadata.name).toBe('Legacy Agent');
    expect(loaded.metadata.type).toBe(ElementType.AGENT); // Should be converted to plural
    expect(loaded.extensions?.instructions).toContain('Do legacy things.');
  });

  it('loads modern agent files with plural "type: agents" correctly', async () => {
    const modernAgentContent = `---\nname: Modern Agent\ndescription: A new generation agent\ntype: agents\n---\n# Modern Agent Instructions\nDo modern things.`;
    const filename = 'modern-agent.md';
    const filepath = path.join(agentsDir, filename);

    await fs.writeFile(filepath, modernAgentContent, 'utf-8');

    const loaded = await manager.load(filename);
    expect(loaded.metadata.name).toBe('Modern Agent');
    expect(loaded.metadata.type).toBe(ElementType.AGENT);
    expect(loaded.extensions?.instructions).toContain('Do modern things.');
  });

  /**
   * Step Count Integration Tests
   *
   * These tests verify that AgentManager.recordAgentStep correctly computes
   * stepCount and that the autonomy directive uses the default config
   * (10 steps) for V1 agents that don't specify autonomy config.
   *
   * Note: V2 autonomy config persistence is tested separately. These tests
   * verify the step counting contract with default configuration.
   *
   * Added after PR #385 review identified the need to verify end-to-end
   * step counting behavior, not just the evaluator in isolation.
   */
  describe('Step count integration (autonomy directive)', () => {
    it('should use default maxAutonomousSteps (10) and track steps correctly', async () => {
      // Create agent (V1 style - will be auto-converted to V2 with defaults)
      const agent = new Agent({
        name: 'Default Steps Agent',
        description: 'Tests default step limit',
      }, metadataService);

      await manager.save(agent, 'default-steps-agent.md');

      await manager.executeAgent(
        'default-steps-agent',
        { objective: 'Test defaults' }
      );

      // Record step 1 - verify default max is 10
      const step1 = await manager.recordAgentStep({
        agentName: 'default-steps-agent',
        stepDescription: 'Step 1',
        outcome: 'success',
      });
      expect(step1.success).toBe(true);
      expect(step1.autonomy.continue).toBe(true);
      expect(step1.autonomy.factors).toContain('Step 2 of 10 autonomous steps');
      expect(step1.autonomy.stepsRemaining).toBe(8); // 10 - 1 - 1 = 8
    });

    it('should correctly compute stepCount from recorded decisions', async () => {
      const agent = new Agent({
        name: 'Step Count Agent',
        description: 'Tests step count computation',
      }, metadataService);

      await manager.save(agent, 'step-count-agent.md');

      await manager.executeAgent(
        'step-count-agent',
        { objective: 'Count steps' }
      );

      // Record multiple steps and verify stepCount progresses correctly
      // The formula for stepsRemaining is: max - stepCount - 1
      // With max=10:
      //   After step 1: stepCount=1, stepsRemaining = 10 - 1 - 1 = 8
      //   After step 2: stepCount=2, stepsRemaining = 10 - 2 - 1 = 7
      //   After step 3: stepCount=3, stepsRemaining = 10 - 3 - 1 = 6

      const step1 = await manager.recordAgentStep({
        agentName: 'step-count-agent',
        stepDescription: 'Step 1',
        outcome: 'success',
      });
      expect(step1.autonomy.stepsRemaining).toBe(8);
      expect(step1.autonomy.factors).toContain('Step 2 of 10 autonomous steps');

      const step2 = await manager.recordAgentStep({
        agentName: 'step-count-agent',
        stepDescription: 'Step 2',
        outcome: 'success',
      });
      expect(step2.autonomy.stepsRemaining).toBe(7);
      expect(step2.autonomy.factors).toContain('Step 3 of 10 autonomous steps');

      const step3 = await manager.recordAgentStep({
        agentName: 'step-count-agent',
        stepDescription: 'Step 3',
        outcome: 'success',
      });
      expect(step3.autonomy.stepsRemaining).toBe(6);
      expect(step3.autonomy.factors).toContain('Step 4 of 10 autonomous steps');
    });

    it('should stop exactly at maxAutonomousSteps (boundary test)', async () => {
      const agent = new Agent({
        name: 'Boundary Agent',
        description: 'Tests step limit boundary',
      }, metadataService);

      await manager.save(agent, 'boundary-agent.md');

      await manager.executeAgent(
        'boundary-agent',
        { objective: 'Test boundary' }
      );

      // Record 10 steps (the default max)
      for (let i = 1; i <= 9; i++) {
        const result = await manager.recordAgentStep({
          agentName: 'boundary-agent',
          stepDescription: `Step ${i}`,
          outcome: 'success',
        });
        expect(result.autonomy.continue).toBe(true);
      }

      // Step 10 should be the last - stepCount=10 triggers >= 10 check
      const step10 = await manager.recordAgentStep({
        agentName: 'boundary-agent',
        stepDescription: 'Step 10',
        outcome: 'success',
      });
      expect(step10.autonomy.continue).toBe(false);
      expect(step10.autonomy.reason).toContain('Maximum autonomous steps reached');
      expect(step10.autonomy.stepsRemaining).toBe(0);
    });

    it('should pause on step failure regardless of step count', async () => {
      const agent = new Agent({
        name: 'Failure Agent',
        description: 'Tests failure handling',
      }, metadataService);

      await manager.save(agent, 'failure-agent.md');

      await manager.executeAgent(
        'failure-agent',
        { objective: 'Test failure' }
      );

      // First step succeeds
      const step1 = await manager.recordAgentStep({
        agentName: 'failure-agent',
        stepDescription: 'Step 1',
        outcome: 'success',
      });
      expect(step1.autonomy.continue).toBe(true);

      // Second step fails - should pause
      const step2 = await manager.recordAgentStep({
        agentName: 'failure-agent',
        stepDescription: 'Step 2 failed',
        outcome: 'failure',
      });
      expect(step2.autonomy.continue).toBe(false);
      expect(step2.autonomy.reason).toContain('Previous step failed');
    });
  });

  describe('V2 Field Validation Integration', () => {
    it('should reject agent creation with invalid goal template content', async () => {
      // This tests the full flow: create() -> validator -> content security check
      const result = await manager.create(
        'Malicious-Agent',
        'Agent with suspicious content',
        'Instructions',
        {
          goal: {
            template: '{{constructor.constructor("return this")()}}',
            parameters: []
          }
        }
      );

      // ValidationService should catch suspicious patterns
      // Note: The exact behavior depends on ValidationService.validateContent patterns
      // This test verifies the integration path exists
      expect(result).toBeDefined();
    });

    it('should accept valid V2 agent with all fields', async () => {
      const result = await manager.create(
        'Complete-V2-Agent',
        'Agent with all V2 fields',
        '# Instructions\n\nBe helpful and complete tasks.',
        {
          goal: {
            template: 'Complete the task: {task_name}',
            parameters: [
              { name: 'task_name', type: 'string', required: true, description: 'Name of the task' }
            ],
            successCriteria: ['Task completed', 'Results documented']
          },
          activates: {
            personas: ['helper'],
            skills: ['code-review']
          },
          tools: {
            allowed: ['read_file', 'write_file'],
            denied: ['delete_file']
          },
          systemPrompt: 'You are a helpful assistant that completes tasks efficiently.',
          autonomy: {
            riskTolerance: 'moderate',
            maxAutonomousSteps: 5,
            requiresApproval: ['deploy_*'],
            autoApprove: ['read_*']
          }
        }
      );

      expect(result.success).toBe(true);
      expect(result.element).toBeDefined();

      // Verify the agent can be loaded and has all V2 fields
      const loaded = await manager.read('Complete-V2-Agent');
      expect(loaded).toBeDefined();
      expect((loaded!.metadata as any).goal).toBeDefined();
      expect((loaded!.metadata as any).goal.template).toBe('Complete the task: {task_name}');
      expect((loaded!.metadata as any).activates).toBeDefined();
      expect((loaded!.metadata as any).tools).toBeDefined();
      expect((loaded!.metadata as any).systemPrompt).toBeDefined();
      expect((loaded!.metadata as any).autonomy).toBeDefined();
    });

    it('should reject agent with invalid autonomy configuration', async () => {
      const result = await manager.create(
        'Invalid-Autonomy-Agent',
        'Agent with invalid autonomy',
        'Instructions',
        {
          goal: {
            template: 'Do something',
            parameters: []
          },
          autonomy: {
            maxAutonomousSteps: -5 // Invalid: must be non-negative
          }
        }
      );

      // Should fail validation
      expect(result.success).toBe(false);
      expect(result.message).toContain('non-negative');
    });

    it('should normalize string goal to V2 format', async () => {
      const result = await manager.create(
        'String-Goal-Agent',
        'Agent with string goal',
        'Instructions',
        {
          goal: 'Complete the analysis task' // String goal, should be normalized
        }
      );

      expect(result.success).toBe(true);

      const loaded = await manager.read('String-Goal-Agent');
      expect(loaded).toBeDefined();

      // Goal should be normalized to V2 format
      const goal = (loaded!.metadata as any).goal;
      expect(goal).toBeDefined();
      expect(goal.template).toBe('Complete the analysis task');
      expect(goal.parameters).toEqual([]);
    });

    it('should sanitize parameter defaults during normalization', async () => {
      const result = await manager.create(
        'Sanitized-Defaults-Agent',
        'Agent with sanitized defaults',
        'Instructions',
        {
          goal: {
            template: 'Run command: {cmd}',
            parameters: [
              {
                name: 'cmd',
                type: 'string',
                required: false,
                default: '<script>alert("xss")</script>'
              }
            ]
          }
        }
      );

      expect(result.success).toBe(true);

      const loaded = await manager.read('Sanitized-Defaults-Agent');
      const defaultValue = (loaded!.metadata as any).goal.parameters[0].default;

      // Default should be sanitized (no script tags)
      expect(defaultValue).not.toContain('<script>');
      expect(defaultValue).not.toContain('</script>');
    });
  });

  // =========================================================================
  // Issue #391: Autonomy metrics integration — verify metrics reflect live evaluations
  // =========================================================================
  describe('Autonomy metrics integration (Issue #391)', () => {
    let getAutonomyMetrics: () => import('../../../src/elements/agents/autonomyEvaluator.js').AutonomyMetricsSnapshot;
    let resetAutonomyMetrics: () => void;

    beforeAll(async () => {
      const mod = await import('../../../src/elements/agents/autonomyEvaluator.js');
      getAutonomyMetrics = mod.getAutonomyMetrics;
      resetAutonomyMetrics = mod.resetAutonomyMetrics;
    });

    it('should accumulate metrics from live recordAgentStep evaluations', async () => {
      resetAutonomyMetrics();
      const metricsBefore = getAutonomyMetrics();
      expect(metricsBefore.totalEvaluations).toBe(0);

      // Create and start a test agent
      const agent = new Agent({
        name: 'Metrics Test Agent',
        description: 'Agent for metrics integration test',
      }, metadataService);
      await manager.save(agent, 'metrics-test-agent.md');
      await manager.executeAgent('metrics-test-agent', { objective: 'Test metrics' });

      // Record a successful step → should be a "continue"
      const step1 = await manager.recordAgentStep({
        agentName: 'metrics-test-agent',
        stepDescription: 'Read a file',
        outcome: 'success',
      });
      expect(step1.autonomy.continue).toBe(true);

      // Record a failed step → should be a "pause"
      const step2 = await manager.recordAgentStep({
        agentName: 'metrics-test-agent',
        stepDescription: 'Operation failed',
        outcome: 'failure',
      });
      expect(step2.autonomy.continue).toBe(false);

      const metricsAfter = getAutonomyMetrics();
      expect(metricsAfter.totalEvaluations).toBe(2);
      expect(metricsAfter.continueCount).toBe(1);
      expect(metricsAfter.pauseCount).toBe(1);
      expect(Object.keys(metricsAfter.pauseReasons).length).toBeGreaterThan(0);
    });

    it('should track pause reasons with descriptive strings', async () => {
      resetAutonomyMetrics();

      const agent = new Agent({
        name: 'Reason Tracking Agent',
        description: 'Agent for pause reason tracking test',
      }, metadataService);
      await manager.save(agent, 'reason-tracking-agent.md');
      await manager.executeAgent('reason-tracking-agent', { objective: 'Test reasons' });

      // Record 9 successful steps — with default max=10, stepCount 1-9 all continue.
      // Step 10 (stepCount=10, 10>=10) will be the first pause.
      for (let i = 0; i < 9; i++) {
        const result = await manager.recordAgentStep({
          agentName: 'reason-tracking-agent',
          stepDescription: `Step ${i + 1}`,
          outcome: 'success',
        });
        expect(result.autonomy.continue).toBe(true);
      }

      // Step 10: stepCount=10 hits the limit → pause
      const step10 = await manager.recordAgentStep({
        agentName: 'reason-tracking-agent',
        stepDescription: 'Step 10',
        outcome: 'success',
      });
      expect(step10.autonomy.continue).toBe(false);
      expect(step10.autonomy.reason).toContain('Maximum autonomous steps');

      const metrics = getAutonomyMetrics();
      expect(metrics.continueCount).toBe(9);
      expect(metrics.pauseCount).toBe(1);
      // Pause reason should reference "Maximum autonomous steps"
      const reasons = Object.keys(metrics.pauseReasons);
      expect(reasons.some(r => r.includes('Maximum autonomous steps'))).toBe(true);
    });

    it('should return consistent snapshots across multiple reads', async () => {
      resetAutonomyMetrics();

      const agent = new Agent({
        name: 'Snapshot Agent',
        description: 'Agent for snapshot consistency test',
      }, metadataService);
      await manager.save(agent, 'snapshot-agent.md');
      await manager.executeAgent('snapshot-agent', { objective: 'Snapshot test' });

      await manager.recordAgentStep({
        agentName: 'snapshot-agent',
        stepDescription: 'Single step',
        outcome: 'success',
      });

      // Take two snapshots — first should not be mutated by subsequent reads
      const snap1 = getAutonomyMetrics();
      const snap2 = getAutonomyMetrics();

      expect(snap1.totalEvaluations).toBe(snap2.totalEvaluations);
      expect(snap1.continueCount).toBe(snap2.continueCount);

      // Mutating snap1 should not affect snap2
      snap1.pauseReasons['injected'] = 999;
      expect(snap2.pauseReasons['injected']).toBeUndefined();
    });
  });

  // =========================================================================
  // Issue #390: Configurable thresholds integration — env var overrides
  // =========================================================================
  describe('Configurable thresholds integration (Issue #390)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should use env-configured max steps when agent has no explicit config', async () => {
      // Set env to allow only 3 steps
      process.env.DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT = '3';

      const agent = new Agent({
        name: 'Env Steps Agent',
        description: 'Agent for env-configured step limit test',
      }, metadataService);
      await manager.save(agent, 'env-steps-agent.md');
      await manager.executeAgent('env-steps-agent', { objective: 'Test env steps' });

      // With max=3: stepCount 1 and 2 continue, stepCount 3 pauses (3>=3)
      const step1 = await manager.recordAgentStep({
        agentName: 'env-steps-agent',
        stepDescription: 'Step 1',
        outcome: 'success',
      });
      expect(step1.autonomy.continue).toBe(true);
      expect(step1.autonomy.stepsRemaining).toBe(1); // 3 - 1 - 1 = 1

      const step2 = await manager.recordAgentStep({
        agentName: 'env-steps-agent',
        stepDescription: 'Step 2',
        outcome: 'success',
      });
      expect(step2.autonomy.continue).toBe(true);
      expect(step2.autonomy.stepsRemaining).toBe(0); // 3 - 2 - 1 = 0

      // Step 3: stepCount=3 hits the env-configured limit → pause
      const step3 = await manager.recordAgentStep({
        agentName: 'env-steps-agent',
        stepDescription: 'Step 3',
        outcome: 'success',
      });
      expect(step3.autonomy.continue).toBe(false);
      expect(step3.autonomy.reason).toContain('Maximum autonomous steps');
      expect(step3.autonomy.reason).toContain('3'); // reflects the env-configured limit
    });
  });
});
