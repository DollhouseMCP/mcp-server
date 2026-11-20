/**
 * RegexValidator - Provides protection against ReDoS attacks
 * 
 * This module implements safe regex execution by:
 * 1. Pre-validating content length based on pattern complexity
 * 2. Analyzing patterns for known ReDoS vulnerabilities
 * 3. Limiting execution based on calculated risk
 */

import { analyzePatternRisks } from './PatternRiskAnalyzer.js';
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
  // Content length limits based on regex pattern complexity.
  //
  // Complexity tiers:
  //   low    — no quantifiers (literal matches, anchored patterns). O(n) linear scan.
  //            500KB at ~0.1ms. Safe at any content size.
  //   medium — 1-3 simple quantifiers (e.g. /test.*end/, /\s+\w+/). Still O(n) linear
  //            because there's no nesting or overlapping alternation. 500KB at ~1-5ms.
  //            Same limit as low because the performance difference is negligible on
  //            modern hardware — both complete well under the 50ms slow-pattern threshold.
  //   high   — nested quantifiers, overlapping alternation, or unbounded lookahead.
  //            These can exhibit O(2^n) exponential backtracking (ReDoS). Even 1KB can
  //            hang for seconds. Capped at 1KB as a hard safety boundary.
  //
  // Low and medium share the same limit (matching MAX_CONTENT_LENGTH) because the
  // complexity classification is retained for monitoring and logging — slow pattern
  // warnings (see elapsed > 50ms check) use it to diagnose performance issues
  // without restricting legitimate content sizes.
  private static readonly COMPLEXITY_LIMITS = {
    low: 500000,    // 500KB — no quantifiers, O(n)
    medium: 500000, // 500KB — simple quantifiers, O(n)
    high: 1000      // 1KB  — complex patterns, O(2^n) risk
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
    
    const startTime = performance.now();
    // An unavailable evaluation propagates; callers require a completed check.
    const result = safeCopy.test(content);
    const elapsed = performance.now() - startTime;
    if (elapsed > 50 && logEvents) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_WARNING',
        severity: 'MEDIUM',
        source: 'RegexValidator',
        details: `Slow regex execution: ${elapsed.toFixed(2)}ms`,
        additionalData: { pattern: pattern.source, contentLength: content.length, elapsed }
      });
    }
    return result;
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
    const { risks, quantifierCount } = analyzePatternRisks(pattern.source);
    const complexity = this.patternComplexity(risks, quantifierCount);
    return { safe: risks.length === 0, risks, complexity, maxSafeLength: this.COMPLEXITY_LIMITS[complexity] };
  }

  private static patternComplexity(risks: string[], quantifierCount: number): PatternAnalysis['complexity'] {
    if (risks.length > 0) return 'high';
    return quantifierCount === 0 ? 'low' : 'medium';
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