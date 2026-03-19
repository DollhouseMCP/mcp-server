import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TemplateActivationStrategy } from '../../../../src/handlers/strategies/TemplateActivationStrategy.js';
import type { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';

describe('TemplateActivationStrategy', () => {
  let strategy: TemplateActivationStrategy;
  let mockTemplateManager: jest.Mocked<TemplateManager>;

  beforeEach(() => {
    mockTemplateManager = {
      list: jest.fn(),
      get: jest.fn(),
    } as unknown as jest.Mocked<TemplateManager>;

    strategy = new TemplateActivationStrategy(mockTemplateManager);
  });

  describe('activate', () => {
    it('should activate template successfully and display variables', async () => {
      const mockTemplate = {
        metadata: {
          name: 'test-template',
          description: 'Test template',
          variables: [
            { name: 'var1', type: 'string', description: 'Variable 1' },
            { name: 'var2', type: 'number', description: 'Variable 2' }
          ]
        },
        content: 'Template content'
      };

      mockTemplateManager.list.mockResolvedValue([mockTemplate]);

      const result = await strategy.activate('test-template');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-template');
      expect(result.content[0].text).toContain('var1, var2');
      expect(result.content[0].text).toContain('render_template');
      expect(mockTemplateManager.list).toHaveBeenCalled();
    });

    it('should handle template with no variables', async () => {
      const mockTemplate = {
        metadata: {
          name: 'simple-template',
          description: 'Simple template',
          variables: []
        },
        content: 'Simple content'
      };

      mockTemplateManager.list.mockResolvedValue([mockTemplate]);

      const result = await strategy.activate('simple-template');

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('none');
    });

    it('should throw ElementNotFoundError when template not found', async () => {
      mockTemplateManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.activate('missing-template'))
        .rejects.toThrow('Template \'missing-template\' not found');
    });

    it('should handle template manager throwing error', async () => {
      mockTemplateManager.list.mockRejectedValue(new Error('Database error'));

      await expect(strategy.activate('test-template')).rejects.toThrow('Database error');
    });
  });

  describe('deactivate', () => {
    it('should return stateless message for templates', async () => {
      const result = await strategy.deactivate('any-template');

      expect(result.content[0].text).toContain('stateless');
      expect(result.content[0].text).toContain('nothing to deactivate');
      expect(result.content[0].text).toContain('📝');
    });

    it('should not call template manager on deactivate', async () => {
      await strategy.deactivate('any-template');

      expect(mockTemplateManager.list).not.toHaveBeenCalled();
    });
  });

  describe('getActiveElements', () => {
    it('should return stateless message', async () => {
      const result = await strategy.getActiveElements();

      expect(result.content[0].text).toContain('stateless');
      expect(result.content[0].text).toContain('activated on-demand');
      expect(result.content[0].text).toContain('📝');
    });

    it('should not call template manager', async () => {
      await strategy.getActiveElements();

      expect(mockTemplateManager.list).not.toHaveBeenCalled();
    });
  });

  describe('getElementDetails', () => {
    it('should return complete template details', async () => {
      const mockTemplate = {
        metadata: {
          name: 'detailed-template',
          description: 'A detailed template',
          output_format: 'markdown',
          variables: [
            { name: 'title', type: 'string', description: 'The title' },
            { name: 'count', type: 'number', description: 'Item count' }
          ]
        },
        content: 'Template content here\nWith multiple lines'
      };

      mockTemplateManager.list.mockResolvedValue([mockTemplate]);

      const result = await strategy.getElementDetails('detailed-template');

      expect(result.content[0].text).toContain('detailed-template');
      expect(result.content[0].text).toContain('A detailed template');
      expect(result.content[0].text).toContain('markdown');
      expect(result.content[0].text).toContain('title');
      expect(result.content[0].text).toContain('count');
      expect(result.content[0].text).toContain('Template content here');
    });

    it('should handle template without output format', async () => {
      const mockTemplate = {
        metadata: {
          name: 'simple-template',
          description: 'Simple',
          variables: []
        },
        content: 'Content'
      };

      mockTemplateManager.list.mockResolvedValue([mockTemplate]);

      const result = await strategy.getElementDetails('simple-template');

      expect(result.content[0].text).toContain('text'); // default output format
    });

    it('should throw ElementNotFoundError when template not found', async () => {
      mockTemplateManager.list.mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(strategy.getElementDetails('missing'))
        .rejects.toThrow('Template \'missing\' not found');
    });

    it('should handle template without variables section', async () => {
      const mockTemplate = {
        metadata: {
          name: 'no-vars',
          description: 'No vars'
        },
        content: 'Content'
      };

      mockTemplateManager.list.mockResolvedValue([mockTemplate]);

      const result = await strategy.getElementDetails('no-vars');

      expect(result.content[0].text).toContain('no-vars');
      expect(result.content[0].text).not.toContain('Variables:');
    });
  });
});
