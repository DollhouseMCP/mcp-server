/**
 * Tests for RegexValidator - ReDoS protection
 */

import { describe, test, expect } from '@jest/globals';
import { RegexValidator } from '../../src/security/regexValidator.js';
import { SecurityError } from '../../src/security/errors.js';

describe('RegexValidator', () => {
  describe('Basic Validation', () => {
    test('validates simple patterns correctly', () => {
      expect(RegexValidator.validate('test@example.com', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)).toBe(true);
      expect(RegexValidator.validate('invalid-email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)).toBe(false);
      expect(RegexValidator.validate('hello world', /^hello/)).toBe(true);
      expect(RegexValidator.validate('world hello', /^hello/)).toBe(false);
    });

    test('rejects content exceeding max length', () => {
      const largeContent = 'a'.repeat(100001);
      expect(() => {
        RegexValidator.validate(largeContent, /test/);
      }).toThrow(SecurityError);
      expect(() => {
        RegexValidator.validate(largeContent, /test/);
      }).toThrow('Content too large for validation');
    });

    test('enforces custom max length', () => {
      const content = 'a'.repeat(101);
      expect(() => {
        RegexValidator.validate(content, /test/, { maxLength: 100 });
      }).toThrow('Content too large for validation: 101 bytes (max: 100)');
    });

    test('handles regex errors gracefully', () => {
      const content = 'test';
      const fakePattern = {
        test: () => { throw new Error('Regex error'); }
      } as unknown as RegExp;
      
      expect(RegexValidator.validate(content, fakePattern)).toBe(false);
    });
  });

  describe('Timeout Protection', () => {
    test('completes quickly for safe patterns', () => {
      const content = 'a'.repeat(1000);
      const pattern = /^a+$/;
      
      const start = Date.now();
      const result = RegexValidator.validate(content, pattern);
      const elapsed = Date.now() - start;
      
      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(50);
    });

    test('prevents exponential backtracking', () => {
      const evilContent = 'a'.repeat(30) + '!';
      const evilPattern = /(a+)+$/;
      
      // Should throw due to timeout
      expect(() => {
        RegexValidator.validate(evilContent, evilPattern, { timeoutMs: 100 });
      }).toThrow(SecurityError);
    });

    test('handles multiple quantifiers safely', () => {
      const content = 'aaaaaaaaaa';
      const pattern = /a+a+a+/;
      
      // Should complete quickly despite multiple quantifiers
      const start = Date.now();
      const result = RegexValidator.validate(content, pattern);
      const elapsed = Date.now() - start;
      
      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(100);
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

  describe('Pattern Creation', () => {
    test('creates basic patterns correctly', () => {
      const pattern = RegexValidator.createSafePattern('^test$', 'i');
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('^test$');
      expect(pattern.flags).toBe('i');
    });

    test('creates patterns with dangerous constructs', () => {
      // Should still create but log warning
      const pattern1 = RegexValidator.createSafePattern('(a+)+b');
      expect(pattern1.source).toBe('(a+)+b');
      
      const pattern2 = RegexValidator.createSafePattern('a{1,}');
      expect(pattern2.source).toBe('a{1,}');
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
        expect(analysis.complexity).toBe('low');
      }
    });

    test('detects catastrophic backtracking', () => {
      const analysis = RegexValidator.analyzePattern(/(a+)+b/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Potential catastrophic backtracking');
    });

    test('detects quantified alternation', () => {
      const analysis = RegexValidator.analyzePattern(/(a|b)+/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Quantified alternation detected');
    });

    test('detects unbounded lookahead', () => {
      const analysis = RegexValidator.analyzePattern(/(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).*/);
      expect(analysis.safe).toBe(false);
      expect(analysis.risks.length).toBeGreaterThan(0);
    });

    test('assigns correct complexity levels', () => {
      const low = RegexValidator.analyzePattern(/test/);
      expect(low.complexity).toBe('low');
      
      const medium = RegexValidator.analyzePattern(/(a+)+b/);
      expect(medium.complexity).toBe('medium');
      
      // Create a pattern with multiple risks for high complexity
      const highRiskPattern = /(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%])(a|b|c)+(.+)+$/;
      const high = RegexValidator.analyzePattern(highRiskPattern);
      expect(high.risks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Integration with Security System', () => {
    test('works with typical security patterns', () => {
      // Email validation
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      expect(RegexValidator.validate('user@domain.com', emailPattern)).toBe(true);
      
      // Path validation
      const pathPattern = /^[a-zA-Z0-9\-_.\/]+$/;
      expect(RegexValidator.validate('/safe/path/file.txt', pathPattern)).toBe(true);
      // Note: .. is valid in the character class, need different test
      expect(RegexValidator.validate('/bad|path', pathPattern)).toBe(false);
      
      // Command validation
      const cmdPattern = /^[a-zA-Z0-9\s\-_]+$/;
      expect(RegexValidator.validate('npm install', cmdPattern)).toBe(true);
      expect(RegexValidator.validate('rm -rf /', cmdPattern)).toBe(false);
    });

    test('handles edge cases', () => {
      // Empty content
      expect(RegexValidator.validate('', /^$/)).toBe(true);
      expect(RegexValidator.validate('', /.+/)).toBe(false);
      
      // Very short timeout should throw
      expect(() => {
        RegexValidator.validate('test', /test/, { timeoutMs: 0.001 });
      }).toThrow(SecurityError);
    });
  });
});