import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PersonaActivationStrategy } from '../../../../src/handlers/strategies/PersonaActivationStrategy.js';
import type { PersonaManager } from '../../../../src/persona/PersonaManager.js';
import type { PersonaIndicatorService } from '../../../../src/services/PersonaIndicatorService.js';

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
        metadata: {
          name: 'test-persona',
          description: 'A test persona'
        },
        content: 'Persona instructions here',
        unique_id: 'test-persona-id'
      };

      mockPersonaManager.activatePersona.mockReturnValue({
        success: true,
        persona: mockPersona,
        message: 'Activated'
      });

      const result = await strategy.activate('test-persona');

      expect(result.content[0].text).toContain('>>'); // indicator
      expect(result.content[0].text).toContain('test-persona');
      expect(result.content[0].text).toContain('A test persona');
      expect(result.content[0].text).toContain('Persona instructions here');
      expect(mockPersonaManager.activatePersona).toHaveBeenCalledWith('test-persona');
    });

    it('should handle persona with empty content', async () => {
      const mockPersona = {
        metadata: {
          name: 'empty-persona',
          description: 'Empty'
        },
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
  });

  describe('deactivate', () => {
    const mockPersona = {
      metadata: { name: 'test-persona', description: 'Test' },
      content: 'Content',
      unique_id: 'test-id'
    };

    it('should deactivate persona successfully', async () => {
      mockPersonaManager.findPersona.mockReturnValue(mockPersona);
      mockPersonaManager.deactivatePersona.mockReturnValue({
        success: true,
        message: 'Persona deactivated'
      });

      const result = await strategy.deactivate('test-persona');

      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Persona deactivated');
      expect(mockPersonaManager.deactivatePersona).toHaveBeenCalled();
    });

    it('should return error when deactivation fails', async () => {
      mockPersonaManager.findPersona.mockReturnValue(mockPersona);
      mockPersonaManager.deactivatePersona.mockReturnValue({
        success: false,
        message: 'No persona is currently active'
      });

      const result = await strategy.deactivate('test-persona');

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

      const result = await strategy.deactivate('test-persona');

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

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

      mockPersonaManager.findPersona.mockReturnValue(mockPersona);

      const result = await strategy.getElementDetails('empty-content');

      expect(result.content[0].text).toContain('No instructions provided');
    });

    it('should throw ElementNotFoundError when persona not found', async () => {
      mockPersonaManager.findPersona.mockReturnValue(null);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing-persona'))
        .rejects.toThrow('Persona \'missing-persona\' not found');
    });
  });
});
