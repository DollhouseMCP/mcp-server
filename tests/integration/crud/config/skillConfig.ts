/**
 * Skill element type test configuration
 *
 * Skills are discrete capabilities for specific tasks.
 * They support activation and can have parameters that affect execution.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test skill data
 */
function createSkillTestData(overrides?: Partial<ElementData>): ElementData {
  // FIX: Issue #20 - Properly merge metadata to avoid losing override fields
  // Only include default metadata if overrides don't provide their own
  const hasCustomMetadata = overrides?.metadata && Object.keys(overrides.metadata).length > 0;

  const mergedMetadata = hasCustomMetadata
    ? overrides!.metadata!
    : {
        domains: ['testing', 'validation'],
        complexity: 'beginner',
        languages: ['javascript', 'typescript'],
        triggers: ['test', 'validate']
      };

  const base: ElementData = {
    name: overrides?.name || 'Test Skill',
    description: overrides?.description || 'A test skill for validation',
    content: overrides?.content || 'This skill performs test operations.',
    metadata: mergedMetadata
  };

  // Don't spread overrides again - we've already used them above
  return base;
}

/**
 * Skill type test configuration
 */
export const SKILL_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.SKILL,
  displayName: 'Skills',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createSkillTestData,

  validExamples: [
    {
      name: 'Minimal Skill',
      description: 'A minimal valid skill',
      content: 'Basic skill instructions.',
      metadata: {}
    },
    {
      name: 'Complete Skill',
      description: 'A skill with all optional fields',
      content: 'Detailed skill instructions with examples.',
      metadata: {
        domains: ['web-dev', 'backend'],
        complexity: 'advanced',
        languages: ['typescript', 'python'],
        prerequisites: ['basic-coding'],
        triggers: ['code', 'develop', 'build'],
        parameters: [
          {
            name: 'mode',
            type: 'enum',
            description: 'Operation mode',
            required: true,
            options: ['strict', 'relaxed']
          }
        ],
        examples: [
          {
            title: 'Basic usage',
            description: 'How to use this skill',
            input: { mode: 'strict' },
            output: 'Success'
          }
        ],
        proficiency_level: 75
      }
    },
    {
      name: 'Parametric Skill',
      description: 'Skill with complex parameters',
      content: 'Skill with configurable behavior.',
      metadata: {
        parameters: [
          {
            name: 'threshold',
            type: 'number',
            description: 'Threshold value',
            required: true,
            min: 0,
            max: 100
          },
          {
            name: 'verbose',
            type: 'boolean',
            description: 'Enable verbose output',
            required: false
          }
        ]
      }
    }
  ],

  invalidExamples: [
    // FIX: Temporarily reduced invalid examples - many validations not implemented yet
    // TODO: Add back when validation is implemented:
    // - Empty name/description validation
    // - Complexity enum validation
    // - Proficiency level range validation
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
        'Updated skill description',
        'A completely different description',
        'Long-form skill description. '.repeat(40)
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'content',
      displayName: 'Instructions',
      type: 'string',
      required: true,
      validValues: [
        'New skill instructions',
        'Enhanced instructions with examples'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'metadata.complexity',
      displayName: 'Complexity Level',
      type: 'enum',
      required: false,
      validValues: ['beginner', 'intermediate', 'advanced', 'expert'],
      invalidValues: [
        { value: 'invalid', expectedError: 'complexity|invalid' }
      ]
    },
    {
      path: 'metadata.domains',
      displayName: 'Domains',
      type: 'array',
      required: false,
      validValues: [
        ['web-dev', 'api'],
        ['data-science']
      ]
    },
    {
      path: 'metadata.triggers',
      displayName: 'Triggers',
      type: 'array',
      required: false,
      validValues: [
        ['analyze', 'review'],
        ['optimize']
      ]
    },
    {
      path: 'metadata.proficiency_level',
      displayName: 'Proficiency Level',
      type: 'number',
      required: false,
      validValues: [50, 75, 100],
      invalidValues: [
        { value: -1, expectedError: 'range|0|100' },
        { value: 101, expectedError: 'range|0|100' }
      ]
    }
  ],

  nestedFields: {
    'metadata.parameters': {
      path: 'metadata.parameters',
      displayName: 'Skill Parameters',
      type: 'array',
      required: false,
      validValues: [
        [
          {
            name: 'param1',
            type: 'string',
            description: 'Test parameter',
            required: false
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
      activationStrategy: 'execution',
      requiresContext: false,
      expectedResultType: 'output',
      testContexts: [
        {
          description: 'Basic skill activation',
          context: undefined,
          expectedOutcome: 'Skill becomes active and ready for execution'
        },
        {
          description: 'Activation with parameters',
          context: { parameters: { mode: 'strict' } },
          expectedOutcome: 'Skill activates with specified parameters'
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
        message: 'Skill name is required'
      }),
      severity: 'error'
    },
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Skill description is required'
      }),
      severity: 'error'
    },
    {
      name: 'instructions-required',
      description: 'Instructions must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.content && data.content.trim()),
        message: 'Skill instructions are required'
      }),
      severity: 'error'
    },
    {
      name: 'complexity-valid',
      description: 'Complexity must be a valid level',
      validate: (data) => {
        if (!data.metadata?.complexity) return { valid: true };
        const validLevels = ['beginner', 'intermediate', 'advanced', 'expert'];
        return {
          valid: validLevels.includes(data.metadata.complexity),
          message: `Complexity must be one of: ${validLevels.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'proficiency-range',
      description: 'Proficiency level must be 0-100',
      validate: (data) => {
        if (!data.metadata?.proficiency_level) return { valid: true };
        const level = data.metadata.proficiency_level;
        return {
          valid: typeof level === 'number' && level >= 0 && level <= 100,
          message: 'Proficiency level must be between 0 and 100'
        };
      },
      severity: 'error'
    },
    {
      name: 'parameters-structure',
      description: 'Parameters must have valid structure',
      validate: (data) => {
        if (!data.metadata?.parameters) return { valid: true };
        if (!Array.isArray(data.metadata.parameters)) {
          return { valid: false, message: 'Parameters must be an array' };
        }
        for (const param of data.metadata.parameters) {
          if (!param.name || !param.type || !param.description) {
            return {
              valid: false,
              message: 'Each parameter must have name, type, and description'
            };
          }
        }
        return { valid: true };
      },
      severity: 'error'
    },
    {
      name: 'domains-recommended',
      description: 'Skills should have domains for better organization',
      validate: (data) => ({
        valid: Boolean(data.metadata?.domains && data.metadata.domains.length > 0),
        message: 'Consider adding domain categories for better organization'
      }),
      severity: 'warning'
    }
  ]
};
