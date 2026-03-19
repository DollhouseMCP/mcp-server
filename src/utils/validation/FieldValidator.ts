/**
 * FieldValidator - Comprehensive field validation utilities
 *
 * Provides reusable validation rules for element metadata fields across all element types.
 * Each validator returns null on success or a ValidationError object on failure.
 *
 * Validation Rules:
 * - required: Field must be present and non-empty
 * - type: Field must match expected JavaScript type
 * - enum: Field value must be in allowed list
 * - array: Field must be array with optional minLength
 * - semver: Field must be valid semantic version
 * - length: String length within min/max bounds
 * - pattern: Field must match regex pattern
 *
 * @module utils/validation
 */

import * as semver from 'semver';

/**
 * Validation error structure
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * FieldValidator class providing static validation methods
 */
export class FieldValidator {
  /**
   * Validate that a field is present and non-empty
   *
   * @param value - Value to validate
   * @param field - Field name for error reporting
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.required(data.name, 'name')
   * // Returns: null if valid, { field: 'name', message: '...' } if invalid
   */
  static required(value: any, field: string): ValidationError | null {
    // Check for undefined, null, or empty string after trimming
    if (value === undefined || value === null) {
      return {
        field,
        message: `${field} is required`
      };
    }

    // For strings, check if empty after trimming
    if (typeof value === 'string' && value.trim() === '') {
      return {
        field,
        message: `${field} is required and cannot be empty`
      };
    }

    return null;
  }

  /**
   * Validate that a field matches the expected JavaScript type
   *
   * @param value - Value to validate
   * @param expectedType - Expected type ('string', 'number', 'boolean', 'object', 'array')
   * @param field - Field name for error reporting
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.type(data.age, 'number', 'age')
   * // Returns: null if valid, { field: 'age', message: '...' } if invalid
   */
  static type(value: any, expectedType: string, field: string): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    // Special handling for arrays
    if (expectedType === 'array') {
      if (!Array.isArray(value)) {
        return {
          field,
          message: `${field} must be an array`
        };
      }
      return null;
    }

    const actualType = typeof value;
    if (actualType !== expectedType) {
      return {
        field,
        message: `${field} must be of type ${expectedType}, got ${actualType}`
      };
    }

    return null;
  }

  /**
   * Validate that a field value is in the allowed list
   *
   * @param value - Value to validate
   * @param allowed - Array of allowed values
   * @param field - Field name for error reporting
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.enum(data.category, ['creative', 'professional'], 'category')
   * // Returns: null if valid, { field: 'category', message: '...' } if invalid
   */
  static enum(value: any, allowed: string[], field: string): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (!allowed.includes(value)) {
      return {
        field,
        message: `${field} must be one of: ${allowed.join(', ')}. Got: ${value}`
      };
    }

    return null;
  }

  /**
   * Validate that a field is an array with optional minimum length
   *
   * @param value - Value to validate
   * @param field - Field name for error reporting
   * @param minLength - Optional minimum array length
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.array(data.elements, 'elements', 1)
   * // Returns: null if valid, { field: 'elements', message: '...' } if invalid
   */
  static array(value: any, field: string, minLength?: number): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (!Array.isArray(value)) {
      return {
        field,
        message: `${field} must be an array`
      };
    }

    if (minLength !== undefined && value.length < minLength) {
      return {
        field,
        message: `${field} must have at least ${minLength} item${minLength === 1 ? '' : 's'}`
      };
    }

    return null;
  }

  /**
   * Validate that a field is a valid semantic version
   *
   * Uses the semver package to validate version strings.
   *
   * @param value - Value to validate
   * @param field - Field name for error reporting
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.semver(data.version, 'version')
   * // Returns: null if valid, { field: 'version', message: '...' } if invalid
   */
  static semverVersion(value: any, field: string): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (typeof value !== 'string') {
      return {
        field,
        message: `${field} must be a string`
      };
    }

    if (!semver.valid(value)) {
      return {
        field,
        message: `${field} must be a valid semantic version (e.g., 1.0.0)`
      };
    }

    return null;
  }

  /**
   * Validate that a string length is within specified bounds
   *
   * @param value - Value to validate
   * @param field - Field name for error reporting
   * @param min - Minimum length (inclusive)
   * @param max - Maximum length (inclusive)
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.length(data.name, 'name', 1, 100)
   * // Returns: null if valid, { field: 'name', message: '...' } if invalid
   */
  static length(value: any, field: string, min: number, max: number): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (typeof value !== 'string') {
      return {
        field,
        message: `${field} must be a string`
      };
    }

    const length = value.length;

    if (length < min) {
      return {
        field,
        message: `${field} must be at least ${min} character${min === 1 ? '' : 's'} long`
      };
    }

    if (length > max) {
      return {
        field,
        message: `${field} must be at most ${max} character${max === 1 ? '' : 's'} long`
      };
    }

    return null;
  }

  /**
   * Validate that a field matches a regular expression pattern
   *
   * @param value - Value to validate
   * @param pattern - Regular expression pattern
   * @param field - Field name for error reporting
   * @param patternDescription - Human-readable description of the pattern
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.pattern(data.email, /^[^@]+@[^@]+$/, 'email', 'valid email address')
   * // Returns: null if valid, { field: 'email', message: '...' } if invalid
   */
  static pattern(
    value: any,
    pattern: RegExp,
    field: string,
    patternDescription?: string
  ): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (typeof value !== 'string') {
      return {
        field,
        message: `${field} must be a string`
      };
    }

    if (!pattern.test(value)) {
      const description = patternDescription ? ` (${patternDescription})` : '';
      return {
        field,
        message: `${field} must match the required pattern${description}`
      };
    }

    return null;
  }

  /**
   * Validate a number is within a specified range
   *
   * @param value - Value to validate
   * @param field - Field name for error reporting
   * @param min - Minimum value (inclusive)
   * @param max - Maximum value (inclusive)
   * @returns ValidationError if invalid, null if valid
   *
   * @example
   * FieldValidator.range(data.proficiency, 'proficiency', 0, 100)
   * // Returns: null if valid, { field: 'proficiency', message: '...' } if invalid
   */
  static range(value: any, field: string, min: number, max: number): ValidationError | null {
    if (value === undefined || value === null) {
      return null; // Use 'required' validator to check for presence
    }

    if (typeof value !== 'number') {
      return {
        field,
        message: `${field} must be a number`
      };
    }

    if (value < min || value > max) {
      return {
        field,
        message: `${field} must be between ${min} and ${max}`
      };
    }

    return null;
  }
}
