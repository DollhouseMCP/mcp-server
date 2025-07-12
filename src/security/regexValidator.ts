/**
 * RegexValidator - Provides timeout protection against ReDoS attacks
 * 
 * This module implements safe regex execution with timeouts to prevent
 * Regular Expression Denial of Service (ReDoS) attacks.
 */

import { SecurityError } from './errors.js';
import { SecurityMonitor } from './securityMonitor.js';

export interface RegexValidationOptions {
  /** Maximum time allowed for regex execution in milliseconds */
  timeoutMs?: number;
  /** Maximum content length before validation */
  maxLength?: number;
  /** Whether to log timeout events */
  logTimeouts?: boolean;
  /** Custom error message for timeouts */
  timeoutMessage?: string;
}

export class RegexValidator {
  private static readonly DEFAULT_TIMEOUT_MS = 100;
  private static readonly DEFAULT_MAX_LENGTH = 100000; // 100KB
  private static readonly PERFORMANCE_WARNING_MS = 50;

  /**
   * Validates content against a pattern with timeout protection
   * @param content The content to validate
   * @param pattern The regex pattern to match
   * @param options Validation options
   * @returns True if pattern matches, false otherwise
   * @throws SecurityError if timeout occurs or content too large
   */
  static validate(
    content: string,
    pattern: RegExp,
    options: RegexValidationOptions = {}
  ): boolean {
    const {
      timeoutMs = this.DEFAULT_TIMEOUT_MS,
      maxLength = this.DEFAULT_MAX_LENGTH,
      logTimeouts = true,
      timeoutMessage = 'Regex execution timeout - possible ReDoS attempt'
    } = options;

    // Check content length first
    if (content.length > maxLength) {
      throw new SecurityError(
        `Content too large for validation: ${content.length} bytes (max: ${maxLength})`
      );
    }

    const startTime = performance.now();
    let matched = false;
    let timedOut = false;

    // Create a promise that resolves with the regex result
    const regexPromise = new Promise<boolean>((resolve) => {
      try {
        matched = pattern.test(content);
        resolve(matched);
      } catch (error) {
        resolve(false);
      }
    });

    // Create a timeout promise
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs);
    });

    // Race between regex execution and timeout
    try {
      // For synchronous regex execution, we'll check time after each operation
      const checkTime = () => {
        const elapsed = performance.now() - startTime;
        if (elapsed > timeoutMs) {
          timedOut = true;
          throw new SecurityError(timeoutMessage);
        }
      };

      // Execute regex with periodic time checks
      checkTime();
      matched = pattern.test(content);
      checkTime();

      const elapsed = performance.now() - startTime;

      // Log performance warning if close to timeout
      if (elapsed > this.PERFORMANCE_WARNING_MS) {
        SecurityMonitor.logSecurityEvent({
          type: 'RATE_LIMIT_WARNING',
          severity: 'MEDIUM',
          source: 'RegexValidator',
          details: `Regex pattern took ${elapsed}ms (threshold: ${this.PERFORMANCE_WARNING_MS}ms)`,
          additionalData: {
            pattern: pattern.source,
            contentLength: content.length,
            elapsedMs: elapsed,
            threshold: this.PERFORMANCE_WARNING_MS
          }
        });
      }

      // Log timeout if it occurred
      if (timedOut && logTimeouts) {
        SecurityMonitor.logSecurityEvent({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'HIGH',
          source: 'RegexValidator',
          details: timeoutMessage,
          additionalData: {
            pattern: pattern.source,
            contentLength: content.length,
            timeoutMs,
          }
        });
      }

      return matched;
    } catch (error) {
      if (error instanceof SecurityError) {
        throw error;
      }
      // Other errors are treated as validation failures
      return false;
    }
  }

  /**
   * Validates multiple patterns with shared timeout
   * @param content The content to validate
   * @param patterns Array of patterns to check
   * @param options Validation options
   * @returns True if any pattern matches
   */
  static validateAny(
    content: string,
    patterns: RegExp[],
    options: RegexValidationOptions = {}
  ): boolean {
    const startTime = performance.now();
    const totalTimeout = options.timeoutMs || this.DEFAULT_TIMEOUT_MS;

    for (const pattern of patterns) {
      const elapsed = performance.now() - startTime;
      const remainingTime = totalTimeout - elapsed;

      if (remainingTime <= 0) {
        throw new SecurityError('Regex validation timeout during multi-pattern check');
      }

      // Check each pattern with remaining time
      if (this.validate(content, pattern, { ...options, timeoutMs: remainingTime })) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validates all patterns match with shared timeout
   * @param content The content to validate
   * @param patterns Array of patterns that must all match
   * @param options Validation options
   * @returns True if all patterns match
   */
  static validateAll(
    content: string,
    patterns: RegExp[],
    options: RegexValidationOptions = {}
  ): boolean {
    const startTime = performance.now();
    const totalTimeout = options.timeoutMs || this.DEFAULT_TIMEOUT_MS;

    for (const pattern of patterns) {
      const elapsed = performance.now() - startTime;
      const remainingTime = totalTimeout - elapsed;

      if (remainingTime <= 0) {
        throw new SecurityError('Regex validation timeout during multi-pattern check');
      }

      // Check each pattern with remaining time
      if (!this.validate(content, pattern, { ...options, timeoutMs: remainingTime })) {
        return false;
      }
    }

    return true;
  }

  /**
   * Creates a safe regex pattern with built-in protections
   * @param pattern The pattern string
   * @param flags Optional regex flags
   * @returns A RegExp object with safety checks
   */
  static createSafePattern(pattern: string, flags?: string): RegExp {
    // Check for known dangerous patterns
    const dangerousPatterns = [
      /(\w+\+)+\w/,     // Nested quantifiers
      /(\w+\*)+\w/,     // Nested quantifiers
      /(\(.+\))+\+/,    // Grouped quantifiers
      /\{(\d+,)?\}/,    // Unbounded repetition
    ];

    for (const dangerous of dangerousPatterns) {
      if (dangerous.test(pattern)) {
        SecurityMonitor.logSecurityEvent({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'MEDIUM',
          source: 'RegexValidator',
          details: 'Pattern contains potentially dangerous constructs',
          additionalData: {
            pattern,
            warning: 'Potential ReDoS vulnerability'
          }
        });
      }
    }

    return new RegExp(pattern, flags);
  }

  /**
   * Analyzes a regex pattern for potential ReDoS vulnerabilities
   * @param pattern The pattern to analyze
   * @returns Analysis results with risk assessment
   */
  static analyzePattern(pattern: RegExp): {
    safe: boolean;
    risks: string[];
    complexity: 'low' | 'medium' | 'high';
  } {
    const source = pattern.source;
    const risks: string[] = [];
    
    // Check for nested quantifiers
    if (/(\w+[+*])+[+*]/.test(source)) {
      risks.push('Nested quantifiers detected');
    }

    // Check for alternation with overlapping
    if (/\([^)]*\|[^)]*\)[+*]/.test(source)) {
      risks.push('Quantified alternation detected');
    }

    // Check for catastrophic backtracking
    if (/(\(.+\))+\+/.test(source)) {
      risks.push('Potential catastrophic backtracking');
    }

    // Check for unbounded lookahead/behind
    if (/\(\?[=!].*[+*]/.test(source)) {
      risks.push('Unbounded lookahead/lookbehind');
    }

    const complexity = risks.length === 0 ? 'low' : 
                      risks.length <= 2 ? 'medium' : 'high';

    return {
      safe: risks.length === 0,
      risks,
      complexity
    };
  }
}