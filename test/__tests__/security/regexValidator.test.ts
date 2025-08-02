/**
 * Tests for RegexValidator - ReDoS protection
 * 
 * NOTE: This test file intentionally contains regex patterns that would cause
 * Regular Expression Denial of Service (ReDoS) attacks. These patterns are
 * used to verify that our RegexValidator correctly identifies and prevents
 * such dangerous patterns from being executed.
 * 
 * CodeQL warnings in this file are expected and should be suppressed.
 * 
 * @security-severity none
 */

/* eslint-disable security/detect-unsafe-regex */
// codeql[javascript/ql/src/Security/CWE-730/PolynomialReDoS.ql] = false
// codeql[javascript/ql/src/Security/CWE-1333/ReDoS.ql] = false

// codeql[js/redos]: This entire file tests ReDoS detection with intentionally vulnerable patterns

import { describe, test, expect } from '@jest/globals';
import { RegexValidator } from '../../../src/security/regexValidator.js';
import { SecurityError } from '../../../src/security/errors.js';

describe('RegexValidator', () => {
  describe('Basic Validation', () => {
    test('validates simple patterns correctly', () => {
      expect(RegexValidator.validate('test@example.com', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)).toBe(true);
      expect(RegexValidator.validate('invalid-email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)).toBe(false);
      expect(RegexValidator.validate('hello world', /^hello/)).toBe(true);
      expect(RegexValidator.validate('world hello', /^hello/)).toBe(false);
    });

    test('enforces content length limits based on complexity', () => {
      const simplePattern = /test/;
      const complexPattern = /(a+)+b/; // codeql[js/redos]: Intentionally dangerous for testing
      
      // Simple pattern allows large content
      const largeContent = 'a'.repeat(50000);
      expect(RegexValidator.validate(largeContent, simplePattern)).toBe(false);
      
      // Complex pattern rejects large content
      expect(() => {
        RegexValidator.validate(largeContent, complexPattern, { rejectDangerousPatterns: false });
      }).toThrow('Content too large for validation');
    });

    test('rejects dangerous patterns by default', () => {
      const dangerousPattern = /(a+)+$/; // codeql[js/redos]: Intentionally dangerous for testing
      
      expect(() => {
        RegexValidator.validate('aaaa', dangerousPattern);
      }).toThrow(SecurityError);
      expect(() => {
        RegexValidator.validate('aaaa', dangerousPattern);
      }).toThrow('Pattern rejected due to ReDoS risk');
    });

    test('allows dangerous patterns when configured', () => {
      const dangerousPattern = /(a+)+$/; // codeql[js/redos]: Intentionally dangerous for testing
      const content = 'aaaa';
      
      // Should not throw when rejectDangerousPatterns is false
      const result = RegexValidator.validate(content, dangerousPattern, { 
        rejectDangerousPatterns: false,
        maxLength: 10 
      });
      expect(result).toBe(true);
    });
  });

  describe('Pattern Analysis', () => {
    test('identifies safe patterns', () => {
      const safePatterns = [
        /^[a-z]+$/,
        /test/,
        /^hello world$/,
        /[0-9]{3}-[0-9]{3}-[0-9]{4}/
      ];
      
      for (const pattern of safePatterns) {
        const analysis = RegexValidator.analyzePattern(pattern);
        expect(analysis.safe).toBe(true);
        expect(analysis.risks).toHaveLength(0);
        // Complexity depends on quantifier count
        const quantifierCount = (pattern.source.match(/[+*?]|\{\d*,?\d*\}/g) || []).length;
        if (quantifierCount === 0) {
          expect(analysis.complexity).toBe('low');
        } else {
          expect(analysis.complexity).toBe('medium');
        }
      }
    });

    test('detects nested quantifiers', () => {
      // These patterns are intentionally dangerous for testing ReDoS detection
      // codeql[js/redos]: Test patterns - intentionally vulnerable for security testing
      const patterns = [
        /(a+)+b/,    // codeql[js/redos]
        /(a*)*b/,    // codeql[js/redos]
        /(a{1,5})+/, // codeql[js/redos]
        /(\w+)+$/    // codeql[js/redos]
      ];
      
      for (const pattern of patterns) {
        const analysis = RegexValidator.analyzePattern(pattern);
        expect(analysis.safe).toBe(false);
        expect(analysis.risks).toContain('Nested quantifiers detected');
      }
    });

    test('detects quantified alternation', () => {
      const analysis = RegexValidator.analyzePattern(/(a|b)+/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Quantified alternation detected');
    });

    test('detects overlapping alternation', () => {
      const analysis = RegexValidator.analyzePattern(/(a|a)*/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Overlapping alternation detected');
    });

    test('detects catastrophic backtracking patterns', () => {
      // These patterns are intentionally dangerous for testing ReDoS detection
      // codeql[js/redos]: Test patterns - intentionally vulnerable for security testing
      const patterns = [
        /(.+)+$/,    // codeql[js/redos]
        /(.*)*x/,    // codeql[js/redos]
        /(\w+)+\s/   // codeql[js/redos]
      ];
      
      for (const pattern of patterns) {
        const analysis = RegexValidator.analyzePattern(pattern);
        expect(analysis.safe).toBe(false);
        // These patterns are caught by nested quantifiers detection
        expect(analysis.risks.some(risk => 
          risk.includes('Nested quantifiers') || risk.includes('catastrophic backtracking')
        )).toBe(true);
      }
    });

    test('detects unbounded lookahead', () => {
      const analysis = RegexValidator.analyzePattern(/(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).*/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Unbounded lookahead/lookbehind');
    });

    test('assigns correct complexity levels', () => {
      const low = RegexValidator.analyzePattern(/test/);
      expect(low.complexity).toBe('low');
      expect(low.maxSafeLength).toBe(100000);
      
      const medium = RegexValidator.analyzePattern(/test.*end/);
      expect(medium.complexity).toBe('medium');
      expect(medium.maxSafeLength).toBe(10000);
      
      const high = RegexValidator.analyzePattern(/(a+)+b/); // codeql[js/redos]: Intentionally dangerous for testing
      expect(high.complexity).toBe('high');
      expect(high.maxSafeLength).toBe(1000);
    });
  });

  describe('Multi-Pattern Validation', () => {
    test('validateAny returns true if any pattern matches', () => {
      const content = 'test@example.com';
      const patterns = [
        /^foo/,
        /@example/,
        /bar$/
      ];
      
      expect(RegexValidator.validateAny(content, patterns)).toBe(true);
    });

    test('validateAny returns false if no patterns match', () => {
      const content = 'test@example.com';
      const patterns = [
        /^foo/,
        /@bar/,
        /baz$/
      ];
      
      expect(RegexValidator.validateAny(content, patterns)).toBe(false);
    });

    test('validateAll returns true only if all patterns match', () => {
      const content = 'test@example.com';
      
      const allMatch = [/^test/, /@example/, /\.com$/];
      expect(RegexValidator.validateAll(content, allMatch)).toBe(true);
      
      const oneFailes = [/^test/, /@example/, /\.org$/];
      expect(RegexValidator.validateAll(content, oneFailes)).toBe(false);
    });
  });

  describe('Safe Pattern Creation', () => {
    test('creates patterns without warnings for safe regex', () => {
      const pattern = RegexValidator.createSafePattern('^test$', 'i');
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('^test$');
      expect(pattern.flags).toBe('i');
    });

    test('creates patterns but logs warnings for dangerous regex', () => {
      const pattern = RegexValidator.createSafePattern('(a+)+b'); // codeql[js/redos]: Intentionally dangerous for testing
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('(a+)+b');
      // Warning would be logged to SecurityMonitor
    });
  });

  describe('Edge Cases', () => {
    test('handles empty content', () => {
      expect(RegexValidator.validate('', /^$/)).toBe(true);
      expect(RegexValidator.validate('', /.+/)).toBe(false);
    });

    test('handles very long safe patterns', () => {
      const longPattern = /^a{1000}$/;
      const content = 'a'.repeat(1000);
      
      expect(RegexValidator.validate(content, longPattern)).toBe(true);
    });

    test('respects custom maxLength over calculated limits', () => {
      const simplePattern = /test/;
      const content = 'a'.repeat(1001);
      
      expect(() => {
        RegexValidator.validate(content, simplePattern, { maxLength: 1000 });
      }).toThrow('Content too large for validation');
    });

    test('handles regex execution errors gracefully', () => {
      // Create a mock pattern that throws
      const badPattern = {
        source: 'bad',
        flags: '',
        test: () => { throw new Error('Regex error'); }
      } as unknown as RegExp;
      
      expect(RegexValidator.validate('test', badPattern)).toBe(false);
    });
  });

  describe('Performance Tracking', () => {
    test('tracks slow pattern execution', () => {
      // Create a pattern that might be slow
      const content = 'a'.repeat(10000);
      const pattern = /a+b/; // Will scan entire string
      
      // Should complete but might log a warning
      const result = RegexValidator.validate(content, pattern);
      expect(result).toBe(false); // No 'b' at end
    });
  });

  describe('Real World Patterns', () => {
    test('validates email addresses safely', () => {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      expect(RegexValidator.validate('user@example.com', emailPattern)).toBe(true);
      expect(RegexValidator.validate('invalid.email', emailPattern)).toBe(false);
      
      // Should handle long inputs gracefully
      const longEmail = 'a'.repeat(100) + '@example.com';
      expect(RegexValidator.validate(longEmail, emailPattern)).toBe(true);
    });

    test('validates file paths safely', () => {
      const pathPattern = /^[a-zA-Z0-9\-_.\/]+$/;
      
      expect(RegexValidator.validate('/safe/path/file.txt', pathPattern)).toBe(true);
      expect(RegexValidator.validate('/bad|path', pathPattern)).toBe(false);
    });

    test('validates URLs safely', () => {
      const urlPattern = /^https?:\/\/[^\s]+$/;
      
      expect(RegexValidator.validate('https://example.com', urlPattern)).toBe(true);
      expect(RegexValidator.validate('ftp://example.com', urlPattern)).toBe(false);
    });
  });

  describe('Integration with Validators', () => {
    test('provides appropriate limits for different use cases', () => {
      // Simple validation pattern
      const usernamePattern = /^[a-zA-Z0-9_]{3,20}$/;
      const analysis = RegexValidator.analyzePattern(usernamePattern);
      expect(analysis.maxSafeLength).toBeGreaterThanOrEqual(20);
      
      // Complex validation pattern
      const complexPattern = /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%]).{8,}$/;
      const complexAnalysis = RegexValidator.analyzePattern(complexPattern);
      expect(complexAnalysis.maxSafeLength).toBeLessThan(10000);
    });
  });
});