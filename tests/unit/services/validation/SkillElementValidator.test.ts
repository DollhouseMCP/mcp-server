/**
 * SkillElementValidator Tests
 *
 * Comprehensive test suite covering skill-specific validation:
 * - Complexity enum validation
 * - Proficiency level range validation
 * - Languages and domains array validation
 * - Parameters array validation with type-specific rules
 * - Examples array validation
 * - Version semver format validation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SkillElementValidator } from '../../../../src/services/validation/SkillElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('SkillElementValidator', () => {
  let validator: SkillElementValidator;
  let mockValidationService: jest.Mocked<ValidationService>;
  let mockTriggerService: jest.Mocked<TriggerValidationService>;
  let mockMetadataService: jest.Mocked<MetadataService>;

  const validSkillData = {
    name: 'Test Skill',
    description: 'A test skill for validation',
    content: 'Skill instructions content that is long enough for validation checks',
  };

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
        validTriggers: ['skill'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new SkillElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with SKILL element type', () => {
      expect(validator.elementType).toBe(ElementType.SKILL);
    });
  });

  describe('validateCreate', () => {
    describe('Complexity Validation', () => {
      const validComplexities = ['beginner', 'intermediate', 'advanced', 'expert'];

      validComplexities.forEach(complexity => {
        it(`should accept valid complexity "${complexity}"`, async () => {
          const data = {
            ...validSkillData,
            complexity,
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });
      });

      it('should reject invalid complexity string', async () => {
        const data = {
          ...validSkillData,
          complexity: 'legendary',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid complexity'))).toBe(true);
      });

      it('should reject non-string complexity', async () => {
        const data = {
          ...validSkillData,
          complexity: 42,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Proficiency Level Validation', () => {
      it('should accept proficiency level 0', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: 0,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept proficiency level 50', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: 50,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept proficiency level 100', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: 100,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject negative proficiency level', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: -1,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 0 and 100'))).toBe(true);
      });

      it('should reject proficiency level greater than 100', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: 101,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 0 and 100'))).toBe(true);
      });

      it('should reject non-number proficiency level', async () => {
        const data = {
          ...validSkillData,
          proficiency_level: 'high',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a number'))).toBe(true);
      });
    });

    describe('Languages Validation', () => {
      it('should accept valid string array', async () => {
        const data = {
          ...validSkillData,
          languages: ['typescript', 'python', 'go'],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-array languages', async () => {
        const data = {
          ...validSkillData,
          languages: 'typescript',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('languages') && e.includes('must be an array'))).toBe(true);
      });
    });

    describe('Domains Validation', () => {
      it('should accept valid string array', async () => {
        const data = {
          ...validSkillData,
          domains: ['web-dev', 'data-science'],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-array domains', async () => {
        const data = {
          ...validSkillData,
          domains: 'web-dev',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('domains') && e.includes('must be an array'))).toBe(true);
      });

      it('should not warn when domains array is empty (handled by Skill.validate())', async () => {
        const data = {
          ...validSkillData,
          domains: [],
        };

        const result = await validator.validateCreate(data);

        // Empty domains warning is emitted by Skill.validate(), not the validator
        expect(result.warnings.some(w => w.includes('empty domains'))).toBe(false);
      });
    });

    describe('Parameters Array Validation', () => {
      it('should accept valid parameters array', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              name: 'format',
              type: 'string',
              description: 'Output format',
            },
            {
              name: 'count',
              type: 'number',
              description: 'Number of results',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject parameter missing name', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              type: 'string',
              description: 'Missing name parameter',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'name'"))).toBe(true);
      });

      it('should reject parameter missing type', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              name: 'format',
              description: 'Missing type parameter',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'type'"))).toBe(true);
      });

      it('should reject parameter with invalid type', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              name: 'format',
              type: 'object',
              description: 'Invalid type parameter',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid type'))).toBe(true);
      });

      it('should reject enum parameter without options', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              name: 'format',
              type: 'enum',
              description: 'Enum without options',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('enum') && e.includes('options'))).toBe(true);
      });

      it('should accept enum parameter with valid options', async () => {
        const data = {
          ...validSkillData,
          parameters: [
            {
              name: 'format',
              type: 'enum',
              description: 'Output format',
              options: ['json', 'yaml', 'xml'],
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });
    });

    describe('Examples Array Validation', () => {
      it('should accept valid examples array', async () => {
        const data = {
          ...validSkillData,
          examples: [
            {
              title: 'Basic Usage',
              description: 'How to use this skill in a simple scenario',
            },
            {
              title: 'Advanced Usage',
              description: 'How to use this skill with custom parameters',
              input: { format: 'json' },
              output: { result: 'success' },
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject example missing title', async () => {
        const data = {
          ...validSkillData,
          examples: [
            {
              description: 'Example without a title',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'title'"))).toBe(true);
      });

      it('should reject example missing description', async () => {
        const data = {
          ...validSkillData,
          examples: [
            {
              title: 'Example Without Description',
            },
          ],
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'description'"))).toBe(true);
      });

      it('should not warn when examples array is empty (handled by Skill.validate())', async () => {
        const data = {
          ...validSkillData,
          examples: [],
        };

        const result = await validator.validateCreate(data);

        // Empty examples warning is emitted by Skill.validate(), not the validator
        expect(result.warnings.some(w => w.includes('empty examples'))).toBe(false);
      });
    });

    describe('Version Validation', () => {
      it('should accept valid semver version', async () => {
        const data = {
          ...validSkillData,
          version: '1.0.0',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept semver with prerelease tag', async () => {
        const data = {
          ...validSkillData,
          version: '2.1.0-beta.1',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid version string', async () => {
        const data = {
          ...validSkillData,
          version: 'not-a-version',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('not valid semver'))).toBe(true);
      });

      it('should reject non-string version', async () => {
        const data = {
          ...validSkillData,
          version: 1,
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Integration / Edge Cases', () => {
      it('should pass when all valid fields are provided together', async () => {
        const data = {
          ...validSkillData,
          complexity: 'advanced',
          proficiency_level: 75,
          languages: ['typescript', 'python'],
          domains: ['web-dev', 'automation'],
          parameters: [
            {
              name: 'output',
              type: 'enum',
              description: 'Output format',
              options: ['json', 'yaml'],
            },
          ],
          examples: [
            {
              title: 'Basic Example',
              description: 'A simple usage example',
            },
          ],
          version: '1.2.3',
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should pass with minimal valid skill data', async () => {
        const result = await validator.validateCreate(validSkillData);

        expect(result.isValid).toBe(true);
      });
    });
  });

  describe('validateMetadata', () => {
    const validMetadata = {
      name: 'Test Skill',
      description: 'A test skill for validation',
    };

    describe('Basic Metadata Validation', () => {
      it('should pass with valid minimal metadata', async () => {
        const result = await validator.validateMetadata(validMetadata);

        expect(result.isValid).toBe(true);
      });

      it('should require name field', async () => {
        const metadata = {
          description: 'Missing name',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('name'))).toBe(true);
      });

      it('should require description field', async () => {
        const metadata = {
          name: 'Test Skill',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('description'))).toBe(true);
      });
    });

    describe('Complexity Validation in Metadata', () => {
      it('should accept valid complexity in metadata', async () => {
        const metadata = {
          ...validMetadata,
          complexity: 'intermediate',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid complexity in metadata', async () => {
        const metadata = {
          ...validMetadata,
          complexity: 'master',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid complexity'))).toBe(true);
      });

      it('should reject non-string complexity in metadata', async () => {
        const metadata = {
          ...validMetadata,
          complexity: 3,
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Proficiency Level Validation in Metadata', () => {
      it('should accept valid proficiency_level in metadata', async () => {
        const metadata = {
          ...validMetadata,
          proficiency_level: 80,
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject negative proficiency_level in metadata', async () => {
        const metadata = {
          ...validMetadata,
          proficiency_level: -5,
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 0 and 100'))).toBe(true);
      });

      it('should reject proficiency_level over 100 in metadata', async () => {
        const metadata = {
          ...validMetadata,
          proficiency_level: 150,
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 0 and 100'))).toBe(true);
      });

      it('should reject non-number proficiency_level in metadata', async () => {
        const metadata = {
          ...validMetadata,
          proficiency_level: 'expert',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a number'))).toBe(true);
      });
    });

    describe('Languages Validation in Metadata', () => {
      it('should accept valid languages array in metadata', async () => {
        const metadata = {
          ...validMetadata,
          languages: ['javascript', 'rust', 'go'],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-array languages in metadata', async () => {
        const metadata = {
          ...validMetadata,
          languages: 'javascript',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('languages') && e.includes('must be an array'))).toBe(true);
      });

      it('should reject languages with non-string elements in metadata', async () => {
        const metadata = {
          ...validMetadata,
          languages: ['javascript', 42, 'python'],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('languages[1]') && e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Domains Validation in Metadata', () => {
      it('should accept valid domains array in metadata', async () => {
        const metadata = {
          ...validMetadata,
          domains: ['automation', 'data-processing'],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-array domains in metadata', async () => {
        const metadata = {
          ...validMetadata,
          domains: 'automation',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('domains') && e.includes('must be an array'))).toBe(true);
      });

      it('should not warn about empty domains array in metadata (handled by Skill.validate())', async () => {
        const metadata = {
          ...validMetadata,
          domains: [],
        };

        const result = await validator.validateMetadata(metadata);

        // Empty domains warning is emitted by Skill.validate(), not the validator
        expect(result.warnings.some(w => w.includes('empty domains'))).toBe(false);
      });
    });

    describe('Parameters Validation in Metadata', () => {
      it('should accept valid parameters array in metadata', async () => {
        const metadata = {
          ...validMetadata,
          parameters: [
            {
              name: 'timeout',
              type: 'number',
              description: 'Timeout in milliseconds',
            },
            {
              name: 'mode',
              type: 'enum',
              description: 'Operation mode',
              options: ['fast', 'normal', 'thorough'],
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject parameter missing name in metadata', async () => {
        const metadata = {
          ...validMetadata,
          parameters: [
            {
              type: 'string',
              description: 'Missing name',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'name'"))).toBe(true);
      });

      it('should reject parameter missing type in metadata', async () => {
        const metadata = {
          ...validMetadata,
          parameters: [
            {
              name: 'param1',
              description: 'Missing type',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'type'"))).toBe(true);
      });

      it('should reject parameter with invalid type in metadata', async () => {
        const metadata = {
          ...validMetadata,
          parameters: [
            {
              name: 'param1',
              type: 'array',
              description: 'Invalid type',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid type'))).toBe(true);
      });

      it('should reject enum parameter without options in metadata', async () => {
        const metadata = {
          ...validMetadata,
          parameters: [
            {
              name: 'mode',
              type: 'enum',
              description: 'Operation mode',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('enum') && e.includes('options'))).toBe(true);
      });
    });

    describe('Examples Validation in Metadata', () => {
      it('should accept valid examples array in metadata', async () => {
        const metadata = {
          ...validMetadata,
          examples: [
            {
              title: 'Quick Start',
              description: 'Getting started with this skill',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject example missing title in metadata', async () => {
        const metadata = {
          ...validMetadata,
          examples: [
            {
              description: 'Example without title',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'title'"))).toBe(true);
      });

      it('should reject example missing description in metadata', async () => {
        const metadata = {
          ...validMetadata,
          examples: [
            {
              title: 'Example Title',
            },
          ],
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required") && e.includes("'description'"))).toBe(true);
      });

      it('should not warn about empty examples array in metadata (handled by Skill.validate())', async () => {
        const metadata = {
          ...validMetadata,
          examples: [],
        };

        const result = await validator.validateMetadata(metadata);

        // Empty examples warning is emitted by Skill.validate(), not the validator
        expect(result.warnings.some(w => w.includes('empty examples'))).toBe(false);
      });
    });

    describe('Version Validation in Metadata', () => {
      it('should accept valid semver version in metadata', async () => {
        const metadata = {
          ...validMetadata,
          version: '2.1.0',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should accept semver with prerelease in metadata', async () => {
        const metadata = {
          ...validMetadata,
          version: '3.0.0-alpha.2',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid version format in metadata', async () => {
        const metadata = {
          ...validMetadata,
          version: 'v1.0',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('not valid semver'))).toBe(true);
      });

      it('should reject non-string version in metadata', async () => {
        const metadata = {
          ...validMetadata,
          version: 2,
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });
    });

    describe('Integration / All Fields in Metadata', () => {
      it('should pass with all valid skill-specific fields in metadata', async () => {
        const metadata = {
          ...validMetadata,
          complexity: 'expert',
          proficiency_level: 95,
          languages: ['typescript', 'rust'],
          domains: ['systems-programming', 'performance'],
          parameters: [
            {
              name: 'optimization',
              type: 'enum',
              description: 'Optimization level',
              options: ['none', 'basic', 'aggressive'],
            },
          ],
          examples: [
            {
              title: 'Performance Tuning',
              description: 'How to optimize with this skill',
            },
          ],
          version: '3.2.1',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accumulate multiple errors across different fields', async () => {
        const metadata = {
          ...validMetadata,
          complexity: 'ultra',
          proficiency_level: 200,
          languages: 'not-an-array',
          version: 'bad-version',
        };

        const result = await validator.validateMetadata(metadata);

        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(3);
      });
    });
  });
});
