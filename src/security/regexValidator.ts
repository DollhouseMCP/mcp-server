/**
 * RegexValidator - Provides protection against ReDoS attacks
 * 
 * This module implements safe regex execution by:
 * 1. Pre-validating content length based on pattern complexity
 * 2. Analyzing patterns for known ReDoS vulnerabilities
 * 3. Limiting execution based on calculated risk
 */

import { SecurityError } from './errors.js';
import { SecurityMonitor } from './securityMonitor.js';

export interface RegexValidationOptions {
  /** Maximum content length allowed */
  maxLength?: number;
  /** Reject patterns with high ReDoS risk */
  rejectDangerousPatterns?: boolean;
  /** Log security events */
  logEvents?: boolean;
}

interface PatternAnalysis {
  safe: boolean;
  risks: string[];
  complexity: 'low' | 'medium' | 'high';
  maxSafeLength: number;
}

export class RegexValidator {
  // Default limits based on pattern complexity
  private static readonly COMPLEXITY_LIMITS = {
    low: 100000,    // 100KB for simple patterns
    medium: 10000,  // 10KB for moderate patterns
    high: 1000      // 1KB for complex patterns
  };

  /**
   * Validates content against a pattern with ReDoS protection
   * 
   * Protection strategy:
   * 1. Analyze pattern complexity
   * 2. Enforce content length limits based on complexity
   * 3. Reject known dangerous patterns
   * 4. Execute regex only if safe
   */
  static validate(
    content: string,
    pattern: RegExp,
    options: RegexValidationOptions = {}
  ): boolean {
    const {
      maxLength,
      rejectDangerousPatterns = true,
      logEvents = true
    } = options;

    // Analyze pattern for ReDoS risks
    const analysis = this.analyzePattern(pattern);
    
    // Reject dangerous patterns if configured
    if (rejectDangerousPatterns && !analysis.safe) {
      if (logEvents) {
        SecurityMonitor.logSecurityEvent({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'HIGH',
          source: 'RegexValidator',
          details: 'Dangerous regex pattern rejected',
          additionalData: {
            pattern: pattern.source,
            risks: analysis.risks
          }
        });
      }
      throw new SecurityError(
        `Pattern rejected due to ReDoS risk: ${analysis.risks.join(', ')}`
      );
    }

    // Determine effective max length
    const effectiveMaxLength = maxLength ?? analysis.maxSafeLength;
    
    // Check content length
    if (content.length > effectiveMaxLength) {
      throw new SecurityError(
        `Content too large for validation: ${content.length} bytes (max: ${effectiveMaxLength} for ${analysis.complexity} complexity pattern)`
      );
    }

    // Create a copy of the regex to avoid modifying the original
    const safeCopy = new RegExp(pattern.source, pattern.flags);
    
    try {
      // Track execution time for monitoring
      const startTime = performance.now();
      const result = safeCopy.test(content);
      const elapsed = performance.now() - startTime;

      // Log slow patterns
      if (elapsed > 50 && logEvents) {
        SecurityMonitor.logSecurityEvent({
          type: 'RATE_LIMIT_WARNING',
          severity: 'MEDIUM',
          source: 'RegexValidator',
          details: `Slow regex execution: ${elapsed.toFixed(2)}ms`,
          additionalData: {
            pattern: pattern.source,
            contentLength: content.length,
            elapsed
          }
        });
      }

      return result;
    } catch (error) {
      // Handle any regex errors
      if (logEvents) {
        SecurityMonitor.logSecurityEvent({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'HIGH',
          source: 'RegexValidator',
          details: 'Regex execution error',
          additionalData: {
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
      return false;
    }
  }

  /**
   * Validates multiple patterns with shared risk assessment
   */
  static validateAny(
    content: string,
    patterns: RegExp[],
    options: RegexValidationOptions = {}
  ): boolean {
    for (const pattern of patterns) {
      if (this.validate(content, pattern, options)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Validates all patterns must match
   */
  static validateAll(
    content: string,
    patterns: RegExp[],
    options: RegexValidationOptions = {}
  ): boolean {
    for (const pattern of patterns) {
      if (!this.validate(content, pattern, options)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Analyzes a regex pattern for potential ReDoS vulnerabilities
   * 
   * Detects patterns known to cause exponential backtracking:
   * - Nested quantifiers: (a+)+, (a*)*
   * - Alternation with overlap: (a|a)*
   * - Quantified groups with alternation: (a|b)+
   * - Catastrophic patterns: (.+)+$
   */
  static analyzePattern(pattern: RegExp): PatternAnalysis {
    const source = pattern.source;
    const risks: string[] = [];
    
    // Nested quantifiers - extremely dangerous
    if (/\([^)]+[+*]\)[+*]/.test(source) || 
        /\([^)]+\{[^}]+\}\)[+*]/.test(source) ||
        /\(\w+[+*]\)[+*]/.test(source)) {
      risks.push('Nested quantifiers detected');
    }

    // Alternation with repetition
    if (/\([^)]*\|[^)]*\)[+*]/.test(source)) {
      risks.push('Quantified alternation detected');
    }

    // Alternation with overlap (e.g., (a|a)*)
    const alternationMatch = source.match(/\(([^|)]+)\|([^)]+)\)/g);
    if (alternationMatch) {
      for (const match of alternationMatch) {
        const parts = match.slice(1, -1).split('|');
        if (parts.some((part, i) => parts.slice(i + 1).includes(part))) {
          risks.push('Overlapping alternation detected');
          break;
        }
      }
    }

    // Catastrophic backtracking patterns
    if (/(\(.+\))+[+*]/.test(source) || /(\.\*)+[+*]/.test(source)) {
      risks.push('Potential catastrophic backtracking');
    }

    // Unbounded lookahead/lookbehind with quantifiers
    if (/\(\?[=!<].*[+*]/.test(source)) {
      risks.push('Unbounded lookahead/lookbehind');
    }

    // Polynomial patterns (multiple quantifiers in sequence)
    const quantifierCount = (source.match(/[+*?]|\{\d*,?\d*\}/g) || []).length;
    if (quantifierCount > 3) {
      risks.push('Multiple quantifiers detected');
    }

    // Determine complexity and safe content length
    let complexity: 'low' | 'medium' | 'high';
    let maxSafeLength: number;
    
    if (risks.length === 0) {
      if (quantifierCount === 0) {
        complexity = 'low';
        maxSafeLength = this.COMPLEXITY_LIMITS.low;
      } else if (quantifierCount <= 3) {
        complexity = 'medium';
        maxSafeLength = this.COMPLEXITY_LIMITS.medium;
      } else {
        complexity = 'high';
        maxSafeLength = this.COMPLEXITY_LIMITS.high;
      }
    } else if (risks.length === 1) {
      complexity = 'high';
      maxSafeLength = this.COMPLEXITY_LIMITS.high;
    } else {
      complexity = 'high';
      maxSafeLength = this.COMPLEXITY_LIMITS.high;
    }

    return {
      safe: risks.length === 0,
      risks,
      complexity,
      maxSafeLength
    };
  }

  /**
   * Creates a regex pattern with safety analysis
   */
  static createSafePattern(pattern: string, flags?: string): RegExp {
    const regex = new RegExp(pattern, flags);
    const analysis = this.analyzePattern(regex);
    
    if (!analysis.safe) {
      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'RegexValidator',
        details: 'Potentially dangerous regex pattern created',
        additionalData: {
          pattern,
          risks: analysis.risks
        }
      });
    }
    
    return regex;
  }
}