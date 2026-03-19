/**
 * SkillElementValidator - Specialized validator for Skill elements
 *
 * Extends GenericElementValidator to add Skill-specific validation:
 * - Complexity enum validation (beginner/intermediate/advanced/expert)
 * - Proficiency level range validation (0-100)
 * - Languages and domains array validation
 * - Parameters array validation with type-specific rules
 * - Examples array validation
 * - Version semver format validation
 */

import { ElementType } from '../../portfolio/types.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { ValidationResult, ValidatorHelpers, ElementValidationOptions, MetadataValidationOptions } from './ElementValidator.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';

const VALID_COMPLEXITY_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
const VALID_PARAMETER_TYPES = ['string', 'number', 'boolean', 'enum'] as const;
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

/**
 * Specialized validator for Skill elements.
 * Validates skill-specific fields: complexity, proficiency_level, languages,
 * domains, parameters, examples, and version (semver).
 */
export class SkillElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(ElementType.SKILL, validationService, triggerValidationService, metadataService);
  }

  /**
   * Override validateCreate to add skill-specific validation
   */
  override async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    // First run generic validation
    const baseResult = await super.validateCreate(data, options);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];
    const suggestions = baseResult.suggestions ? [...baseResult.suggestions] : [];

    if (!data || typeof data !== 'object') {
      return baseResult;
    }

    const record = data as Record<string, unknown>;

    // Validate complexity enum
    if (record.complexity !== undefined) {
      const complexityResult = this.validateComplexity(record.complexity);
      if (!complexityResult.isValid) {
        errors.push(...complexityResult.errors);
      }
    }

    // Validate proficiency_level range (0-100)
    if (record.proficiency_level !== undefined) {
      const proficiencyResult = this.validateProficiencyLevel(record.proficiency_level);
      if (!proficiencyResult.isValid) {
        errors.push(...proficiencyResult.errors);
      }
    }

    // Validate languages array
    if (record.languages !== undefined) {
      const languagesResult = this.validateStringArray(record.languages, 'languages');
      if (!languagesResult.isValid) {
        errors.push(...languagesResult.errors);
      }
    }

    // Validate domains array
    if (record.domains !== undefined) {
      const domainsResult = this.validateStringArray(record.domains, 'domains');
      if (!domainsResult.isValid) {
        errors.push(...domainsResult.errors);
      }
    }

    // Validate parameters array
    if (record.parameters !== undefined) {
      const paramsResult = this.validateParameters(record.parameters);
      if (!paramsResult.isValid) {
        errors.push(...paramsResult.errors);
      }
      warnings.push(...paramsResult.warnings);
    }

    // Validate examples array
    if (record.examples !== undefined) {
      const examplesResult = this.validateExamples(record.examples);
      if (!examplesResult.isValid) {
        errors.push(...examplesResult.errors);
      }
    }

    // Validate version semver format
    if (record.version !== undefined) {
      const versionResult = this.validateVersion(record.version);
      if (!versionResult.isValid) {
        errors.push(...versionResult.errors);
      }
    }

    // Note: empty domains/examples warnings are emitted by Skill.validate()
    // to avoid duplication in the combined validateElement output.

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Override validateMetadata to add skill-specific metadata validation
   */
  override async validateMetadata(
    metadata: unknown,
    options?: MetadataValidationOptions
  ): Promise<ValidationResult> {
    // Start with base metadata validation
    const baseResult = await super.validateMetadata(metadata, {
      ...options,
      requiredFields: options?.requiredFields ?? ['name', 'description']
    });

    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];

    if (!metadata || typeof metadata !== 'object') {
      return baseResult;
    }

    const record = metadata as Record<string, unknown>;

    // Validate complexity enum
    if (record.complexity !== undefined) {
      const complexityResult = this.validateComplexity(record.complexity);
      if (!complexityResult.isValid) {
        errors.push(...complexityResult.errors);
      }
    }

    // Validate proficiency_level range (0-100)
    if (record.proficiency_level !== undefined) {
      const proficiencyResult = this.validateProficiencyLevel(record.proficiency_level);
      if (!proficiencyResult.isValid) {
        errors.push(...proficiencyResult.errors);
      }
    }

    // Validate languages array
    if (record.languages !== undefined) {
      const languagesResult = this.validateStringArray(record.languages, 'languages');
      if (!languagesResult.isValid) {
        errors.push(...languagesResult.errors);
      }
    }

    // Validate domains array
    if (record.domains !== undefined) {
      const domainsResult = this.validateStringArray(record.domains, 'domains');
      if (!domainsResult.isValid) {
        errors.push(...domainsResult.errors);
      }
    }

    // Validate parameters array
    if (record.parameters !== undefined) {
      const paramsResult = this.validateParameters(record.parameters);
      if (!paramsResult.isValid) {
        errors.push(...paramsResult.errors);
      }
      warnings.push(...paramsResult.warnings);
    }

    // Validate examples array
    if (record.examples !== undefined) {
      const examplesResult = this.validateExamples(record.examples);
      if (!examplesResult.isValid) {
        errors.push(...examplesResult.errors);
      }
    }

    // Validate version semver format
    if (record.version !== undefined) {
      const versionResult = this.validateVersion(record.version);
      if (!versionResult.isValid) {
        errors.push(...versionResult.errors);
      }
    }

    // Note: empty domains/examples warnings are emitted by Skill.validate()
    // to avoid duplication in the combined validateElement output.

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate complexity enum value
   */
  private validateComplexity(complexity: unknown): ValidationResult {
    if (typeof complexity !== 'string') {
      return ValidatorHelpers.fail(['Complexity must be a string']);
    }

    if (!(VALID_COMPLEXITY_LEVELS as readonly string[]).includes(complexity)) {
      return ValidatorHelpers.fail([
        `Invalid complexity '${complexity}'. Valid options: ${VALID_COMPLEXITY_LEVELS.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate proficiency_level is a number in range 0-100
   */
  private validateProficiencyLevel(level: unknown): ValidationResult {
    if (typeof level !== 'number') {
      return ValidatorHelpers.fail(['Proficiency level must be a number']);
    }

    if (level < 0 || level > 100) {
      return ValidatorHelpers.fail([
        `Proficiency level must be between 0 and 100, got ${level}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate that a field is an array of strings
   */
  private validateStringArray(value: unknown, fieldName: string): ValidationResult {
    if (!Array.isArray(value)) {
      return ValidatorHelpers.fail([`${fieldName} must be an array`]);
    }

    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        return ValidatorHelpers.fail([
          `${fieldName}[${i}] must be a string`
        ]);
      }
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate parameters array with type-specific rules
   */
  private validateParameters(parameters: unknown): ValidationResult {
    if (!Array.isArray(parameters)) {
      return ValidatorHelpers.fail(['Parameters must be an array']);
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < parameters.length; i++) {
      const param = parameters[i];

      if (!param || typeof param !== 'object') {
        errors.push(`Parameter at index ${i} must be an object`);
        continue;
      }

      const p = param as Record<string, unknown>;

      // name is required and must be non-empty string
      if (!p.name || typeof p.name !== 'string' || p.name.trim().length === 0) {
        errors.push(`Parameter at index ${i} is missing required non-empty 'name' field`);
      }

      // type is required and must be one of the valid types
      if (!p.type || typeof p.type !== 'string') {
        errors.push(`Parameter at index ${i} is missing required 'type' field`);
      } else if (!(VALID_PARAMETER_TYPES as readonly string[]).includes(p.type)) {
        errors.push(
          `Parameter '${p.name || i}' has invalid type '${p.type}'. Valid types: ${VALID_PARAMETER_TYPES.join(', ')}`
        );
      }

      // description is required
      if (!p.description || typeof p.description !== 'string') {
        errors.push(`Parameter '${p.name || i}' is missing required 'description' field`);
      }

      // enum-type parameters need options array
      if (p.type === 'enum') {
        if (!p.options || !Array.isArray(p.options) || p.options.length === 0) {
          errors.push(`Parameter '${p.name || i}' has type 'enum' but is missing or has empty 'options' array`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate examples array
   */
  private validateExamples(examples: unknown): ValidationResult {
    if (!Array.isArray(examples)) {
      return ValidatorHelpers.fail(['Examples must be an array']);
    }

    const errors: string[] = [];

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];

      if (!example || typeof example !== 'object') {
        errors.push(`Example at index ${i} must be an object`);
        continue;
      }

      const ex = example as Record<string, unknown>;

      if (!ex.title || typeof ex.title !== 'string') {
        errors.push(`Example at index ${i} is missing required 'title' field`);
      }

      if (!ex.description || typeof ex.description !== 'string') {
        errors.push(`Example at index ${i} is missing required 'description' field`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: []
    };
  }

  /**
   * Validate version follows semver format
   */
  private validateVersion(version: unknown): ValidationResult {
    if (typeof version !== 'string') {
      return ValidatorHelpers.fail(['Version must be a string']);
    }

    if (!SEMVER_REGEX.test(version)) {
      return ValidatorHelpers.fail([
        `Version '${version}' is not valid semver format (expected: major.minor.patch, e.g., 1.0.0)`
      ]);
    }

    return ValidatorHelpers.pass();
  }
}
