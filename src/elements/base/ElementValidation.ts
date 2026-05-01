/**
 * ElementValidation - Common validation logic for element managers
 *
 * Provides shared validation patterns for all element types:
 * - Name, description, category validation
 * - Trigger word validation
 * - Author and version validation
 *
 * SECURITY: All validation uses sanitizeInput and proper type checking
 * UNICODE HANDLING: Uses UnicodeValidator for safe string processing
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This file provides validation utilities only.
 * No audit logging is required - logging happens in the calling managers.
 * @security-audit-suppress DMCP-SEC-006
 */

import { sanitizeInput } from '../../security/InputValidator.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

/**
 * Validation constants shared across element types
 */
export const VALIDATION_CONSTANTS = {
  MAX_NAME_LENGTH: 100,
  MAX_CATEGORY_LENGTH: 50,
  MAX_TAG_LENGTH: 50,
  MAX_AUTHOR_LENGTH: 100,
  MAX_VERSION_LENGTH: 20,
  MAX_TRIGGER_LENGTH: 50,
  MAX_TRIGGERS: 20,
  // Allows alphanumeric, hyphens, underscores, @ (mentions/emails), . (domains)
  TRIGGER_VALIDATION_REGEX: /^[a-zA-Z0-9\-_@.]+$/
} as const;

/**
 * Result of trigger validation
 */
export interface TriggerValidationResult {
  valid: string[];
  rejected: string[];
  warnings: string[];
}

/**
 * Static utility class for common validation operations
 */
export class ElementValidation {
  /**
   * Validate and sanitize a name field
   * Applies Unicode normalization and length limits
   *
   * @param name - Raw name value
   * @param maxLength - Maximum length (default: 100)
   * @returns Sanitized name
   */
  static validateName(name: any, maxLength: number = VALIDATION_CONSTANTS.MAX_NAME_LENGTH): string {
    if (!name) {
      throw new Error('Name is required');
    }

    const normalized = UnicodeValidator.normalize(String(name));
    const sanitized = sanitizeInput(normalized.normalizedContent, maxLength);

    if (!sanitized) {
      throw new Error('Name is empty after sanitization');
    }

    return sanitized;
  }

  /**
   * Validate and sanitize a description field
   *
   * @param description - Raw description value
   * @param maxLength - Maximum length (default: global content limit)
   * @returns Sanitized description or undefined
   */
  static validateDescription(
    description: any,
    maxLength: number = SECURITY_LIMITS.MAX_CONTENT_LENGTH
  ): string | undefined {
    if (!description) {
      return undefined;
    }

    const normalized = UnicodeValidator.normalize(String(description));
    return sanitizeInput(normalized.normalizedContent, maxLength) || undefined;
  }

  /**
   * Validate and sanitize an author field
   *
   * @param author - Raw author value
   * @returns Sanitized author or undefined
   */
  static validateAuthor(author: any): string | undefined {
    if (!author) {
      return undefined;
    }

    return sanitizeInput(String(author), VALIDATION_CONSTANTS.MAX_AUTHOR_LENGTH) || undefined;
  }

  /**
   * Validate and sanitize a version string
   *
   * @param version - Raw version value
   * @returns Sanitized version or undefined
   */
  static validateVersion(version: any): string | undefined {
    if (!version) {
      return undefined;
    }

    return sanitizeInput(String(version), VALIDATION_CONSTANTS.MAX_VERSION_LENGTH) || undefined;
  }

  /**
   * Validate and sanitize an array of tags
   *
   * @param tags - Raw tags array
   * @returns Sanitized tags array
   */
  static validateTags(tags: any): string[] {
    if (!Array.isArray(tags)) {
      return [];
    }

    return tags
      .filter(tag => tag !== null && tag !== undefined && tag !== '') // Filter out null/undefined/empty BEFORE converting
      .map(tag => sanitizeInput(String(tag), VALIDATION_CONSTANTS.MAX_TAG_LENGTH))
      .filter((tag): tag is string => tag !== null && tag.length > 0);
  }

