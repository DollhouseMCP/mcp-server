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
import type {
  ValidationResult as InputValidationResult,
  ValidationService,
} from './ValidationService.js';
import type { TriggerValidationService } from './TriggerValidationService.js';
import type { MetadataService } from '../MetadataService.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import type { ContentValidatorOptions } from '../../security/contentValidator.js';
import { InputNormalizer } from '../../security/InputNormalizer.js';
import type {
  ElementValidationOptions,
  ElementValidator,
  MetadataValidationOptions,
  ValidationReport,
  ValidationResult,
} from './ElementValidator.js';
import { ValidatorHelpers } from './ElementValidator.js';

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

    this.appendValidationResult(this.validateName(record.name), errors, warnings);
    this.appendValidationResult(this.validateDescription(record.description), errors, warnings);

    // Fix #908: content and instructions use the same security validation boundary.
    await this.validateContentFields(record, options, errors, warnings);

    // Validate triggers if present
    if (record.triggers !== undefined) {
      const elementName = typeof record.name === 'string' ? record.name : 'unknown';
      const triggerResult = this.validateTriggers(
        record.triggers,
        elementName
      );
      this.appendValidationResult(triggerResult, errors, warnings);
    }

    // Add suggestions for missing optional fields
    suggestions.push(...this.buildCreateSuggestions(record));

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

    this.validateChangedScalarFields(changeRecord, errors, warnings);
    await this.validateContentFields(changeRecord, options, errors, warnings);

    if (changeRecord.triggers !== undefined) {
      const triggerResult = this.validateTriggers(
        changeRecord.triggers,
        this.resolveElementName(element as Record<string, unknown>, changeRecord)
      );
      this.appendValidationResult(triggerResult, errors, warnings);
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
  validateMetadata(
    metadata: unknown,
    options?: MetadataValidationOptions
  ): Promise<ValidationResult> {
    try {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!metadata || typeof metadata !== 'object') {
      return Promise.resolve(ValidatorHelpers.fail(['Metadata must be a non-null object']));
    }

    const record = metadata as Record<string, unknown>;

    this.collectRequiredFieldErrors(record, options?.requiredFields ?? ['name'], errors);
    this.collectFormatErrors(record, options?.formatFields, errors);
    this.collectMaxLengthErrors(record, options?.maxLengths, errors);

    // Standard field validations
    if (record.name) {
      this.appendValidationResult(this.validateName(record.name), errors, warnings);
    }

    return Promise.resolve({
      isValid: errors.length === 0,
      errors,
      warnings
    });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private appendValidationResult(
    result: ValidationResult,
    errors: string[],
    warnings: string[]
  ): void {
    if (!result.isValid) errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  private async validateContentFields(
    record: Record<string, unknown>,
    options: ElementValidationOptions | undefined,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    if (options?.skipContentValidation) return;

    for (const field of ['content', 'instructions'] as const) {
      if (record[field] === undefined) continue;
      const result = await this.validateContent(record[field], options?.maxContentLength);
      this.appendValidationResult(result, errors, warnings);
    }
  }

  private buildCreateSuggestions(record: Record<string, unknown>): string[] {
    const suggestions: string[] = [];
    if (!record.triggers || (Array.isArray(record.triggers) && record.triggers.length === 0)) {
      suggestions.push('Add trigger keywords to improve discoverability');
    }
    if (!record.author) suggestions.push('Add an author field for proper attribution');
    if (!record.version) suggestions.push('Add a version number for tracking updates');
    return suggestions;
  }

  private validateChangedScalarFields(
    changes: Record<string, unknown>,
    errors: string[],
    warnings: string[]
  ): void {
    if (changes.name !== undefined) {
      this.appendValidationResult(this.validateName(changes.name), errors, warnings);
    }
    if (changes.description !== undefined) {
      this.appendValidationResult(this.validateDescription(changes.description), errors, warnings);
    }
  }

  private resolveElementName(
    element: Record<string, unknown>,
    changes: Record<string, unknown>
  ): string {
    if (typeof element.name === 'string') return element.name;
    return typeof changes.name === 'string' ? changes.name : 'unknown';
  }

  private collectRequiredFieldErrors(
    record: Record<string, unknown>,
    requiredFields: string[],
    errors: string[]
  ): void {
    for (const field of requiredFields) {
      if (!record[field]) errors.push(`Required field '${field}' is missing or empty`);
    }
  }

  private collectFormatErrors(
    record: Record<string, unknown>,
    formatFields: Record<string, RegExp> | undefined,
    errors: string[]
  ): void {
    if (!formatFields) return;

    for (const [field, pattern] of Object.entries(formatFields)) {
      const value = record[field];
      if (value && typeof value === 'string' && !pattern.test(value)) {
        errors.push(`Field '${field}' has invalid format`);
      }
    }
  }

  private collectMaxLengthErrors(
    record: Record<string, unknown>,
    maxLengths: Record<string, number> | undefined,
    errors: string[]
  ): void {
    if (!maxLengths) return;

    for (const [field, maxLength] of Object.entries(maxLengths)) {
      const value = record[field];
      if (value && typeof value === 'string' && value.length > maxLength) {
        errors.push(`Field '${field}' exceeds maximum length of ${maxLength} characters`);
      }
    }
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
    const rawContent = record.content || record.instructions || '';
    const content = typeof rawContent === 'string' ? rawContent : '';

    // Validate all fields
    const createResult = await this.validateCreate({
      name: metadata.name,
      description: metadata.description,
      content: rawContent,
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

    if (description.length > SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH) {
      return ValidatorHelpers.fail([
        `Description exceeds maximum length of ${SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH} characters ` +
        '(frontmatter overhead reserved)'
      ]);
    }

    const result = this.sanitizeDescriptionInput(description);

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

  private sanitizeDescriptionInput(description: string): InputValidationResult {
    return this.validationService.validateAndSanitizeInput(description, {
      maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
      allowSpaces: true,
      fieldType: 'description'
    });
  }

  /**
   * Validate element content
   */
  protected validateContent(
    content: unknown,
    maxLength?: number
  ): Promise<ValidationResult> {
    try {
      const warnings: string[] = [];
      const max = maxLength || SECURITY_LIMITS.MAX_CONTENT_LENGTH;

      if (!content) {
        return Promise.resolve(ValidatorHelpers.fail(['Content is required']));
      }

      if (typeof content !== 'string') {
        return Promise.resolve(ValidatorHelpers.fail(['Content must be a string']));
      }

      // Check minimum length
      if (content.trim().length < 10) {
        return Promise.resolve(ValidatorHelpers.fail(['Content is too short (minimum 10 characters)']));
      }

      // Use ValidationService for content validation
      const result = this.validationService.validateContent(content, {
        maxLength: max,
        contentContext: this.contentValidationContext(),
      });

      if (!result.isValid) {
        return Promise.resolve(ValidatorHelpers.fail(
          result.detectedPatterns || ['Content validation failed']
        ));
      }

      // Content quality warnings
      if (content.length > 5000) {
        warnings.push('Content is very long - consider breaking it into sections');
      }

      return Promise.resolve({
        isValid: true,
        errors: [],
        warnings
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private contentValidationContext(): ContentValidatorOptions['contentContext'] {
    switch (this.elementType) {
      case ElementType.PERSONA:
        return 'persona';
      case ElementType.SKILL:
        return 'skill';
      case ElementType.TEMPLATE:
        return 'template';
      case ElementType.AGENT:
        return 'agent';
      case ElementType.MEMORY:
        return 'memory';
      case ElementType.ENSEMBLE:
        return undefined;
    }
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
    const score = this.textQualityScore(metadata.name, 3, 50)
      + this.textQualityScore(metadata.description, 20, 200)
      + this.contentQualityScore(content)
      + this.metadataCompletenessScore(metadata)
      + this.triggerQualityScore(metadata.triggers);
    return Math.min(100, score);
  }

  private textQualityScore(value: unknown, minimum: number, maximum: number): number {
    if (!value || typeof value !== 'string') return 0;
    return value.length >= minimum && value.length <= maximum ? 15 : 10;
  }

  private contentQualityScore(content: string): number {
    if (!content) return 0;
    let score = 15;
    if (content.length >= 50) score += 10;
    if (content.length <= 5000) score += 5;
    return score;
  }

  private metadataCompletenessScore(metadata: Record<string, unknown>): number {
    return ['author', 'version', 'category', 'created']
      .filter(field => Boolean(metadata[field]))
      .length * 5;
  }

  private triggerQualityScore(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    let score = 0;
    if (value.length > 0) score += 10;
    if (value.length >= 3) score += 5;
    if (value.length <= 10) score += 5;
    return score;
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
