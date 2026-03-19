/**
 * MemoryElementValidator - Specialized validator for Memory elements
 *
 * Extends GenericElementValidator to add Memory-specific validation:
 * - Storage backend validation
 * - Retention policy validation
 * - Auto-load flag validation
 * - Entry size validation
 */

import { ElementType } from '../../portfolio/types.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { ValidationResult, ValidatorHelpers, ElementValidationOptions } from './ElementValidator.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
import { MEMORY_CONSTANTS } from '../../elements/memories/constants.js';

const VALID_STORAGE_BACKENDS = ['file', 'memory', 'sqlite', 'hybrid'];
const VALID_RETENTION_PATTERNS = /^(\d+)([dDwWmMyY])$/; // e.g., "30d", "1y", "6m"

export class MemoryElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(ElementType.MEMORY, validationService, triggerValidationService, metadataService);
  }

  /**
   * Override validateCreate to add memory-specific validation
   */
  override async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    // First run generic validation
    const baseResult = await super.validateCreate(data, options);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];
    const suggestions = [...(baseResult.suggestions || [])];

    if (!data || typeof data !== 'object') {
      return baseResult;
    }

    const record = data as Record<string, unknown>;

    // Validate storage backend
    if (record.storageBackend !== undefined || record.storage_backend !== undefined) {
      const backend = record.storageBackend || record.storage_backend;
      const backendResult = this.validateStorageBackend(backend);
      if (!backendResult.isValid) {
        errors.push(...backendResult.errors);
      }
      warnings.push(...backendResult.warnings);
    }

    // Validate retention policy
    if (record.retentionDays !== undefined || record.retention_days !== undefined) {
      const retention = record.retentionDays || record.retention_days;
      const retentionResult = this.validateRetentionDays(retention);
      if (!retentionResult.isValid) {
        errors.push(...retentionResult.errors);
      }
      warnings.push(...retentionResult.warnings);
    }

    // Validate retention policy object format
    if (record.retention_policy !== undefined) {
      const policyResult = this.validateRetentionPolicy(record.retention_policy);
      if (!policyResult.isValid) {
        errors.push(...policyResult.errors);
      }
      warnings.push(...policyResult.warnings);
    }

    // Validate auto-load flag
    if (record.autoLoad !== undefined || record.auto_load !== undefined) {
      // Use ternary to properly handle false values (|| treats false as falsy)
      const autoLoad = record.autoLoad !== undefined ? record.autoLoad : record.auto_load;
      const autoLoadResult = this.validateAutoLoad(autoLoad);
      if (!autoLoadResult.isValid) {
        errors.push(...autoLoadResult.errors);
      }
      warnings.push(...autoLoadResult.warnings);
    }

    // Validate priority if autoLoad is true
    if ((record.autoLoad === true || record.auto_load === true) && record.priority !== undefined) {
      const priorityResult = this.validatePriority(record.priority);
      if (!priorityResult.isValid) {
        errors.push(...priorityResult.errors);
      }
      warnings.push(...priorityResult.warnings);
    }

    // Memory-specific suggestions
    if (!record.storageBackend && !record.storage_backend) {
      suggestions.push(`Consider specifying a storage backend (default: ${MEMORY_CONSTANTS.DEFAULT_STORAGE_BACKEND})`);
    }

    if (!record.retentionDays && !record.retention_days && !record.retention_policy) {
      suggestions.push('Consider setting a retention policy for memory entries');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate storage backend
   */
  private validateStorageBackend(backend: unknown): ValidationResult {
    if (typeof backend !== 'string') {
      return ValidatorHelpers.fail(['Storage backend must be a string']);
    }

    const sanitized = this.validationService.validateAndSanitizeInput(backend, {
      maxLength: 20,
      allowSpaces: false
    });

    if (!sanitized.isValid) {
      return ValidatorHelpers.fail(sanitized.errors || ['Invalid storage backend']);
    }

    const normalizedBackend = sanitized.sanitizedValue!.toLowerCase();
    if (!VALID_STORAGE_BACKENDS.includes(normalizedBackend)) {
      return ValidatorHelpers.fail([
        `Invalid storage backend '${normalizedBackend}'. Valid options: ${VALID_STORAGE_BACKENDS.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate retention days (number or string format like "30d")
   */
  private validateRetentionDays(retention: unknown): ValidationResult {
    if (retention === null || retention === undefined) {
      return ValidatorHelpers.pass();
    }

    // Handle numeric retention days
    // Note: Memories are permanent by default. We only validate that the value is valid,
    // not that it's "too long" - permanent retention is expected behavior.
    if (typeof retention === 'number') {
      if (!Number.isInteger(retention) || retention < 0) {
        return ValidatorHelpers.fail(['Retention days must be a positive integer']);
      }
      return ValidatorHelpers.pass();
    }

    // Handle string format (e.g., "30d", "1y")
    if (typeof retention === 'string') {
      const match = retention.match(VALID_RETENTION_PATTERNS);
      if (!match) {
        return ValidatorHelpers.fail([
          'Invalid retention format. Use number of days or format like "30d", "6m", "1y"'
        ]);
      }

      // Format is valid - no need to validate the actual duration
      // since permanent retention is the expected default
      return ValidatorHelpers.pass();
    }

    return ValidatorHelpers.fail(['Retention must be a number or string like "30d"']);
  }

  /**
   * Validate retention policy object
   */
  private validateRetentionPolicy(policy: unknown): ValidationResult {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      return ValidatorHelpers.fail(['Retention policy must be an object']);
    }

    const policyObj = policy as Record<string, unknown>;
    const warnings: string[] = [];

    // Validate default retention
    if (policyObj.default !== undefined) {
      const defaultResult = this.validateRetentionDays(policyObj.default);
      if (!defaultResult.isValid) {
        return ValidatorHelpers.fail([
          `Invalid default retention: ${defaultResult.errors.join(', ')}`
        ]);
      }
      warnings.push(...defaultResult.warnings);
    }

    // Validate tag-specific retentions
    if (policyObj.byTag !== undefined && policyObj.by_tag !== undefined) {
      const byTag = policyObj.byTag || policyObj.by_tag;
      if (typeof byTag !== 'object' || Array.isArray(byTag)) {
        return ValidatorHelpers.fail(['Retention policy byTag must be an object']);
      }

      for (const [tag, retention] of Object.entries(byTag as Record<string, unknown>)) {
        const tagResult = this.validateRetentionDays(retention);
        if (!tagResult.isValid) {
          return ValidatorHelpers.fail([
            `Invalid retention for tag '${tag}': ${tagResult.errors.join(', ')}`
          ]);
        }
        warnings.push(...tagResult.warnings.map(w => `Tag '${tag}': ${w}`));
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }

  /**
   * Validate auto-load flag
   */
  private validateAutoLoad(autoLoad: unknown): ValidationResult {
    if (typeof autoLoad !== 'boolean') {
      return ValidatorHelpers.fail(['Auto-load flag must be a boolean']);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate priority for auto-load memories
   */
  private validatePriority(priority: unknown): ValidationResult {
    if (typeof priority !== 'number') {
      return ValidatorHelpers.fail(['Priority must be a number']);
    }

    if (!Number.isInteger(priority) || priority < 1 || priority > 99) {
      return ValidatorHelpers.fail(['Priority must be an integer between 1 and 99']);
    }

    if (priority > 50) {
      return {
        isValid: true,
        errors: [],
        warnings: ['High priority (> 50) memories will load very early in the session']
      };
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Override validateContent for memory-specific size limits
   */
  protected override async validateContent(
    content: unknown,
    maxLength?: number
  ): Promise<ValidationResult> {
    // Use memory-specific max size
    const maxSize = maxLength || MEMORY_CONSTANTS.MAX_ENTRY_SIZE || 100000;
    return super.validateContent(content, maxSize);
  }
}