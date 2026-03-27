/**
 * ValidationService - Centralized validation and sanitization for DollhouseMCP
 *
 * Eliminates duplicate validation code across element managers by providing
 * a unified security-first validation approach.
 *
 * Key Features:
 * - Security-first pattern: validate → sanitize → re-validate
 * - Wraps existing validators (UnicodeValidator, ContentValidator, sanitizeInput)
 * - Consistent validation algorithm across all element types
 * - Comprehensive error reporting and logging
 * - Full TypeScript type safety
 *
 * Security Pattern:
 * The service enforces the correct validation sequence to prevent security bypasses:
 * 1. VALIDATE input against pattern/rules (reject malicious input)
 * 2. SANITIZE if validation passes (clean up input)
 * 3. RE-VALIDATE sanitized output (ensure sanitization didn't break constraints)
 *
 * WRONG (common bug):
 *   const sanitized = sanitizeInput(category);
 *   metadata.category = sanitized.toLowerCase(); // No validation!
 *
 * CORRECT (what this service enforces):
 *   if (!isValidCategory(category)) throw error;  // Validate FIRST
 *   const sanitized = sanitizeInput(category);     // Then sanitize
 *   if (!isValidCategory(sanitized)) throw error;  // Re-validate
 *
 * @example
 * ```typescript
 * import { validationService } from './services/ValidationService';
 *
 * // High-level coordinated validation
 * const result = validationService.validateAndSanitizeInput(userInput, {
 *   maxLength: 200,
 *   allowSpaces: true
 * });
 *
 * if (!result.isValid) {
 *   console.error(result.errors);
 * } else {
 *   use(result.sanitizedValue);
 * }
 *
 * // Metadata field validation
 * const categoryResult = validationService.validateCategory('creative');
 * const usernameResult = validationService.validateUsername('john-doe');
 * const emailResult = validationService.validateEmail('user@example.com');
 * ```
 */

import { sanitizeInput, validateCategory, validateUsername } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { ContentValidator } from '../../security/contentValidator.js';
import type { ContentValidatorOptions, ContentValidationResult } from '../../security/contentValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { VALIDATION_PATTERNS, PATTERN_DESCRIPTIONS } from '../../security/constants.js';

/**
 * Field types for validation with appropriate strictness levels
 */
export type ValidationFieldType = 'name' | 'description' | 'content' | 'filename';

/**
 * Options for input validation
 */
export interface InputValidationOptions {
  /** Maximum length of input (default: 1000) */
  maxLength?: number;
  /** Allow spaces in input (default: false) */
  allowSpaces?: boolean;
  /** Custom validation pattern (overrides default) */
  customPattern?: RegExp;
  /** Skip Unicode normalization (default: false) */
  skipUnicode?: boolean;
  /** Field type for appropriate validation strictness (default: validates based on allowSpaces) */
  fieldType?: ValidationFieldType;
}

/**
 * Options for metadata field validation
 */
export interface FieldValidationOptions {
  /** Whether field is required (default: true) */
  required?: boolean;
  /** Maximum field length (default: 500) */
  maxLength?: number;
  /** Custom validation pattern */
  pattern?: RegExp;
}

/**
 * Generic validation result
 */
export interface ValidationResult {
  /** Whether the input passed all validation checks */
  isValid: boolean;
  /** Sanitized and validated value (only present if isValid is true) */
  sanitizedValue?: string;
  /** List of validation errors (only present if isValid is false) */
  errors?: string[];
  /** List of validation warnings (non-fatal issues) */
  warnings?: string[];
}

/**
 * Field-specific validation result with additional metadata
 */
export interface FieldValidationResult extends ValidationResult {
  /** Original field name that was validated */
  fieldName?: string;
  /** Whether the field was empty before validation */
  wasEmpty?: boolean;
}

/**
 * Result from Unicode validation
 */
