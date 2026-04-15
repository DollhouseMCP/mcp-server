import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SkillActivationStrategy } from '../../../../src/handlers/strategies/SkillActivationStrategy.js';
import type { SkillManager } from '../../../../src/elements/skills/SkillManager.js';

describe('SkillActivationStrategy', () => {
  let strategy: SkillActivationStrategy;
  let mockSkillManager: jest.Mocked<SkillManager>;

  beforeEach(() => {
    mockSkillManager = {
      list: jest.fn(),
      get: jest.fn(),
      activateSkill: jest.fn(),
      deactivateSkill: jest.fn(),
      getActiveSkills: jest.fn(),
    } as unknown as jest.Mocked<SkillManager>;

    strategy = new SkillActivationStrategy(mockSkillManager);
  });

  describe('activate', () => {
    it('should activate skill successfully', async () => {
      const mockSkill = {
        metadata: {
          name: 'test-skill',
          description: 'Test skill'
        },
        instructions: 'Follow these instructions',
        activate: jest.fn().mockResolvedValue(undefined),
        deactivate: jest.fn(),
        getStatus: jest.fn()
      };

      mockSkillManager.activateSkill.mockResolvedValue({
        success: true,
        message: 'Activated',
        skill: mockSkill
      });

      const result = await strategy.activate('test-skill');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-skill');
      expect(result.content[0].text).toContain('Follow these instructions');
    });

    it('should handle skill without activate method', async () => {
      const mockSkill = {
        metadata: {
          name: 'simple-skill',
          description: 'Simple'
        },
        instructions: 'Instructions',
        getStatus: jest.fn()
      };

      mockSkillManager.activateSkill.mockResolvedValue({
        success: true,
        message: 'Activated',
        skill: mockSkill
      });

      const result = await strategy.activate('simple-skill');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('simple-skill');
    });

    it('should include a warning when the skill gatekeeper policy is malformed', async () => {
      const mockSkill = {
        metadata: {
          name: 'warning-skill',
          description: 'Warns about malformed policy',
          gatekeeperDiagnostics: {
            valid: false,
            enforceable: false,
            message: 'externalRestrictions must be nested under gatekeeper',
          },
        },
        instructions: 'Follow these instructions',
        activate: jest.fn().mockResolvedValue(undefined),
        deactivate: jest.fn(),
        getStatus: jest.fn(),
      };

      mockSkillManager.activateSkill.mockResolvedValue({
        success: true,
        message: 'Activated',
        skill: mockSkill,
      });

      const result = await strategy.activate('warning-skill');

      expect(result.content[0].text).toContain('Gatekeeper Policy Warning');
      expect(result.content[0].text).toContain('externalRestrictions must be nested under gatekeeper');
      expect(result.content[0].text).toContain('still activate');
      expect(result.content[0].text).toContain('not being enforced');
    });

    it('should return error when skill not found', async () => {
      mockSkillManager.activateSkill.mockResolvedValue({
        success: false,
        message: 'Skill not found'
      });

      const result = await strategy.activate('missing-skill');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('missing-skill');
    });

    it('should propagate activation errors', async () => {
      mockSkillManager.activateSkill.mockRejectedValue(new Error('Activation failed'));

      await expect(strategy.activate('error-skill')).rejects.toThrow('Activation failed');
    });
  });

  describe('deactivate', () => {
    it('should deactivate skill successfully', async () => {
      mockSkillManager.deactivateSkill.mockResolvedValue({
        success: true,
        message: '✅ Skill active-skill deactivated'
      });

      const result = await strategy.deactivate('active-skill');

      expect(result.content[0].text).toContain('active-skill');
      expect(result.content[0].text).toContain('deactivated');
    });

    it('should handle skill without deactivate method', async () => {
      mockSkillManager.deactivateSkill.mockResolvedValue({
        success: true,
        message: '✅ Skill simple-skill deactivated'
      });

      const result = await strategy.deactivate('simple-skill');

      expect(result.content[0].text).toContain('simple-skill');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when skill not found', async () => {
      mockSkillManager.deactivateSkill.mockResolvedValue({
        success: false,
        message: 'Skill not found'
      });

      await expect(strategy.deactivate('missing-skill'))
        .rejects.toThrow('Skill \'missing-skill\' not found');
    });

    it('should propagate deactivation errors', async () => {
      mockSkillManager.deactivateSkill.mockRejectedValue(new Error('Deactivation failed'));

      await expect(strategy.deactivate('error-skill')).rejects.toThrow('Deactivation failed');
    });
  });

  describe('getActiveElements', () => {
    it('should return empty message when no active skills', async () => {
      mockSkillManager.getActiveSkills.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active skills');
      expect(result.content[0].text).toContain('📋');
    });

    it('should list all active skills', async () => {
      const activeSkills = [
        {
          metadata: { name: 'skill-one' },
          getStatus: jest.fn().mockReturnValue('active')
        },
        {
          metadata: { name: 'skill-two' },
          getStatus: jest.fn().mockReturnValue('active')
        }
      ];

      mockSkillManager.getActiveSkills.mockResolvedValue(activeSkills);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('skill-one');
      expect(result.content[0].text).toContain('skill-two');
      expect(result.content[0].text).toContain('🛠️');
    });

    it('should handle empty skill list', async () => {
      mockSkillManager.getActiveSkills.mockResolvedValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('No active skills');
    });
  });

  describe('getElementDetails', () => {
    it('should return complete skill details', async () => {
      const mockSkill = {
        metadata: {
          name: 'detailed-skill',
          description: 'A detailed skill',
          complexity: 'intermediate',
          domains: ['web', 'api'],
          languages: ['javascript', 'typescript'],
          prerequisites: ['basic-skill'],
          parameters: [
            { name: 'endpoint', type: 'string', description: 'API endpoint' },
            { name: 'timeout', type: 'number', description: 'Request timeout' }
          ]
        },
        instructions: 'Detailed instructions here',
        getStatus: jest.fn()
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await strategy.getElementDetails('detailed-skill');

      expect(result.content[0].text).toContain('detailed-skill');
      expect(result.content[0].text).toContain('A detailed skill');
      expect(result.content[0].text).toContain('intermediate');
      expect(result.content[0].text).toContain('web, api');
      expect(result.content[0].text).toContain('javascript, typescript');
      expect(result.content[0].text).toContain('basic-skill');
      expect(result.content[0].text).toContain('endpoint');
      expect(result.content[0].text).toContain('timeout');
      expect(result.content[0].text).toContain('Detailed instructions');
    });

    it('should handle minimal skill metadata', async () => {
      const mockSkill = {
        metadata: {
          name: 'simple-skill',
          description: 'Simple'
        },
        instructions: 'Simple instructions',
        getStatus: jest.fn()
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await strategy.getElementDetails('simple-skill');

      expect(result.content[0].text).toContain('simple-skill');
      expect(result.content[0].text).toContain('beginner'); // default complexity
      expect(result.content[0].text).toContain('general'); // default domains
      expect(result.content[0].text).toContain('any'); // default languages
      expect(result.content[0].text).toContain('none'); // default prerequisites
    });

    it('should throw ElementNotFoundError when skill not found', async () => {
      mockSkillManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing'))
        .rejects.toThrow('Skill \'missing\' not found');
    });

    it('should handle skill without parameters', async () => {
      const mockSkill = {
        metadata: {
          name: 'no-params',
          description: 'No params'
        },
        instructions: 'Instructions',
        getStatus: jest.fn()
      };

      mockSkillManager.list.mockResolvedValue([mockSkill]);

      const result = await strategy.getElementDetails('no-params');

      expect(result.content[0].text).toContain('no-params');
      expect(result.content[0].text).not.toContain('Parameters:');
    });
  });
});
