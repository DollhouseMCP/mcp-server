/**
 * ElementValidator - Interface for element-type specific validators
 *
 * Defines the contract for all element validators in the ValidationRegistry.
 * Each element type can have its own validator implementation that provides
 * specialized validation logic while conforming to this common interface.
 *
 * @example
 * ```typescript
 * const validator = validationRegistry.getValidator(ElementType.PERSONA);
 * const result = await validator.validateCreate(personaData);
 * if (!result.isValid) {
 *   throw new Error(result.errors.join(', '));
 * }
 * ```
 */

import { ElementType } from '../../portfolio/types.js';

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  /** Whether the validation passed */
  isValid: boolean;
  /** List of validation errors (if any) */
  errors: string[];
  /** List of validation warnings (non-fatal issues) */
  warnings: string[];
  /** Suggestions for improvement (optional) */
  suggestions?: string[];
}

/**
 * Detailed validation report for an element
 */
export interface ValidationReport {
  /** Overall status of validation */
  status: 'pass' | 'fail' | 'warning';
  /** Summary description of validation result */
  summary: string;
  /** Detailed validation findings */
  details: string[];
  /** When the validation was performed */
  timestamp: Date;
  /** Optional element-specific metrics */
  metrics?: {
    /** Content length in characters */
    contentLength?: number;
    /** Number of triggers defined */
    triggerCount?: number;
    /** Estimated quality score (0-100) */
    qualityScore?: number;
  };
}

/**
 * Options for element validation
 */
export interface ElementValidationOptions {
  /** Whether to perform strict validation (default: false) */
  strict?: boolean;
  /** Skip content validation (for performance) */
  skipContentValidation?: boolean;
  /** Maximum content length to validate */
  maxContentLength?: number;
  /** Context for validation (e.g., 'create', 'edit', 'import') */
  context?: 'create' | 'edit' | 'import' | 'validate';
}

/**
 * Metadata validation options
 */
export interface MetadataValidationOptions {
  /** Fields that are required */
  requiredFields?: string[];
  /** Fields that should be validated for format */
  formatFields?: Record<string, RegExp>;
  /** Maximum lengths for string fields */
  maxLengths?: Record<string, number>;
}

/**
 * Interface for element-type specific validators
 *
 * Each element type (persona, skill, template, etc.) can have its own
 * validator implementation that provides specialized validation logic.
 */
export interface ElementValidator {
  /**
   * The element type this validator handles
   */
  readonly elementType: ElementType;

  /**
   * Validate data for element creation
   *
   * @param data - Raw data for creating an element
   * @param options - Validation options
   * @returns Promise resolving to validation result
   */
  validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult>;

  /**
   * Validate changes to an existing element
   *
   * @param element - The existing element
   * @param changes - Proposed changes to the element
   * @param options - Validation options
   * @returns Promise resolving to validation result
   */
  validateEdit(
    element: unknown,
    changes: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult>;

  /**
   * Validate element metadata
   *
   * @param metadata - Element metadata to validate
   * @param options - Metadata validation options
   * @returns Promise resolving to validation result
   */
  validateMetadata(
    metadata: unknown,
    options?: MetadataValidationOptions
  ): Promise<ValidationResult>;

  /**
   * Generate a comprehensive validation report for an element
   *
   * @param element - Element to generate report for
   * @returns Promise resolving to validation report
   */
  generateReport(element: unknown): Promise<ValidationReport>;
}

/**
 * Base implementation helpers for validators
 */
export const ValidatorHelpers = {
  /**
   * Create a passing validation result
   */
  pass(suggestions?: string[]): ValidationResult {
    return {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions
    };
  },

  /**
   * Create a failing validation result
   */
  fail(errors: string[], warnings?: string[]): ValidationResult {
    return {
      isValid: false,
      errors,
      warnings: warnings || []
    };
  },

  /**
   * Create a result with warnings but still valid
   */
  warn(warnings: string[], suggestions?: string[]): ValidationResult {
    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions
    };
  },

  /**
   * Merge multiple validation results
   */
  merge(...results: ValidationResult[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    for (const result of results) {
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      if (result.suggestions) {
        suggestions.push(...result.suggestions);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }
};
