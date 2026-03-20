/**
 * PersonaElementValidator - Specialized validator for persona elements
 *
 * Restores and extends the original PersonaValidator functionality including:
 * - Content length quality checks (min 50 chars, warn if >5000)
 * - Age rating validation
 * - Improvement suggestions
 * - Validation report generation
 *
 * This validator provides persona-specific validation logic while using
 * the shared validation services for security-first patterns.
 */

import { ElementType } from '../../portfolio/types.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
// VALID_CATEGORIES import removed — categories are deprecated (see config/constants.ts)
import {
  ValidationResult,
  ValidationReport,
  ElementValidationOptions,
  MetadataValidationOptions,
  ValidatorHelpers
} from './ElementValidator.js';
import { GenericElementValidator } from './GenericElementValidator.js';

/**
 * Valid age ratings for personas
 */
const VALID_AGE_RATINGS = ['all', '13+', '18+'] as const;
type AgeRating = typeof VALID_AGE_RATINGS[number];

/**
 * Specialized validator for persona elements
 */
export class PersonaElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(
      ElementType.PERSONA,
      validationService,
      triggerValidationService,
      metadataService
    );
  }

  /**
   * Validate data for persona creation
   * Extends base validation with persona-specific checks
   */
  override async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    // Start with base validation
    const baseResult = await super.validateCreate(data, options);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];
    const suggestions = baseResult.suggestions ? [...baseResult.suggestions] : [];

    if (!data || typeof data !== 'object') {
      return baseResult;
    }

    const record = data as Record<string, unknown>;
    const content = String(record.content || record.instructions || '');

    // Persona-specific: Minimum content length check (warning, not error)
    // The base validator already checks for minimum 10 characters
    if (content && content.trim().length >= 10 && content.trim().length < 50) {
      warnings.push('Persona content is short (recommended minimum 50 characters)');
    }

    // Persona-specific: Content length warning
    if (content && content.length > 5000) {
      warnings.push('Persona content is very long - consider breaking it into sections');
    }

    // Validate age rating if present
    if (record.age_rating !== undefined) {
      const ageRatingResult = this.validateAgeRating(record.age_rating);
      if (!ageRatingResult.isValid) {
        warnings.push(...ageRatingResult.errors);
      }
    }

    // Generate persona-specific suggestions
    const personaSuggestions = this.suggestImprovements(record);
    suggestions.push(...personaSuggestions);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate metadata with persona-specific rules
   */
  override async validateMetadata(
    metadata: unknown,
    options?: MetadataValidationOptions
  ): Promise<ValidationResult> {
    // Start with base metadata validation
    const baseResult = await super.validateMetadata(metadata, {
      ...options,
      requiredFields: options?.requiredFields || ['name', 'description']
    });

    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];

    if (!metadata || typeof metadata !== 'object') {
      return baseResult;
    }

    const record = metadata as Record<string, unknown>;

    // Persona-specific: Validate age rating
    if (record.age_rating) {
      const ageRatingResult = this.validateAgeRating(record.age_rating);
      if (!ageRatingResult.isValid) {
        warnings.push(...ageRatingResult.errors);
      }
    }

    // Warn about missing optional but important fields
    if (!record.triggers || (Array.isArray(record.triggers) && record.triggers.length === 0)) {
      warnings.push('No trigger keywords defined - users may have difficulty finding this persona');
    }
    if (!record.version) {
      warnings.push("No version specified - defaulting to '1.0'");
    }
    if (!record.unique_id) {
      warnings.push('No unique_id - one will be generated automatically');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Generate a comprehensive validation report for a persona
   * Restores original PersonaValidator report generation
   */
  override async generateReport(element: unknown): Promise<ValidationReport> {
    const details: string[] = [];
    let status: 'pass' | 'fail' | 'warning' = 'pass';

    if (!element || typeof element !== 'object') {
      return {
        status: 'fail',
        summary: 'Invalid persona: must be a non-null object',
        details: ['Persona validation failed - invalid input type'],
        timestamp: new Date()
      };
    }

    const record = element as Record<string, unknown>;
    const metadata = (record.metadata || record) as Record<string, unknown>;
    const content = String(record.content || record.instructions || '');

    // Validate the persona
    const createResult = await this.validateCreate({
      name: metadata.name,
      description: metadata.description,
      content,
      triggers: metadata.triggers,
      author: metadata.author,
      version: metadata.version,
      category: metadata.category,
      age_rating: metadata.age_rating
    });

    const metadataResult = await this.validateMetadata(metadata);

    // Merge results
    const allErrors = [...createResult.errors, ...metadataResult.errors];
    const allWarnings = [...createResult.warnings, ...metadataResult.warnings];
    const suggestions = createResult.suggestions || [];

    // Generate formatted report (matching original PersonaValidator format)
    if (allErrors.length === 0 && allWarnings.length === 0) {
      details.push('All Checks Passed!');
      details.push('');
      details.push(`Persona: ${metadata.name}`);
      details.push(`Category: ${metadata.category || 'general'}`);
      details.push(`Version: ${metadata.version || '1.0'}`);
      details.push(`Content Length: ${content.length} characters`);
      details.push(`Triggers: ${Array.isArray(metadata.triggers) ? metadata.triggers.length : 0} keywords`);
      details.push('');
      details.push('This persona meets all validation requirements and is ready for use!');
    } else {
      if (allErrors.length > 0) {
        status = 'fail';
        details.push(`Issues Found (${allErrors.length}):`);
        allErrors.forEach((error, i) => {
          details.push(`   ${i + 1}. ${error}`);
        });
        details.push('');
      }

      if (allWarnings.length > 0) {
        if (status === 'pass') {
          status = 'warning';
        }
        details.push(`Warnings (${allWarnings.length}):`);
        allWarnings.forEach((warning, i) => {
          details.push(`   ${i + 1}. ${warning}`);
        });
        details.push('');
      }

      if (status === 'fail') {
        details.push('Fix Required: Please address the issues above before using this persona.');
      } else {
        details.push('Status: This persona is valid but could be improved. Consider addressing the warnings.');
      }
    }

    // Add suggestions if any
    if (suggestions.length > 0) {
      details.push('');
      details.push(`Suggestions (${suggestions.length}):`);
      suggestions.forEach((suggestion, i) => {
        details.push(`   ${i + 1}. ${suggestion}`);
      });
    }

    // Calculate metrics
    const triggerCount = Array.isArray(metadata.triggers) ? metadata.triggers.length : 0;

    // Generate summary
    let summary: string;
    if (status === 'pass') {
      summary = `Persona "${metadata.name}" validation passed`;
    } else if (status === 'warning') {
      summary = `Persona "${metadata.name}" is valid with ${allWarnings.length} warning(s)`;
    } else {
      summary = `Persona "${metadata.name}" validation failed with ${allErrors.length} error(s)`;
    }

    return {
      status,
      summary,
      details,
      timestamp: new Date(),
      metrics: {
        contentLength: content.length,
        triggerCount,
        qualityScore: this.calculatePersonaQualityScore(metadata, content)
      }
    };
  }

  /**
   * Validate age rating
   */
  private validateAgeRating(ageRating: unknown): ValidationResult {
    if (typeof ageRating !== 'string') {
      return ValidatorHelpers.fail(["Age rating must be a string"]);
    }

    if (!VALID_AGE_RATINGS.includes(ageRating as AgeRating)) {
      return ValidatorHelpers.fail([
        `Invalid age_rating '${ageRating}'. Should be one of: ${VALID_AGE_RATINGS.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Suggest improvements for a persona
   * Restores original PersonaValidator.suggestImprovements functionality
   */
  private suggestImprovements(record: Record<string, unknown>): string[] {
    const suggestions: string[] = [];
    const triggers = record.triggers;
    const content = String(record.content || record.instructions || '');

    // Trigger suggestions
    if (!triggers || !Array.isArray(triggers) || triggers.length < 3) {
      suggestions.push('Add more trigger keywords to improve discoverability');
    }

    // Author suggestion
    if (!record.author) {
      suggestions.push('Add an author field for proper attribution');
    }

    // Content length suggestion
    if (content.length < 200) {
      suggestions.push('Expand the persona instructions for better AI guidance');
    }

    // Version suggestion
    if (!record.version) {
      suggestions.push('Add a version number for tracking updates');
    }

    return suggestions;
  }

  /**
   * Check if a persona name is valid
   * Restores original PersonaValidator.isValidPersonaName functionality
   */
  isValidPersonaName(name: string): boolean {
    if (!name || name.trim().length === 0) return false;
    if (name.length > 50) return false;
    // Check for invalid characters
    return !/[<>:"/\\|?*]/.test(name);
  }

  /**
   * Calculate a quality score specific to personas (0-100)
   */
  private calculatePersonaQualityScore(
    metadata: Record<string, unknown>,
    content: string
  ): number {
    let score = 0;

    // Name quality (0-15 points)
    if (metadata.name && typeof metadata.name === 'string') {
      score += 10;
      if (this.isValidPersonaName(metadata.name)) {
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

    // Content quality (0-30 points) - stricter for personas
    if (content) {
      if (content.length >= 50) {
        score += 15;
      }
      if (content.length >= 200) {
        score += 10;
      }
      if (content.length >= 50 && content.length <= 5000) {
        score += 5;
      }
    }

    // Metadata completeness (0-20 points)
    if (metadata.author) score += 5;
    if (metadata.version) score += 5;
    if (metadata.category) score += 5;
    if (metadata.age_rating && VALID_AGE_RATINGS.includes(String(metadata.age_rating) as AgeRating)) score += 5;

    // Triggers (0-20 points) - important for personas
    if (Array.isArray(metadata.triggers)) {
      const triggers = metadata.triggers as unknown[];
      if (triggers.length > 0) score += 10;
      if (triggers.length >= 3) score += 5;
      if (triggers.length <= 10) score += 5;
    }

    return Math.min(100, score);
  }
}
