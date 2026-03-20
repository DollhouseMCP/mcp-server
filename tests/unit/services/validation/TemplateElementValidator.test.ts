/**
 * TemplateElementValidator Tests
 *
 * Comprehensive test suite covering template-specific validation:
 * - Output format validation (text, markdown, json, yaml, html, xml)
 * - Variable placeholder validation ({{variable}} syntax)
 * - Template syntax validation (balanced braces)
 * - Variables object validation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TemplateElementValidator } from '../../../../src/services/validation/TemplateElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('TemplateElementValidator', () => {
  let validator: TemplateElementValidator;
  let mockValidationService: jest.Mocked<ValidationService>;
  let mockTriggerService: jest.Mocked<TriggerValidationService>;
  let mockMetadataService: jest.Mocked<MetadataService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockValidationService = {
      validateAndSanitizeInput: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedValue: 'sanitized',
        errors: undefined,
        warnings: []
      }),
      validateContent: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedContent: 'content',
        detectedPatterns: []
      }),
      validateCategory: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedValue: 'creative',
        errors: undefined
      })
    } as unknown as jest.Mocked<ValidationService>;

    mockTriggerService = {
      validateTriggers: jest.fn().mockReturnValue({
        validTriggers: ['render'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new TemplateElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with TEMPLATE element type', () => {
      expect(validator.elementType).toBe(ElementType.TEMPLATE);
    });
  });

  describe('validateCreate', () => {
    describe('Output Format Validation', () => {
      const validFormats = ['text', 'markdown', 'json', 'yaml', 'html', 'xml'];

      validFormats.forEach(format => {
        it(`should accept valid output format "${format}"`, async () => {
          const data = {
            name: 'Test Template',
            description: 'A test template',
            content: 'Template content {{var}}',
            output_format: format
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
          expect(result.errors).toHaveLength(0);
        });
      });

      it('should accept uppercase format (normalized to lowercase)', async () => {
        mockValidationService.validateAndSanitizeInput.mockReturnValue({
          isValid: true,
          sanitizedValue: 'markdown',
          errors: undefined,
          warnings: []
        });

        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content here',
          output_format: 'MARKDOWN'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should warn about unknown output format', async () => {
        mockValidationService.validateAndSanitizeInput
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'name', warnings: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'desc', warnings: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'csv', warnings: [] });

        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content here',
          output_format: 'csv'
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('Unknown output format'))).toBe(true);
        expect(result.warnings.some(w => w.includes('Valid formats'))).toBe(true);
      });

      it('should reject non-string output format', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content here',
          output_format: 123
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Output format must be a string'))).toBe(true);
      });

      it('should suggest adding output format when not present', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content here'
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('output_format'))).toBe(true);
      });
    });

    describe('Template Syntax Validation', () => {
      it('should accept valid template with placeholders', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Hello {{name}}, your order {{orderId}} is ready.'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept template without placeholders', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Static content without any variables'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject unbalanced braces (more opening)', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Hello {{name}} {{ more {{nested}}'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('unbalanced'))).toBe(true);
      });

      it('should reject unbalanced braces (more closing)', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Hello {{name}} }} extra closing'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('unbalanced'))).toBe(true);
      });

      it('should warn about many unique variables (> 10)', async () => {
        const vars = Array.from({ length: 15 }, (_, i) => `{{var${i}}}`).join(' ');
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: `Template with ${vars}`
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('15 unique variables'))).toBe(true);
      });
    });

    describe('Variables Object Validation', () => {
      it('should accept valid variables object', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Hello {{name}}',
          variables: {
            name: 'default name',
            count: 0,
            enabled: true
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject primitive variables', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: 'not-an-object'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('not a primitive'))).toBe(true);
      });

      it('should accept valid array-format variable declarations', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Hello {{title}}',
          variables: [
            { name: 'title', type: 'string', required: true, description: 'Page title' },
            { name: 'author', type: 'string', required: false }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject array declarations missing name field', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: [{ type: 'string' }]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('"name" string field'))).toBe(true);
      });

      it('should reject array declarations missing type field', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: [{ name: 'title' }]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('"type" string field'))).toBe(true);
      });

      it('should reject array with non-object entries', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: ['a', 'b']
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an object with at least { name, type }'))).toBe(true);
      });

      it('should reject array declarations with invalid variable names', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: [{ name: '123bad', type: 'string' }]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("Invalid variable name '123bad'"))).toBe(true);
      });

      it('should warn about empty variables object', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: {}
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
      });

      it('should warn about too many variables (> 20)', async () => {
        const variables: Record<string, string> = {};
        for (let i = 0; i < 25; i++) {
          variables[`var${i}`] = 'value';
        }

        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('25 variables') && w.includes('reducing'))).toBe(true);
      });

      it('should reject invalid variable names', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: {
            '123invalid': 'value'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("Invalid variable name '123invalid'"))).toBe(true);
      });

      it('should accept valid variable names with underscores', async () => {
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content that is long enough for validation to pass',
          variables: {
            _privateVar: 'value',
            user_name: 'value',
            camelCase123: 'value'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should warn about very long variable names', async () => {
        const longName = 'a'.repeat(60);
        const data = {
          name: 'Test Template',
          description: 'A test template',
          content: 'Content',
          variables: {
            [longName]: 'value'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('very long'))).toBe(true);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle nested template braces', async () => {
      const data = {
        name: 'Test Template',
        description: 'A test template',
        content: '{{#if condition}}{{value}}{{/if}}'
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should handle template with JSON-like content', async () => {
      const data = {
        name: 'JSON Template',
        description: 'A JSON template',
        content: '{"name": "{{name}}", "count": {{count}}}',
        output_format: 'json'
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should pass undefined variables through', async () => {
      const data = {
        name: 'Test Template',
        description: 'A test template',
        content: 'Content that is long enough for validation to pass',
        variables: undefined
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should pass null variables through', async () => {
      const data = {
        name: 'Test Template',
        description: 'A test template',
        content: 'Content that is long enough for validation to pass',
        variables: null
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });
  });

  describe('Section-format validation (issue #705)', () => {
    it('should pass when <style> contains unmatched }} (CSS is not variable syntax)', async () => {
      const data = {
        name: 'CSS Template',
        description: 'A template with CSS',
        content: [
          '<template>Hello {{name}}</template>',
          '<style>.card { padding: 0; } .btn::after { content: "}}"; }</style>',
        ].join('\n'),
      };

      const result = await validator.validateCreate(data);

      // Unbalanced }} in <style> must NOT cause validation failure
      expect(result.isValid).toBe(true);
    });

    it('should pass when <script> contains unmatched }} (JS is not variable syntax)', async () => {
      const data = {
        name: 'JS Template',
        description: 'A template with JS',
        content: [
          '<template>Hi {{user}}</template>',
          '<script>function f() { return { x: 1 }; }</script>',
        ].join('\n'),
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should still detect unbalanced }} in <template> section (extra stray }})', async () => {
      const data = {
        name: 'Bad Template',
        description: 'Extra stray }} in template section',
        content: [
          // {{name}} is valid, but there is an extra stray }} — 1 open, 2 close
          '<template>Hello {{name}} and stray }}</template>',
          '<style>.x {}</style>',
        ].join('\n'),
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('unbalanced'))).toBe(true);
    });

    it('should pass a valid section-format template with balanced {{ }} in template section', async () => {
      const data = {
        name: 'Valid Section Template',
        description: 'A valid section-format template',
        content: [
          '<template>{{greeting}}, {{name}}!</template>',
          '<style>.x { color: red; }</style>',
          '<script>const x = () => {};</script>',
        ].join('\n'),
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });
  });
});
