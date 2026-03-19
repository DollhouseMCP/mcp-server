/**
 * Validation Services Module
 *
 * Provides consolidated validation functionality for all element types.
 * Export the ValidationRegistry as the primary entry point for validation.
 */

export {
  ValidationRegistry,
  ValidatorHelpers,
  GenericElementValidator,
  PersonaElementValidator,
  SkillElementValidator,
  ValidationService,
  TriggerValidationService
} from './ValidationRegistry.js';

export type {
  ElementValidator,
  ValidationResult,
  ValidationReport,
  ElementValidationOptions,
  MetadataValidationOptions
} from './ValidationRegistry.js';
