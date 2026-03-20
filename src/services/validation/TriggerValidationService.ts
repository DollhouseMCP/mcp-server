/**
 * TriggerValidationService - Centralized trigger validation for all element types
 *
 * Eliminates duplicate trigger validation code across PersonaManager, SkillManager,
 * MemoryManager, TemplateManager, AgentManager, and EnsembleManager.
 *
 * Key Features:
 * - Unified validation rules for all element types (max 20 triggers, max 50 chars)
 * - Consistent validation algorithm across all element types
 * - Comprehensive error reporting and logging
 * - Full TypeScript type safety
 *
 * @example
 * ```typescript
 * import { triggerValidationService } from './services/TriggerValidationService';
 *
 * const result = triggerValidationService.validateTriggers(
 *   ['create', 'build', 'invalid!@#'],
 *   ElementType.SKILL,
 *   'my-skill'
 * );
 *
 * console.log(result.validTriggers); // ['create', 'build']
 * console.log(result.rejectedTriggers); // [{ original: 'invalid!@#', reason: '...' }]
 * ```
 */

import { ElementType } from '../../portfolio/types.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { logger } from '../../utils/logger.js';

/**
 * Details about a rejected trigger
 */
export interface RejectedTrigger {
  /** Original trigger value before sanitization */
  original: string;

  /** Human-readable reason why this trigger was rejected */
  reason: string;
}

/**
 * Result of trigger validation operation
 */
export interface TriggerValidationResult {
  /** Successfully validated triggers (sanitized and validated) */
  validTriggers: string[];

  /** Triggers that failed validation with reasons */
  rejectedTriggers: RejectedTrigger[];

  /** Whether any triggers were rejected during validation */
  hasRejections: boolean;

  /** Total count of input triggers (before validation) */
  totalInput: number;

  /** Warnings about truncation, limit exceeded, etc. */
  warnings: string[];
}

/**
 * Maximum number of triggers allowed for all element types
 */
const DEFAULT_MAX_TRIGGERS = 20;

/**
 * Maximum length of each trigger string after sanitization
 */
const DEFAULT_MAX_TRIGGER_LENGTH = 50;

/**
 * Validation pattern for triggers
 *
 * Allowed characters: a-z, A-Z, 0-9, hyphen (-), underscore (_), at (@), period (.)
 *
 * Valid trigger examples:
 * - "code-review"      - kebab-case keywords
 * - "bug_fix"          - snake_case keywords
 * - "@username"        - social media mentions
 * - "user@example.com" - email addresses
 * - "api.docs"         - domain-style patterns
 * - "v2.0"             - version numbers
 *
 * Invalid trigger examples (will be rejected):
 * - "bad!trigger"      - shell metacharacter !
 * - "cmd;injection"    - shell metacharacter ;
 * - "$(evil)"          - command substitution
 * - "with spaces"      - spaces not allowed
 * - "<script>"         - HTML characters
 *
 * Security note: @ and . are intentionally allowed as they are NOT shell
 * metacharacters and enable common use cases (mentions, emails, domains).
 */
const DEFAULT_VALIDATION_PATTERN = /^[a-zA-Z0-9\-_@.]+$/;

/**
 * Service for validating and processing trigger arrays across all element types
 *
 * This service provides centralized trigger validation to eliminate code duplication
 * across element managers. All element types use the same validation rules:
 * - Maximum 20 triggers
 * - Maximum 50 characters per trigger
 * - Only alphanumeric, hyphens, underscores, @, and . allowed
 */
export class TriggerValidationService {
  constructor() {
    // No configuration needed - all element types use same rules
  }