export interface UnicodeValidationResult {
  /** Whether the Unicode content is valid */
  isValid: boolean;
  /** Normalized Unicode content */
  normalizedContent: string;
  /** Detected Unicode issues */
  detectedIssues?: string[];
  /** Severity of detected issues */
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Service for validating and sanitizing input across all element types
 *
 * This service provides centralized validation to eliminate code duplication
 * and enforce the security-first validation pattern across the codebase.
 */
export class ValidationService {
  /**
   * Validate and sanitize general input with sanitize-then-validate approach
   *
   * Validation process:
   * 1. Check for empty/null input
   * 2. SANITIZE input first (remove control chars, shell metacharacters, dangerous patterns)
   * 3. Normalize Unicode if enabled (convert confusables, remove zero-width)
   * 4. VALIDATE the cleaned result against field-appropriate pattern
   * 5. Log any security issues detected
   *
   * This approach allows legitimate Unicode content (like "Cafe Assistant") to pass
   * while still blocking security threats after they've been normalized/sanitized.
   *
   * @param input - Raw input string to validate
   * @param options - Validation options
   * @returns Validation result with sanitized value or errors
   *
   * @example
   * ```typescript
   * const result = service.validateAndSanitizeInput('user-input', {
   *   maxLength: 100,
   *   allowSpaces: true,
   *   fieldType: 'name'
   * });
   *
   * if (result.isValid) {
   *   console.log('Clean input:', result.sanitizedValue);
   * } else {
   *   console.error('Validation failed:', result.errors);
   * }
   * ```
   */
  validateAndSanitizeInput(
    input: string,
    options: InputValidationOptions = {}
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const maxLength = options.maxLength ?? 1000;

    // Step 1: Check for empty/null input
    if (!input || typeof input !== 'string') {
      errors.push('Input must be a non-empty string');
      return { isValid: false, errors, warnings };
    }

    // Step 2: SANITIZE the input first (remove known threats)
    // This removes control chars, shell metacharacters, HTML tags, etc.
    let cleaned = sanitizeInput(input, maxLength);

    // Step 3: Unicode normalization (if not skipped)
    if (!options.skipUnicode) {
      const unicodeResult = this.normalizeUnicode(cleaned);
      cleaned = unicodeResult.normalizedContent;

      if (!unicodeResult.isValid && unicodeResult.detectedIssues) {
        warnings.push(...unicodeResult.detectedIssues.map(issue => `Unicode: ${issue}`));

        // Log high/critical Unicode issues
        if (unicodeResult.severity === 'high' || unicodeResult.severity === 'critical') {
          SecurityMonitor.logSecurityEvent({
            type: 'UNICODE_VALIDATION_ERROR',
            severity: unicodeResult.severity.toUpperCase() as 'HIGH' | 'CRITICAL',
            source: 'validation_service',
            details: `Unicode validation detected: ${unicodeResult.detectedIssues.join(', ')}`,
          });
        }
      }
    }

    // Step 4: Check if empty after sanitization
    if (!cleaned || cleaned.length === 0) {
      errors.push('Input is empty after sanitization');
      return { isValid: false, errors, warnings };
    }

    // Step 5: VALIDATE the cleaned result against field-appropriate pattern
    const pattern = this.getPatternForField(options);

    if (!pattern.test(cleaned)) {
      const desc = this.getPatternDescription(options);
      const invalidChars = desc ? this.findInvalidCharacters(cleaned, desc.charTest) : [];
      const charDetail = invalidChars.length > 0 ? `: ${this.formatCharList(invalidChars)}` : '';
      const allowedDetail = desc ? `. Allowed: ${desc.allowed}` : '';
      const structDetail = desc?.structural ? ` (${desc.structural})` : '';
      errors.push(`Input contains invalid characters${charDetail}${allowedDetail}${structDetail}`);
      return { isValid: false, errors, warnings };
    }

    // Validation success is the normal path — only failures need logging.
    // Failures throw errors with full context upstream.

    return {
      isValid: true,
      sanitizedValue: cleaned,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Get the appropriate validation pattern for a field type
   *
   * @param options - Input validation options
   * @returns RegExp pattern appropriate for the field type
   */
  private getPatternForField(options: InputValidationOptions): RegExp {
    // If custom pattern provided, use it
    if (options.customPattern) {
      return options.customPattern;
    }

    // Use field type if specified
    if (options.fieldType) {
      switch (options.fieldType) {
        case 'name':
          return VALIDATION_PATTERNS.SAFE_NAME;
        case 'description':
          return VALIDATION_PATTERNS.SAFE_DESCRIPTION;
        case 'content':
          return VALIDATION_PATTERNS.SAFE_CONTENT;
        case 'filename':
          return VALIDATION_PATTERNS.SAFE_FILENAME_CREATE;
      }
    }

    // Fall back to allowSpaces-based pattern for backward compatibility
    return options.allowSpaces
      ? VALIDATION_PATTERNS.SAFE_NAME  // Names/descriptions allow spaces and Unicode
      : VALIDATION_PATTERNS.SAFE_FILENAME_CREATE;  // No spaces = stricter filename pattern
  }

  /**
   * Validate a metadata field with sanitize-then-validate approach
   *
   * @param fieldName - Name of the field being validated
   * @param value - Field value to validate
   * @param options - Field validation options
   * @returns Field validation result
   *
   * @example
   * ```typescript
   * const result = service.validateMetadataField('category', 'creative', {
   *   required: true,
   *   maxLength: 50
   * });
   * ```
   */
  validateMetadataField(
    fieldName: string,
    value: unknown,
    options: FieldValidationOptions = {}
  ): FieldValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const required = options.required ?? true;
    const maxLength = options.maxLength ?? 500;

    // Check if value is string
    if (typeof value !== 'string') {
      if (required) {
        errors.push(`${fieldName}: Must be a string (got ${typeof value})`);
        return { isValid: false, errors, warnings, fieldName };
      }
      return { isValid: true, fieldName, wasEmpty: true };
    }

    // Check if empty
    const wasEmpty = value.trim().length === 0;
    if (wasEmpty && required) {
      errors.push(`${fieldName}: Required field cannot be empty`);
      return { isValid: false, errors, warnings, fieldName, wasEmpty };
    }

    if (wasEmpty && !required) {
      return { isValid: true, fieldName, wasEmpty };
    }

    // Length check
    if (value.length > maxLength) {
      errors.push(`${fieldName}: Exceeds maximum length of ${maxLength} characters`);
      return { isValid: false, errors, warnings, fieldName };
    }

    // SANITIZE first (remove known threats)
    const sanitized = sanitizeInput(value, maxLength);

    // Check if empty after sanitization
    if (!sanitized || sanitized.length === 0) {
      errors.push(`${fieldName}: Empty after sanitization`);
      return { isValid: false, errors, warnings, fieldName };
    }

    // VALIDATE the sanitized result
    // Use provided pattern or default to SAFE_NAME which allows Unicode letters
    const pattern = options.pattern ?? VALIDATION_PATTERNS.SAFE_NAME;
    if (!pattern.test(sanitized)) {
      const desc = this.getDescriptionForPattern(pattern);
      const invalidChars = desc ? this.findInvalidCharacters(sanitized, desc.charTest) : [];
      const charDetail = invalidChars.length > 0 ? `: ${this.formatCharList(invalidChars)}` : '';
      const allowedDetail = desc ? `. Allowed: ${desc.allowed}` : '';
      errors.push(`${fieldName}: Contains invalid characters${charDetail}${allowedDetail}`);
      return { isValid: false, errors, warnings, fieldName };
    }

    return {
      isValid: true,
      sanitizedValue: sanitized,
      warnings: warnings.length > 0 ? warnings : undefined,
      fieldName,
      wasEmpty,
    };
  }

  /**
   * Validate a category field
   *
   * Enforces security-first pattern:
   * 1. Validate format (lowercase letters and hyphens only)
   * 2. Sanitize input
   * 3. Re-validate sanitized output
   *
   * @param category - Category string to validate
   * @returns Validation result with sanitized category
   *
   * @example
   * ```typescript
   * const result = service.validateCategory('creative');
   * if (result.isValid) {
   *   metadata.category = result.sanitizedValue;
   * }
   * ```
   */
  validateCategory(category: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // VALIDATE before sanitization
      if (!category || typeof category !== 'string') {
        errors.push('Category must be a non-empty string');
        return { isValid: false, errors };
      }

      if (!VALIDATION_PATTERNS.SAFE_CATEGORY.test(category)) {
        const desc = PATTERN_DESCRIPTIONS.SAFE_CATEGORY;
        const invalidChars = this.findInvalidCharacters(category, desc.charTest);
        const charDetail = invalidChars.length > 0 ? `: ${this.formatCharList(invalidChars)}` : '';
        const structDetail = desc.structural ? ` (${desc.structural})` : '';
        errors.push(`Category contains invalid characters${charDetail}. Allowed: ${desc.allowed}${structDetail}`);
        return { isValid: false, errors };
      }

      // SANITIZE using existing validator (which also validates format)
      const sanitized = validateCategory(category);

      // RE-VALIDATE is done inside validateCategory()
      // The function throws if format is invalid, so if we get here, it's valid

      return {
        isValid: true,
        sanitizedValue: sanitized,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);

      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'MEDIUM',
        source: 'validation_service',
        details: `Category validation failed: ${errorMessage}`,
      });

