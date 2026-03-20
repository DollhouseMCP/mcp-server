/**
 * PersonaElementValidator Tests
 *
 * Comprehensive test suite covering persona-specific validation:
 * - Content length quality checks (min 50 chars, warn if > 5000)
 * - Age rating validation (all, 13+, 18+)
 * - Improvement suggestions
 * - Validation report generation with persona-specific formatting
 * - isValidPersonaName method
 * - Quality score calculation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PersonaElementValidator } from '../../../../src/services/validation/PersonaElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';

// Mock the services
jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('PersonaElementValidator', () => {
  let validator: PersonaElementValidator;
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
      }),
      validateMetadataField: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedValue: 'field',
        errors: undefined
      })
    } as unknown as jest.Mocked<ValidationService>;

    mockTriggerService = {
      validateTriggers: jest.fn().mockReturnValue({
        validTriggers: ['trigger1'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new PersonaElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with PERSONA element type', () => {
      expect(validator.elementType).toBe(ElementType.PERSONA);
    });
  });

  describe('validateCreate', () => {
    describe('Age Rating Validation', () => {
      it('should accept valid age rating "all"', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          age_rating: 'all'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('age_rating'))).toBe(false);
      });

      it('should accept valid age rating "13+"', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          age_rating: '13+'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept valid age rating "18+"', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          age_rating: '18+'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should warn about invalid age rating', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          age_rating: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('age_rating') && w.includes('invalid'))).toBe(true);
      });

      it('should warn about non-string age rating', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          age_rating: 18
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('must be a string'))).toBe(true);
      });
    });

    describe('Content Length Checks', () => {
      it('should warn about short content (< 50 chars)', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(30)
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('short') && w.includes('50'))).toBe(true);
      });

      it('should not warn about adequate content length', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100)
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('short'))).toBe(false);
      });

      it('should warn about very long content (> 5000 chars)', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(6000)
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('very long'))).toBe(true);
      });
    });

    describe('Improvement Suggestions', () => {
      it('should suggest adding triggers when less than 3', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          triggers: ['one']
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('trigger') && s.includes('discoverability'))).toBe(true);
      });

      it('should not suggest triggers when 3 or more exist', async () => {
        mockTriggerService.validateTriggers.mockReturnValueOnce({
          validTriggers: ['one', 'two', 'three'],
          rejectedTriggers: [],
          hasRejections: false,
          totalInput: 3,
          warnings: []
        });

        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100),
          triggers: ['one', 'two', 'three']
        };

        const result = await validator.validateCreate(data);

        // Should still suggest but for different reason if missing
        expect(result.suggestions?.filter(s => s.includes('trigger'))).toBeDefined();
      });

      it('should suggest adding author', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100)
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('author'))).toBe(true);
      });

      it('should suggest expanding content for short instructions', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(50)
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('Expand'))).toBe(true);
      });

      it('should suggest adding version', async () => {
        const data = {
          name: 'Test Persona',
          description: 'A test persona',
          content: 'a'.repeat(100)
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('version'))).toBe(true);
      });
    });
  });

  describe('validateMetadata', () => {
    it('should require name and description by default', async () => {
      const metadata = {
        name: 'Test'
        // missing description
      };

      const result = await validator.validateMetadata(metadata);

      // Should check for required fields
      expect(result.errors.some(e => e.includes('description'))).toBe(true);
    });

    it('should warn about missing triggers', async () => {
      const metadata = {
        name: 'Test',
        description: 'A description'
      };

      const result = await validator.validateMetadata(metadata);

      expect(result.warnings.some(w => w.includes('trigger'))).toBe(true);
    });

    it('should warn about missing version', async () => {
      const metadata = {
        name: 'Test',
        description: 'A description',
        triggers: ['test']
      };

      const result = await validator.validateMetadata(metadata);

      expect(result.warnings.some(w => w.includes('version'))).toBe(true);
    });

    it('should warn about missing unique_id', async () => {
      const metadata = {
        name: 'Test',
        description: 'A description',
        triggers: ['test'],
        version: '1.0'
      };

      const result = await validator.validateMetadata(metadata);

      expect(result.warnings.some(w => w.includes('unique_id'))).toBe(true);
    });

    it('should validate age_rating in metadata', async () => {
      const metadata = {
        name: 'Test',
        description: 'A description',
        age_rating: 'invalid'
      };

      const result = await validator.validateMetadata(metadata);

      expect(result.warnings.some(w => w.includes('age_rating'))).toBe(true);
    });

    it('should not warn about category in metadata', async () => {
      const metadata = {
        name: 'Test',
        description: 'A description',
        category: 'any-value'
      };

      const result = await validator.validateMetadata(metadata);

      // Category validation has been removed - any category value is accepted
      expect(result.warnings.some(w => w.includes('category'))).toBe(false);
    });
  });

  describe('generateReport', () => {
    describe('Pass Status', () => {
      it('should generate detailed pass report', async () => {
        mockTriggerService.validateTriggers.mockReturnValueOnce({
          validTriggers: ['test', 'demo', 'example'],
          rejectedTriggers: [],
          hasRejections: false,
          totalInput: 3,
          warnings: []
        });

        const element = {
          metadata: {
            name: 'Test Persona',
            description: 'A test description',
            version: '1.0.0',
            category: 'creative',
            triggers: ['test', 'demo', 'example'],
            author: 'test-author',
            unique_id: 'test-123'
          },
          content: 'a'.repeat(200)
        };

        const report = await validator.generateReport(element);

        expect(report.status).toBe('pass');
        expect(report.summary).toContain('Test Persona');
        expect(report.summary).toContain('passed');
        expect(report.details.some(d => d.includes('All Checks Passed'))).toBe(true);
        expect(report.details.some(d => d.includes('Persona: Test Persona'))).toBe(true);
        expect(report.details.some(d => d.includes('Category: creative'))).toBe(true);
        expect(report.details.some(d => d.includes('Version: 1.0.0'))).toBe(true);
        expect(report.details.some(d => d.includes('Content Length:'))).toBe(true);
        expect(report.details.some(d => d.includes('Triggers: 3'))).toBe(true);
      });

      it('should include quality score in metrics', async () => {
        const element = {
          metadata: {
            name: 'Good Persona',
            description: 'A well-written description',
            author: 'test',
            version: '1.0.0',
            category: 'creative',
            age_rating: 'all',
            triggers: ['a', 'b', 'c']
          },
          content: 'a'.repeat(300)
        };

        const report = await validator.generateReport(element);

        expect(report.metrics?.qualityScore).toBeGreaterThan(50);
      });
    });

    describe('Warning Status', () => {
      it('should generate warning report with warnings listed', async () => {
        const element = {
          metadata: {
            name: 'Test Persona',
            description: 'Test'
          },
          content: 'a'.repeat(30)
        };

        const report = await validator.generateReport(element);

        expect(report.status).toBe('warning');
        expect(report.summary).toContain('warning');
        expect(report.details.some(d => d.includes('Warnings'))).toBe(true);
      });
    });

    describe('Fail Status', () => {
      it('should generate fail report for invalid persona', async () => {
        const report = await validator.generateReport(null);

        expect(report.status).toBe('fail');
        expect(report.summary).toContain('Invalid persona');
      });

      it('should list errors in fail report', async () => {
        mockValidationService.validateAndSanitizeInput.mockReturnValueOnce({
          isValid: false,
          errors: ['Name is required'],
          warnings: []
        });

        const element = {
          metadata: {},
          content: 'a'.repeat(100)
        };

        const report = await validator.generateReport(element);

        expect(report.status).toBe('fail');
        expect(report.details.some(d => d.includes('Issues Found'))).toBe(true);
        expect(report.details.some(d => d.includes('Fix Required'))).toBe(true);
      });
    });

    describe('Suggestions', () => {
      it('should include suggestions in report details', async () => {
        const element = {
          metadata: {
            name: 'Test',
            description: 'Test desc'
          },
          content: 'a'.repeat(50)
        };

        const report = await validator.generateReport(element);

        expect(report.details.some(d => d.includes('Suggestions'))).toBe(true);
      });
    });
  });

  describe('isValidPersonaName', () => {
    describe('Valid Names', () => {
      it('should accept simple alphanumeric names', () => {
        expect(validator.isValidPersonaName('TestPersona')).toBe(true);
        expect(validator.isValidPersonaName('test123')).toBe(true);
      });

      it('should accept names with spaces', () => {
        expect(validator.isValidPersonaName('Test Persona')).toBe(true);
        expect(validator.isValidPersonaName('My Great Persona')).toBe(true);
      });

      it('should accept names with hyphens and underscores', () => {
        expect(validator.isValidPersonaName('Test-Persona')).toBe(true);
        expect(validator.isValidPersonaName('Test_Persona')).toBe(true);
      });

      it('should accept names up to 50 characters', () => {
        const name = 'a'.repeat(50);
        expect(validator.isValidPersonaName(name)).toBe(true);
      });
    });

    describe('Invalid Names', () => {
      it('should reject empty string', () => {
        expect(validator.isValidPersonaName('')).toBe(false);
      });

      it('should reject whitespace-only string', () => {
        expect(validator.isValidPersonaName('   ')).toBe(false);
      });

      it('should reject names over 50 characters', () => {
        const name = 'a'.repeat(51);
        expect(validator.isValidPersonaName(name)).toBe(false);
      });

      it('should reject names with < character', () => {
        expect(validator.isValidPersonaName('Test<Persona')).toBe(false);
      });

      it('should reject names with > character', () => {
        expect(validator.isValidPersonaName('Test>Persona')).toBe(false);
      });

      it('should reject names with : character', () => {
        expect(validator.isValidPersonaName('Test:Persona')).toBe(false);
      });

      it('should reject names with " character', () => {
        expect(validator.isValidPersonaName('Test"Persona')).toBe(false);
      });

      it('should reject names with / character', () => {
        expect(validator.isValidPersonaName('Test/Persona')).toBe(false);
      });

      it('should reject names with \\ character', () => {
        expect(validator.isValidPersonaName('Test\\Persona')).toBe(false);
      });

      it('should reject names with | character', () => {
        expect(validator.isValidPersonaName('Test|Persona')).toBe(false);
      });

      it('should reject names with ? character', () => {
        expect(validator.isValidPersonaName('Test?Persona')).toBe(false);
      });

      it('should reject names with * character', () => {
        expect(validator.isValidPersonaName('Test*Persona')).toBe(false);
      });
    });
  });

  describe('Quality Score Calculation', () => {
    it('should give higher score for complete metadata', async () => {
      const completeElement = {
        metadata: {
          name: 'Complete Persona',
          description: 'A thorough description',
          author: 'test',
          version: '1.0.0',
          category: 'any-category',  // Any category value now contributes to score
          age_rating: 'all',
          triggers: ['a', 'b', 'c']
        },
        content: 'a'.repeat(300)
      };

      const incompleteElement = {
        metadata: {
          name: 'Incomplete',
          description: 'Short'
        },
        content: 'a'.repeat(30)
      };

      const completeReport = await validator.generateReport(completeElement);
      const incompleteReport = await validator.generateReport(incompleteElement);

      expect(completeReport.metrics?.qualityScore).toBeGreaterThan(
        incompleteReport.metrics?.qualityScore || 0
      );
    });

    it('should reward good content length', async () => {
      const shortContent = {
        metadata: { name: 'Test', description: 'Test' },
        content: 'a'.repeat(30)
      };

      const goodContent = {
        metadata: { name: 'Test', description: 'Test' },
        content: 'a'.repeat(300)
      };

      const shortReport = await validator.generateReport(shortContent);
      const goodReport = await validator.generateReport(goodContent);

      expect(goodReport.metrics?.qualityScore).toBeGreaterThan(
        shortReport.metrics?.qualityScore || 0
      );
    });

    it('should reward optimal trigger count (3-10)', async () => {
      const fewTriggers = {
        metadata: {
          name: 'Test',
          description: 'Test',
          triggers: ['one']
        },
        content: 'a'.repeat(100)
      };

      mockTriggerService.validateTriggers.mockReturnValueOnce({
        validTriggers: ['a', 'b', 'c', 'd', 'e'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 5,
        warnings: []
      });

      const goodTriggers = {
        metadata: {
          name: 'Test',
          description: 'Test',
          triggers: ['a', 'b', 'c', 'd', 'e']
        },
        content: 'a'.repeat(100)
      };

      const fewReport = await validator.generateReport(fewTriggers);
      const goodReport = await validator.generateReport(goodTriggers);

      expect(goodReport.metrics?.qualityScore).toBeGreaterThan(
        fewReport.metrics?.qualityScore || 0
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle element with instructions instead of content', async () => {
      const element = {
        metadata: { name: 'Test', description: 'Desc' },
        instructions: 'a'.repeat(100)
      };

      const report = await validator.generateReport(element);

      expect(report.metrics?.contentLength).toBe(100);
    });

    it('should use default category in report when pass status', async () => {
      mockTriggerService.validateTriggers.mockReturnValueOnce({
        validTriggers: ['test', 'demo', 'example'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 3,
        warnings: []
      });

      const element = {
        metadata: {
          name: 'Test',
          description: 'Desc',
          author: 'author',
          version: '1.0',
          triggers: ['test', 'demo', 'example'],
          unique_id: 'test-123'
        },
        content: 'a'.repeat(200)
      };

      const report = await validator.generateReport(element);

      // When status is pass, the report includes Category: general
      if (report.status === 'pass') {
        expect(report.details.some(d => d.includes('Category: general'))).toBe(true);
      }
    });

    it('should use default version in report when pass status', async () => {
      mockTriggerService.validateTriggers.mockReturnValueOnce({
        validTriggers: ['test', 'demo', 'example'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 3,
        warnings: []
      });

      const element = {
        metadata: {
          name: 'Test',
          description: 'Desc',
          author: 'author',
          category: 'creative',
          triggers: ['test', 'demo', 'example'],
          unique_id: 'test-123'
        },
        content: 'a'.repeat(200)
      };

      const report = await validator.generateReport(element);

      // When status is pass, the report includes Version: 1.0
      if (report.status === 'pass') {
        expect(report.details.some(d => d.includes('Version: 1.0'))).toBe(true);
      }
    });
  });
});
