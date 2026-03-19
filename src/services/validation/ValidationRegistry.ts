/**
 * ValidationRegistry - Central registry for element validators
 *
 * Consolidates all validation services into a single injection point,
 * reducing constructor bloat in element managers while maintaining
 * type-specific validation capabilities.
 *
 * @example
 * ```typescript
 * // In Container.ts
 * const validationRegistry = new ValidationRegistry(
 *   validationService,
 *   triggerValidationService,
 *   metadataService
 * );
 *
 * // In element managers
 * constructor(validationRegistry: ValidationRegistry) {
 *   this.validator = validationRegistry.getValidator(this.elementType);
 * }
 * ```
 */

import { ElementType } from '../../portfolio/types.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
import { logger } from '../../utils/logger.js';
import { ElementValidator } from './ElementValidator.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { PersonaElementValidator } from './PersonaElementValidator.js';
import { TemplateElementValidator } from './TemplateElementValidator.js';
import { MemoryElementValidator } from './MemoryElementValidator.js';
import { EnsembleElementValidator } from './EnsembleElementValidator.js';
import { AgentElementValidator } from './AgentElementValidator.js';
import { SkillElementValidator } from './SkillElementValidator.js';

/**
 * Central registry for element validators
 */
export class ValidationRegistry {
  private validators: Map<ElementType, ElementValidator> = new Map();
  private genericValidators: Map<ElementType, GenericElementValidator> = new Map();

  /**
   * Create a new ValidationRegistry
   *
   * @param validationService - Core validation service for input sanitization
   * @param triggerValidationService - Service for validating trigger keywords
   * @param metadataService - Service for metadata operations
   */
  constructor(
    private validationService: ValidationService,
    private triggerValidationService: TriggerValidationService,
    private metadataService: MetadataService
  ) {
    this.registerDefaultValidators();
    logger.debug('ValidationRegistry initialized with default validators');
  }

  /**
   * Get a validator for the specified element type
   *
   * Returns a specialized validator if registered, otherwise returns
   * a generic validator for that element type.
   *
   * @param type - The element type to get a validator for
   * @returns ElementValidator for the specified type
   */
  getValidator(type: ElementType): ElementValidator {
    // First check for specialized validators
    const specialized = this.validators.get(type);
    if (specialized) {
      return specialized;
    }

    // Fall back to generic validator
    return this.getGenericValidator(type);
  }

  /**
   * Register a custom validator for an element type
   *
   * @param type - The element type to register for
   * @param validator - The validator implementation
   */
  registerValidator(type: ElementType, validator: ElementValidator): void {
    this.validators.set(type, validator);
    logger.debug(`Registered custom validator for ${type}`);
  }

  /**
   * Check if a specialized validator is registered for an element type
   *
   * @param type - The element type to check
   * @returns true if a specialized validator is registered
   */
  hasSpecializedValidator(type: ElementType): boolean {
    return this.validators.has(type);
  }

  /**
   * Get all registered element types
   *
   * @returns Array of element types with registered validators
   */
  getRegisteredTypes(): ElementType[] {
    return Array.from(this.validators.keys());
  }

  /**
   * Get the underlying validation service
   *
   * Used by element managers that need direct access to validation
   * utilities beyond what the ElementValidator interface provides.
   *
   * @returns ValidationService instance
   */
  getValidationService(): ValidationService {
    return this.validationService;
  }

  /**
   * Get the underlying trigger validation service
   *
   * @returns TriggerValidationService instance
   */
  getTriggerValidationService(): TriggerValidationService {
    return this.triggerValidationService;
  }

  /**
   * Get the underlying metadata service
   *
   * @returns MetadataService instance
   */
  getMetadataService(): MetadataService {
    return this.metadataService;
  }

  /**
   * Register default validators for all element types
   */
  private registerDefaultValidators(): void {
    // Register PersonaElementValidator for personas
    this.validators.set(
      ElementType.PERSONA,
      new PersonaElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );

    // Register TemplateElementValidator for templates
    this.validators.set(
      ElementType.TEMPLATE,
      new TemplateElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );

    // Register MemoryElementValidator for memories
    this.validators.set(
      ElementType.MEMORY,
      new MemoryElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );

    // Register EnsembleElementValidator for ensembles
    this.validators.set(
      ElementType.ENSEMBLE,
      new EnsembleElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );

    // Register AgentElementValidator for agents
    this.validators.set(
      ElementType.AGENT,
      new AgentElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );

    // Register SkillElementValidator for skills
    this.validators.set(
      ElementType.SKILL,
      new SkillElementValidator(
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      )
    );
  }

  /**
   * Get or create a generic validator for an element type
   */
  private getGenericValidator(type: ElementType): GenericElementValidator {
    let validator = this.genericValidators.get(type);
    if (!validator) {
      validator = new GenericElementValidator(
        type,
        this.validationService,
        this.triggerValidationService,
        this.metadataService
      );
      this.genericValidators.set(type, validator);
    }
    return validator;
  }
}

// Export all validation-related types and classes
export type {
  ElementValidator,
  ValidationResult,
  ValidationReport,
  ElementValidationOptions,
  MetadataValidationOptions
} from './ElementValidator.js';

export { ValidatorHelpers } from './ElementValidator.js';

export { GenericElementValidator } from './GenericElementValidator.js';
export { PersonaElementValidator } from './PersonaElementValidator.js';
export { TemplateElementValidator } from './TemplateElementValidator.js';
export { MemoryElementValidator } from './MemoryElementValidator.js';
export { EnsembleElementValidator } from './EnsembleElementValidator.js';
export { AgentElementValidator } from './AgentElementValidator.js';
export { SkillElementValidator } from './SkillElementValidator.js';
export { ValidationService } from './ValidationService.js';
export { TriggerValidationService } from './TriggerValidationService.js';