  /**
   * Validate an array of triggers for a specific element type
   *
   * Validation process:
   * 1. Limit input array to MAX_TRIGGERS (20)
   * 2. For each trigger:
   *    a. Convert to string
   *    b. Sanitize (remove dangerous characters, trim, limit length to 50)
   *    c. Check if empty after sanitization
   *    d. Validate against regex pattern (/^[a-zA-Z0-9\-_@.]+$/)
   * 3. Collect valid and rejected triggers
   * 4. Log warnings if truncation or rejections occurred
   *
   * @param triggers - Raw trigger array from user input or metadata
   * @param elementType - Type of element being validated (used for logging context)
   * @param elementName - Name of element (used for logging context)
   * @returns Validation result with valid/rejected triggers and warnings
   *
   * @example
   * ```typescript
   * const result = service.validateTriggers(
   *   ['create', 'build', 'test!@#', ''],
   *   ElementType.SKILL,
   *   'code-generator'
   * );
   * // result.validTriggers: ['create', 'build']
   * // result.rejectedTriggers: [
   * //   { original: 'test!@#', reason: '(invalid format ...)' },
   * //   { original: '', reason: '(empty)' }
   * // ]
   * ```
   */
  validateTriggers(
    triggers: string[],
    elementType: ElementType,
    elementName: string
  ): TriggerValidationResult {
    // Handle edge cases
    if (!triggers || !Array.isArray(triggers)) {
      return this.createEmptyResult(0);
    }

    if (triggers.length === 0) {
      return this.createEmptyResult(0);
    }

    const totalInput = triggers.length;

    // Initialize result containers
    const validTriggers: string[] = [];
    const rejectedTriggers: RejectedTrigger[] = [];
    const warnings: string[] = [];

    // Limit input to MAX_TRIGGERS
    const limitedTriggers = triggers.slice(0, DEFAULT_MAX_TRIGGERS);

    // Warn if we had to truncate
    if (totalInput > DEFAULT_MAX_TRIGGERS) {
      const warning = `Trigger limit exceeded (${totalInput} > ${DEFAULT_MAX_TRIGGERS}), truncating`;
      warnings.push(warning);

      logger.warn(
        `${elementType} "${elementName}": ${warning}`,
        {
          elementType,
          elementName,
          providedCount: totalInput,
          limit: DEFAULT_MAX_TRIGGERS,
          truncated: totalInput - DEFAULT_MAX_TRIGGERS
        }
      );
    }

    // Validate each trigger
    for (const rawTrigger of limitedTriggers) {
      // Convert to string (handle non-string inputs)
      const triggerString = String(rawTrigger).trim();

      // Check if empty
      if (!triggerString || triggerString.length === 0) {
        rejectedTriggers.push({
          original: rawTrigger,
          reason: '(empty)'
        });
        continue;
      }

      // SECURITY: Validate BEFORE sanitization to reject invalid characters
      // This prevents 'bad!trigger' from becoming 'badtrigger' and passing
      if (!DEFAULT_VALIDATION_PATTERN.test(triggerString)) {
        rejectedTriggers.push({
          original: rawTrigger,
          reason: '(invalid format - allowed: letters, numbers, hyphens, underscores, @ and .)'
        });
        continue;
      }

      // Now sanitize the already-valid trigger (for length limits, etc.)
      const sanitized = sanitizeInput(triggerString, DEFAULT_MAX_TRIGGER_LENGTH);

      // Check if empty after sanitization
      if (!sanitized || sanitized.length === 0) {
        rejectedTriggers.push({
          original: rawTrigger,
          reason: '(empty after sanitization)'
        });
        continue;
      }

      // Passed all validation - add to valid list
      validTriggers.push(sanitized);
    }

    // Log rejections if any
    if (rejectedTriggers.length > 0) {
      logger.warn(
        `${elementType} "${elementName}": Rejected ${rejectedTriggers.length} invalid trigger(s)`,
        {
          elementType,
          elementName,
          rejectedTriggers: rejectedTriggers.map(r => `"${r.original}" ${r.reason}`),
          acceptedCount: validTriggers.length
        }
      );
    }

    // Log debug info
    logger.debug(
      `[TriggerValidationService] Validated triggers for ${elementType} "${elementName}"`,
      {
        elementType,
        elementName,
        totalInput,
        validCount: validTriggers.length,
        rejectedCount: rejectedTriggers.length,
        truncated: totalInput > DEFAULT_MAX_TRIGGERS
      }
    );

    return {
      validTriggers,
      rejectedTriggers,
      hasRejections: rejectedTriggers.length > 0,
      totalInput,
      warnings
    };
  }

  /**
   * Create an empty validation result
   *
   * @param totalInput - Total count of input triggers
   * @returns Empty result with no valid or rejected triggers
   * @private
   */
  private createEmptyResult(totalInput: number): TriggerValidationResult {
    return {
      validTriggers: [],
      rejectedTriggers: [],
      hasRejections: false,
      totalInput,
      warnings: []
    };
  }
}
