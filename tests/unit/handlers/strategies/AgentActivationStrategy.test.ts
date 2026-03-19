import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AgentActivationStrategy } from '../../../../src/handlers/strategies/AgentActivationStrategy.js';
import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';

describe('AgentActivationStrategy', () => {
  let strategy: AgentActivationStrategy;
  let mockAgentManager: jest.Mocked<AgentManager>;

  beforeEach(() => {
    mockAgentManager = {
      list: jest.fn(),
      get: jest.fn(),
      activateAgent: jest.fn(),
      deactivateAgent: jest.fn(),
      getActiveAgents: jest.fn(),
      persistState: jest.fn(),
    } as unknown as jest.Mocked<AgentManager>;

    strategy = new AgentActivationStrategy(mockAgentManager);
  });

  describe('activate', () => {
    it('should activate agent successfully with specializations', async () => {
      const mockAgent = {
        metadata: {
          name: 'test-agent',
          description: 'Test agent',
          specializations: ['planning', 'execution']
        },
        extensions: {
          decisionFramework: 'rule-based',
          riskTolerance: 'moderate'
        },
        getState: jest.fn().mockReturnValue({
          goals: [],
          decisions: [],
          context: {},
          lastActive: new Date(),
          sessionCount: 0,
          stateVersion: 1
        }),
        markStatePersisted: jest.fn(),
        activate: jest.fn().mockResolvedValue(undefined),
        deactivate: jest.fn(),
        getStatus: jest.fn()
      };

      mockAgentManager.activateAgent.mockResolvedValue({
        success: true,
        message: 'Activated',
        agent: mockAgent
      });
      mockAgentManager.persistState.mockResolvedValue(undefined);

      const result = await strategy.activate('test-agent');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('planning, execution');
      expect(result.content[0].text).toContain('Session');
      expect(mockAgentManager.persistState).toHaveBeenCalled();
    });

    it('should handle agent without specializations', async () => {
      const mockAgent = {
        metadata: {
          name: 'general-agent',
          description: 'General purpose'
        },
        extensions: {},
        getState: jest.fn().mockReturnValue({
          goals: [],
          decisions: [],
          context: {},
          lastActive: new Date(),
          sessionCount: 0,
          stateVersion: 1
        }),
        markStatePersisted: jest.fn(),
        activate: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn()
      };

      mockAgentManager.activateAgent.mockResolvedValue({
        success: true,
        message: 'Activated',
        agent: mockAgent
      });
      mockAgentManager.persistState.mockResolvedValue(undefined);

      const result = await strategy.activate('general-agent');

      expect(result.content[0].text).toContain('✅');
      // Issue #749: No phantom 'general' default when specializations absent
      expect(result.content[0].text).not.toContain('Specializations');
    });

    it('should return error when agent not found', async () => {
      mockAgentManager.activateAgent.mockResolvedValue({
        success: false,
        message: 'Agent not found'
      });

      const result = await strategy.activate('missing-agent');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('missing-agent');
    });

    it('should propagate activation errors', async () => {
      mockAgentManager.activateAgent.mockRejectedValue(new Error('Activation failed'));

      await expect(strategy.activate('error-agent')).rejects.toThrow('Activation failed');
    });
  });

  describe('deactivate', () => {
    it('should deactivate agent successfully', async () => {
      mockAgentManager.deactivateAgent.mockResolvedValue({
        success: true,
        message: 'Agent deactivated'
      });

      const result = await strategy.deactivate('active-agent');

      expect(result.content[0].text).toContain('Agent deactivated');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when agent not found', async () => {
      mockAgentManager.deactivateAgent.mockResolvedValue({
        success: false,
        message: 'Agent not found'
      });

      await expect(strategy.deactivate('missing-agent'))
        .rejects.toThrow('Agent \'missing-agent\' not found');
    });

    it('should propagate deactivation errors', async () => {
      mockAgentManager.deactivateAgent.mockRejectedValue(new Error('Deactivation failed'));

      await expect(strategy.deactivate('error-agent')).rejects.toThrow('Deactivation failed');
    });
  });

  describe('getActiveElements', () => {
    it('should return empty message when no active agents', async () => {
      mockAgentManager.getActiveAgents.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active agents');
      expect(result.content[0].text).toContain('🤖');
    });

    it('should list active agents with goal counts', async () => {
      const activeAgents = [
        {
          metadata: { name: 'agent-one' },
          getState: jest.fn().mockReturnValue({ goals: [{ id: 1 }, { id: 2 }] })
        },
        {
          metadata: { name: 'agent-two' },
          getState: jest.fn().mockReturnValue({ goals: [] })
        }
      ];

      mockAgentManager.getActiveAgents.mockResolvedValue(activeAgents);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('agent-one');
      expect(result.content[0].text).toContain('2 active goals');
      expect(result.content[0].text).toContain('agent-two');
      expect(result.content[0].text).toContain('0 active goals');
    });

    it('should handle agents without state', async () => {
      const activeAgents = [
        {
          metadata: { name: 'agent-no-state' },
          getState: jest.fn().mockReturnValue({ goals: [] })
        }
      ];

      mockAgentManager.getActiveAgents.mockResolvedValue(activeAgents);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('agent-no-state');
      expect(result.content[0].text).toContain('0 active goals');
    });

    it('should handle empty agent list', async () => {
      mockAgentManager.getActiveAgents.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active agents');
    });
  });

  describe('getElementDetails', () => {
    it('should return complete agent details', async () => {
      const mockAgent = {
        metadata: {
          name: 'detailed-agent',
          description: 'A detailed agent',
          specializations: ['research', 'analysis'],
          decisionFramework: 'heuristic',
          riskTolerance: 'medium'
        },
        instructions: 'Agent instructions here',
        getStatus: jest.fn().mockReturnValue('active'),
        state: {
          goals: [
            { description: 'Goal 1', status: 'active' },
            { description: 'Goal 2', status: 'completed' }
          ]
        }
      };

      mockAgentManager.list.mockResolvedValue([mockAgent]);

      const result = await strategy.getElementDetails('detailed-agent');

      expect(result.content[0].text).toContain('detailed-agent');
      expect(result.content[0].text).toContain('A detailed agent');
      expect(result.content[0].text).toContain('active');
      expect(result.content[0].text).toContain('research, analysis');
      expect(result.content[0].text).toContain('heuristic');
      expect(result.content[0].text).toContain('medium');
      expect(result.content[0].text).toContain('Agent instructions');
      expect(result.content[0].text).toContain('Goal 1');
      expect(result.content[0].text).toContain('Goal 2');
    });

    it('should handle minimal agent metadata', async () => {
      const mockAgent = {
        metadata: {
          name: 'simple-agent',
          description: 'Simple'
        },
        getStatus: jest.fn().mockReturnValue('inactive')
      };

      mockAgentManager.list.mockResolvedValue([mockAgent]);

      const result = await strategy.getElementDetails('simple-agent');

      expect(result.content[0].text).toContain('simple-agent');
      expect(result.content[0].text).toContain('inactive');
      // Issue #749: V1 defaults should NOT appear when fields are absent
      expect(result.content[0].text).not.toContain('general'); // no phantom specialization
      expect(result.content[0].text).not.toContain('rule-based'); // no phantom framework
      expect(result.content[0].text).not.toContain('Risk Tolerance'); // no phantom risk tolerance
      expect(result.content[0].text).toContain('No instructions available');
    });

    // Issue #749: V2 agents should not show phantom V1 defaults
    it('should not show V1 defaults for V2 agents with goal config', async () => {
      const mockAgent = {
        metadata: {
          name: 'v2-agent',
          description: 'A V2 agent with goal',
          goal: { template: 'Review {target}', parameters: [{ name: 'target', type: 'string', required: true }] },
          autonomy: { riskTolerance: 'conservative', maxAutonomousSteps: 10 }
        },
        extensions: {
          decisionFramework: 'rule_based',  // Constructor default — should NOT display
          riskTolerance: 'moderate'          // Constructor default — should NOT display
        },
        instructions: 'V2 agent instructions',
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockAgentManager.list.mockResolvedValue([mockAgent]);

      const result = await strategy.getElementDetails('v2-agent');

      expect(result.content[0].text).toContain('v2-agent');
      // V1 phantom defaults must NOT appear
      expect(result.content[0].text).not.toContain('Decision Framework');
      expect(result.content[0].text).not.toContain('rule_based');
      expect(result.content[0].text).not.toContain('**Risk Tolerance**: moderate');
      // V2 autonomy section SHOULD appear
      expect(result.content[0].text).toContain('Autonomy Configuration');
      expect(result.content[0].text).toContain('conservative');
    });

    it('should throw ElementNotFoundError when agent not found', async () => {
      mockAgentManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing'))
        .rejects.toThrow('Agent \'missing\' not found');
    });

    it('should handle agent without goals', async () => {
      const mockAgent = {
        metadata: {
          name: 'no-goals',
          description: 'No goals'
        },
        instructions: 'Instructions',
        getStatus: jest.fn().mockReturnValue('active'),
        state: { goals: [] }
      };

      mockAgentManager.list.mockResolvedValue([mockAgent]);

      const result = await strategy.getElementDetails('no-goals');

      expect(result.content[0].text).toContain('no-goals');
      expect(result.content[0].text).not.toContain('Current Goals:');
    });

    it('should handle agent without state', async () => {
      const mockAgent = {
        metadata: {
          name: 'no-state',
          description: 'No state'
        },
        instructions: 'Instructions',
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockAgentManager.list.mockResolvedValue([mockAgent]);

      const result = await strategy.getElementDetails('no-state');

      expect(result.content[0].text).toContain('no-state');
      expect(result.content[0].text).not.toContain('Current Goals:');
    });
  });
});
