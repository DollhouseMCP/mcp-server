/**
 * GenericElementValidator - Default validator implementation for most element types
 *
 * Provides standard validation logic that works for any element type.
 * Uses the existing ValidationService and TriggerValidationService for
 * consistent security-first validation patterns.
 *
 * Element types that need specialized validation (like personas) can
 * extend this class or implement ElementValidator directly.
 */

import { ElementType } from '../../portfolio/types.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { InputNormalizer } from '../../security/InputNormalizer.js';
import {
  ElementValidator,
  ValidationResult,
  ValidationReport,
  ElementValidationOptions,
  MetadataValidationOptions,
  ValidatorHelpers
} from './ElementValidator.js';

/**
 * Default validator implementation for most element types
 */
export class GenericElementValidator implements ElementValidator {
  readonly elementType: ElementType;

  constructor(
    elementType: ElementType,
    protected validationService: ValidationService,
    protected triggerValidationService: TriggerValidationService,
    protected metadataService: MetadataService
  ) {
    this.elementType = elementType;
  }

  /**
   * Validate data for element creation
   *
   * ARCHITECTURE: Input Normalization at Boundary
   * Step 1: Normalize ALL string fields (Unicode, confusables, direction overrides)
   * Step 2: Validate the normalized data (field rules, lengths, patterns)
   *
   * This ensures we can't forget to normalize a field - it happens once at entry.
   */
  async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!data || typeof data !== 'object') {
      return ValidatorHelpers.fail(['Data must be a non-null object']);
    }

    // STEP 1: NORMALIZE at the boundary (before any validation)
    const normalized = InputNormalizer.normalize(data);

    // Fail fast if high or critical Unicode issues detected
    if (normalized.hasHighOrCriticalIssues) {
      return ValidatorHelpers.fail(normalized.errors);
    }

    // Add normalization warnings to results
    warnings.push(...normalized.warnings);

    // STEP 2: VALIDATE the normalized data
    const record = normalized.data as Record<string, unknown>;

    // Validate name
    const nameResult = this.validateName(record.name);
    if (!nameResult.isValid) {
      errors.push(...nameResult.errors);
    }
    warnings.push(...nameResult.warnings);

    // Validate description
    const descResult = this.validateDescription(record.description);
    if (!descResult.isValid) {
      errors.push(...descResult.errors);
    }
    warnings.push(...descResult.warnings);

    // Validate content if present
    if (record.content !== undefined && !options?.skipContentValidation) {
      const contentResult = await this.validateContent(
        record.content,
        options?.maxContentLength
      );
      if (!contentResult.isValid) {
        errors.push(...contentResult.errors);
      }
      warnings.push(...contentResult.warnings);
    }

    // Fix #908: Validate instructions field — previously only content was checked,
    // allowing injection payloads in instructions to reach disk unscanned.
    if (record.instructions !== undefined && !options?.skipContentValidation) {
      const instrResult = await this.validateContent(
        record.instructions,
        options?.maxContentLength
      );
      if (!instrResult.isValid) {
        errors.push(...instrResult.errors);
      }
      warnings.push(...instrResult.warnings);
    }

    // Validate triggers if present
    if (record.triggers !== undefined) {
      const triggerResult = this.validateTriggers(
        record.triggers,
        String(record.name || 'unknown')
      );
      if (!triggerResult.isValid) {
        errors.push(...triggerResult.errors);
      }
      warnings.push(...triggerResult.warnings);
    }

    // Add suggestions for missing optional fields
    if (!record.triggers || (Array.isArray(record.triggers) && record.triggers.length === 0)) {
      suggestions.push('Add trigger keywords to improve discoverability');
    }
    if (!record.author) {
      suggestions.push('Add an author field for proper attribution');
    }
    if (!record.version) {
      suggestions.push('Add a version number for tracking updates');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate changes to an existing element
   *
   * ARCHITECTURE: Input Normalization at Boundary
   * Step 1: Normalize ALL string fields in changes object
   * Step 2: Validate the normalized changes
   */
  async validateEdit(
    element: unknown,
    changes: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!element || typeof element !== 'object') {
      return ValidatorHelpers.fail(['Element must be a non-null object']);
    }

    if (!changes || typeof changes !== 'object') {
      return ValidatorHelpers.fail(['Changes must be a non-null object']);
    }

    // STEP 1: NORMALIZE changes at the boundary
    const normalized = InputNormalizer.normalize(changes);

    // Fail fast if high or critical Unicode issues detected
    if (normalized.hasHighOrCriticalIssues) {
      return ValidatorHelpers.fail(normalized.errors);
    }

    // Add normalization warnings to results
    warnings.push(...normalized.warnings);

    // STEP 2: VALIDATE the normalized changes
    const changeRecord = normalized.data as Record<string, unknown>;

    // Validate each changed field
    if (changeRecord.name !== undefined) {
      const nameResult = this.validateName(changeRecord.name);
      if (!nameResult.isValid) {
        errors.push(...nameResult.errors);
      }
      warnings.push(...nameResult.warnings);
    }

    if (changeRecord.description !== undefined) {
      const descResult = this.validateDescription(changeRecord.description);
      if (!descResult.isValid) {
        errors.push(...descResult.errors);
      }
      warnings.push(...descResult.warnings);
    }

    if (changeRecord.content !== undefined && !options?.skipContentValidation) {
      const contentResult = await this.validateContent(
        changeRecord.content,
        options?.maxContentLength
      );
      if (!contentResult.isValid) {
        errors.push(...contentResult.errors);
      }
      warnings.push(...contentResult.warnings);
    }

    // Fix #908: Validate instructions on edit path (same gap as validateCreate)
    if (changeRecord.instructions !== undefined && !options?.skipContentValidation) {
      const instrResult = await this.validateContent(
        changeRecord.instructions,
        options?.maxContentLength
      );
      if (!instrResult.isValid) {
        errors.push(...instrResult.errors);
      }
      warnings.push(...instrResult.warnings);
    }

    if (changeRecord.triggers !== undefined) {
      const elementRecord = element as Record<string, unknown>;
      const triggerResult = this.validateTriggers(
        changeRecord.triggers,
        String(elementRecord.name || changeRecord.name || 'unknown')
      );
      if (!triggerResult.isValid) {
        errors.push(...triggerResult.errors);
      }
      warnings.push(...triggerResult.warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate element metadata
   */
  async validateMetadata(
    metadata: unknown,
    options?: MetadataValidationOptions
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!metadata || typeof metadata !== 'object') {
      return ValidatorHelpers.fail(['Metadata must be a non-null object']);
    }

    const record = metadata as Record<string, unknown>;

    // Check required fields
    const requiredFields = options?.requiredFields || ['name'];
    for (const field of requiredFields) {
      if (!record[field]) {
        errors.push(`Required field '${field}' is missing or empty`);
      }
    }

    // Validate field formats
    if (options?.formatFields) {
      for (const [field, pattern] of Object.entries(options.formatFields)) {
        const value = record[field];
        if (value && typeof value === 'string' && !pattern.test(value)) {
          errors.push(`Field '${field}' has invalid format`);
        }
      }
    }

    // Validate max lengths
    if (options?.maxLengths) {
      for (const [field, maxLength] of Object.entries(options.maxLengths)) {
        const value = record[field];
        if (value && typeof value === 'string' && value.length > maxLength) {
          errors.push(`Field '${field}' exceeds maximum length of ${maxLength} characters`);
        }
      }
    }

    // Standard field validations
    if (record.name) {
      const nameResult = this.validateName(record.name);
      if (!nameResult.isValid) {
        errors.push(...nameResult.errors);
      }
      warnings.push(...nameResult.warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Generate a comprehensive validation report
   */
  async generateReport(element: unknown): Promise<ValidationReport> {
    const details: string[] = [];
    let status: 'pass' | 'fail' | 'warning' = 'pass';

    if (!element || typeof element !== 'object') {
      return {
        status: 'fail',
        summary: 'Invalid element: must be a non-null object',
        details: ['Element validation failed - invalid input type'],
        timestamp: new Date()
      };
    }

    const record = element as Record<string, unknown>;
    const metadata = (record.metadata || record) as Record<string, unknown>;
    const content = String(record.content || record.instructions || '');

    // Validate all fields
    const createResult = await this.validateCreate({
      name: metadata.name,
      description: metadata.description,
      content,
      triggers: metadata.triggers,
      author: metadata.author,
      version: metadata.version
    });

    // Process validation results
    if (createResult.errors.length > 0) {
      status = 'fail';
      details.push('Errors:');
      createResult.errors.forEach((error, i) => {
        details.push(`  ${i + 1}. ${error}`);
      });
    }

    if (createResult.warnings.length > 0) {
      if (status === 'pass') {
        status = 'warning';
      }
      details.push('Warnings:');
      createResult.warnings.forEach((warning, i) => {
        details.push(`  ${i + 1}. ${warning}`);
      });
    }

    if (createResult.suggestions && createResult.suggestions.length > 0) {
      details.push('Suggestions:');
      createResult.suggestions.forEach((suggestion, i) => {
        details.push(`  ${i + 1}. ${suggestion}`);
      });
    }

    // Calculate metrics
    const triggerCount = Array.isArray(metadata.triggers) ? metadata.triggers.length : 0;
    const contentLength = content.length;

    // Generate summary
    let summary: string;
    if (status === 'pass') {
      summary = `${this.getElementLabel()} validation passed with no issues`;
    } else if (status === 'warning') {
      summary = `${this.getElementLabel()} is valid but has ${createResult.warnings.length} warning(s)`;
    } else {
      summary = `${this.getElementLabel()} validation failed with ${createResult.errors.length} error(s)`;
    }

    return {
      status,
      summary,
      details,
      timestamp: new Date(),
      metrics: {
        contentLength,
        triggerCount,
        qualityScore: this.calculateQualityScore(metadata, content)
      }
    };
  }

  /**
   * Validate element name
   */
  protected validateName(name: unknown): ValidationResult {
    if (!name || typeof name !== 'string') {
      return ValidatorHelpers.fail(["Name is required and must be a string"]);
    }

    const result = this.validationService.validateAndSanitizeInput(name, {
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
      allowSpaces: true,
      fieldType: 'name'
    });

    if (!result.isValid) {
      return ValidatorHelpers.fail(result.errors || ['Invalid name']);
    }

    const warnings: string[] = [];
    if (name.length > 50) {
      warnings.push('Name is very long - consider shortening for better display');
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate element description
   */
  protected validateDescription(description: unknown): ValidationResult {
    const warnings: string[] = [];

    if (!description) {
      return ValidatorHelpers.fail(["Description is required"]);
    }

    if (typeof description !== 'string') {
      return ValidatorHelpers.fail(["Description must be a string"]);
    }

    const result = this.validationService.validateAndSanitizeInput(description, {
      maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH,
      allowSpaces: true,
      fieldType: 'description'
    });

    if (!result.isValid) {
      return ValidatorHelpers.fail(result.errors || ['Invalid description']);
    }

    if (description.length > 200) {
      warnings.push('Description is very long - consider keeping it under 200 characters');
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate element content
   */
  protected async validateContent(
    content: unknown,
    maxLength?: number
  ): Promise<ValidationResult> {
    const warnings: string[] = [];
    const max = maxLength || SECURITY_LIMITS.MAX_CONTENT_LENGTH;

    if (!content) {
      return ValidatorHelpers.fail(['Content is required']);
    }

    if (typeof content !== 'string') {
      return ValidatorHelpers.fail(['Content must be a string']);
    }

    // Check minimum length
    if (content.trim().length < 10) {
      return ValidatorHelpers.fail(['Content is too short (minimum 10 characters)']);
    }

    // Use ValidationService for content validation
    const result = this.validationService.validateContent(content, {
      maxLength: max
    });

    if (!result.isValid) {
      return ValidatorHelpers.fail(
        result.detectedPatterns || ['Content validation failed']
      );
    }

    // Content quality warnings
    if (content.length > 5000) {
      warnings.push('Content is very long - consider breaking it into sections');
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate triggers array
   */
  protected validateTriggers(triggers: unknown, elementName: string): ValidationResult {
    if (!Array.isArray(triggers)) {
      return ValidatorHelpers.fail(['Triggers must be an array']);
    }

    const result = this.triggerValidationService.validateTriggers(
      triggers,
      this.elementType,
      elementName
    );

    const errors: string[] = [];
    const warnings: string[] = [...result.warnings];

    if (result.hasRejections) {
      result.rejectedTriggers.forEach(rejected => {
        warnings.push(`Trigger "${rejected.original}" rejected: ${rejected.reason}`);
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Calculate a quality score for the element (0-100)
   */
  protected calculateQualityScore(
    metadata: Record<string, unknown>,
    content: string
  ): number {
    let score = 0;

    // Name quality (0-15 points)
    if (metadata.name && typeof metadata.name === 'string') {
      score += 10;
      if (metadata.name.length >= 3 && metadata.name.length <= 50) {
        score += 5;
      }
    }

    // Description quality (0-15 points)
    if (metadata.description && typeof metadata.description === 'string') {
      score += 10;
      const desc = metadata.description as string;
      if (desc.length >= 20 && desc.length <= 200) {
        score += 5;
      }
    }

    // Content quality (0-30 points)
    if (content) {
      score += 15;
      if (content.length >= 50) {
        score += 10;
      }
      if (content.length <= 5000) {
        score += 5;
      }
    }

    // Metadata completeness (0-20 points)
    if (metadata.author) score += 5;
    if (metadata.version) score += 5;
    if (metadata.category) score += 5;
    if (metadata.created) score += 5;

    // Triggers (0-20 points)
    if (Array.isArray(metadata.triggers)) {
      const triggers = metadata.triggers as unknown[];
      if (triggers.length > 0) score += 10;
      if (triggers.length >= 3) score += 5;
      if (triggers.length <= 10) score += 5;
    }

    return Math.min(100, score);
  }

  /**
   * Get human-readable label for this element type
   */
  protected getElementLabel(): string {
    const labels: Record<ElementType, string> = {
      [ElementType.PERSONA]: 'Persona',
      [ElementType.SKILL]: 'Skill',
      [ElementType.TEMPLATE]: 'Template',
      [ElementType.AGENT]: 'Agent',
      [ElementType.MEMORY]: 'Memory',
      [ElementType.ENSEMBLE]: 'Ensemble'
    };
    return labels[this.elementType] || this.elementType;
  }
}
