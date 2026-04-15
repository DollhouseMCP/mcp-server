import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { editElement } = await import('../../../../src/handlers/element-crud/editElement.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
const { ElementNotFoundError } = await import('../../../../src/utils/ErrorHandler.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

describe('editElement helper', () => {
  let mockContext: ElementCrudContext;

  const createMockElement = (name: string, metadata: Record<string, any> = {}) => ({
    metadata: { name, version: '1.0.0', ...metadata },
    version: '1.0.0',
    validate: () => ({ valid: true }),
  });

  beforeEach(() => {
    mockContext = {
      skillManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      templateManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      agentManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      memoryManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      },
      ensembleManager: {
        list: jest.fn().mockResolvedValue([]),
        save: jest.fn().mockResolvedValue(undefined),
      },
      personaManager: {
        find: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
        editPersona: jest.fn().mockResolvedValue({
          success: true,
          message: 'Persona updated',
          newName: 'Persona Name',
          version: '1.1',
          isDefault: false,
        }),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue('>> '),
    } as any;
  });

  describe('input validation', () => {
    it('should return error for invalid element type', async () => {
      const result = await editElement(mockContext, {
        name: 'test',
        type: 'invalid-type',
        input: { description: 'test' },
      });

      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('invalid-type');
    });

    it('should return error when input is missing', async () => {
      const result = await editElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        input: null as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Missing or invalid input');
    });

    it('should return error when input is undefined', async () => {
      const result = await editElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        input: undefined as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Missing or invalid input');
    });

    it('should return error when input is not an object (string)', async () => {
      const result = await editElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        input: 'not an object' as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Missing or invalid input');
    });

    it('should return error when input is not an object (number)', async () => {
      const result = await editElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        input: 123 as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Missing or invalid input');
    });

    // Issue #334: Old parameter format without input wrapper should be rejected
    it('should require input wrapper - passing description directly should fail', async () => {
      // This simulates the old format where fields were passed directly
      // instead of wrapped in an input object
      const result = await editElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        // Missing input wrapper - description passed at wrong level
        input: undefined as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Missing or invalid input');
      expect(result.content[0].text).toContain('nested object');
    });

    it('should accept valid element type: skills', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated' },
      });

      expect(mockContext.skillManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: templates', async () => {
      const element = createMockElement('test-template');
      mockContext.templateManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
        input: { description: 'Updated' },
      });

      expect(mockContext.templateManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: agents', async () => {
      const element = createMockElement('test-agent');
      mockContext.agentManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { description: 'Updated' },
      });

      expect(mockContext.agentManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: memories', async () => {
      const element = createMockElement('test-memory');
      mockContext.memoryManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
        input: { description: 'Updated' },
      });

      expect(mockContext.memoryManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    // Issue #1591: Memory content is append-only
    it('should reject attempts to edit memory content field', async () => {
      const element = createMockElement('test-memory');
      mockContext.memoryManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
        input: { content: 'Attempting to modify content directly' },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Memory content cannot be modified');
      expect(result.content[0].text).toContain('append-only');
      expect(result.content[0].text).toContain('addEntry');
      // Should NOT have called save since validation failed early
      expect(mockContext.memoryManager.save).not.toHaveBeenCalled();
    });
  });

  describe('element not found', () => {
    it('should throw ElementNotFoundError when skill not found', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue(null);

      await expect(
        editElement(mockContext, {
          name: 'missing-skill',
          type: ElementType.SKILL,
          input: { description: 'test' },
        })
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('should throw ElementNotFoundError when template not found', async () => {
      mockContext.templateManager.find = jest.fn().mockResolvedValue(null);

      await expect(
        editElement(mockContext, {
          name: 'missing-template',
          type: ElementType.TEMPLATE,
          input: { description: 'test' },
        })
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('should throw ElementNotFoundError when agent not found', async () => {
      mockContext.agentManager.find = jest.fn().mockResolvedValue(null);

      await expect(
        editElement(mockContext, {
          name: 'missing-agent',
          type: ElementType.AGENT,
          input: { description: 'test' },
        })
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('should throw ElementNotFoundError when memory not found', async () => {
      mockContext.memoryManager.find = jest.fn().mockResolvedValue(null);

      await expect(
        editElement(mockContext, {
          name: 'missing-memory',
          type: ElementType.MEMORY,
          input: { description: 'test' },
        })
      ).rejects.toThrow(ElementNotFoundError);
    });
  });

  describe('deep merge behavior', () => {
    it('should deep merge nested metadata', async () => {
      const element = createMockElement('test-skill', {
        settings: { theme: 'light', verbose: false }
      });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          metadata: {
            settings: { theme: 'dark' }  // Only update theme, keep verbose
          }
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.settings.theme).toBe('dark');
      expect(saved.metadata.settings.verbose).toBe(false);  // Preserved
    });

    it('should allow direct editing of ensemble.elements field (Issue #14)', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'test-ensemble',
          version: '1.0.0',
          elements: []
        },
        version: '1.0.0',
        validate: () => ({ valid: true }),
      };
      mockContext.ensembleManager.list = jest.fn().mockResolvedValue([mockEnsemble]);
      mockContext.ensembleManager.save = jest.fn().mockResolvedValue(mockEnsemble);

      const result = await editElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [{ name: 'new-element', type: 'skill', role: 'primary', priority: 80, activation: 'always' }]
        },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Updated');
      expect(mockContext.ensembleManager.save).toHaveBeenCalled();
    });

    it('should replace arrays entirely (not merge element-by-element)', async () => {
      const element = createMockElement('test-skill', {
        tags: ['old1', 'old2']
      });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          tags: ['new1', 'new2', 'new3']
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.tags).toEqual(['new1', 'new2', 'new3']);
    });

    it('should update multiple fields in one call', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          description: 'New description',
          author: 'New Author',
          tags: ['tag1', 'tag2']
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.description).toBe('New description');
      expect(saved.metadata.author).toBe('New Author');
      expect(saved.metadata.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('persona editing', () => {
    it('should edit persona through standard BaseElementManager pattern', async () => {
      const mockPersona = {
        metadata: { name: 'Test Persona', version: '1.0.0' },
        content: 'Original content',
        filename: 'test-persona.md'
      };

      (mockContext.personaManager.find as jest.Mock).mockResolvedValueOnce(mockPersona);
      (mockContext.personaManager.save as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await editElement(mockContext, {
        name: 'Test Persona',
        type: ElementType.PERSONA,
        input: { description: 'Updated description' },
      });

      expect(mockContext.personaManager.find).toHaveBeenCalled();
      expect(mockContext.personaManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Test Persona');
    });
  });

  describe('post-edit metadata normalization (#911)', () => {
    it('should default description to empty string when null after edit', async () => {
      const element = createMockElement('test-skill', { description: null });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { author: 'new-author' },
      });

      expect(element.metadata.description).toBe('');
    });

    it('should default tags to empty array when undefined after edit', async () => {
      const element = createMockElement('test-skill', { tags: undefined });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { author: 'new-author' },
      });

      expect(element.metadata.tags).toEqual([]);
    });

    it('should update modified timestamp on edit', async () => {
      const element = createMockElement('test-skill', { modified: '2020-01-01T00:00:00.000Z' });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { author: 'new-author' },
      });

      expect(element.metadata.modified).not.toBe('2020-01-01T00:00:00.000Z');
      expect(element.metadata.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should preserve existing description and tags when present', async () => {
      const element = createMockElement('test-skill', {
        description: 'Existing description',
        tags: ['tag1', 'tag2'],
      });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { author: 'new-author' },
      });

      expect(element.metadata.description).toBe('Existing description');
      expect(element.metadata.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('version handling', () => {
    it('should auto-increment version when editing metadata without explicit version', async () => {
      const element = createMockElement('test-skill', { version: '1.0.0' });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated description' },
      });

      expect(result.content[0].text).toContain('✅');
      expect(mockContext.skillManager.save).toHaveBeenCalled();
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.version).toBe('1.0.1');
      expect(saved.metadata.version).toBe('1.0.1');
    });

    it('should accept explicit version updates without auto-incrementing', async () => {
      const element = createMockElement('test-skill', { version: '1.0.0' });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { version: '2.0.0' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.version).toBe('2.0.0');
      expect(saved.metadata.version).toBe('2.0.0');
    });

    it('should reject invalid version format', async () => {
      const element = createMockElement('test-skill', { version: '1.0.0' });
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { version: 'not-a-version' },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid version format');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should handle pre-release version auto-increment', async () => {
      const element = createMockElement('test-skill');
      element.version = '1.0.0-beta.1';
      element.metadata.version = '1.0.0-beta.1';
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.version).toBe('1.0.0-beta.2');
    });
  });

  describe('value type handling', () => {
    it('should handle string values', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'string value' },
      });

      expect(result.content[0].text).toContain('✅');
    });

    it('should handle number values', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { metadata: { priority: 42 } },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.priority).toBe(42);
    });

    it('should handle boolean values', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { metadata: { enabled: true } },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.enabled).toBe(true);
    });

    it('should handle array values', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { tags: ['tag1', 'tag2'] },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.tags).toEqual(['tag1', 'tag2']);
    });

    it('should handle object values', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { metadata: { config: { setting1: 'value1', setting2: 'value2' } } },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.config).toEqual({ setting1: 'value1', setting2: 'value2' });
    });
  });

  describe('error handling', () => {
    it('should handle manager.find errors gracefully', async () => {
      mockContext.skillManager.find = jest.fn().mockImplementation(async () => {
        throw new Error('Find failed');
      });

      await expect(editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'test' },
      })).rejects.toThrow('Find failed');
    });

    it('should handle manager.save errors gracefully', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);
      mockContext.skillManager.save = jest.fn().mockImplementation(async () => {
        throw new Error('Save failed');
      });

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'test' },
      });

      expect(result.content[0].text).toContain('❌ Failed to save element');
      expect(result.content[0].text).toContain('Save failed');
    });
  });

  describe('successful edits', () => {
    it('should edit skill successfully', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated description' },
      });

      expect(mockContext.skillManager.find).toHaveBeenCalled();
      expect(mockContext.skillManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-skill');
    });

    it('should edit template successfully', async () => {
      const element = createMockElement('test-template');
      mockContext.templateManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
        input: { description: 'Updated' },
      });

      expect(mockContext.templateManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should edit agent successfully', async () => {
      const element = createMockElement('test-agent');
      mockContext.agentManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { description: 'Updated' },
      });

      expect(mockContext.agentManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should edit memory successfully', async () => {
      const element = createMockElement('test-memory');
      mockContext.memoryManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
        input: { description: 'Updated' },
      });

      expect(mockContext.memoryManager.save).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('filename generation', () => {
    it('should generate .md extension for skills', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated' },
      });

      expect(mockContext.skillManager.save).toHaveBeenCalledWith(
        expect.anything(),
        'test-skill.md'
      );
    });

    it('should generate .yaml extension for memories', async () => {
      const element = createMockElement('test-memory');
      mockContext.memoryManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
        input: { description: 'Updated' },
      });

      expect(mockContext.memoryManager.save).toHaveBeenCalledWith(
        expect.anything(),
        'test-memory.yaml'
      );
    });

    it('should sanitize filenames with special characters', async () => {
      const element = createMockElement('Test Skill With Spaces!');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      await editElement(mockContext, {
        name: 'Test Skill With Spaces!',
        type: ElementType.SKILL,
        input: { description: 'Updated' },
      });

      expect(mockContext.skillManager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^[a-z0-9-]+\.md$/)
      );
    });
  });

  // Issue #585: Agent content editing / Issue #602 resolved: dual-field (instructions + content)
  describe('agent content editing', () => {
    const createMockAgent = (name: string, instructions?: string) => ({
      metadata: { name, version: '1.0.0' },
      version: '1.0.0',
      instructions: instructions || '',
      content: '',
      extensions: { instructions: instructions || '' },
      validate: () => ({ valid: true }),
    });

    it('should update agent reference material via content field', async () => {
      const agent = createMockAgent('test-agent', 'old instructions');
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { content: 'new reference material' },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('Unknown property');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.content).toBe('new reference material');
      // extensions.instructions should remain unchanged (content doesn't affect it)
      expect(saved.extensions.instructions).toBe('old instructions');
    });

    // Issue #602 resolved: 'instructions' is a first-class field for behavioral directives
    it('should accept instructions field in edit input and update extensions', async () => {
      const agent = createMockAgent('test-agent', 'old instructions');
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { instructions: 'updated behavioral protocol' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.instructions).toBe('updated behavioral protocol');
      expect(saved.extensions.instructions).toBe('updated behavioral protocol');
    });

    it('should accept instructions field combined with other fields', async () => {
      const agent = createMockAgent('test-agent', 'old instructions');
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: {
          description: 'Updated description',
          instructions: 'updated instructions',
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.instructions).toBe('updated instructions');
      expect(saved.extensions.instructions).toBe('updated instructions');
    });

    it('should initialize extensions object if not present', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: '',
        content: '',
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { instructions: 'new instructions' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.instructions).toBe('new instructions');
      expect(saved.extensions.instructions).toBe('new instructions');
    });

    it('should not affect non-agent content fields (skills still work)', async () => {
      const skill = {
        metadata: { name: 'test-skill', version: '1.0.0' },
        version: '1.0.0',
        content: 'old content',
        validate: () => ({ valid: true }),
      };
      mockContext.skillManager.find = jest.fn().mockResolvedValue(skill);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated' },
      });

      expect(result.content[0].text).toContain('✅');
      // Skill content should not be affected by agent-specific handling
    });
  });

  // Issue #565: Type-specific metadata field routing
  describe('type-specific metadata routing', () => {
    it('should route agent goal field to metadata (not silently dropped)', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: '',
        content: '',
        extensions: { instructions: '' },
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { goal: { template: 'Complete: {task}', parameters: [{ name: 'task', type: 'string', required: true }] } },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('Unrecognized Field');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.goal).toEqual({ template: 'Complete: {task}', parameters: [{ name: 'task', type: 'string', required: true }] });
    });

    it('should route agent activates field to metadata (Issue #724: object, not array)', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: '',
        content: '',
        extensions: { instructions: '' },
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const activatesObj = { skills: ['skill-a', 'skill-b'], personas: ['dev'] };
      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { activates: activatesObj },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.activates).toEqual(activatesObj);
    });

    it('should route agent autonomy and resilience to metadata', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: '',
        content: '',
        extensions: { instructions: '' },
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: {
          autonomy: { maxTurns: 10 },
          resilience: { retryPolicy: 'exponential' },
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.autonomy).toEqual({ maxTurns: 10 });
      expect(saved.metadata.resilience).toEqual({ retryPolicy: 'exponential' });
    });

    it('should route skill domains field to metadata', async () => {
      const skill = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(skill);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { domains: ['coding', 'review'] },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('Unrecognized Field');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.domains).toEqual(['coding', 'review']);
    });

    it('should route skill category field to metadata', async () => {
      const skill = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(skill);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { category: 'development' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.category).toBe('development');
    });

    it('should route template variables field to metadata', async () => {
      const template = createMockElement('test-template');
      mockContext.templateManager.find = jest.fn().mockResolvedValue(template);

      const result = await editElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
        input: { variables: ['title', 'body'] },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.templateManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata.variables).toEqual(['title', 'body']);
    });

    it('should produce warning for truly unknown fields', async () => {
      const skill = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(skill);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { nonexistent_field_xyz: 'some value' },
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Unrecognized Field');
      expect(result.content[0].text).toContain('nonexistent_field_xyz');
      expect(result.content[0].text).toContain('may not persist');
    });

    it('should still use special route for instructions (no regression)', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: 'old',
        content: '',
        extensions: { instructions: 'old' },
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { instructions: 'new behavioral directives' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.agentManager.save as jest.Mock).mock.calls[0][0];
      // instructions should be set directly on element, not routed to metadata
      expect(saved.instructions).toBe('new behavioral directives');
      expect(saved.extensions.instructions).toBe('new behavioral directives');
    });

    it('should still use special route for content (no regression)', async () => {
      const skill = {
        metadata: { name: 'test-skill', version: '1.0.0' },
        version: '1.0.0',
        content: 'old content',
        validate: () => ({ valid: true }),
      };
      mockContext.skillManager.find = jest.fn().mockResolvedValue(skill);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { content: 'new reference material' },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      expect(saved.content).toBe('new reference material');
    });
  });

  // Issue #662: Field type validation
  describe('field type validation', () => {
    it('should reject dict where array is expected (tags)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { tags: { key: 'value' } },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Field type validation failed');
      expect(result.content[0].text).toContain("'tags'");
      expect(result.content[0].text).toContain('array');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject string where array is expected (triggers)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { triggers: 'not-an-array' },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'triggers'");
      expect(result.content[0].text).toContain('array');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject array where object is expected (gatekeeper)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { gatekeeper: ['not', 'an', 'object'] },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'gatekeeper'");
      expect(result.content[0].text).toContain('object');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject top-level externalRestrictions during edit', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          externalRestrictions: {
            description: 'misnested',
            denyPatterns: ['Bash:rm *'],
          },
        } as any,
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Gatekeeper policy validation failed');
      expect(result.content[0].text).toContain('externalRestrictions must be nested');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject metadata gatekeeper without externalRestrictions description during edit', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                denyPatterns: ['Bash:rm *'],
              },
            },
          },
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('externalRestrictions.description is required');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject number where string is expected (description)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { description: 42 },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'description'");
      expect(result.content[0].text).toContain('string');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should reject string where number is expected (priority)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { priority: 'high' },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'priority'");
      expect(result.content[0].text).toContain('number');
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should report multiple type errors in a single response', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          tags: 'not-array',
          description: 123,
          gatekeeper: ['not-object'],
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'tags'");
      expect(result.content[0].text).toContain("'description'");
      expect(result.content[0].text).toContain("'gatekeeper'");
      expect(mockContext.skillManager.save).not.toHaveBeenCalled();
    });

    it('should skip element-type-scoped rules for non-matching types', async () => {
      // goal is agent-only; should not reject for skills
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { goal: 'some string value' },
      });

      // Should NOT fail field type validation (goal rule only applies to agents)
      expect(result.content[0].text).toContain('✅');
    });

    it('should enforce element-type-scoped rules for matching types', async () => {
      const agent = {
        metadata: { name: 'test-agent', version: '1.0.0' },
        version: '1.0.0',
        instructions: '',
        content: '',
        extensions: { instructions: '' },
        validate: () => ({ valid: true }),
      };
      mockContext.agentManager.find = jest.fn().mockResolvedValue(agent);

      const result = await editElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        input: { goal: 'not-an-object' },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain("'goal'");
      expect(result.content[0].text).toContain('object');
      expect(mockContext.agentManager.save).not.toHaveBeenCalled();
    });

    it('should allow null/undefined values (skip validation)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { tags: null, description: 'Valid string' },
      });

      // null is skipped; description is valid — should succeed
      expect(result.content[0].text).toContain('✅');
    });

    it('should allow unknown fields to pass type validation (caught later)', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { custom_field: { nested: true } },
      });

      // Unknown fields skip type validation — caught by unknown property detection
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Unrecognized Field');
    });

    it('should accept version as both string and number', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      // version accepts string or number per the rule
      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: { version: '2.0.0' },
      });
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('read-only fields', () => {
    it('should skip read-only fields like id', async () => {
      const element = createMockElement('test-skill');
      mockContext.skillManager.find = jest.fn().mockResolvedValue(element);

      const result = await editElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        input: {
          id: 'new-id',  // This should be skipped
          description: 'Updated'
        },
      });

      expect(result.content[0].text).toContain('✅');
      const saved = (mockContext.skillManager.save as jest.Mock).mock.calls[0][0];
      // id should not be changed
      expect(saved.metadata.id).not.toBe('new-id');
    });
  });
});
