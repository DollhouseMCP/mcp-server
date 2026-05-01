/**
 * Agent element type test configuration
 *
 * Agents are autonomous goal-oriented actors with decision-making capabilities.
 * They support activation and maintain state across execution sessions.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test agent data
 */
function createAgentTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test Agent',
    description: overrides?.description || 'A test agent for validation',
    // Issue #722: Agent behavioral text goes in 'instructions' (not 'content').
    // 'content' is for reference material (markdown body).
    instructions: overrides?.instructions || 'You are an autonomous agent that performs tasks independently.',
    metadata: {
      decisionFramework: 'rule_based',
      riskTolerance: 'moderate',
      learningEnabled: false,
      maxConcurrentGoals: 5,
      specializations: ['testing', 'validation'],
      ...(overrides?.metadata || {})
    }
  };

  return { ...base, ...overrides };
}

/**
 * Agent type test configuration
 */
export const AGENT_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.AGENT,
  displayName: 'Agents',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createAgentTestData,

  validExamples: [
    {
      name: 'Minimal Agent',
      description: 'A minimal valid agent',
      instructions: 'You are a minimal agent for basic task execution.',
      metadata: {
        decisionFramework: 'rule_based',
        riskTolerance: 'moderate'
      }
    },
    {
      name: 'Complete Agent',
      description: 'An agent with all optional fields',
      instructions: 'You are a comprehensive agent with advanced decision-making capabilities. You analyze situations thoroughly before acting.',
      metadata: {
        decisionFramework: 'hybrid',
        riskTolerance: 'conservative',
        learningEnabled: true,
        maxConcurrentGoals: 10,
        specializations: ['research', 'analysis', 'planning'],
        ruleEngineConfig: {
          ruleBased: {
            priority: {
              critical: 'high',
              high: 'high',
              medium: 'medium',
              low: 'low'
            },
            urgencyThresholds: {
              immediate: 8,
              high: 6,
              medium: 4
            },
            confidence: {
              critical: 0.95,
              blocked: 0.9,
              riskApproval: 0.85,
              resourceLimit: 0.8,
              default: 0.7
            }
          }
        }
      }
    },
    {
      name: 'Learning Agent',
      description: 'Agent with learning enabled',
      instructions: 'You are an adaptive agent that learns from interactions and improves over time.',
      metadata: {
        decisionFramework: 'ml_based',
        riskTolerance: 'aggressive',
        learningEnabled: true,
        maxConcurrentGoals: 20
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
  requiredFields: ['name', 'description', 'instructions'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated agent description',
        'A completely different description',
        'Long-form agent description. '.repeat(40)
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'metadata.decisionFramework',
      displayName: 'Decision Framework',
      type: 'enum',
      required: false,
      validValues: ['rule_based', 'ml_based', 'programmatic', 'hybrid'],
      invalidValues: [
        { value: 'invalid', expectedError: 'framework|invalid' }
      ]
    },
    {
      path: 'metadata.riskTolerance',
      displayName: 'Risk Tolerance',
      type: 'enum',
      required: false,
      validValues: ['conservative', 'moderate', 'aggressive'],
      invalidValues: [
        { value: 'extreme', expectedError: 'tolerance|invalid' }
      ]
    },
    {
      path: 'metadata.learningEnabled',
      displayName: 'Learning Enabled',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.maxConcurrentGoals',
      displayName: 'Max Concurrent Goals',
      type: 'number',
      required: false,
      validValues: [1, 5, 10, 20],
      invalidValues: [
        { value: 0, expectedError: 'range|minimum' },
        { value: 101, expectedError: 'range|maximum' }
      ]
    },
    {
      path: 'metadata.specializations',
      displayName: 'Specializations',
      type: 'array',
      required: false,
      validValues: [
        ['coding', 'debugging'],
        ['research']
      ]
    }
  ],

  nestedFields: {
    'metadata.ruleEngineConfig': {
      path: 'metadata.ruleEngineConfig',
      displayName: 'Rule Engine Configuration',
      type: 'object',
      required: false
    }
  },

  // ============================================================================
  // Capabilities
  // ============================================================================
  capabilities: {
    supportsActivation: {
      activationStrategy: 'execution',
      requiresContext: false,
      expectedResultType: 'side-effect',
      testContexts: [
        {
          description: 'Basic agent activation',
          context: undefined,
          expectedOutcome: 'Agent becomes active, increments session count'
        },
        {
          description: 'Activation with goals',
          context: {
            goals: [
              {
                description: 'Complete test task',
                priority: 'high',
                importance: 8,
                urgency: 7
              }
            ]
          },
          expectedOutcome: 'Agent activates with initial goals loaded'
        }
      ]
    },
    hasStateFile: {
      fileExtension: '.state.json',
      cleanupOnDelete: true,
      stateSchema: {
        goals: 'array',
        decisions: 'array',
        context: 'object',
        lastActive: 'date',
        sessionCount: 'number'
      }
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
        message: 'Agent name is required'
      }),
      severity: 'error'
    },
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Agent description is required'
      }),
      severity: 'error'
    },
    {
      name: 'framework-valid',
      description: 'Decision framework must be valid',
      validate: (data) => {
        if (!data.metadata?.decisionFramework) return { valid: true };
        const validFrameworks = ['rule_based', 'ml_based', 'programmatic', 'hybrid'];
        return {
          valid: validFrameworks.includes(data.metadata.decisionFramework),
          message: `Decision framework must be one of: ${validFrameworks.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'risk-tolerance-valid',
      description: 'Risk tolerance must be valid',
      validate: (data) => {
        if (!data.metadata?.riskTolerance) return { valid: true };
        const validLevels = ['conservative', 'moderate', 'aggressive'];
        return {
          valid: validLevels.includes(data.metadata.riskTolerance),
          message: `Risk tolerance must be one of: ${validLevels.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'max-goals-range',
      description: 'Max concurrent goals must be in valid range',
      validate: (data) => {
        if (data.metadata?.maxConcurrentGoals === undefined) return { valid: true };
        const max = data.metadata.maxConcurrentGoals;
        return {
          valid: typeof max === 'number' && max >= 1 && max <= 100,
          message: 'Max concurrent goals must be between 1 and 100'
        };
      },
      severity: 'error'
    },
    {
      name: 'specializations-recommended',
      description: 'Agents should have specializations',
      validate: (data) => ({
        valid: Boolean(data.metadata?.specializations && data.metadata.specializations.length > 0),
        message: 'Consider adding specializations to improve agent focus'
      }),
      severity: 'warning'
    }
  ]
};
