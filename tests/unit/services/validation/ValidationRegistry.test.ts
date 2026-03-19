/**
 * ValidationRegistry Tests
 *
 * Comprehensive test suite covering:
 * - Registry initialization with default validators
 * - Getting validators for different element types
 * - Custom validator registration
 * - Service accessors
 * - Generic validator fallback behavior
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { PersonaElementValidator } from '../../../../src/services/validation/PersonaElementValidator.js';
import { TemplateElementValidator } from '../../../../src/services/validation/TemplateElementValidator.js';
import { MemoryElementValidator } from '../../../../src/services/validation/MemoryElementValidator.js';
import { EnsembleElementValidator } from '../../../../src/services/validation/EnsembleElementValidator.js';
import { AgentElementValidator } from '../../../../src/services/validation/AgentElementValidator.js';
import { GenericElementValidator } from '../../../../src/services/validation/GenericElementValidator.js';
import type { ElementValidator } from '../../../../src/services/validation/ElementValidator.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');
jest.mock('../../../../src/utils/logger.js');

describe('ValidationRegistry', () => {
  let registry: ValidationRegistry;
  let mockValidationService: jest.Mocked<ValidationService>;
  let mockTriggerService: jest.Mocked<TriggerValidationService>;
  let mockMetadataService: jest.Mocked<MetadataService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockValidationService = {} as jest.Mocked<ValidationService>;
    mockTriggerService = {} as jest.Mocked<TriggerValidationService>;
    mockMetadataService = {} as jest.Mocked<MetadataService>;

    registry = new ValidationRegistry(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor and Initialization', () => {
    it('should initialize successfully', () => {
      expect(registry).toBeInstanceOf(ValidationRegistry);
    });

    it('should register default validators during initialization', () => {
      expect(registry.hasSpecializedValidator(ElementType.PERSONA)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.TEMPLATE)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.MEMORY)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.ENSEMBLE)).toBe(true);
    });

    it('should register specialized validator for SKILL', () => {
      expect(registry.hasSpecializedValidator(ElementType.SKILL)).toBe(true);
    });

    it('should register specialized validator for AGENT', () => {
      expect(registry.hasSpecializedValidator(ElementType.AGENT)).toBe(true);
    });
  });

  describe('getValidator', () => {
    describe('Specialized Validators', () => {
      it('should return PersonaElementValidator for PERSONA type', () => {
        const validator = registry.getValidator(ElementType.PERSONA);

        expect(validator).toBeInstanceOf(PersonaElementValidator);
        expect(validator.elementType).toBe(ElementType.PERSONA);
      });

      it('should return TemplateElementValidator for TEMPLATE type', () => {
        const validator = registry.getValidator(ElementType.TEMPLATE);

        expect(validator).toBeInstanceOf(TemplateElementValidator);
        expect(validator.elementType).toBe(ElementType.TEMPLATE);
      });

      it('should return MemoryElementValidator for MEMORY type', () => {
        const validator = registry.getValidator(ElementType.MEMORY);

        expect(validator).toBeInstanceOf(MemoryElementValidator);
        expect(validator.elementType).toBe(ElementType.MEMORY);
      });

      it('should return EnsembleElementValidator for ENSEMBLE type', () => {
        const validator = registry.getValidator(ElementType.ENSEMBLE);

        expect(validator).toBeInstanceOf(EnsembleElementValidator);
        expect(validator.elementType).toBe(ElementType.ENSEMBLE);
      });

      it('should return AgentElementValidator for AGENT type', () => {
        const validator = registry.getValidator(ElementType.AGENT);

        expect(validator).toBeInstanceOf(AgentElementValidator);
        expect(validator.elementType).toBe(ElementType.AGENT);
      });
    });

    describe('Generic Validator Fallback', () => {
      it('should return GenericElementValidator for SKILL type', () => {
        const validator = registry.getValidator(ElementType.SKILL);

        expect(validator).toBeInstanceOf(GenericElementValidator);
        expect(validator.elementType).toBe(ElementType.SKILL);
      });

      it('should cache and reuse generic validators', () => {
        const validator1 = registry.getValidator(ElementType.SKILL);
        const validator2 = registry.getValidator(ElementType.SKILL);

        expect(validator1).toBe(validator2);
      });

      it('should create separate generic validators for different types', () => {
        const skillValidator = registry.getValidator(ElementType.SKILL);
        const agentValidator = registry.getValidator(ElementType.AGENT);

        expect(skillValidator).not.toBe(agentValidator);
        expect(skillValidator.elementType).toBe(ElementType.SKILL);
        expect(agentValidator.elementType).toBe(ElementType.AGENT);
      });
    });
  });

  describe('registerValidator', () => {
    it('should register a custom validator for an element type', () => {
      const customValidator: ElementValidator = {
        elementType: ElementType.SKILL,
        validateCreate: jest.fn(),
        validateEdit: jest.fn(),
        validateMetadata: jest.fn(),
        generateReport: jest.fn()
      };

      registry.registerValidator(ElementType.SKILL, customValidator);

      const validator = registry.getValidator(ElementType.SKILL);
      expect(validator).toBe(customValidator);
    });

    it('should override existing specialized validator', () => {
      const customValidator: ElementValidator = {
        elementType: ElementType.PERSONA,
        validateCreate: jest.fn(),
        validateEdit: jest.fn(),
        validateMetadata: jest.fn(),
        generateReport: jest.fn()
      };

      registry.registerValidator(ElementType.PERSONA, customValidator);

      const validator = registry.getValidator(ElementType.PERSONA);
      expect(validator).toBe(customValidator);
      expect(validator).not.toBeInstanceOf(PersonaElementValidator);
    });

    it('should allow overriding registered validators with custom ones', () => {
      const customValidator: ElementValidator = {
        elementType: ElementType.SKILL,
        validateCreate: jest.fn(),
        validateEdit: jest.fn(),
        validateMetadata: jest.fn(),
        generateReport: jest.fn()
      };

      // SKILL already has a specialized validator
      expect(registry.hasSpecializedValidator(ElementType.SKILL)).toBe(true);

      registry.registerValidator(ElementType.SKILL, customValidator);

      // After registration, should use the custom validator
      expect(registry.hasSpecializedValidator(ElementType.SKILL)).toBe(true);
      expect(registry.getValidator(ElementType.SKILL)).toBe(customValidator);
    });
  });

  describe('hasSpecializedValidator', () => {
    it('should return true for types with specialized validators', () => {
      expect(registry.hasSpecializedValidator(ElementType.PERSONA)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.TEMPLATE)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.MEMORY)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.ENSEMBLE)).toBe(true);
      expect(registry.hasSpecializedValidator(ElementType.AGENT)).toBe(true);
    });

    it('should return true for SKILL with specialized validator', () => {
      expect(registry.hasSpecializedValidator(ElementType.SKILL)).toBe(true);
    });

    it('should return true after registering custom validator', () => {
      const customValidator: ElementValidator = {
        elementType: ElementType.SKILL,
        validateCreate: jest.fn(),
        validateEdit: jest.fn(),
        validateMetadata: jest.fn(),
        generateReport: jest.fn()
      };

      registry.registerValidator(ElementType.SKILL, customValidator);

      expect(registry.hasSpecializedValidator(ElementType.SKILL)).toBe(true);
    });
  });

  describe('getRegisteredTypes', () => {
    it('should return array of registered element types', () => {
      const types = registry.getRegisteredTypes();

      expect(Array.isArray(types)).toBe(true);
      expect(types).toContain(ElementType.PERSONA);
      expect(types).toContain(ElementType.TEMPLATE);
      expect(types).toContain(ElementType.MEMORY);
      expect(types).toContain(ElementType.ENSEMBLE);
    });

    it('should include SKILL in registered types', () => {
      const types = registry.getRegisteredTypes();

      expect(types).toContain(ElementType.SKILL);
    });

    it('should include newly registered types', () => {
      const customValidator: ElementValidator = {
        elementType: ElementType.SKILL,
        validateCreate: jest.fn(),
        validateEdit: jest.fn(),
        validateMetadata: jest.fn(),
        generateReport: jest.fn()
      };

      registry.registerValidator(ElementType.SKILL, customValidator);

      const types = registry.getRegisteredTypes();
      expect(types).toContain(ElementType.SKILL);
    });
  });

  describe('Service Accessors', () => {
    describe('getValidationService', () => {
      it('should return the ValidationService instance', () => {
        const service = registry.getValidationService();
        expect(service).toBe(mockValidationService);
      });
    });

    describe('getTriggerValidationService', () => {
      it('should return the TriggerValidationService instance', () => {
        const service = registry.getTriggerValidationService();
        expect(service).toBe(mockTriggerService);
      });
    });

    describe('getMetadataService', () => {
      it('should return the MetadataService instance', () => {
        const service = registry.getMetadataService();
        expect(service).toBe(mockMetadataService);
      });
    });
  });

  describe('Validator Consistency', () => {
    it('should return the same specialized validator instance each time', () => {
      const validator1 = registry.getValidator(ElementType.PERSONA);
      const validator2 = registry.getValidator(ElementType.PERSONA);

      expect(validator1).toBe(validator2);
    });

    it('should return the same generic validator instance each time', () => {
      const validator1 = registry.getValidator(ElementType.SKILL);
      const validator2 = registry.getValidator(ElementType.SKILL);

      expect(validator1).toBe(validator2);
    });
  });

  describe('Type Safety', () => {
    it('should return validators that implement ElementValidator interface', () => {
      const types = [
        ElementType.PERSONA,
        ElementType.TEMPLATE,
        ElementType.MEMORY,
        ElementType.ENSEMBLE,
        ElementType.SKILL,
        ElementType.AGENT
      ];

      for (const type of types) {
        const validator = registry.getValidator(type);

        expect(validator.elementType).toBeDefined();
        expect(typeof validator.validateCreate).toBe('function');
        expect(typeof validator.validateEdit).toBe('function');
        expect(typeof validator.validateMetadata).toBe('function');
        expect(typeof validator.generateReport).toBe('function');
      }
    });
  });

  describe('Multiple Registry Instances', () => {
    it('should allow multiple registry instances with different services', () => {
      const anotherValidationService = {} as ValidationService;
      const anotherTriggerService = {} as TriggerValidationService;
      const anotherMetadataService = {} as MetadataService;

      const anotherRegistry = new ValidationRegistry(
        anotherValidationService,
        anotherTriggerService,
        anotherMetadataService
      );

      expect(registry.getValidationService()).toBe(mockValidationService);
      expect(anotherRegistry.getValidationService()).toBe(anotherValidationService);
    });
  });
});
