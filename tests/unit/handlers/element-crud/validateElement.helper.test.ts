import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { validateElement } = await import('../../../../src/handlers/element-crud/validateElement.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

describe('validateElement helper', () => {
  let mockContext: ElementCrudContext;
  let mockValidator: { validateMetadata: jest.Mock };

  beforeEach(() => {
    mockValidator = {
      validateMetadata: jest.fn().mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        suggestions: []
      })
    };

    mockContext = {
      skillManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      templateManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      agentManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      memoryManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      ensembleManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      personaManager: {
        find: jest.fn().mockResolvedValue(null),
      },
      validationRegistry: {
        getValidator: jest.fn().mockReturnValue(mockValidator),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue('>> '),
    } as any;
  });

  describe('type validation', () => {
    it('should return error for invalid element type', async () => {
      const result = await validateElement(mockContext, {
        name: 'test',
        type: 'invalid-type',
      });

      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('invalid-type');
    });

    it('should accept valid element type: skills', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-skill' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.find).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });

    it('should accept valid element type: templates', async () => {
      mockContext.templateManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-template' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
      });

      expect(mockContext.templateManager.find).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });

    it('should accept valid element type: agents', async () => {
      mockContext.agentManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-agent' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
      });

      expect(mockContext.agentManager.find).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });

    it('should accept valid element type: memories', async () => {
      mockContext.memoryManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-memory' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
      });

      expect(mockContext.memoryManager.find).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });

    // FIX: Issue #281 - Persona now uses standard validation flow like other element types
    it('should validate persona using standard flow', async () => {
      mockContext.personaManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'Test Persona' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      const result = await validateElement(mockContext, {
        name: 'Test Persona',
        type: ElementType.PERSONA,
      });

      expect(mockContext.personaManager.find).toHaveBeenCalled();
      expect(result.content[0].text).toContain('🔍 Validation Report');
      expect(result.content[0].text).toContain('Test Persona');
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });
  });

  describe('element not found', () => {
    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when skill not found', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue(null);

      await expect(validateElement(mockContext, {
        name: 'missing-skill',
        type: ElementType.SKILL,
      })).rejects.toThrow('skill \'missing-skill\' not found');
    });

    // Issue #275: Now throws error instead of returning error content
    it('should throw ElementNotFoundError when template not found', async () => {
      mockContext.templateManager.find = jest.fn().mockResolvedValue(null);

      await expect(validateElement(mockContext, {
        name: 'missing-template',
        type: ElementType.TEMPLATE,
      })).rejects.toThrow('template \'missing-template\' not found');
    });
  });

  describe('validation reports - valid elements', () => {
    it('should generate valid report for element with no issues', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [],
          suggestions: [],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('🔍 Validation Report');
      expect(result.content[0].text).toContain('test-skill');
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });
  });

  describe('validation reports - invalid elements', () => {
    it('should show errors in validation report', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'bad-skill' },
        validate: jest.fn().mockReturnValue({
          valid: false,
          errors: [
            { field: 'metadata.name', message: 'Name is required', fix: 'Add a name field' },
            { field: 'metadata.description', message: 'Description too short' },
          ],
          warnings: [],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'bad-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('❌ Status: Invalid');
      expect(result.content[0].text).toContain('❌ Errors (2)');
      expect(result.content[0].text).toContain('metadata.name: Name is required');
      expect(result.content[0].text).toContain('💡 Fix: Add a name field');
      expect(result.content[0].text).toContain('metadata.description: Description too short');
    });

    it('should show warnings in validation report', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'warned-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [
            { field: 'metadata.keywords', message: 'No keywords provided', suggestion: 'Add relevant keywords' },
            { field: 'metadata.version', message: 'Version not specified' },
          ],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'warned-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('⚠️  Warnings (2)');
      expect(result.content[0].text).toContain('metadata.keywords: No keywords provided');
      expect(result.content[0].text).toContain('💡 Suggestion: Add relevant keywords');
      expect(result.content[0].text).toContain('metadata.version: Version not specified');
    });

    it('should show suggestions in validation report', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'improvable-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [],
          suggestions: [
            'Consider adding examples to documentation',
            'Add unit tests for better coverage',
          ],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'improvable-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('💡 Suggestions:');
      expect(result.content[0].text).toContain('Consider adding examples to documentation');
      expect(result.content[0].text).toContain('Add unit tests for better coverage');
    });

    it('should show combined errors, warnings, and suggestions', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'complex-skill' },
        validate: jest.fn().mockReturnValue({
          valid: false,
          errors: [
            { field: 'content', message: 'Content is empty', fix: 'Add implementation' },
          ],
          warnings: [
            { field: 'metadata.author', message: 'Author not specified' },
          ],
          suggestions: [
            'Add more documentation',
          ],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'complex-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).toContain('❌ Status: Invalid');
      expect(result.content[0].text).toContain('❌ Errors (1)');
      expect(result.content[0].text).toContain('⚠️  Warnings (1)');
      expect(result.content[0].text).toContain('💡 Suggestions:');
    });
  });

  describe('strict mode', () => {
    it('should show strict mode indicator when enabled', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        strict: true,
      });

      expect(result.content[0].text).toContain('📋 Strict Mode: Additional quality checks applied');
    });

    it('should not show strict mode indicator when disabled', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        strict: false,
      });

      expect(result.content[0].text).not.toContain('Strict Mode');
    });

    it('should default to non-strict mode', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test-skill' },
        validate: jest.fn().mockReturnValue({
          valid: true,
          errors: [],
          warnings: [],
        }),
      });

      const result = await validateElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
      });

      expect(result.content[0].text).not.toContain('Strict Mode');
    });
  });

  describe('element finding', () => {
    it('should find element by exact name match', async () => {
      const findCallback = jest.fn();
      mockContext.skillManager.find = jest.fn().mockImplementation((cb) => {
        findCallback.mockImplementation(cb);
        const element = { metadata: { name: 'exact-match' }, validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }) };
        return findCallback(element) ? element : null;
      });

      await validateElement(mockContext, {
        name: 'exact-match',
        type: ElementType.SKILL,
      });

      expect(mockContext.skillManager.find).toHaveBeenCalled();
    });
  });

  describe('initialization', () => {
    it('should call ensureInitialized', async () => {
      mockContext.skillManager.find = jest.fn().mockResolvedValue({
        metadata: { name: 'test' },
        validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
      });

      await validateElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
      });

      expect(mockContext.ensureInitialized).toHaveBeenCalled();
    });
  });
});
