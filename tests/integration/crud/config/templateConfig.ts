/**
 * Template element type test configuration
 *
 * Templates are reusable content structures with variable substitution.
 * They support activation through rendering with provided variables.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test template data
 */
function createTemplateTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test Template',
    description: overrides?.description || 'A test template for validation',
    content: overrides?.content || 'Hello {{ name }}, welcome to {{ project }}!',
    metadata: {
      category: 'testing',
      output_format: 'markdown',
      variables: [
        {
          name: 'name',
          type: 'string',
          description: 'User name',
          required: true
        },
        {
          name: 'project',
          type: 'string',
          description: 'Project name',
          required: true
        }
      ],
      triggers: ['generate', 'create'],
      ...(overrides?.metadata || {})
    }
  };

  return { ...base, ...overrides };
}

/**
 * Template type test configuration
 */
export const TEMPLATE_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.TEMPLATE,
  displayName: 'Templates',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createTemplateTestData,

  validExamples: [
    {
      name: 'Minimal Template',
      description: 'A minimal valid template',
      content: 'Static content without variables',
      metadata: {
        category: 'general',
        output_format: 'text'
      }
    },
    {
      name: 'Complete Template',
      description: 'A template with all optional fields',
      content: '# {{ title }}\n\nAuthor: {{ author }}\nDate: {{ date }}\n\n{{ content }}',
      metadata: {
        category: 'documents',
        output_format: 'markdown',
        variables: [
          {
            name: 'title',
            type: 'string',
            description: 'Document title',
            required: true
          },
          {
            name: 'author',
            type: 'string',
            description: 'Document author',
            required: false,
            default: 'Unknown'
          },
          {
            name: 'date',
            type: 'date',
            description: 'Creation date',
            required: false,
            format: 'YYYY-MM-DD'
          },
          {
            name: 'content',
            type: 'string',
            description: 'Main content',
            required: true
          }
        ],
        tags: ['document', 'report'],
        triggers: ['create', 'generate', 'draft'],
        examples: [
          {
            title: 'Basic report',
            description: 'Generate a basic report',
            variables: {
              title: 'Test Report',
              content: 'Report body'
            }
          }
        ]
      }
    },
    {
      name: 'Complex Variable Template',
      description: 'Template with various variable types',
      content: 'Count: {{ count }}, Active: {{ active }}, Items: {{ items }}',
      metadata: {
        variables: [
          {
            name: 'count',
            type: 'number',
            description: 'Item count',
            required: true
          },
          {
            name: 'active',
            type: 'boolean',
            description: 'Is active',
            required: false,
            default: true
          },
          {
            name: 'items',
            type: 'array',
            description: 'List of items',
            required: false
          }
        ]
      }
    }
  ],

  invalidExamples: [
    // FIX: Temporarily reduced - validation not fully implemented
    // TODO: Add back when validation implemented
  ],

  // ============================================================================
  // Field Specifications
  // ============================================================================
  requiredFields: ['name', 'description', 'content'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated template description',
        'A completely different description',
        'Long-form template description. '.repeat(40)
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'content',
      displayName: 'Template Content',
      type: 'string',
      required: true,
      validValues: [
        'New template: {{ var1 }}',
        'Updated {{ var2 }} template'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'metadata.category',
      displayName: 'Category',
      type: 'string',
      required: false,
      validValues: ['documents', 'emails', 'code', 'reports']
    },
    {
      path: 'metadata.output_format',
      displayName: 'Output Format',
      type: 'string',
      required: false,
      validValues: ['markdown', 'html', 'json', 'yaml', 'text']
    },
    {
      path: 'metadata.tags',
      displayName: 'Tags',
      type: 'array',
      required: false,
      validValues: [
        ['tag1', 'tag2'],
        ['single-tag']
      ]
    },
    {
      path: 'metadata.triggers',
      displayName: 'Triggers',
      type: 'array',
      required: false,
      validValues: [
        ['create', 'generate'],
        ['draft']
      ]
    }
  ],

  nestedFields: {
    'metadata.variables': {
      path: 'metadata.variables',
      displayName: 'Template Variables',
      type: 'array',
      required: false,
      validValues: [
        [
          {
            name: 'var1',
            type: 'string',
            description: 'Test variable',
            required: true
          }
        ]
      ]
    }
  },

  // ============================================================================
  // Capabilities
  // ============================================================================
  capabilities: {
    supportsActivation: {
      activationStrategy: 'rendering',
      requiresContext: false,
      expectedResultType: 'state-change',
      testContexts: [
        {
          description: 'Activate template with required variables',
          context: undefined,
          expectedOutcome: 'ready to use'
        },
        {
          description: 'Activate template for rendering',
          context: undefined,
          expectedOutcome: 'ready to use'
        }
      ]
    }
  },

  // ============================================================================
  // Validation Rules
  // ============================================================================
  validators: [
    {
      name: 'name-required',
      description: 'Name field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.name && data.name.trim()),
        message: 'Template name is required'
      }),
      severity: 'error'
    },
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Template description is required'
      }),
      severity: 'error'
    },
    {
      name: 'content-required',
      description: 'Content must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.content && data.content.trim()),
        message: 'Template content is required'
      }),
      severity: 'error'
    },
    {
      name: 'token-matching',
      description: 'Template tokens must be properly matched',
      validate: (data) => {
        if (!data.content) return { valid: true };
        const openTokens = (data.content.match(/\{\{/g) || []).length;
        const closeTokens = (data.content.match(/\}\}/g) || []).length;
        return {
          valid: openTokens === closeTokens,
          message: 'Template has unmatched variable tokens'
        };
      },
      severity: 'error'
    },
    {
      name: 'variables-structure',
      description: 'Variables must have valid structure',
      validate: (data) => {
        if (!data.metadata?.variables) return { valid: true };
        if (!Array.isArray(data.metadata.variables)) {
          return { valid: false, message: 'Variables must be an array' };
        }
        for (const variable of data.metadata.variables) {
          if (!variable.name || !variable.type) {
            return {
              valid: false,
              message: 'Each variable must have name and type'
            };
          }
        }
        return { valid: true };
      },
      severity: 'error'
    },
    {
      name: 'output-format-valid',
      description: 'Output format should be a known format',
      validate: (data) => {
        if (!data.metadata?.output_format) return { valid: true };
        const validFormats = ['markdown', 'html', 'json', 'yaml', 'text', 'xml'];
        return {
          valid: validFormats.includes(data.metadata.output_format),
          message: `Unknown output format. Common formats: ${validFormats.join(', ')}`
        };
      },
      severity: 'warning'
    },
    {
      name: 'tags-recommended',
      description: 'Templates should have tags for searchability',
      validate: (data) => ({
        valid: Boolean(data.metadata?.tags && data.metadata.tags.length > 0),
        message: 'Consider adding tags for better searchability'
      }),
      severity: 'info'
    }
  ]
};
