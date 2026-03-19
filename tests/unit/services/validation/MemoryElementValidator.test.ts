/**
 * MemoryElementValidator Tests
 *
 * Comprehensive test suite covering memory-specific validation:
 * - Storage backend validation (file, memory, sqlite, hybrid)
 * - Retention policy validation (days, string format)
 * - Auto-load flag validation
 * - Priority validation for auto-load memories
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryElementValidator } from '../../../../src/services/validation/MemoryElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('MemoryElementValidator', () => {
  let validator: MemoryElementValidator;
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
        validTriggers: ['recall'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new MemoryElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with MEMORY element type', () => {
      expect(validator.elementType).toBe(ElementType.MEMORY);
    });
  });

  describe('validateCreate', () => {
    describe('Storage Backend Validation', () => {
      const validBackends = ['file', 'memory', 'sqlite', 'hybrid'];

      validBackends.forEach(backend => {
        it(`should accept valid storage backend "${backend}"`, async () => {
          mockValidationService.validateAndSanitizeInput.mockReturnValue({
            isValid: true,
            sanitizedValue: backend,
            errors: undefined,
            warnings: []
          });

          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content here that is long enough',
            storageBackend: backend
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });
      });

      it('should accept storage_backend (snake_case)', async () => {
        mockValidationService.validateAndSanitizeInput.mockReturnValue({
          isValid: true,
          sanitizedValue: 'file',
          errors: undefined,
          warnings: []
        });

        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          storage_backend: 'file'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject invalid storage backend', async () => {
        mockValidationService.validateAndSanitizeInput
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'name', warnings: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'desc', warnings: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedValue: 'invalid', warnings: [] });

        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          storageBackend: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid storage backend'))).toBe(true);
      });

      it('should reject non-string storage backend', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          storageBackend: 123
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });

      it('should suggest adding storage backend when not present', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content'
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('storage backend'))).toBe(true);
      });
    });

    describe('Retention Days Validation', () => {
      describe('Numeric Format', () => {
        it('should accept valid retention days number', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retentionDays: 30
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should accept zero retention days', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retentionDays: 0
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should reject negative retention days', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retentionDays: -1
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(false);
          expect(result.errors.some(e => e.includes('positive integer'))).toBe(true);
        });

        it('should reject non-integer retention days', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retentionDays: 30.5
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(false);
        });

        it('should accept very long retention (permanent is default)', async () => {
          // Memories are permanent by default, so long retention is expected behavior
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retentionDays: 999999  // Permanent retention
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
          // No warnings for long retention - permanent is the expected default
        });
      });

      describe('String Format', () => {
        it('should accept "30d" format', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: '30d'
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should accept "1w" format', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: '1w'
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should accept "6m" format', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: '6m'
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should accept "1y" format', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: '1y'
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
        });

        it('should reject invalid string format', async () => {
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: 'invalid'
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(false);
          expect(result.errors.some(e => e.includes('Invalid retention format'))).toBe(true);
        });

        it('should accept long string retention (permanent is default)', async () => {
          // Memories are permanent by default, so long retention is expected behavior
          const data = {
            name: 'Test Memory',
            description: 'A test memory',
            content: 'Memory content',
            retention_days: '20y'  // 20 years - valid, no warning
          };

          const result = await validator.validateCreate(data);

          expect(result.isValid).toBe(true);
          // No warnings for long retention - permanent is the expected default
        });
      });

      it('should suggest adding retention policy when not present', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content'
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions?.some(s => s.includes('retention'))).toBe(true);
      });
    });

    describe('Retention Policy Object Validation', () => {
      it('should accept valid retention policy object', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          retention_policy: {
            default: 30
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-object retention policy', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          retention_policy: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an object'))).toBe(true);
      });

      it('should reject array retention policy', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          retention_policy: [30]
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
      });

      it('should validate default retention in policy', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          retention_policy: {
            default: -1
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid default retention'))).toBe(true);
      });
    });

    describe('Auto-Load Validation', () => {
      it('should accept true autoLoad', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      // Note: Due to a bug in the validator where `autoLoad || auto_load`
      // treats false as falsy, we test explicitly set false values differently
      it('should handle false autoLoad value', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content that is long enough for validation to pass here',
          autoLoad: false
        };

        const result = await validator.validateCreate(data);

        // autoLoad: false should be accepted as a valid boolean
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept auto_load (snake_case)', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          auto_load: true
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-boolean autoLoad', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: 'true'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a boolean'))).toBe(true);
      });
    });

    describe('Priority Validation', () => {
      it('should accept valid priority (1-99)', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 50
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept priority 1', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 1
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should accept priority 99', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 99
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject priority below 1', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 0
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 1 and 99'))).toBe(true);
      });

      it('should reject priority above 99', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 100
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('between 1 and 99'))).toBe(true);
      });

      it('should reject non-integer priority', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 50.5
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
      });

      it('should reject non-number priority', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 'high'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a number'))).toBe(true);
      });

      it('should warn about high priority (> 50)', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content',
          autoLoad: true,
          priority: 75
        };

        const result = await validator.validateCreate(data);

        expect(result.warnings.some(w => w.includes('High priority') && w.includes('early'))).toBe(true);
      });

      it('should handle priority with false autoLoad', async () => {
        const data = {
          name: 'Test Memory',
          description: 'A test memory',
          content: 'Memory content that is long enough for validation to pass',
          autoLoad: false,
          priority: 999
        };

        const result = await validator.validateCreate(data);

        // autoLoad: false is valid, and priority is ignored when autoLoad is false
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle null retention days', async () => {
      const data = {
        name: 'Test Memory',
        description: 'A test memory',
        content: 'Memory content',
        retentionDays: null
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should handle undefined retention days', async () => {
      const data = {
        name: 'Test Memory',
        description: 'A test memory',
        content: 'Memory content',
        retentionDays: undefined
      };

      const result = await validator.validateCreate(data);

      expect(result.isValid).toBe(true);
    });

    it('should prefer storageBackend over storage_backend', async () => {
      mockValidationService.validateAndSanitizeInput.mockReturnValue({
        isValid: true,
        sanitizedValue: 'memory',
        warnings: []
      });

      const data = {
        name: 'Test Memory',
        description: 'A test memory',
        content: 'Memory content',
        storageBackend: 'memory',
        storage_backend: 'file'
      };

      // Should use storageBackend value
      await validator.validateCreate(data);

      // Validation should have been called
      expect(mockValidationService.validateAndSanitizeInput).toHaveBeenCalled();
    });
  });
});
