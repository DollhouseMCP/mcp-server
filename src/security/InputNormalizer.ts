/**
 * InputNormalizer - Industry-standard input normalization at the boundary
 *
 * Architecture Pattern: Defense in Depth - Normalize Once at Entry Point
 *
 * This utility enforces the principle of "normalize at the boundary" for security:
 * - Recursively normalizes ALL string values in input objects
 * - Uses UnicodeValidator.normalize() as the single normalization implementation
 * - Returns normalized object + aggregated security issues
 * - Validators receive clean, pre-normalized data
 *
 * Security Benefits:
 * - Single normalization point (no scattered validateContent calls)
 * - Can't forget to normalize a field
 * - Separation of concerns (normalization vs validation)
 * - Easier to audit and maintain
 *
 * Usage:
 * ```typescript
 * // At the validation boundary (GenericElementValidator)
 * const normalized = InputNormalizer.normalize(data);
 *
 * if (normalized.hasCriticalIssues) {
 *   return ValidatorHelpers.fail(normalized.errors);
 * }
 *
 * // Now validate the normalized data
 * const result = await this.validateFields(normalized.data);
 * ```
 *
 * @see UnicodeValidator.normalize() - Core normalization implementation
 * @see GenericElementValidator - Uses this at the boundary
 */

import { UnicodeValidator } from './validators/unicodeValidator.js';
import { SecurityMonitor } from './securityMonitor.js';

/**
 * Result from input normalization
 */
export interface NormalizationResult<T = unknown> {
  /** The normalized data structure with all strings normalized */
  data: T;
  /** Whether normalization detected any issues */
  hasIssues: boolean;
  /** Whether critical issues were detected that should fail validation */
  hasCriticalIssues: boolean;
  /** All errors detected during normalization (critical issues) */
  errors: string[];
  /** All warnings detected during normalization (non-critical issues) */
  warnings: string[];
  /** Detailed issues by path (for debugging) */
  issuesByPath: Map<string, string[]>;
  /** Highest severity level detected */
  maxSeverity?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * InputNormalizer - Recursively normalizes all string values in an object
 *
 * This class provides a centralized, recursive normalization utility that:
 * - Walks object/array structures recursively
 * - Normalizes every string value using UnicodeValidator
 * - Aggregates security issues across all fields
 * - Preserves non-string values unchanged
 * - Tracks normalization path for detailed error reporting
 */
export class InputNormalizer {
  /**
   * Normalize all string values in an object/array structure
   *
   * @param input - Input data to normalize (object, array, or primitive)
   * @param path - Current path in object tree (for error tracking)
   * @returns Normalization result with normalized data and detected issues
   *
   * @example
   * ```typescript
   * const input = {
   *   name: 'Test\u200BName',  // Zero-width space
   *   description: 'Café',      // Legitimate Unicode
   *   nested: {
   *     field: 'Val\u202Eue'    // Direction override
   *   }
   * };
   *
   * const result = InputNormalizer.normalize(input);
   * console.log(result.data.name);  // 'TestName' (cleaned)
   * console.log(result.warnings);   // ['name: Zero-width characters detected', ...]
   * ```
   */
  static normalize<T = unknown>(input: T, path: string = '$'): NormalizationResult<T> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const issuesByPath = new Map<string, string[]>();
    let maxSeverity: 'low' | 'medium' | 'high' | 'critical' | undefined;

    // Recursive normalization implementation
    const normalizeValue = (value: unknown, currentPath: string): unknown => {
      // Handle null/undefined
      if (value === null || value === undefined) {
        return value;
      }

      // Handle strings - this is where normalization happens
      if (typeof value === 'string') {
        const unicodeResult = UnicodeValidator.normalize(value);

        // Track issues for this field
        if (unicodeResult.detectedIssues && unicodeResult.detectedIssues.length > 0) {
          const pathIssues = unicodeResult.detectedIssues.map(
            issue => `${currentPath}: ${issue}`
          );
          issuesByPath.set(currentPath, unicodeResult.detectedIssues);

          // Categorize by severity
          if (unicodeResult.severity) {
            maxSeverity = this.escalateSeverity(maxSeverity, unicodeResult.severity);

            if (unicodeResult.severity === 'critical' || unicodeResult.severity === 'high') {
              errors.push(...pathIssues);
            } else {
              warnings.push(...pathIssues);
            }
          } else {
            warnings.push(...pathIssues);
          }
        }

        return unicodeResult.normalizedContent;
      }

      // Handle arrays - recursively normalize each element
      if (Array.isArray(value)) {
        return value.map((item, index) =>
          normalizeValue(item, `${currentPath}[${index}]`)
        );
      }

      // Handle objects - recursively normalize each property
      if (typeof value === 'object') {
        const normalized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          normalized[key] = normalizeValue(val, `${currentPath}.${key}`);
        }
        return normalized;
      }

      // Preserve other types unchanged (numbers, booleans, etc.)
      return value;
    };

    // Normalize the input
    const normalizedData = normalizeValue(input, path) as T;

    // Calculate aggregate status
    const hasIssues = errors.length > 0 || warnings.length > 0;
    const hasCriticalIssues = maxSeverity === 'critical' || maxSeverity === 'high';

    // Log if critical issues detected
    if (hasCriticalIssues) {
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: maxSeverity === 'critical' ? 'CRITICAL' : 'HIGH',
        source: 'InputNormalizer',
        details: `Critical Unicode issues detected during normalization: ${errors.join('; ')}`
      });
    }

    return {
      data: normalizedData,
      hasIssues,
      hasCriticalIssues,
      errors,
      warnings,
      issuesByPath,
      maxSeverity
    };
  }

  /**
   * Escalate severity level (higher severity takes precedence)
   */
  private static escalateSeverity(
    current: 'low' | 'medium' | 'high' | 'critical' | undefined,
    newSeverity: 'low' | 'medium' | 'high' | 'critical'
  ): 'low' | 'medium' | 'high' | 'critical' {
    const severityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    const currentLevel = current ? severityLevels[current] : 0;
    const newLevel = severityLevels[newSeverity];

    return newLevel > currentLevel ? newSeverity : (current || 'low');
  }

  /**
   * Quick check if input needs normalization (has suspicious Unicode)
   *
   * This is an optimization - you can check if normalization is needed
   * before doing expensive recursive normalization.
   *
   * @param input - Input data to check
   * @returns True if input contains potentially dangerous Unicode
   */
  static needsNormalization(input: unknown): boolean {
    if (typeof input === 'string') {
      return UnicodeValidator.containsDangerousUnicode(input);
    }

    if (Array.isArray(input)) {
      return input.some(item => this.needsNormalization(item));
    }

    if (input && typeof input === 'object') {
      return Object.values(input as Record<string, unknown>).some(
        value => this.needsNormalization(value)
      );
    }

    return false;
  }
}
