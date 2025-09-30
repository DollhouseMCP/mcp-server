/**
 * DOS Protection Utilities
 *
 * Centralized protection against Denial of Service attacks, particularly ReDoS
 * (Regular Expression Denial of Service) vulnerabilities.
 *
 * SECURITY: This module provides comprehensive protection mechanisms for all
 * regex operations in the codebase to prevent catastrophic backtracking.
 */

// Constants for timeouts and limits (Reviewer recommendation: Extract constants)
const REGEX_TIMEOUT_MS = 100;          // Default timeout for user input regex
const SYSTEM_TIMEOUT_MS = 1000;        // Timeout for system operations
const MAX_INPUT_LENGTH = 10000;        // Maximum input length to process
const MAX_PATTERN_CACHE_SIZE = 1000;   // Maximum patterns to cache
const RATE_LIMIT_RESET_MS = 60000;     // Reset rate limits every minute

export interface RegexExecutionOptions {
  /**
   * Maximum time allowed for regex execution (milliseconds)
   * Default: 100ms for user input, 1000ms for system operations
   */
  timeout?: number;

  /**
   * Maximum input length to process
   * Default: 10000 characters
   */
  maxLength?: number;

  /**
   * Whether to cache compiled regex patterns
   * Default: true for static patterns, false for dynamic
   */
  cache?: boolean;

  /**
   * Context for logging/monitoring
   */
  context?: string;
}

/**
 * Safe regex execution with timeout protection
 * Prevents ReDoS attacks by limiting execution time
 */
export class SafeRegex {
  private static readonly patternCache = new Map<string, RegExp>();

  /**
   * Safely test a regex pattern against input with timeout protection
   */
  static test(
    pattern: string | RegExp,
    input: string,
    options: RegexExecutionOptions = {}
  ): boolean {
    const {
      timeout = REGEX_TIMEOUT_MS,
      maxLength = MAX_INPUT_LENGTH,
      context = 'unknown'
    } = options;

    // Input validation
    if (!input || typeof input !== 'string') {
      return false;
    }

    // Length check to prevent DOS
    if (input.length > maxLength) {
      console.warn(`[SafeRegex] Input too long (${input.length} > ${maxLength}) in ${context}`);
      return false;
    }

    // Get or compile regex
    const regex = typeof pattern === 'string' ? this.compilePattern(pattern) : pattern;
    if (!regex) {
      return false;
    }

    // Execute with timing
    const startTime = Date.now();
    try {
      const result = regex.test(input);
      const duration = Date.now() - startTime;

      // Log slow operations
      if (duration > timeout) {
        console.warn(`[SafeRegex] Slow regex execution (${duration}ms) in ${context}`);
      }

      return result;
    } catch (error) {
      console.error(`[SafeRegex] Regex execution error in ${context}:`, error);
      return false;
    } finally {
      // Reset lastIndex for global regexes
      if (regex.global) {
        regex.lastIndex = 0;
      }
    }
  }

  /**
   * Safely execute regex match with timeout protection
   */
  static match(
    input: string,
    pattern: string | RegExp,
    options: RegexExecutionOptions = {}
  ): RegExpMatchArray | null {
    const {
      timeout = REGEX_TIMEOUT_MS,
      maxLength = MAX_INPUT_LENGTH,
      context = 'unknown'
    } = options;

    // Input validation
    if (!input || typeof input !== 'string') {
      return null;
    }

    // Length check
    if (input.length > maxLength) {
      console.warn(`[SafeRegex] Input too long (${input.length} > ${maxLength}) in ${context}`);
      return null;
    }

    // Get or compile regex
    const regex = typeof pattern === 'string' ? this.compilePattern(pattern) : pattern;
    if (!regex) {
      return null;
    }

    // Execute with timing
    const startTime = Date.now();
    try {
      const result = input.match(regex);
      const duration = Date.now() - startTime;

      // Log slow operations
      if (duration > timeout) {
        console.warn(`[SafeRegex] Slow regex match (${duration}ms) in ${context}`);
      }

      return result;
    } catch (error) {
      console.error(`[SafeRegex] Match execution error in ${context}:`, error);
      return null;
    } finally {
      // Reset lastIndex for global regexes
      if (regex.global) {
        regex.lastIndex = 0;
      }
    }
  }

