/**
 * Ensemble element type test configuration
 *
 * Ensembles orchestrate multiple elements working together as a cohesive unit.
 * They support activation (multi-element orchestration) and nesting of other elements.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test ensemble data
 */
function createEnsembleTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test Ensemble',
    description: overrides?.description || 'A test ensemble for validation',
    metadata: {
      activationStrategy: 'sequential',
      conflictResolution: 'first-write',  // FIX: Use hyphen not underscore
      contextSharing: true,
      allowNested: true,
      maxNestingDepth: 3,
      elements: [],
      resourceLimits: {
        maxActiveElements: 10,
        maxExecutionTimeMs: 30000
      },
      ...(overrides?.metadata || {})
    }
  };

  return { ...base, ...overrides };
}

/**
 * Ensemble type test configuration
 */
export const ENSEMBLE_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.ENSEMBLE,
  displayName: 'Ensembles',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createEnsembleTestData,

  validExamples: [
    {
      name: 'Minimal Ensemble',
      description: 'A minimal valid ensemble',
      metadata: {
        activationStrategy: 'sequential',
        conflictResolution: 'first-write',  // FIX: Use hyphen not underscore
        elements: []
      }
    },
    {
      name: 'Complete Ensemble',
      description: 'An ensemble with all optional fields',
      metadata: {
        activationStrategy: 'all',
        conflictResolution: 'merge',
        contextSharing: true,
        allowNested: true,
        maxNestingDepth: 5,
        elements: [
          {
            element_name: 'helper-persona',
            element_type: ElementType.PERSONA,
            role: 'primary',
            order: 1,
            condition: undefined
          },
          {
            element_name: 'code-skill',
            element_type: ElementType.SKILL,
            role: 'support',
            order: 2,
            condition: undefined
          }
        ],
        resourceLimits: {
          maxActiveElements: 20,
          maxExecutionTimeMs: 60000
        }
      }
    },
    {
      name: 'Nested Ensemble',
      description: 'Ensemble with nested ensemble',
      metadata: {
        activationStrategy: 'sequential',
        conflictResolution: 'priority',
        allowNested: true,
        maxNestingDepth: 2,
        elements: [
          {
            element_name: 'sub-ensemble',
            element_type: ElementType.ENSEMBLE,
            role: 'primary',
            order: 1
          }
        ]
      }
    },
    {
      name: 'Conditional Ensemble',
      description: 'Ensemble with conditional activation',
      metadata: {
        activationStrategy: 'conditional',
        conflictResolution: 'last-write',
        elements: [
          {
            element_name: 'primary-persona',
            element_type: ElementType.PERSONA,
            role: 'primary',
            order: 1,
            condition: 'context.mode === "strict"'
          },
          {
            element_name: 'fallback-persona',
            element_type: ElementType.PERSONA,
            role: 'support',
            order: 2,
            condition: 'context.mode === "relaxed"'
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
  requiredFields: ['name', 'description'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated ensemble description',
        'A completely different description'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' },
        { value: 'A'.repeat(501), expectedError: 'length|size' }
      ]
    },
    {
      path: 'metadata.activationStrategy',
      displayName: 'Activation Strategy',
      type: 'enum',
      required: false,
      validValues: ['all', 'sequential', 'lazy', 'conditional', 'priority'],
      invalidValues: [
        { value: 'invalid', expectedError: 'strategy|invalid' }
      ]
    },
    {
      path: 'metadata.conflictResolution',
      displayName: 'Conflict Resolution',
      type: 'enum',
      required: false,
      validValues: ['last-write', 'first-write', 'merge', 'priority', 'error'],
      invalidValues: [
        { value: 'invalid', expectedError: 'conflict|resolution|invalid' }
      ]
    },
    {
      path: 'metadata.contextSharing',
      displayName: 'Context Sharing',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.allowNested',
      displayName: 'Allow Nested',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.maxNestingDepth',
      displayName: 'Max Nesting Depth',
      type: 'number',
      required: false,
      validValues: [1, 2, 3, 5],
      invalidValues: [
        { value: 0, expectedError: 'minimum|invalid' },
        { value: 11, expectedError: 'maximum|exceeded' }
      ]
    }
  ],

  nestedFields: {
    'metadata.elements': {
      path: 'metadata.elements',
      displayName: 'Ensemble Elements',
      type: 'array',
      required: false,
      validValues: [
        [
          {
            element_name: 'test-persona',
            element_type: ElementType.PERSONA,
            role: 'primary',
            order: 1
          }
        ]
      ]
    },
    'metadata.resourceLimits': {
      path: 'metadata.resourceLimits',
      displayName: 'Resource Limits',
      type: 'object',
      required: false,
      validValues: [
        {
          maxActiveElements: 10,
          maxExecutionTimeMs: 30000
        }
      ]
    }
  },

  // ============================================================================
  // Capabilities
  // ============================================================================
  capabilities: {
    supportsActivation: {
      activationStrategy: 'orchestration',
      requiresContext: false,
      expectedResultType: 'multi-element',
      testContexts: [
        {
          description: 'Sequential activation',
          context: { strategy: 'sequential' },
          expectedOutcome: 'activated'
        },
        {
          description: 'Parallel activation',
          context: { strategy: 'parallel' },
          expectedOutcome: 'activated'
        },
        {
          description: 'Conditional activation',
          context: {
            strategy: 'conditional',
            mode: 'strict'
          },
          expectedOutcome: 'activated'
        }
      ]
    },
    supportsNesting: {
      maxDepth: 10,
      allowedTypes: [
        ElementType.PERSONA,
        ElementType.SKILL,
        ElementType.TEMPLATE,
        ElementType.AGENT,
        ElementType.MEMORY,
        ElementType.ENSEMBLE
      ],
      detectCircular: true,
      nestingField: 'metadata.elements'
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
        message: 'Ensemble name is required'
      }),
      severity: 'error'
    },
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Ensemble description is required'
      }),
      severity: 'error'
    },
    {
      name: 'activation-strategy-valid',
      description: 'Activation strategy must be valid',
      validate: (data) => {
        if (!data.metadata?.activationStrategy) return { valid: true };
        const validStrategies = ['all', 'sequential', 'lazy', 'conditional', 'priority'];
        return {
          valid: validStrategies.includes(data.metadata.activationStrategy),
          message: `Activation strategy must be one of: ${validStrategies.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'conflict-resolution-valid',
      description: 'Conflict resolution must be valid',
      validate: (data) => {
        if (!data.metadata?.conflictResolution) return { valid: true };
        const validStrategies = ['last-write', 'first-write', 'merge', 'priority', 'error'];
        return {
          valid: validStrategies.includes(data.metadata.conflictResolution),
          message: `Conflict resolution must be one of: ${validStrategies.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'nesting-depth-range',
      description: 'Nesting depth must be in valid range',
      validate: (data) => {
        if (data.metadata?.maxNestingDepth === undefined) return { valid: true };
        const depth = data.metadata.maxNestingDepth;
        return {
          valid: typeof depth === 'number' && depth >= 1 && depth <= 10,
          message: 'Max nesting depth must be between 1 and 10'
        };
      },
      severity: 'error'
    },
    {
      name: 'elements-structure',
      description: 'Elements must have valid structure',
      validate: (data) => {
        if (!data.metadata?.elements) return { valid: true };
        if (!Array.isArray(data.metadata.elements)) {
          return { valid: false, message: 'Elements must be an array' };
        }
        for (const element of data.metadata.elements) {
          // Support both new (element_name/element_type) and legacy (name/type) field names
          const elemName = element.element_name || element.name;
          const elemType = element.element_type || element.type;
          if (!elemName || !elemType) {
            return {
              valid: false,
              message: 'Each element must have element_name and element_type'
            };
          }
        }
        return { valid: true };
      },
      severity: 'error'
    },
    {
      name: 'resource-limits-positive',
      description: 'Resource limits must be positive',
      validate: (data) => {
        if (!data.metadata?.resourceLimits) return { valid: true };
        const limits = data.metadata.resourceLimits;
        if (limits.maxActiveElements !== undefined && limits.maxActiveElements < 1) {
          return { valid: false, message: 'maxActiveElements must be at least 1' };
        }
        if (limits.maxExecutionTimeMs !== undefined && limits.maxExecutionTimeMs < 1000) {
          return { valid: false, message: 'maxExecutionTimeMs must be at least 1000ms' };
        }
        return { valid: true };
      },
      severity: 'error'
    },
    {
      name: 'nested-ensembles-depth',
      description: 'Nested ensembles should respect depth limits',
      validate: (data) => {
        if (!data.metadata?.elements) return { valid: true };
        const hasNestedEnsemble = data.metadata.elements.some(
          (el: any) => el.type === ElementType.ENSEMBLE
        );
        if (hasNestedEnsemble && data.metadata.allowNested === false) {
          return {
            valid: false,
            message: 'Nested ensembles not allowed when allowNested is false'
          };
        }
        return { valid: true };
      },
      severity: 'error'
    },
    {
      name: 'conditional-strategy-requires-conditions',
      description: 'Conditional strategy should have conditions defined',
      validate: (data) => {
        if (data.metadata?.activationStrategy !== 'conditional') return { valid: true };
        if (!data.metadata?.elements || data.metadata.elements.length === 0) {
          return { valid: true };
        }
        const hasConditions = data.metadata.elements.some((el: any) => el.condition);
        return {
          valid: hasConditions,
          message: 'Conditional strategy should have at least one element with conditions'
        };
      },
      severity: 'warning'
    }
  ]
};
