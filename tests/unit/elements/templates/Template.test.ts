/**
 * Unit tests for Template element class
 */

import { Template, TemplateVariable } from '../../../../src/elements/templates/Template.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

// Create a shared MetadataService instance for all tests
const metadataService = createTestMetadataService();

describe('Template', () => {
  describe('constructor', () => {
    it('should create a template with minimal metadata', () => {
      const template = new Template({ name: 'Test Template' }, 'Hello {{name}}!', metadataService);
      
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
      }, 'Content', metadataService);
      
      // The sanitization removes angle brackets and quotes, leaving the text content
      expect(template.metadata.name).toBe('Testscriptalertxss/script');
      expect(template.metadata.description).toBe('Test descriptionimg src=x onerror=alert1');
      // Category is sanitized with Unicode normalization, removing angle brackets
      expect(template.metadata.category).toBe('testbcategory/b');
    });

    it('should enforce template size limit', () => {
      const largeContent = 'x'.repeat(101 * 1024); // 101KB
      
      expect(() => {
        new Template({ name: 'Large' }, largeContent, metadataService);
      }).toThrow('Template content exceeds maximum size');
    });

    it('should enforce variable count limit', () => {
      const variables: TemplateVariable[] = [];
      for (let i = 0; i < 101; i++) {
        variables.push({ name: `var${i}`, type: 'string' });
      }
      
      expect(() => {
        new Template({ name: 'Many Vars', variables }, 'Content', metadataService);
      }).toThrow('Variable count 101 exceeds maximum 100');
    });

    it('should validate include paths', () => {
      expect(() => {
        new Template({
          name: 'Bad Include',
          includes: ['../../../etc/passwd']
        }, 'Content', metadataService);
      }).toThrow('Invalid include path');
    });

    it('should allow valid include paths', () => {
      const template = new Template({
        name: 'Good Include',
        includes: ['shared/header.md', 'components/footer.md']
      }, 'Content', metadataService);
      
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
      }, 'Hello {{name}}, you are {{age}} years old!', metadataService);
      
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
      }, 'Hello {{title}} {{name}}!', metadataService);
      
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
      }, '{{greeting}} World{{punctuation}}', metadataService);
      
      const result = await template.render({});
      
      expect(result).toBe('Hello World!');
    });

    it('should throw for missing required variables', async () => {
      const template = new Template({
        name: 'Required',
        variables: [
          { name: 'name', type: 'string', required: true }
        ]
      }, 'Hello {{name}}!', metadataService);
      
      await expect(template.render({})).rejects.toThrow("Required variable 'name' not provided");
    });

    it('should validate string patterns', async () => {
      const template = new Template({
        name: 'Pattern',
        variables: [
          // Use a simpler pattern that doesn't need escaping
          { name: 'email', type: 'string', validation: '^[a-zA-Z0-9.-]+@[a-zA-Z0-9.-]+.[a-zA-Z]+$' }
        ]
      }, 'Email: {{email}}', metadataService);
      
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
      }, 'Size: {{size}}', metadataService);
      
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
      }, 'User: {{user.name}} ({{user.email}})', metadataService);
      
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
      }, 'String: {{str}}\nNumber: {{num}}\nBoolean: {{bool}}\nDate: {{date}}\nArray: {{arr}}\nObject: {{obj}}', metadataService);
      
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
      }, 'Content: {{content}}', metadataService);
      
      // The sanitization removes the dangerous characters, so it won't throw
      // Instead, check that the content is sanitized
      const result = await template.render({ content: '<script>alert("xss")</script>' });
      expect(result).toBe('Content: scriptalertxss/script');
    });

    it('should enforce include depth limit', async () => {
      const template = new Template({
        name: 'Deep Include',
        includes: ['other.md']
      }, 'Content', metadataService);
      
      await expect(
        template.render({}, 6) // Exceed max depth
      ).rejects.toThrow('Maximum template include depth exceeded');
    });

    it('should update usage statistics', async () => {
      const template = new Template({ name: 'Stats' }, 'Hello!', metadataService);
      
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
      const template = new Template({ name: 'Empty' }, '', metadataService);
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
      const template = new Template({ name: 'Unmatched' }, 'Hello {{name} world!', metadataService);
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
      }, 'Content', metadataService);
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
      }, 'Content', metadataService);
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
      }, 'Content', metadataService);
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
      }, 'Hello {{defined}} and {{undefined}}!', metadataService);
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

    it('should not warn for dot-notation variables registered with their full path', () => {
      // deriveVariablesFromContent stores 'user.name' as the variable name;
      // validate() must match against the full path, not just the root 'user'.
      const template = new Template({
        name: 'Dot Notation Vars',
        variables: [
          { name: 'user.name', type: 'string' },
          { name: 'user.email', type: 'string' }
        ]
      }, 'Hello {{user.name}}, your email is {{user.email}}.', metadataService);
      const result = template.validate();

      const undefinedVarWarnings = (result.warnings ?? []).filter(
        w => w.field === 'variables' && w.message.includes('undefined variable')
      );
      expect(undefinedVarWarnings).toHaveLength(0);
    });

    it('should suggest best practices', () => {
      const template = new Template({ name: 'Basic' }, 'Content', metadataService);
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
      }, 'String: {{string_var}}\nNumber: {{number_var}}\nBool: {{bool_var}}\nArray: {{array_var}}\nObject: {{object_var}}', metadataService);
      
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
      }, '{{greeting}}, count: {{count}}', metadataService);
      
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
      }, 'Content: {{var1}}, {{var2}}', metadataService);
      
      // Test with JSON serialization for backward compatibility
      const serializedJSON = original.serializeToJSON();
      const restored = new Template({}, '', metadataService);
      restored.deserialize(serializedJSON);
      
      expect(restored.metadata.name).toBe('Test Template');
      expect(restored.metadata.description).toBe('A test template');
      expect(restored.metadata.variables).toHaveLength(2);
      expect(restored.metadata.tags).toEqual(['test', 'example']);
      expect(restored.content).toBe('Content: {{var1}}, {{var2}}');
    });

    it('should handle deserialization errors', () => {
      const template = new Template({ name: 'Test' }, 'Content', metadataService);
      
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
      }, 'Hello {{test}}!', metadataService);
      
      await template.activate();
      
      // Should not throw
      expect(template.getStatus()).toBe('active');
    });

    it('should clear cache on deactivation', async () => {
      const template = new Template({ name: 'Cache Test' }, 'Content {{var}}', metadataService);

      // Trigger compilation
      await template.render({ var: 'test' });

      await template.deactivate();

      // Cache should be cleared (we can't directly test this, but deactivate should complete)
      expect(template.getStatus()).toBe('inactive');
    });
  });

  describe('Section-format parsing (issue #705)', () => {
    const SECTION_CONTENT = [
      '<template>',
      'Hello {{name}}!',
      '</template>',
      '<style>',
      '.btn { color: red; }',
      '</style>',
      '<script>',
      'function init() { return {}; }',
      '</script>',
    ].join('\n');

    describe('Template.parseSections()', () => {
      it('detects section mode when all three tags are present', () => {
        const result = Template.parseSections(SECTION_CONTENT);
        expect(result.isSectionMode).toBe(true);
      });

      it('extracts templateSection correctly', () => {
        const { templateSection } = Template.parseSections(SECTION_CONTENT);
        expect(templateSection.trim()).toBe('Hello {{name}}!');
      });

      it('extracts styleSection correctly', () => {
        const { styleSection } = Template.parseSections(SECTION_CONTENT);
        expect(styleSection.trim()).toBe('.btn { color: red; }');
      });

      it('extracts scriptSection correctly', () => {
        const { scriptSection } = Template.parseSections(SECTION_CONTENT);
        expect(scriptSection.trim()).toBe('function init() { return {}; }');
      });

      it('returns isSectionMode=false for plain templates', () => {
        const result = Template.parseSections('Hello {{name}}!');
        expect(result.isSectionMode).toBe(false);
        expect(result.templateSection).toBe('');
      });

      it('works with only a <template> section', () => {
        const result = Template.parseSections('<template>Hello</template>');
        expect(result.isSectionMode).toBe(true);
        expect(result.templateSection.trim()).toBe('Hello');
        expect(result.styleSection).toBe('');
        expect(result.scriptSection).toBe('');
      });

      it('tags with attributes (e.g. <template id="x">) are NOT treated as section markers', () => {
        // HTML <template> elements with attributes are intentional HTML, not section markers
        const html = '<template id="slot-1">Hello {{name}}</template>';
        const result = Template.parseSections(html);
        expect(result.isSectionMode).toBe(false);
      });

      it('handles nested bare <template> tags gracefully without throwing', () => {
        // Nested section markers are unsupported — parseSections() logs a warning
        // but must not throw. The lazy regex will match the innermost pair.
        const content = '<template>outer <template>inner</template></template>';
        expect(() => Template.parseSections(content)).not.toThrow();
        const result = Template.parseSections(content);
        // isSectionMode is true because at least one section tag was found
        expect(result.isSectionMode).toBe(true);
      });
    });

    describe('getSections() caching', () => {
      it('returns the same object reference on repeated calls (cache hit)', () => {
        const t = new Template({ name: 'cached' }, SECTION_CONTENT, metadataService);
        const first = t.getSections();
        const second = t.getSections();
        expect(first).toBe(second); // same reference = cached
      });

      it('clears the cache on deactivation', async () => {
        const t = new Template({ name: 'deactivate-test' }, SECTION_CONTENT, metadataService);
        const first = t.getSections();
        await t.deactivate();
        const second = t.getSections();
        // After deactivation the cache is cleared — new object with same values
        expect(second).not.toBe(first);
        expect(second.isSectionMode).toBe(first.isSectionMode);
      });
    });

    describe('getSections() instance method', () => {
      it('delegates to parseSections on instance content', () => {
        const t = new Template({ name: 'sect' }, SECTION_CONTENT, metadataService);
        const sections = t.getSections();
        expect(sections.isSectionMode).toBe(true);
        expect(sections.templateSection.trim()).toBe('Hello {{name}}!');
      });
    });

    describe('render() in section mode', () => {
      it('substitutes variables only within <template> section', async () => {
        const t = new Template(
          { name: 'sect', variables: [{ name: 'name', type: 'string' }] },
          SECTION_CONTENT,
          metadataService
        );
        const output = await t.render({ name: 'Alice' });
        expect(output.trim()).toBe('Hello Alice!');
        // style/script content must NOT appear in rendered output
        expect(output).not.toContain('.btn');
        expect(output).not.toContain('function init');
      });

      it('does not fail on }} in <script> section (not parsed as token)', async () => {
        const content = [
          '<template>Hi {{name}}</template>',
          '<script>const x = () => { return { val: 1 }; };</script>',
        ].join('\n');
        const t = new Template(
          { name: 'js-tmpl', variables: [{ name: 'name', type: 'string' }] },
          content,
          metadataService
        );
        const output = await t.render({ name: 'World' });
        expect(output.trim()).toBe('Hi World');
      });
    });
  });

  describe('deriveVariablesFromContent() (#1896)', () => {
    it('returns an empty array when content has no placeholders', () => {
      const result = Template.deriveVariablesFromContent('No placeholders here.');
      expect(result).toHaveLength(0);
    });

    it('derives a single placeholder', () => {
      const result = Template.deriveVariablesFromContent('Hello {{name}}!');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('name');
      expect(result[0].type).toBe('string');
      expect(result[0].required).toBe(false);
    });

    it('derives multiple distinct placeholders', () => {
      const result = Template.deriveVariablesFromContent('{{first}} and {{second}} and {{third}}');
      const names = result.map(v => v.name).sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(['first', 'second', 'third']);
    });

    it('deduplicates repeated placeholders', () => {
      const result = Template.deriveVariablesFromContent('{{foo}} then {{foo}} again');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('foo');
    });

    it('preserves existing variable entries unchanged', () => {
      const existing: TemplateVariable[] = [
        { name: 'name', type: 'string', required: true, description: 'Full name' }
      ];
      const result = Template.deriveVariablesFromContent('Hello {{name}}! Your score: {{score}}', existing);
      const namVar = result.find(v => v.name === 'name')!;
      expect(namVar.required).toBe(true);
      expect(namVar.description).toBe('Full name');
    });

    it('adds only missing placeholders when some are already declared', () => {
      const existing: TemplateVariable[] = [{ name: 'name', type: 'string' }];
      const result = Template.deriveVariablesFromContent('{{name}} and {{score}}', existing);
      expect(result).toHaveLength(2);
      const scoreVar = result.find(v => v.name === 'score')!;
      expect(scoreVar.type).toBe('string');
      expect(scoreVar.required).toBe(false);
    });

    it('handles dot-notation placeholder paths', () => {
      const result = Template.deriveVariablesFromContent('{{user.name}} at {{user.email}}');
      const names = result.map(v => v.name).sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(['user.email', 'user.name']);
    });

    it('handles whitespace inside braces', () => {
      const result = Template.deriveVariablesFromContent('{{ spaced }} and {{  also_spaced  }}');
      const names = result.map(v => v.name).sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(['also_spaced', 'spaced']);
    });

    it('in section mode, only scans the <template> section', () => {
      const content = [
        '<template>{{title}}</template>',
        '<style>.cls-{{ignored}} { color: red; }</style>',
        '<script>var {{also_ignored}} = 1;</script>',
      ].join('\n');
      const result = Template.deriveVariablesFromContent(content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('title');
    });

    it('throws with ensemble guidance when derived count would exceed 100', () => {
      // Build content with 101 distinct placeholders
      const placeholders = Array.from({ length: 101 }, (_, i) => `{{var_${i}}}`).join(' ');
      expect(() => Template.deriveVariablesFromContent(placeholders)).toThrow(
        /Split this content across multiple templates and combine them in an ensemble/
      );
    });

    it('succeeds when derived count is exactly 100', () => {
      const placeholders = Array.from({ length: 100 }, (_, i) => `{{var_${i}}}`).join(' ');
      const result = Template.deriveVariablesFromContent(placeholders);
      expect(result).toHaveLength(100);
    });
  });
});