      return { isValid: false, errors, warnings };
    }
  }

  /**
   * Validate a username field
   *
   * @param username - Username string to validate
   * @returns Validation result with sanitized username
   *
   * @example
   * ```typescript
   * const result = service.validateUsername('john-doe');
   * ```
   */
  validateUsername(username: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // VALIDATE before sanitization
      if (!username || typeof username !== 'string') {
        errors.push('Username must be a non-empty string');
        return { isValid: false, errors };
      }

      if (!VALIDATION_PATTERNS.SAFE_USERNAME.test(username)) {
        const desc = PATTERN_DESCRIPTIONS.SAFE_USERNAME;
        const invalidChars = this.findInvalidCharacters(username, desc.charTest);
        const charDetail = invalidChars.length > 0 ? `: ${this.formatCharList(invalidChars)}` : '';
        const structDetail = desc.structural ? ` (${desc.structural})` : '';
        errors.push(`Username contains invalid characters${charDetail}. Allowed: ${desc.allowed}${structDetail}`);
        return { isValid: false, errors };
      }

      // SANITIZE using existing validator (which also validates)
      const sanitized = validateUsername(username);

      return {
        isValid: true,
        sanitizedValue: sanitized,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);

      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'MEDIUM',
        source: 'validation_service',
        details: `Username validation failed: ${errorMessage}`,
      });

      return { isValid: false, errors, warnings };
    }
  }

  /**
   * Validate an email address
   *
   * @param email - Email address to validate
   * @returns Validation result with sanitized email
   *
   * @example
   * ```typescript
   * const result = service.validateEmail('user@example.com');
   * ```
   */
  validateEmail(email: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // VALIDATE format
      if (!email || typeof email !== 'string') {
        errors.push('Email must be a non-empty string');
        return { isValid: false, errors };
      }

      // Basic email pattern (more lenient for international domains)
      const emailPattern = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

      if (!emailPattern.test(email)) {
        errors.push('Invalid email format');
        return { isValid: false, errors };
      }

      // SANITIZE (trim and lowercase)
      const sanitized = email.trim().toLowerCase();

      // RE-VALIDATE after sanitization
      if (!emailPattern.test(sanitized)) {
        errors.push('Email invalid after sanitization');
        return { isValid: false, errors };
      }

      return {
        isValid: true,
        sanitizedValue: sanitized,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      return { isValid: false, errors, warnings };
    }
  }

  /**
   * Normalize Unicode content using UnicodeValidator
   *
   * Delegates to existing UnicodeValidator.normalize() to prevent
   * homograph attacks, direction override attacks, and other Unicode-based bypasses.
   *
   * @param text - Text to normalize
   * @returns Unicode validation result with normalized content
   *
   * @example
   * ```typescript
   * const result = service.normalizeUnicode('text with unicode');
   * console.log(result.normalizedContent);
   * ```
   */
  normalizeUnicode(text: string): UnicodeValidationResult {
    return UnicodeValidator.normalize(text);
  }

  /**
   * Validate content for security threats using ContentValidator
   *
   * Delegates to existing ContentValidator.validateAndSanitize() to detect
   * prompt injection, YAML bombs, command injection, and other content-based attacks.
   *
   * @param content - Content to validate
   * @param options - Content validation options
   * @returns Content validation result
   *
   * @example
   * ```typescript
   * const result = service.validateContent(personaContent, {
   *   skipSizeCheck: false
   * });
   *
   * if (!result.isValid) {
   *   console.error('Security threat detected:', result.detectedPatterns);
   * }
   * ```
   */
  validateContent(
    content: string,
    options?: ContentValidatorOptions
  ): ContentValidationResult {
    return ContentValidator.validateAndSanitize(content, options);
  }

  /**
   * Find characters in `input` that do not match `charTest`.
   * Returns deduplicated list of invalid characters.
   */
  private findInvalidCharacters(input: string, charTest: RegExp): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const ch of input) {
      if (!charTest.test(ch) && !seen.has(ch)) {
        seen.add(ch);
        result.push(ch);
      }
    }
    return result;
  }

  /**
   * Format a list of characters for display in error messages.
   * Labels spaces and non-printable characters; caps output at 5 unique chars.
   */
  private formatCharList(chars: string[]): string {
    const MAX_DISPLAY = 5;
    const display = chars.slice(0, MAX_DISPLAY).map(ch => {
      if (ch === ' ') return "' ' (space)";
      if (ch === '\t') return "'\\t' (tab)";
      if (ch === '\n') return "'\\n' (newline)";
      if (ch === '\r') return "'\\r' (carriage return)";
      // Non-printable: show unicode codepoint
      if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) {
        return `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      }
      return `'${ch}'`;
    });
    if (chars.length > MAX_DISPLAY) {
      display.push(`and ${chars.length - MAX_DISPLAY} more`);
    }
    return display.join(', ');
  }

  /**
   * Resolve which PATTERN_DESCRIPTIONS entry applies for InputValidationOptions.
   * Mirrors the logic of `getPatternForField`.
   */
  private getPatternDescription(options: InputValidationOptions) {
    if (options.customPattern) {
      return this.getDescriptionForPattern(options.customPattern);
    }
    if (options.fieldType) {
      switch (options.fieldType) {
        case 'name': return PATTERN_DESCRIPTIONS.SAFE_NAME;
        case 'description': return PATTERN_DESCRIPTIONS.SAFE_DESCRIPTION;
        case 'content': return PATTERN_DESCRIPTIONS.SAFE_CONTENT;
        case 'filename': return PATTERN_DESCRIPTIONS.SAFE_FILENAME_CREATE;
      }
    }
    return options.allowSpaces
      ? PATTERN_DESCRIPTIONS.SAFE_NAME
      : PATTERN_DESCRIPTIONS.SAFE_FILENAME_CREATE;
  }

  /**
   * Reverse-lookup from a RegExp instance to its PATTERN_DESCRIPTIONS entry.
   * Compares by source+flags. Returns undefined for unknown patterns.
   */
  private getDescriptionForPattern(pattern: RegExp) {
    const key = `${pattern.source}|${pattern.flags}`;
    for (const [name, vp] of Object.entries(VALIDATION_PATTERNS)) {
      if (`${vp.source}|${vp.flags}` === key) {
        return PATTERN_DESCRIPTIONS[name] ?? undefined;
      }
    }
    return undefined;
  }
}

/**
 * Singleton instance of ValidationService
 *
 * Use this instance throughout the application to ensure consistent
 * validation behavior across all element managers.
 *
 * @example
 * ```typescript
 * import { validationService } from './services/ValidationService';
 *
 * // In any element manager:
 * const result = validationService.validateCategory(metadata.category);
 * if (!result.isValid) {
 *   throw new Error(result.errors.join(', '));
 * }
 * metadata.category = result.sanitizedValue;
 * ```
 */
export const validationService = new ValidationService();