  /**
   * Validate and process triggers with detailed logging
   * Follows pattern from SkillManager (Issue #1139) and MemoryManager (Issue #1133)
   *
   * @param triggers - Raw triggers array
   * @param elementName - Element name for logging
   * @param maxTriggers - Maximum number of triggers (default: 20)
   * @returns Validation result with valid and rejected triggers
   */
  static validateTriggers(
    triggers: any[],
    elementName: string = 'unknown',
    maxTriggers: number = VALIDATION_CONSTANTS.MAX_TRIGGERS
  ): TriggerValidationResult {
    const result: TriggerValidationResult = {
      valid: [],
      rejected: [],
      warnings: []
    };

    if (!Array.isArray(triggers) || triggers.length === 0) {
      return result;
    }

    // Limit to max triggers
    const rawTriggers = triggers.slice(0, maxTriggers);

    // Validate each trigger
    // SECURITY: Validate BEFORE sanitization to reject invalid characters
    // This prevents 'bad!trigger' from becoming 'badtrigger' and passing
    for (const raw of rawTriggers) {
      const rawTrigger = String(raw).trim();

      // Check if empty
      if (!rawTrigger) {
        result.rejected.push(`"${raw}" (empty)`);
        continue;
      }

      // SECURITY: Validate format BEFORE sanitization
      if (!VALIDATION_CONSTANTS.TRIGGER_VALIDATION_REGEX.test(rawTrigger)) {
        result.rejected.push(
          `"${raw}" (invalid format - allowed: letters, numbers, hyphens, underscores, @ and .)`
        );
        continue;
      }

      // Only sanitize AFTER validation passes (for length limits)
      const sanitized = sanitizeInput(rawTrigger, VALIDATION_CONSTANTS.MAX_TRIGGER_LENGTH);
      if (sanitized) {
        result.valid.push(sanitized);
      }
    }

    // Generate warnings
    if (result.rejected.length > 0) {
      result.warnings.push(
        `Element "${elementName}": Rejected ${result.rejected.length} invalid trigger(s)`
      );
    }

    if (triggers.length > maxTriggers) {
      result.warnings.push(
        `Element "${elementName}": Trigger limit exceeded (${triggers.length} > ${maxTriggers})`
      );
    }

    // Log warnings
    result.warnings.forEach(warning => logger.warn(warning, {
      elementName,
      rejectedTriggers: result.rejected,
      acceptedCount: result.valid.length
    }));

    // FIX: DMCP-SEC-006 - Add security audit logging for validation
    if (result.rejected.length > 0) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_VALIDATED',
        severity: 'LOW',
        source: 'ElementValidation.validateTriggers',
        details: `Trigger validation rejected ${result.rejected.length} invalid trigger(s) for ${elementName}`,
        additionalData: { elementName, rejectedCount: result.rejected.length }
      });
    }

    return result;
  }

  /**
   * Validate a category field
   *
   * @param category - Raw category value
   * @returns Sanitized category or undefined
   */
  static validateCategory(category: any): string | undefined {
    if (!category) {
      return undefined;
    }

    return sanitizeInput(String(category), VALIDATION_CONSTANTS.MAX_CATEGORY_LENGTH) || undefined;
  }

  /**
   * Validate and sanitize common element metadata fields
   * Returns an object with all common validated fields
   *
   * @param data - Raw metadata object
   * @returns Validated common metadata fields
   */
  static validateCommonMetadata(data: any): {
    name?: string;
    description?: string;
    author?: string;
    version?: string;
    category?: string;
    tags?: string[];
    triggers?: string[];
  } {
    const result: any = {};

    // Validate name (required for most elements)
    if (data.name) {
      try {
        result.name = this.validateName(data.name);
      } catch {
        // Name validation failed, let caller handle
      }
    }

    // Validate optional fields
    result.description = this.validateDescription(data.description);
    result.author = this.validateAuthor(data.author);
    result.version = this.validateVersion(data.version);
    result.category = this.validateCategory(data.category);
    result.tags = this.validateTags(data.tags);

    // Validate triggers if present
    if (data.triggers && Array.isArray(data.triggers)) {
      const triggerResult = this.validateTriggers(data.triggers, data.name || 'unknown');
      result.triggers = triggerResult.valid;
    }

    return result;
  }

  /**
   * Validate a numeric field with min/max bounds
   *
   * @param value - Raw numeric value
   * @param min - Minimum value (default: 0)
   * @param max - Maximum value (default: Number.MAX_SAFE_INTEGER)
   * @returns Validated number
   */
  static validateNumber(
    value: any,
    min: number = 0,
    max: number = Number.MAX_SAFE_INTEGER
  ): number {
    // Reject null/undefined explicitly
    if (value === null || value === undefined) {
      throw new Error(`Invalid number: ${value}`);
    }

    const num = Number(value);

    if (isNaN(num)) {
      throw new Error(`Invalid number: ${value}`);
    }

    if (num < min || num > max) {
      throw new Error(`Number out of range: ${num} (min: ${min}, max: ${max})`);
    }

    return num;
  }

  /**
   * Validate a boolean field
   *
   * @param value - Raw boolean value
   * @param defaultValue - Default if value is undefined
   * @returns Boolean value
   */
  static validateBoolean(value: any, defaultValue: boolean = false): boolean {
    if (value === undefined || value === null) {
      return defaultValue;
    }

    return Boolean(value);
  }
}