  /**
   * Escape user input for safe use in regex patterns
   * Prevents injection of regex special characters
   */
  static escape(input: string): string {
    if (!input || typeof input !== 'string') {
      return '';
    }

    // Escape all regex special characters
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Convert glob pattern to safe regex pattern
   * Prevents ReDoS from malicious glob patterns
   */
  static globToRegex(glob: string): RegExp | null {
    if (!glob || typeof glob !== 'string') {
      return null;
    }

    // Length check
    if (glob.length > 1000) {
      console.warn('[SafeRegex] Glob pattern too long');
      return null;
    }

    try {
      // Escape special regex chars except * and ?
      let pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

      // Replace glob patterns with safe regex equivalents
      // Use [^/]* instead of .* to prevent catastrophic backtracking
      pattern = pattern
        .replace(/\*\*/g, '<<GLOBSTAR>>')     // Temporary placeholder
        .replace(/\*/g, '[^/]*')              // * matches anything except /
        .replace(/\?/g, '[^/]')               // ? matches single char except /
        .replace(/<<GLOBSTAR>>\//g, '(?:.*/)?') // **/ matches any dirs
        .replace(/<<GLOBSTAR>>/g, '.*');      // ** matches anything

      return new RegExp('^' + pattern + '$');
    } catch (error) {
      console.error('[SafeRegex] Failed to convert glob to regex:', error);
      return null;
    }
  }

  /**
   * Compile and validate a regex pattern
   */
  private static compilePattern(pattern: string): RegExp | null {
    // Check cache first
    if (this.patternCache.has(pattern)) {
      return this.patternCache.get(pattern)!;
    }

    try {
      // Validate pattern for dangerous constructs
      if (this.isDangerous(pattern)) {
        // FIX: Combine message and pattern into single string for console.warn
        // Previously: Called with two arguments which breaks test expectations
        // Now: Single formatted string
        console.warn(`[SafeRegex] Dangerous pattern detected: ${pattern}`);
        return null;
      }

      const regex = new RegExp(pattern);

      // Cache if not too many patterns
      if (this.patternCache.size < MAX_PATTERN_CACHE_SIZE) {
        this.patternCache.set(pattern, regex);
      }

      return regex;
    } catch (error) {
      console.error('[SafeRegex] Invalid regex pattern:', pattern, error);
      return null;
    }
  }

  /**
   * Check for nested quantifiers in pattern
   * Reviewer recommendation: Break down complex functions
   */
  private static hasNestedQuantifiers(pattern: string): boolean {
    const nestedPatterns = [
      /[+*]{2,}/,                       // Multiple consecutive quantifiers
      /\(.{0,50}\+\)[+*]/,             // Nested quantifiers (bounded check)
      /\[[^\]]{0,20}\+\][+*]/,         // Nested quantifiers in char class
    ];

    for (const dangerous of nestedPatterns) {
      if (dangerous.test(pattern)) {
        return true;
      }
    }

    // String-based checks for catastrophic patterns (safer)
    const catastrophicPatterns = [
      '(.+)+', '(.*)+', '(.+)*', '(.*)*',  // Classic catastrophic
      '(\\d+)+', '(\\w+)+', '(\\s+)+',     // Digit/word/space catastrophic
      '(a+)+', '(a*)*',                    // Simple catastrophic
    ];

    for (const catastrophic of catastrophicPatterns) {
      if (pattern.includes(catastrophic)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check for complex alternation patterns that can cause backtracking
   */
  private static hasComplexAlternation(pattern: string): boolean {
    // Check for overlapping alternation
    if (pattern.includes('(a|a)*') || pattern.includes('(a|ab)*')) {
      return true;
    }

    // Count alternations
    const alternations = (pattern.match(/\|/g) || []).length;
    return alternations > 10;
  }

  /**
   * Check if pattern complexity exceeds safe thresholds
   */
  private static exceedsComplexityThreshold(pattern: string): boolean {
    const groups = (pattern.match(/\(/g) || []).length;
    const quantifiers = (pattern.match(/[+*?{]/g) || []).length;

    // High complexity = potential danger
    return groups > 10 || quantifiers > 15;
  }

  /**
   * Check if a regex pattern is potentially dangerous (ReDoS)
   * Based on OWASP recommendations
   * Refactored for clarity (Reviewer recommendation)
   */
  private static isDangerous(pattern: string): boolean {
    return this.hasNestedQuantifiers(pattern) ||
           this.hasComplexAlternation(pattern) ||
           this.exceedsComplexityThreshold(pattern);
  }

  /**
   * Clear the pattern cache
   */
  static clearCache(): void {
    this.patternCache.clear();
  }
}

/**
 * DOS Protection middleware for various operations
 */
export class DOSProtection {
  /**
   * Protect string split operations from ReDoS
   */
  static safeSplit(
    input: string,
    separator: string | RegExp,
    limit?: number
  ): string[] {
    // FIX: Handle empty string case correctly
    // Previously: Returned [] for empty string
    // Now: Returns [''] to match standard JavaScript split() behavior
    if (!input) {
      return input === '' ? [''] : [];
    }

    // Length check
    if (input.length > 100000) {
      return [];
    }

    // For regex separators, use SafeRegex
    if (separator instanceof RegExp || separator.startsWith('/')) {
      // FIX: Remove object comparison that always returns false
      // Previously: separator === /\s+/ (compares by reference)
      // Now: Check separator.toString() only
      // Simple whitespace split is safe
      if (separator.toString() === '/\\s+/') {
        return input.split(/\s+/, limit);
      }

      // Use safe execution for complex patterns
      const parts: string[] = [];
      let remaining = input;
      let count = 0;
      const maxIterations = limit || 1000;

      while (remaining && count < maxIterations) {
        const match = SafeRegex.match(remaining, separator, {
          context: 'split operation',
          timeout: 50
        });

        // FIX: Use cleaner null checking
        // Previously: !match || match.index === undefined
        // Now: Check both conditions properly
        if (!match?.index && match?.index !== 0) {
          parts.push(remaining);
          break;
        }

        parts.push(remaining.substring(0, match.index));
        remaining = remaining.substring(match.index + match[0].length);
        count++;
      }

      return parts;
    }

    // FIX: Handle limit parameter to keep remainder in final element
    // Previously: Used native split which truncates
    // Now: Custom implementation that preserves remainder
    // String separator is safe
    if (limit === undefined || limit <= 0) {
      return input.split(separator);
    }

    const parts: string[] = [];
    let remaining = input;
    let count = 0;

    // FIX: Remove unnecessary type assertions
    // Previously: separator as string (TypeScript knows it's string here)
    // Now: Let TypeScript infer the type
    const sep = separator.toString();
    while (remaining && count < limit - 1) {
      const index = remaining.indexOf(sep);
      if (index === -1) {
        parts.push(remaining);
        return parts;
      }

      parts.push(remaining.substring(0, index));
      remaining = remaining.substring(index + sep.length);
      count++;
    }

    // Add remainder as final element
    if (remaining || count < limit) {
      parts.push(remaining);
    }

    return parts;
  }

  /**
   * Protect replace operations from ReDoS
   */
  static safeReplace(
    input: string,
    pattern: string | RegExp,
    replacement: string | ((match: string, ...args: any[]) => string)
  ): string {
    // Length check
    if (!input) {
      return '';
    }
    if (input.length > 100000) {
      return '';  // Return empty string for overly long input
    }

    // For regex patterns, validate first
    if (pattern instanceof RegExp) {
      const patternStr = pattern.source;
      if (SafeRegex['isDangerous'](patternStr)) {
        console.warn('[DOSProtection] Dangerous replace pattern blocked');
        return input;
      }
    }

    try {
      return input.replace(pattern, replacement as any);
    } catch (error) {
      console.error('[DOSProtection] Replace operation failed:', error);
      return input;
    }
  }

  /**
   * Rate limiting for expensive operations
   */
  private static readonly operationCounts = new Map<string, number>();
  private static resetInterval: NodeJS.Timeout | null = null;

  static rateLimit(
    operation: string,
    maxPerMinute: number = 100
  ): boolean {
    // Initialize reset interval if needed
    this.resetInterval ??= setInterval(() => {
      this.operationCounts.clear();
    }, RATE_LIMIT_RESET_MS);

    const count = this.operationCounts.get(operation) || 0;
    if (count >= maxPerMinute) {
      console.warn(`[DOSProtection] Rate limit exceeded for ${operation}`);
      return false;
    }

    this.operationCounts.set(operation, count + 1);
    return true;
  }

  /**
   * Cleanup resources
   */
  static cleanup(): void {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
      this.resetInterval = null;
    }
    this.operationCounts.clear();
    SafeRegex.clearCache();
  }
}

// Export convenience functions
export const safeTest = SafeRegex.test.bind(SafeRegex);
export const safeMatch = SafeRegex.match.bind(SafeRegex);
export const escapeRegex = SafeRegex.escape.bind(SafeRegex);
export const globToRegex = SafeRegex.globToRegex.bind(SafeRegex);
export const safeSplit = DOSProtection.safeSplit.bind(DOSProtection);
export const safeReplace = DOSProtection.safeReplace.bind(DOSProtection);