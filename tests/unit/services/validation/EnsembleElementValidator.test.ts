/**
 * EnsembleElementValidator Tests
 *
 * Comprehensive test suite covering ensemble-specific validation:
 * - Activation strategy validation
 * - Conflict resolution validation
 * - Context sharing validation
 * - Element array validation with type checking
 * - Circular dependency detection
 * - Nested ensemble validation
 * - Resource limits validation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { EnsembleElementValidator } from '../../../../src/services/validation/EnsembleElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('EnsembleElementValidator', () => {
  let validator: EnsembleElementValidator;
  let mockValidationService: jest.Mocked<ValidationService>;
  let mockTriggerService: jest.Mocked<TriggerValidationService>;
  let mockMetadataService: jest.Mocked<MetadataService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockValidationService = {
      validateAndSanitizeInput: jest.fn().mockImplementation(() => ({
        isValid: true,
        sanitizedValue: 'sanitized',
        errors: undefined,
        warnings: []
      })),
      validateContent: jest.fn().mockImplementation(() => ({
        isValid: true,
        sanitizedContent: 'content',
        detectedPatterns: []
      })),
      validateCategory: jest.fn().mockImplementation(() => ({
        isValid: true,
        sanitizedValue: 'creative',
        errors: undefined
      }))
    } as unknown as jest.Mocked<ValidationService>;

    mockTriggerService = {
      validateTriggers: jest.fn().mockReturnValue({
        validTriggers: ['ensemble'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new EnsembleElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with ENSEMBLE element type', () => {
      expect(validator.elementType).toBe(ElementType.ENSEMBLE);
    });
  });

  describe('validateCreate', () => {
    describe('Activation Strategy Validation', () => {
      // Valid strategies: 'all', 'sequential', 'lazy', 'conditional', 'priority'
      const validStrategies = ['sequential', 'conditional', 'priority'];

      validStrategies.forEach(strategy => {
        it(`should accept valid activation strategy "${strategy}"`, async () => {
          const data = {
            name: 'Test Ensemble',
            description: 'A test ensemble',
            content: 'Ensemble content here that is long enough for validation',
            activationStrategy: strategy,
            elements: [
              { element_name: 'elem1', element_type: 'personas' }
            ]
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });
      });

      it('should reject invalid activation strategy', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          activationStrategy: 'invalid',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid activation strategy'))).toBe(true);
      });

      it('should reject non-string activation strategy', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          activationStrategy: 123,
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Conflict Resolution Validation', () => {
      // Valid resolutions: 'last-write', 'first-write', 'priority', 'merge', 'error'
      const validResolutions = ['last-write', 'first-write', 'merge', 'priority'];

      validResolutions.forEach(resolution => {
        it(`should accept valid conflict resolution "${resolution}"`, async () => {
          const data = {
            name: 'Test Ensemble',
            description: 'A test ensemble',
            content: 'Ensemble content that is long enough for validation',
            conflictResolution: resolution,
            elements: []
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });
      });

      it('should reject invalid conflict resolution', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          conflictResolution: 'invalid',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid conflict resolution'))).toBe(true);
      });

      it('should suggest adding conflict resolution when not present', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('conflict resolution'))).toBe(true);
      });
    });

    describe('Context Sharing Validation', () => {
      const validModes = ['none', 'selective', 'full'];

      validModes.forEach(mode => {
        it(`should accept valid context sharing mode "${mode}"`, async () => {
          const data = {
            name: 'Test Ensemble',
            description: 'A test ensemble',
            content: 'Ensemble content',
            contextSharing: mode,
            elements: []
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });
      });

      it('should reject invalid context sharing mode', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          contextSharing: 'invalid',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid context sharing'))).toBe(true);
      });
    });

    describe('Elements Array Validation', () => {
      it('should accept valid elements array', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'persona1', element_type: 'personas' },
            { element_name: 'skill1', element_type: 'skills' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should warn about empty elements array', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('no elements'))).toBe(true);
      });

      it('should warn about missing elements', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content'
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('no elements'))).toBe(true);
      });

      it('should reject non-array elements', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: 'not-array'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an array'))).toBe(true);
      });

      it('should reject elements without name', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_type: 'personas' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('missing required') && e.includes('element_name'))).toBe(true);
      });

      it('should reject elements without type', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('missing required') && e.includes('element_type'))).toBe(true);
      });

      it('should reject invalid element type', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'invalid-type' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid type'))).toBe(true);
      });

      it('should reject duplicate element names', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'same-name', element_type: 'personas' },
            { element_name: 'same-name', element_type: 'skills' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Duplicate element name'))).toBe(true);
      });

      it('should reject non-object elements in array', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: ['invalid', 123]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an object'))).toBe(true);
      });

      it('should reject too many elements', async () => {
        const elements = Array.from({ length: 60 }, (_, i) => ({
          element_name: `elem${i}`,
          element_type: 'personas'
        }));

        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('cannot have more than'))).toBe(true);
      });
    });

    describe('Nested Ensemble Validation', () => {
      it('should reject nested ensemble when not allowed', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'nested', element_type: 'ensembles' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('not allowed'))).toBe(true);
      });

      it('should accept nested ensemble when allowed', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          allowNested: true,
          elements: [
            { element_name: 'nested', element_type: 'ensembles' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should handle maxNestingDepth when set to 0', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content that is long enough',
          allowNested: true,
          maxNestingDepth: 0,
          elements: [
            { element_name: 'nested', element_type: 'ensembles' }
          ]
        };

        const result = await validator.validateCreate(data);

        // maxNestingDepth: 0 means no nesting allowed, but we have nested ensembles
        // This should fail because nested ensembles exceed the depth limit of 0
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.toLowerCase().includes('depth') || e.toLowerCase().includes('nesting'))).toBe(true);
      });
    });

    describe('Element Role Validation', () => {
      it('should accept valid element role', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'personas', role: 'primary' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid element role', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'personas', role: 'invalid-role' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid role'))).toBe(true);
      });
    });

    describe('Element Activation Mode Validation', () => {
      it('should accept valid activation mode', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'personas', activation: 'always' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid activation mode', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'personas', activation: 'invalid-mode' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid activation'))).toBe(true);
      });

      it('should require condition when activation is conditional', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'elem1', element_type: 'personas', activation: 'conditional' }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('no condition specified'))).toBe(true);
      });

      it('should accept conditional activation with condition', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            {
              element_name: 'elem1',
              element_type: 'personas',
              activation: 'conditional',
              condition: 'trigger === "test"'
            }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });
    });

    describe('Dependency Validation', () => {
      it('should warn about unknown dependencies', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            {
              element_name: 'elem1',
              element_type: 'personas',
              dependencies: ['unknown-element']
            }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes("depends on unknown"))).toBe(true);
      });

      it('should reject too many dependencies', async () => {
        const dependencies = Array.from({ length: 15 }, (_, i) => `dep${i}`);

        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            {
              element_name: 'elem1',
              element_type: 'personas',
              dependencies
            }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('too many dependencies'))).toBe(true);
      });
    });

    describe('Circular Dependency Detection', () => {
      it('should detect simple circular dependency', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'a', element_type: 'personas', dependencies: ['b'] },
            { element_name: 'b', element_type: 'personas', dependencies: ['a'] }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Circular dependencies'))).toBe(true);
      });

      it('should detect complex circular dependency', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'a', element_type: 'personas', dependencies: ['b'] },
            { element_name: 'b', element_type: 'personas', dependencies: ['c'] },
            { element_name: 'c', element_type: 'personas', dependencies: ['a'] }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Circular dependencies'))).toBe(true);
      });

      it('should accept valid non-circular dependencies', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          elements: [
            { element_name: 'a', element_type: 'personas' },
            { element_name: 'b', element_type: 'personas', dependencies: ['a'] },
            { element_name: 'c', element_type: 'personas', dependencies: ['a', 'b'] }
          ]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });
    });

    describe('Resource Limits Validation', () => {
      it('should accept valid resource limits', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: {
            memoryMB: 512,
            executionTimeMs: 30000,
            maxConcurrent: 5
          },
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-object resource limits', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: 'invalid',
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an object'))).toBe(true);
      });

      it('should reject negative memory limit', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: {
            memoryMB: -1
          },
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Memory limit must be a positive'))).toBe(true);
      });

      it('should warn about high memory limit', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: {
            memoryMB: 2048
          },
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('High memory limit'))).toBe(true);
      });

      it('should warn about long execution time', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: {
            executionTimeMs: 120000
          },
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('execution time limit'))).toBe(true);
      });

      it('should warn about high concurrent limit', async () => {
        const data = {
          name: 'Test Ensemble',
          description: 'A test ensemble',
          content: 'Ensemble content',
          resourceLimits: {
            maxConcurrent: 20
          },
          elements: []
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('concurrent limit'))).toBe(true);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should accept snake_case field names', async () => {
      const data = {
        name: 'Test Ensemble',
        description: 'A test ensemble',
        content: 'Ensemble content that is long enough for validation',
        activation_strategy: 'sequential',
        conflict_resolution: 'last-write',
        context_sharing: 'full',
        elements: []
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should handle all valid element types', async () => {
      const types = ['personas', 'skills', 'templates', 'agents', 'memories'];

      const elements = types.map((type, i) => ({
        element_name: `elem${i}`,
        element_type: type
      }));

      const data = {
        name: 'Test Ensemble',
        description: 'A test ensemble',
        content: 'Ensemble content',
        elements
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });
  });
});
