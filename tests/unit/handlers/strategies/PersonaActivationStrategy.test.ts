import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PersonaActivationStrategy } from '../../../../src/handlers/strategies/PersonaActivationStrategy.js';
import type { PersonaManager } from '../../../../src/persona/PersonaManager.js';
import type { PersonaIndicatorService } from '../../../../src/services/PersonaIndicatorService.js';

const TEST_PERSONA_NAME = 'test-persona';

describe('PersonaActivationStrategy', () => {
  let strategy: PersonaActivationStrategy;
  let mockPersonaManager: jest.Mocked<PersonaManager>;
  let mockPersonaIndicatorService: jest.Mocked<PersonaIndicatorService>;

  beforeEach(() => {
    mockPersonaManager = {
      activatePersona: jest.fn(),
      deactivatePersona: jest.fn(),
      getActivePersona: jest.fn(),
      // Issue #281: Add getActivePersonas for multiple active personas support
      getActivePersonas: jest.fn().mockReturnValue([]),
      findPersona: jest.fn(),
      findPersonaAsync: jest.fn(),
    } as unknown as jest.Mocked<PersonaManager>;

    mockPersonaIndicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>'),
    } as unknown as jest.Mocked<PersonaIndicatorService>;

    strategy = new PersonaActivationStrategy(
      mockPersonaManager,
      mockPersonaIndicatorService
    );
  });

  describe('activate', () => {
    it('should activate persona successfully', async () => {
      const mockPersona = {
        filename: 'test-persona.md',
        metadata: {
          name: TEST_PERSONA_NAME,
          description: 'A test persona'
        },
        instructions: '',
        content: 'Persona instructions here',
        unique_id: 'test-persona-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'Activated'
      });

      const result = await strategy.activate(TEST_PERSONA_NAME);

      expect(result.content[0].text).toContain('>>'); // indicator
      expect(result.content[0].text).toContain(TEST_PERSONA_NAME);
      expect(result.content[0].text).toContain('A test persona');
      expect(result.content[0].text).toContain('Persona instructions here');
      expect(result.activationRecord).toEqual({
        name: TEST_PERSONA_NAME,
        filename: 'test-persona.md',
      });
      expect(mockPersonaManager.activatePersona).toHaveBeenCalledWith(TEST_PERSONA_NAME);
    });

    it('should handle persona with empty content', async () => {
      const mockPersona = {
        metadata: {
          name: 'empty-persona',
          description: 'Empty'
        },
        instructions: '',
        content: '',
        unique_id: 'empty-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'Activated'
      });

      const result = await strategy.activate('empty-persona');

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('No instructions provided');
    });

    it('should handle persona with whitespace-only content', async () => {
      const mockPersona = {
        metadata: {
          name: 'whitespace-persona',
          description: 'Whitespace'
        },
        instructions: '',
        content: '   \n\n  ',
        unique_id: 'whitespace-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'Activated'
      });

      const result = await strategy.activate('whitespace-persona');

      expect(result.content[0].text).toContain('No instructions provided');
    });

    it('should return error when activation fails', async () => {
      mockPersonaManager.activatePersona.mockReturnValue({
        success: false,
        persona: null,
        message: 'Persona not found'
      });

      const result = await strategy.activate('missing-persona');

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Persona not found');
    });

    it('should return error when persona is null', async () => {
      mockPersonaManager.activatePersona.mockReturnValue({
        success: false,
        persona: null,
        message: 'Invalid persona'
      });

      const result = await strategy.activate('invalid-persona');

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid persona');
    });

    it('should use indicator service for prefix', async () => {
      mockPersonaIndicatorService.getPersonaIndicator.mockReturnValue('🎭>>');

      const mockPersona = {
        metadata: { name: 'test', description: 'Test' },
        instructions: '',
        content: 'Content',
        unique_id: 'test-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'OK'
      });

      const result = await strategy.activate('test');

      expect(result.content[0].text).toContain('🎭>>');
      expect(mockPersonaIndicatorService.getPersonaIndicator).toHaveBeenCalled();
    });

    it('uses behavioral instructions and keeps reference content separate', async () => {
      const mockPersona = {
        filename: 'dual-field.md',
        metadata: { name: 'dual-field', description: 'Dual field persona' },
        instructions: 'Follow these instructions',
        content: 'Use this reference material',
        unique_id: 'dual-field-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'Activated'
      });

      const result = await strategy.activate('dual-field');

      expect(result.content[0].text).toContain('**Instructions:**\nFollow these instructions');
      expect(result.content[0].text).toContain('**Reference:**\nUse this reference material');
    });
  });

  describe('deactivate', () => {
    const mockPersona = {
      filename: 'test-persona.md',
      metadata: { name: TEST_PERSONA_NAME, description: 'Test' },
      content: 'Content',
      unique_id: 'test-id'
    };

    it('should deactivate persona successfully', async () => {
      mockPersonaManager.findPersona.mockReturnValue(mockPersona);
      mockPersonaManager.deactivatePersona.mockReturnValue({
        success: true,
        message: 'Persona deactivated'
      });

      const result = await strategy.deactivate(TEST_PERSONA_NAME);

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Persona deactivated');
      expect(result.activationRecord).toEqual({
        name: TEST_PERSONA_NAME,
        filename: 'test-persona.md',
      });
      expect(mockPersonaManager.deactivatePersona).toHaveBeenCalled();
    });

    it('should return error when deactivation fails', async () => {
      mockPersonaManager.findPersona.mockReturnValue(mockPersona);
      mockPersonaManager.deactivatePersona.mockReturnValue({
        success: false,
        message: 'No persona is currently active'
      });

      const result = await strategy.deactivate(TEST_PERSONA_NAME);

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('No persona is currently active');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when persona not found', async () => {
      mockPersonaManager.findPersona.mockReturnValue(null);

      await expect(strategy.deactivate('missing-persona'))
        .rejects.toThrow('Persona \'missing-persona\' not found');
    });

    it('should use indicator service for prefix', async () => {
      mockPersonaIndicatorService.getPersonaIndicator.mockReturnValue('🎭>>');
      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

      mockPersonaManager.deactivatePersona.mockReturnValue({
        success: true,
        message: 'Deactivated'
      });

      const result = await strategy.deactivate(TEST_PERSONA_NAME);

      expect(result.content[0].text).toContain('🎭>>');
      expect(mockPersonaIndicatorService.getPersonaIndicator).toHaveBeenCalled();
    });
  });

  describe('getActiveElements', () => {
    it('should return message when no persona is active', async () => {
      // Issue #281: Use getActivePersonas which returns array
      mockPersonaManager.getActivePersonas.mockReturnValue([]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('No personas are currently active');
    });

    it('should return active persona details', async () => {
      const mockPersona = {
        metadata: {
          name: 'active-persona',
          description: 'The active one',
          category: 'creative',
          author: 'John Doe'
        },
        unique_id: 'active-persona-123',
        content: 'Instructions'
      };

      // Issue #281: Use getActivePersonas which returns array
      mockPersonaManager.getActivePersonas.mockReturnValue([mockPersona]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('active-persona');
      expect(result.content[0].text).toContain('active-persona-123');
      expect(result.content[0].text).toContain('The active one');
      expect(result.content[0].text).toContain('creative');
      expect(result.content[0].text).toContain('John Doe');
    });

    it('should handle persona without category', async () => {
      const mockPersona = {
        metadata: {
          name: 'no-category',
          description: 'No category'
        },
        unique_id: 'no-cat-id',
        content: 'Content'
      };

      // Issue #281: Use getActivePersonas which returns array
      mockPersonaManager.getActivePersonas.mockReturnValue([mockPersona]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('general'); // default category
    });

    it('should handle persona without author', async () => {
      const mockPersona = {
        metadata: {
          name: 'no-author',
          description: 'No author'
        },
        unique_id: 'no-author-id',
        content: 'Content'
      };

      // Issue #281: Use getActivePersonas which returns array
      mockPersonaManager.getActivePersonas.mockReturnValue([mockPersona]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('Unknown'); // default author
    });

    it('summarizes typed Gatekeeper external restrictions', async () => {
      const restrictedPersona = {
        metadata: {
          name: 'restricted-persona',
          description: 'Restricted',
          gatekeeper: {
            externalRestrictions: {
              description: 'Read-only shell access'
            }
          }
        },
        unique_id: 'restricted-id',
        instructions: 'Stay safe',
        content: ''
      };

      mockPersonaManager.getActivePersonas.mockReturnValue([restrictedPersona]);

      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('**Loaded CLI Restrictions:**');
      expect(result.content[0].text).toContain('**restricted-persona**: Read-only shell access');
    });
  });

  describe('getElementDetails', () => {
    it('should return complete persona details', async () => {
      const mockPersona = {
        metadata: {
          name: 'detailed-persona',
          description: 'A detailed persona',
          version: '2.0',
          author: 'Jane Smith',
          triggers: ['create', 'write', 'compose']
        },
        content: 'Detailed instructions\nWith multiple lines',
        filename: 'detailed-persona.md',
        unique_id: 'detailed-123'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('detailed-persona');

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('detailed-persona');
      expect(result.content[0].text).toContain('A detailed persona');
      expect(result.content[0].text).toContain('detailed-persona.md');
      expect(result.content[0].text).toContain('2.0');
      expect(result.content[0].text).toContain('Jane Smith');
      expect(result.content[0].text).toContain('create, write, compose');
      expect(result.content[0].text).toContain('Detailed instructions');
    });

    it('should handle persona without version', async () => {
      const mockPersona = {
        metadata: {
          name: 'no-version',
          description: 'No version'
        },
        content: 'Content',
        filename: 'no-version.md',
        unique_id: 'no-ver-id'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('no-version');

      expect(result.content[0].text).toContain('1.0'); // default version
    });

    it('should handle persona without author', async () => {
      const mockPersona = {
        metadata: {
          name: 'no-author',
          description: 'No author'
        },
        content: 'Content',
        filename: 'no-author.md',
        unique_id: 'no-auth-id'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('no-author');

      expect(result.content[0].text).toContain('Unknown'); // default author
    });

    it('should handle persona without triggers', async () => {
      const mockPersona = {
        metadata: {
          name: 'no-triggers',
          description: 'No triggers',
          triggers: []
        },
        content: 'Content',
        filename: 'no-triggers.md',
        unique_id: 'no-trig-id'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('no-triggers');

      expect(result.content[0].text).toContain('None'); // when empty array
    });

    it('should handle persona with null triggers', async () => {
      const mockPersona = {
        metadata: {
          name: 'null-triggers',
          description: 'Null triggers'
        },
        content: 'Content',
        filename: 'null-triggers.md',
        unique_id: 'null-trig-id'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('null-triggers');

      expect(result.content[0].text).toContain('None'); // when undefined
    });

    it('should handle persona with empty content', async () => {
      const mockPersona = {
        metadata: {
          name: 'empty-content',
          description: 'Empty'
        },
        content: '',
        filename: 'empty.md',
        unique_id: 'empty-id'
      };

      mockPersonaManager.findPersonaAsync.mockResolvedValue(mockPersona);

      const result = await strategy.getElementDetails('empty-content');

      expect(result.content[0].text).toContain('No instructions provided');
    });

    it('should throw ElementNotFoundError when persona not found', async () => {
      mockPersonaManager.findPersonaAsync.mockResolvedValue();

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing-persona'))
        .rejects.toThrow('Persona \'missing-persona\' not found');
    });

    it('uses the storage-backed lookup when the persona is not cached', async () => {
      const recoveredPersona = {
        metadata: {
          name: 'recovered-persona',
          description: 'Recovered after cache invalidation',
        },
        content: 'Recovered instructions',
        filename: 'recovered-persona.md',
        unique_id: 'recovered-id',
      };
      mockPersonaManager.findPersonaAsync.mockResolvedValue(recoveredPersona);

      const result = await strategy.getElementDetails('recovered-persona');

      expect(mockPersonaManager.findPersonaAsync).toHaveBeenCalledWith('recovered-persona');
      expect(result.content[0].text).toContain('Recovered after cache invalidation');
    });
  });
});
