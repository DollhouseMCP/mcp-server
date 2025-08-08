/**
 * Unit tests for Template element class
 */

import { Template, TemplateMetadata, TemplateVariable } from '../../../../../src/elements/templates/Template.js';
import { ElementType } from '../../../../../src/portfolio/types.js';

describe('Template', () => {
  describe('constructor', () => {
    it('should create a template with minimal metadata', () => {
      const template = new Template({ name: 'Test Template' }, 'Hello {{name}}!');
      
      expect(template.type).toBe(ElementType.TEMPLATE);
      expect(template.metadata.name).toBe('Test Template');
      expect(template.content).toBe('Hello {{name}}!');
      expect(template.metadata.category).toBe('general');
      expect(template.metadata.output_format).toBe('markdown');
    });

    it('should sanitize metadata inputs', () => {
      const template = new Template({
        name: 'Test<script>alert("xss")</script>',
        description: 'Test description<img src=x onerror=alert(1)>',
        category: 'test<b>category</b>'
      }, 'Content');
      
      // The sanitization removes angle brackets and quotes, leaving the text content
      expect(template.metadata.name).toBe('Testscriptalertxss/script');
      expect(template.metadata.description).toBe('Test descriptionimg src=x onerror=alert1');
      // Category is sanitized with Unicode normalization, removing angle brackets
      expect(template.metadata.category).toBe('testbcategory/b');
    });

    it('should enforce template size limit', () => {
      const largeContent = 'x'.repeat(101 * 1024); // 101KB
      
      expect(() => {
        new Template({ name: 'Large' }, largeContent);
      }).toThrow('Template content exceeds maximum size');
    });

    it('should enforce variable count limit', () => {
      const variables: TemplateVariable[] = [];
      for (let i = 0; i < 101; i++) {
        variables.push({ name: `var${i}`, type: 'string' });
      }
      
      expect(() => {
        new Template({ name: 'Many Vars', variables }, 'Content');
      }).toThrow('Variable count 101 exceeds maximum 100');
    });

    it('should validate include paths', () => {
      expect(() => {
        new Template({
          name: 'Bad Include',
          includes: ['../../../etc/passwd']
        }, 'Content');
      }).toThrow('Invalid include path');
    });

    it('should allow valid include paths', () => {
      const template = new Template({
        name: 'Good Include',
        includes: ['shared/header.md', 'components/footer.md']
      }, 'Content');
      
      expect(template.metadata.includes).toEqual(['shared/header.md', 'components/footer.md']);
    });
  });

  describe('render', () => {
    it('should render simple variables', async () => {
      const template = new Template({
        name: 'Simple',
        variables: [
          { name: 'name', type: 'string' },
          { name: 'age', type: 'number' }
        ]
      }, 'Hello {{name}}, you are {{age}} years old!');
      
      const result = await template.render({
        name: 'Alice',
        age: 30
      });
      
      expect(result).toBe('Hello Alice, you are 30 years old!');
    });

    it('should handle missing optional variables', async () => {
      const template = new Template({
        name: 'Optional',
        variables: [
          { name: 'name', type: 'string', required: true },
          { name: 'title', type: 'string', required: false }
        ]
      }, 'Hello {{title}} {{name}}!');
      
      const result = await template.render({ name: 'Bob' });
      
      expect(result).toBe('Hello  Bob!');
    });

    it('should use default values', async () => {
      const template = new Template({
        name: 'Defaults',
        variables: [
          { name: 'greeting', type: 'string', default: 'Hello' },
          { name: 'punctuation', type: 'string', default: '!' }
        ]
      }, '{{greeting}} World{{punctuation}}');
      
      const result = await template.render({});
      
      expect(result).toBe('Hello World!');
    });

    it('should throw for missing required variables', async () => {
      const template = new Template({
        name: 'Required',
        variables: [
          { name: 'name', type: 'string', required: true }
        ]
      }, 'Hello {{name}}!');
      
      await expect(template.render({})).rejects.toThrow("Required variable 'name' not provided");
    });

    it('should validate string patterns', async () => {
      const template = new Template({
        name: 'Pattern',
        variables: [
          // Use a simpler pattern that doesn't need escaping
          { name: 'email', type: 'string', validation: '^[a-zA-Z0-9.-]+@[a-zA-Z0-9.-]+.[a-zA-Z]+$' }
        ]
      }, 'Email: {{email}}');
      
      await expect(
        template.render({ email: 'invalid-email' })
      ).rejects.toThrow("Variable 'email' does not match validation pattern");
      
      const result = await template.render({ email: 'test@example.com' });
      expect(result).toBe('Email: test@example.com');
    });

    it('should validate enum options', async () => {
      const template = new Template({
        name: 'Enum',
        variables: [
          { name: 'size', type: 'string', options: ['small', 'medium', 'large'] }
        ]
      }, 'Size: {{size}}');
      
      await expect(
        template.render({ size: 'extra-large' })
      ).rejects.toThrow("Variable 'size' must be one of: small, medium, large");
      
      const result = await template.render({ size: 'medium' });
      expect(result).toBe('Size: medium');
    });

    it('should handle nested object variables', async () => {
      const template = new Template({
        name: 'Nested',
        variables: [
          { name: 'user', type: 'object' }
        ]
      }, 'User: {{user.name}} ({{user.email}})');
      
      const result = await template.render({
        user: { name: 'Charlie', email: 'charlie@example.com' }
      });
      
      expect(result).toBe('User: Charlie (charlie@example.com)');
    });

    it('should format different value types', async () => {
      const template = new Template({
        name: 'Types',
        variables: [
          { name: 'str', type: 'string' },
          { name: 'num', type: 'number' },
          { name: 'bool', type: 'boolean' },
          { name: 'date', type: 'date' },
          { name: 'arr', type: 'array' },
          { name: 'obj', type: 'object' }
        ]
      }, 'String: {{str}}\nNumber: {{num}}\nBoolean: {{bool}}\nDate: {{date}}\nArray: {{arr}}\nObject: {{obj}}');
      
      const testDate = new Date('2025-01-01T00:00:00Z');
      const result = await template.render({
        str: 'test',
        num: 42,
        bool: true,
        date: testDate,
        arr: ['a', 'b', 'c'],
        obj: { key: 'value' }
      });
      
      expect(result).toContain('String: test');
      expect(result).toContain('Number: 42');
      expect(result).toContain('Boolean: true');
      expect(result).toContain('Date: 2025-01-01T00:00:00.000Z');
      expect(result).toContain('Array: a, b, c');
      expect(result).toContain('Object: {\n  "key": "value"\n}');
    });

    it('should sanitize XSS attempts in variables', async () => {
      const template = new Template({
        name: 'XSS Test',
        variables: [
          { name: 'content', type: 'string' }
        ]
      }, 'Content: {{content}}');
      
      // The sanitization removes the dangerous characters, so it won't throw
      // Instead, check that the content is sanitized
      const result = await template.render({ content: '<script>alert("xss")</script>' });
      expect(result).toBe('Content: scriptalertxss/script');
    });

    it('should enforce include depth limit', async () => {
      const template = new Template({
        name: 'Deep Include',
        includes: ['other.md']
      }, 'Content');
      
      await expect(
        template.render({}, 6) // Exceed max depth
      ).rejects.toThrow('Maximum template include depth exceeded');
    });

    it('should update usage statistics', async () => {
      const template = new Template({ name: 'Stats' }, 'Hello!');
      
      expect(template.metadata.usage_count).toBe(0);
      expect(template.metadata.last_used).toBeUndefined();
      
      await template.render();
      
      expect(template.metadata.usage_count).toBe(1);
      expect(template.metadata.last_used).toBeDefined();
      
      await template.render();
      
      expect(template.metadata.usage_count).toBe(2);
    });
  });

  describe('validate', () => {
    it('should validate empty content', () => {
      const template = new Template({ name: 'Empty' }, '');
      const result = template.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'content',
          code: 'EMPTY_CONTENT'
        })
      );
    });

    it('should detect unmatched tokens', () => {
      const template = new Template({ name: 'Unmatched' }, 'Hello {{name} world!');
      const result = template.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'content',
          code: 'UNMATCHED_TOKENS'
        })
      );
    });

    it('should warn about unknown output formats', () => {
      const template = new Template({
        name: 'Format',
        output_format: 'custom'
      }, 'Content');
      const result = template.validate();
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          field: 'output_format',
          severity: 'low'
        })
      );
    });

    it('should detect duplicate variable names', () => {
      const template = new Template({
        name: 'Duplicates',
        variables: [
          { name: 'var1', type: 'string' },
          { name: 'var1', type: 'number' }
        ]
      }, 'Content');
      const result = template.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'variables[1].name',
          code: 'DUPLICATE_VARIABLE'
        })
      );
    });

    it('should validate regex patterns', () => {
      const template = new Template({
        name: 'Bad Regex',
        variables: [
          { name: 'test', type: 'string', validation: '[invalid(' }
        ]
      }, 'Content');
      const result = template.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'variables[0].validation',
          code: 'INVALID_REGEX'
        })
      );
    });

    it('should warn about undefined variables', () => {
      const template = new Template({
        name: 'Undefined Vars',
        variables: [
          { name: 'defined', type: 'string' }
        ]
      }, 'Hello {{defined}} and {{undefined}}!');
      const result = template.validate();
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          field: 'variables',
          message: expect.stringContaining("undefined variable 'undefined'"),
          severity: 'medium'
        })
      );
    });

    it('should suggest best practices', () => {
      const template = new Template({ name: 'Basic' }, 'Content');
      const result = template.validate();
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          field: 'tags',
          severity: 'low'
        })
      );
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          field: 'examples',
          severity: 'medium'
        })
      );
    });
  });

  describe('preview', () => {
    it('should generate preview with sample data', async () => {
      const template = new Template({
        name: 'Preview Test',
        variables: [
          { name: 'string_var', type: 'string' },
          { name: 'number_var', type: 'number' },
          { name: 'bool_var', type: 'boolean' },
          { name: 'array_var', type: 'array' },
          { name: 'object_var', type: 'object' }
        ]
      }, 'String: {{string_var}}\nNumber: {{number_var}}\nBool: {{bool_var}}\nArray: {{array_var}}\nObject: {{object_var}}');
      
      const preview = await template.preview();
      
      expect(preview).toContain('String: [string_var]');
      expect(preview).toContain('Number: 42');
      expect(preview).toContain('Bool: true');
      expect(preview).toContain('Array: item1, item2');
      expect(preview).toContain('Object: {\n  "key": "value"\n}');
    });

    it('should use default values in preview', async () => {
      const template = new Template({
        name: 'Preview Defaults',
        variables: [
          { name: 'greeting', type: 'string', default: 'Hello' },
          { name: 'count', type: 'number', default: 5 }
        ]
      }, '{{greeting}}, count: {{count}}');
      
      const preview = await template.preview();
      
      expect(preview).toBe('Hello, count: 5');
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize correctly', () => {
      const original = new Template({
        name: 'Test Template',
        description: 'A test template',
        variables: [
          { name: 'var1', type: 'string', required: true },
          { name: 'var2', type: 'number', default: 10 }
        ],
        tags: ['test', 'example']
      }, 'Content: {{var1}}, {{var2}}');
      
      const serialized = original.serialize();
      const restored = new Template({}, '');
      restored.deserialize(serialized);
      
      expect(restored.metadata.name).toBe('Test Template');
      expect(restored.metadata.description).toBe('A test template');
      expect(restored.metadata.variables).toHaveLength(2);
      expect(restored.metadata.tags).toEqual(['test', 'example']);
      expect(restored.content).toBe('Content: {{var1}}, {{var2}}');
    });

    it('should handle deserialization errors', () => {
      const template = new Template({ name: 'Test' }, 'Content');
      
      expect(() => {
        template.deserialize('invalid json');
      }).toThrow('Template deserialization failed');
    });
  });

  describe('lifecycle', () => {
    it('should compile on activation', async () => {
      const template = new Template({
        name: 'Lifecycle',
        variables: [{ name: 'test', type: 'string' }]
      }, 'Hello {{test}}!');
      
      await template.activate();
      
      // Should not throw
      expect(template.getStatus()).toBe('active');
    });

    it('should clear cache on deactivation', async () => {
      const template = new Template({ name: 'Cache Test' }, 'Content {{var}}');
      
      // Trigger compilation
      await template.render({ var: 'test' });
      
      await template.deactivate();
      
      // Cache should be cleared (we can't directly test this, but deactivate should complete)
      expect(template.getStatus()).toBe('inactive');
    });
  });
});