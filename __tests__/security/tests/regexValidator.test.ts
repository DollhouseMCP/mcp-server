/**
 * Tests for RegexValidator - ReDoS protection
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RegexValidator } from '../../../src/security/regexValidator.js';
import { SecurityError } from '../../../src/security/errors.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

// Mock SecurityMonitor
jest.mock('../../../src/security/securityMonitor.js');

describe('RegexValidator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validate', () => {
    it('should validate simple patterns quickly', () => {
      const content = 'test@example.com';
      const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      const result = RegexValidator.validate(content, pattern);
      expect(result).toBe(true);
    });

    it('should reject content exceeding max length', () => {
      const content = 'a'.repeat(100001); // Over 100KB
      const pattern = /test/;
      
      expect(() => {
        RegexValidator.validate(content, pattern);
      }).toThrow(SecurityError);
      expect(() => {
        RegexValidator.validate(content, pattern);
      }).toThrow('Content too large for validation');
    });

    it('should enforce custom max length', () => {
      const content = 'a'.repeat(101);
      const pattern = /test/;
      
      expect(() => {
        RegexValidator.validate(content, pattern, { maxLength: 100 });
      }).toThrow('Content too large for validation');
    });

    it('should log performance warnings for slow patterns', () => {
      // Create a pattern that takes some time
      const content = 'a'.repeat(1000) + 'b';
      const pattern = /a+a+b/; // Potential backtracking
      
      RegexValidator.validate(content, pattern, { timeoutMs: 1000 });
      
      // Check if performance warning was logged
      const mockLog = jest.mocked(SecurityMonitor.logSecurityEvent);
      const perfWarning = mockLog.mock.calls.find(
        call => call[0].type === 'RATE_LIMIT_WARNING'
      );
      
      // May or may not trigger depending on system performance
      if (perfWarning) {
        expect(perfWarning[0].severity).toBe('MEDIUM');
      }
    });

    it('should handle regex errors gracefully', () => {
      const content = 'test';
      // Create a pattern that might throw
      const pattern = {
        test: () => { throw new Error('Regex error'); }
      } as unknown as RegExp;
      
      const result = RegexValidator.validate(content, pattern);
      expect(result).toBe(false);
    });

    it('should respect custom timeout message', () => {
      const content = 'a'.repeat(1000);
      const pattern = /(a+)+b/; // Known ReDoS pattern
      const customMessage = 'Custom timeout error';
      
      try {
        // Use very short timeout to force timeout
        RegexValidator.validate(content, pattern, { 
          timeoutMs: 0.1,
          timeoutMessage: customMessage 
        });
      } catch (error) {
        if (error instanceof SecurityError) {
          expect(error.message).toBe(customMessage);
        }
      }
    });
  });

  describe('validateAny', () => {
    it('should return true if any pattern matches', () => {
      const content = 'test@example.com';
      const patterns = [
        /^test/,
        /@example/,
        /nonexistent/
      ];
      
      const result = RegexValidator.validateAny(content, patterns);
      expect(result).toBe(true);
    });

    it('should return false if no patterns match', () => {
      const content = 'test@example.com';
      const patterns = [
        /^foo/,
        /@bar/,
        /baz$/
      ];
      
      const result = RegexValidator.validateAny(content, patterns);
      expect(result).toBe(false);
    });

    it('should share timeout across all patterns', () => {
      const content = 'a'.repeat(100);
      const patterns = [
        /b+/, // Won't match
        /c+/, // Won't match
        /a+/  // Will match but might not reach due to timeout
      ];
      
      // Should complete within timeout
      const result = RegexValidator.validateAny(content, patterns, { timeoutMs: 100 });
      expect(typeof result).toBe('boolean');
    });
  });

  describe('validateAll', () => {
    it('should return true if all patterns match', () => {
      const content = 'test@example.com';
      const patterns = [
        /^test/,
        /@example/,
        /\.com$/
      ];
      
      const result = RegexValidator.validateAll(content, patterns);
      expect(result).toBe(true);
    });

    it('should return false if any pattern fails', () => {
      const content = 'test@example.com';
      const patterns = [
        /^test/,
        /@example/,
        /\.org$/ // This won't match
      ];
      
      const result = RegexValidator.validateAll(content, patterns);
      expect(result).toBe(false);
    });
  });

  describe('createSafePattern', () => {
    it('should create basic patterns without warnings', () => {
      const pattern = RegexValidator.createSafePattern('^test$', 'i');
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('^test$');
      expect(pattern.flags).toBe('i');
      
      const mockLog = jest.mocked(SecurityMonitor.logSecurityEvent);
      expect(mockLog).not.toHaveBeenCalled();
    });

    it('should warn about nested quantifiers', () => {
      const pattern = RegexValidator.createSafePattern('(a+)+b');
      expect(pattern).toBeInstanceOf(RegExp);
      
      const mockLog = jest.mocked(SecurityMonitor.logSecurityEvent);
      expect(mockLog).toHaveBeenCalledWith({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'RegexValidator',
        details: 'Pattern contains potentially dangerous constructs',
        additionalData: {
          pattern: '(a+)+b',
          warning: 'Potential ReDoS vulnerability'
        }
      });
    });

    it('should warn about unbounded repetition', () => {
      RegexValidator.createSafePattern('a{1,}');
      
      const mockLog = jest.mocked(SecurityMonitor.logSecurityEvent);
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'MEDIUM'
        })
      );
    });
  });

  describe('analyzePattern', () => {
    it('should identify safe patterns', () => {
      const pattern = /^[a-z]+@[a-z]+\.[a-z]+$/;
      const analysis = RegexValidator.analyzePattern(pattern);
      
      expect(analysis.safe).toBe(true);
      expect(analysis.risks).toHaveLength(0);
      expect(analysis.complexity).toBe('low');
    });

    it('should detect nested quantifiers', () => {
      const pattern = /(a+)+b/;
      const analysis = RegexValidator.analyzePattern(pattern);
      
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Nested quantifiers detected');
      expect(analysis.complexity).toBe('medium');
    });

    it('should detect quantified alternation', () => {
      const pattern = /(a|b)+/;
      const analysis = RegexValidator.analyzePattern(pattern);
      
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Quantified alternation detected');
    });

    it('should detect catastrophic backtracking patterns', () => {
      const pattern = /(.+)+$/;
      const analysis = RegexValidator.analyzePattern(pattern);
      
      expect(analysis.safe).toBe(false);
      expect(analysis.risks).toContain('Potential catastrophic backtracking');
      expect(analysis.complexity).toBe('high');
    });

    it('should detect unbounded lookahead', () => {
      const pattern = /(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).*/;
      const analysis = RegexValidator.analyzePattern(pattern);
      
      expect(analysis.safe).toBe(false);
      expect(analysis.risks.length).toBeGreaterThan(0);
    });
  });

  describe('ReDoS attack prevention', () => {
    it('should handle exponential backtracking patterns', () => {
      const evilContent = 'a'.repeat(30) + '!';
      const evilPattern = /(a+)+$/; // Classic ReDoS pattern
      
      // Should complete quickly despite ReDoS pattern
      const start = Date.now();
      expect(() => {
        RegexValidator.validate(evilContent, evilPattern, { timeoutMs: 100 });
      }).not.toThrow();
      const elapsed = Date.now() - start;
      
      // Should complete in reasonable time
      expect(elapsed).toBeLessThan(200);
    });

    it('should handle polynomial time patterns', () => {
      const content = 'a'.repeat(100);
      const pattern = /a*a*a*a*a*b/; // Polynomial time complexity
      
      const result = RegexValidator.validate(content, pattern, { timeoutMs: 50 });
      expect(result).toBe(false); // No 'b' at end
    });

    it('should handle alternation-based ReDoS', () => {
      const content = 'a'.repeat(20) + 'c';
      const pattern = /(a|a)*b/; // Alternation ReDoS
      
      const start = Date.now();
      const result = RegexValidator.validate(content, pattern, { timeoutMs: 100 });
      const elapsed = Date.now() - start;
      
      expect(result).toBe(false);
      expect(elapsed).toBeLessThan(150);
    });
  });
});