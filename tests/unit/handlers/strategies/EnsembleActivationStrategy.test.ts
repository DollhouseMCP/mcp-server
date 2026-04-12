import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EnsembleActivationStrategy } from '../../../../src/handlers/strategies/EnsembleActivationStrategy.js';
import type { EnsembleManager } from '../../../../src/elements/ensembles/EnsembleManager.js';
import type { SkillManager } from '../../../../src/elements/skills/SkillManager.js';
import type { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import type { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import type { PersonaManager } from '../../../../src/persona/PersonaManager.js';
import type { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';

describe('EnsembleActivationStrategy', () => {
  let strategy: EnsembleActivationStrategy;
  let mockEnsembleManager: jest.Mocked<EnsembleManager>;
  let mockPortfolioManager: jest.Mocked<PortfolioManager>;
  let mockSkillManager: jest.Mocked<SkillManager>;
  let mockTemplateManager: jest.Mocked<TemplateManager>;
  let mockAgentManager: jest.Mocked<AgentManager>;
  let mockMemoryManager: jest.Mocked<MemoryManager>;
  let mockPersonaManager: jest.Mocked<PersonaManager>;

  beforeEach(() => {
    mockEnsembleManager = {
      list: jest.fn(),
      activateEnsemble: jest.fn(),
      deactivateEnsemble: jest.fn(),
      getActiveEnsembles: jest.fn(),
    } as unknown as jest.Mocked<EnsembleManager>;

    mockPortfolioManager = {} as jest.Mocked<PortfolioManager>;
    mockSkillManager = {
      deactivateSkill: jest.fn(),
    } as unknown as jest.Mocked<SkillManager>;
    mockTemplateManager = {} as jest.Mocked<TemplateManager>;
    mockAgentManager = {
      deactivateAgent: jest.fn(),
    } as unknown as jest.Mocked<AgentManager>;
    mockMemoryManager = {
      deactivateMemory: jest.fn(),
    } as unknown as jest.Mocked<MemoryManager>;
    mockPersonaManager = {
      deactivatePersona: jest.fn(),
    } as unknown as jest.Mocked<PersonaManager>;

    strategy = new EnsembleActivationStrategy(
      mockEnsembleManager,
      mockPortfolioManager,
      mockSkillManager,
      mockTemplateManager,
      mockAgentManager,
      mockMemoryManager,
      mockPersonaManager
    );
  });

  describe('activate', () => {
    it('should activate ensemble successfully with all elements', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'test-ensemble',  // Ensemble's own name (not element_name)
          description: 'Test ensemble',
          activationStrategy: 'sequential',
          elements: [
            { element_name: 'skill1', element_type: 'skill' },
            { element_name: 'template1', element_type: 'template' }
          ]
        },
        activateEnsemble: jest.fn().mockResolvedValue({
          success: true,
          activatedElements: ['skill1', 'template1'],
          failedElements: [],
          elementResults: [],
          totalDuration: 150
        }),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('test-ensemble');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-ensemble');
      expect(result.content[0].text).toContain('sequential');
      expect(result.content[0].text).toContain('2 elements'); // activated count
      expect(result.content[0].text).toContain('0 elements'); // failed count
      expect(result.content[0].text).toContain('150ms');
      expect(result.content[0].text).toContain('skill1');
      expect(result.content[0].text).toContain('template1');
      expect(mockEnsemble.activateEnsemble).toHaveBeenCalledWith(
        mockPortfolioManager,
        {
          skillManager: mockSkillManager,
          templateManager: mockTemplateManager,
          agentManager: mockAgentManager,
          memoryManager: mockMemoryManager,
          personaManager: mockPersonaManager,
          ensembleManager: mockEnsembleManager
        }
      );
    });

    it('should handle partial activation with failures', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'partial-ensemble',
          activationStrategy: 'all',
          elements: [
            { name: 'success1', element_type: 'skill' },
            { name: 'failed1', element_type: 'agent' }
          ]
        },
        activateEnsemble: jest.fn().mockResolvedValue({
          success: false,
          activatedElements: ['success1'],
          failedElements: ['failed1'],
          elementResults: [
            { elementName: 'success1', success: true },
            { elementName: 'failed1', success: false, error: new Error('Agent not found') }
          ],
          totalDuration: 200
        }),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('partial-ensemble');

      expect(result.content[0].text).toContain('⚠️'); // warning emoji
      expect(result.content[0].text).toContain('partial-ensemble');
      expect(result.content[0].text).toContain('1 elements'); // activated
      expect(result.content[0].text).toContain('1 elements'); // failed
      expect(result.content[0].text).toContain('success1');
      expect(result.content[0].text).toContain('failed1');
      expect(result.content[0].text).toContain('Agent not found');
    });

    it('should handle activation with no failures', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'perfect-ensemble',
          activationStrategy: 'sequential'
        },
        activateEnsemble: jest.fn().mockResolvedValue({
          success: true,
          activatedElements: ['elem1', 'elem2', 'elem3'],
          failedElements: [],
          elementResults: [],
          totalDuration: 300
        }),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('perfect-ensemble');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('3 elements');
      expect(result.content[0].text).toContain('0 elements');
      expect(result.content[0].text).not.toContain('Failed Elements:');
    });

    it('should return error when ensemble not found', async () => {
      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: false,
        message: 'Ensemble not found'
      });

      const result = await strategy.activate('missing-ensemble');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('missing-ensemble');
    });

    it('should handle ensemble activation throwing error', async () => {
      const mockEnsemble = {
        metadata: { name: 'error-ensemble' },
        activateEnsemble: jest.fn().mockRejectedValue(new Error('Activation error')),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('error-ensemble');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Failed to activate ensemble');
      expect(result.content[0].text).toContain('Activation error');
    });

    it('should handle non-Error exceptions', async () => {
      const mockEnsemble = {
        metadata: { name: 'string-error-ensemble' },
        activateEnsemble: jest.fn().mockRejectedValue('String error'),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('string-error-ensemble');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('should handle failed elements with missing error message', async () => {
      const mockEnsemble = {
        metadata: { name: 'partial' },
        activateEnsemble: jest.fn().mockResolvedValue({
          success: false,
          activatedElements: [],
          failedElements: ['elem1'],
          elementResults: [
            { elementName: 'elem1', success: false } // no error object
          ],
          totalDuration: 100
        }),
        getStatus: jest.fn()
      };

      mockEnsembleManager.activateEnsemble.mockResolvedValue({
        success: true,
        message: 'Activated',
        ensemble: mockEnsemble
      });

      const result = await strategy.activate('partial');

      expect(result.content[0].text).toContain('elem1');
      expect(result.content[0].text).toContain('Unknown error');
    });
  });

  describe('deactivate', () => {
    it('should deactivate ensemble with deactivate method', async () => {
      mockEnsembleManager.deactivateEnsemble.mockResolvedValue({
        success: true,
        message: '✅ Ensemble active-ensemble deactivated',
        ensemble: {
          metadata: {
            name: 'active-ensemble',
            elements: [],
          },
        } as any
      });

      const result = await strategy.deactivate('active-ensemble');

      expect(result.content[0].text).toContain('active-ensemble');
      expect(result.content[0].text).toContain('deactivated');
    });

    it('should deactivate ensemble members via their type managers', async () => {
      mockEnsembleManager.deactivateEnsemble.mockResolvedValue({
        success: true,
        message: '✅ Ensemble active-ensemble deactivated',
        ensemble: {
          metadata: {
            name: 'active-ensemble',
            elements: [
              { element_name: 'persona-member', element_type: 'persona' },
              { element_name: 'skill-member', element_type: 'skill' },
              { element_name: 'agent-member', element_type: 'agent' },
              { element_name: 'memory-member', element_type: 'memory' },
              { element_name: 'nested-ensemble', element_type: 'ensemble' },
              { element_name: 'template-member', element_type: 'template' },
            ],
          },
        } as any
      });

      await strategy.deactivate('active-ensemble');

      expect(mockPersonaManager.deactivatePersona).toHaveBeenCalledWith('persona-member');
      expect(mockSkillManager.deactivateSkill).toHaveBeenCalledWith('skill-member');
      expect(mockAgentManager.deactivateAgent).toHaveBeenCalledWith('agent-member');
      expect(mockMemoryManager.deactivateMemory).toHaveBeenCalledWith('memory-member');
      expect(mockEnsembleManager.deactivateEnsemble).toHaveBeenCalledWith('nested-ensemble');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when ensemble not found', async () => {
      mockEnsembleManager.deactivateEnsemble.mockResolvedValue({
        success: false,
        message: 'Ensemble not found'
      });

      await expect(strategy.deactivate('missing-ensemble'))
        .rejects.toThrow('Ensemble \'missing-ensemble\' not found');
    });

    it('should propagate deactivation errors', async () => {
      mockEnsembleManager.deactivateEnsemble.mockRejectedValue(new Error('Deactivation failed'));

      await expect(strategy.deactivate('error-ensemble')).rejects.toThrow('Deactivation failed');
    });
  });

  describe('getActiveElements', () => {
    it('should return empty message when no active ensembles', async () => {
      mockEnsembleManager.getActiveEnsembles.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active ensembles');
      expect(result.content[0].text).toContain('🎭');
    });

    it('should list active ensembles with element counts', async () => {
      const activeEnsembles = [
        {
          metadata: {
            name: 'ensemble-one',
            elements: [
              { name: 'e1', element_type: 'skill' },
              { name: 'e2', element_type: 'agent' },
              { name: 'e3', element_type: 'memory' }
            ]
          },
          getStatus: jest.fn().mockReturnValue('active')
        },
        {
          metadata: {
            name: 'ensemble-two',
            elements: [{ name: 'e1', element_type: 'skill' }]
          },
          getStatus: jest.fn().mockReturnValue('active')
        }
      ];

      mockEnsembleManager.getActiveEnsembles.mockResolvedValue(activeEnsembles);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('ensemble-one');
      expect(result.content[0].text).toContain('3 elements');
      expect(result.content[0].text).toContain('ensemble-two');
      expect(result.content[0].text).toContain('1 elements');
    });

    it('should handle ensemble without elements array', async () => {
      const activeEnsembles = [
        {
          metadata: { name: 'no-elements' },
          getStatus: jest.fn().mockReturnValue('active')
        }
      ];

      mockEnsembleManager.getActiveEnsembles.mockResolvedValue(activeEnsembles);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('no-elements');
      expect(result.content[0].text).toContain('0 elements');
    });

    it('should handle empty ensemble list', async () => {
      mockEnsembleManager.getActiveEnsembles.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active ensembles');
    });
  });

  describe('getElementDetails', () => {
    it('should return complete ensemble details', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'detailed-ensemble',
          description: 'A detailed ensemble',
          version: '2.1.0',
          activationStrategy: 'all',
          conflictResolution: 'merge',
          contextSharing: 'full',
          allowNested: true,
          maxNestingDepth: 10,
          elements: [
            {
              element_name: 'skill1',
              element_type: 'skill',
              role: 'processor',
              priority: 1,
              activation: 'immediate'
            },
            {
              element_name: 'agent1',
              element_type: 'agent',
              role: 'executor',
              priority: 2,
              activation: 'lazy'
            }
          ]
        },
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockEnsembleManager.list.mockResolvedValue([mockEnsemble]);

      const result = await strategy.getElementDetails('detailed-ensemble');

      expect(result.content[0].text).toContain('detailed-ensemble');
      expect(result.content[0].text).toContain('A detailed ensemble');
      expect(result.content[0].text).toContain('active');
      expect(result.content[0].text).toContain('2.1.0');
      expect(result.content[0].text).toContain('all');
      expect(result.content[0].text).toContain('merge');
      expect(result.content[0].text).toContain('full');
      expect(result.content[0].text).toContain('Yes'); // allowNested
      expect(result.content[0].text).toContain('10'); // maxNestingDepth
      expect(result.content[0].text).toContain('skill1');
      expect(result.content[0].text).toContain('processor');
      expect(result.content[0].text).toContain('priority: 1');
      expect(result.content[0].text).toContain('immediate');
      expect(result.content[0].text).toContain('agent1');
    });

    it('should handle minimal ensemble metadata', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'simple-ensemble',
          description: 'Simple',
          elements: []
        },
        getStatus: jest.fn().mockReturnValue('inactive')
      };

      mockEnsembleManager.list.mockResolvedValue([mockEnsemble]);

      const result = await strategy.getElementDetails('simple-ensemble');

      expect(result.content[0].text).toContain('simple-ensemble');
      expect(result.content[0].text).toContain('inactive');
      expect(result.content[0].text).toContain('1.0.0'); // default version
      expect(result.content[0].text).toContain('sequential'); // default strategy
      expect(result.content[0].text).toContain('last-write'); // default conflict
      expect(result.content[0].text).toContain('selective'); // default sharing
      expect(result.content[0].text).toContain('No'); // default allowNested
      expect(result.content[0].text).toContain('5'); // default maxNestingDepth
    });

    it('should handle ensemble without elements', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'no-elements',
          description: 'No elements'
        },
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockEnsembleManager.list.mockResolvedValue([mockEnsemble]);

      const result = await strategy.getElementDetails('no-elements');

      expect(result.content[0].text).toContain('no-elements');
      expect(result.content[0].text).toContain('(0)'); // element count
      expect(result.content[0].text).toContain('No elements configured');
    });

    it('should throw ElementNotFoundError when ensemble not found', async () => {
      mockEnsembleManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing'))
        .rejects.toThrow('Ensemble \'missing\' not found');
    });

    it('should format multiple elements correctly', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'multi-elem',
          description: 'Multiple',
          elements: [
            { element_name: 'e1', element_type: 't1', role: 'r1', priority: 1, activation: 'a1' },
            { element_name: 'e2', element_type: 't2', role: 'r2', priority: 2, activation: 'a2' },
            { element_name: 'e3', element_type: 't3', role: 'r3', priority: 3, activation: 'a3' }
          ]
        },
        getStatus: jest.fn().mockReturnValue('active')
      };

      mockEnsembleManager.list.mockResolvedValue([mockEnsemble]);

      const result = await strategy.getElementDetails('multi-elem');

      expect(result.content[0].text).toContain('(3)'); // count
      expect(result.content[0].text).toContain('e1');
      expect(result.content[0].text).toContain('e2');
      expect(result.content[0].text).toContain('e3');
    });
  });
});
