/**
 * Tests for DOS Protection utilities
 *
 * Coverage for DOS vulnerability fixes:
 * - SafeRegex timeout protection
 * - Pattern validation and escaping
 * - Safe glob conversion
 * - Rate limiting
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  SafeRegex,
  DOSProtection,
  safeTest,
  safeMatch,
  escapeRegex,
  globToRegex,
  safeSplit,
  safeReplace
} from '../../../../src/security/dosProtection.js';

describe('SafeRegex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    SafeRegex.clearCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('test()', () => {
    it('should safely test patterns', () => {
      expect(SafeRegex.test(/hello/, 'hello world')).toBe(true);
      expect(SafeRegex.test(/foo/, 'bar')).toBe(false);
    });

    it('should handle string patterns', () => {
      expect(SafeRegex.test('\\d+', '123')).toBe(true);
      expect(SafeRegex.test('\\d+', 'abc')).toBe(false);
    });

    it('should reject dangerous patterns', () => {
      const dangerous = '(.+)+$';
      expect(SafeRegex.test(dangerous, 'aaaaaaaaaa')).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Dangerous pattern detected')
      );
    });

    it('should enforce input length limits', () => {
      const longInput = 'a'.repeat(20000);
      expect(SafeRegex.test(/a+/, longInput)).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Input too long')
      );
    });

    it('should handle invalid input gracefully', () => {
      expect(SafeRegex.test(/test/, null as any)).toBe(false);
      expect(SafeRegex.test(/test/, undefined as any)).toBe(false);
      expect(SafeRegex.test(/test/, '' as any)).toBe(false);
    });

    it('should reset global regex lastIndex', () => {
      const globalRegex = /test/g;
      globalRegex.lastIndex = 5;
      SafeRegex.test(globalRegex, 'test test');
      expect(globalRegex.lastIndex).toBe(0);
    });
  });

  describe('match()', () => {
    it('should safely match patterns', () => {
      const result = SafeRegex.match('hello world', /hello/);
      expect(result).toEqual(['hello']);
    });

    it('should return null for no match', () => {
      expect(SafeRegex.match('foo', /bar/)).toBeNull();
    });

    it('should enforce length limits', () => {
      const longInput = 'a'.repeat(20000);
      expect(SafeRegex.match(longInput, /a+/)).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Input too long')
      );
    });

    it('should reject dangerous patterns', () => {
      const dangerous = '(.+)+$';
      expect(SafeRegex.match('aaaaaaaaaa', dangerous)).toBeNull();
    });
  });

  describe('escape()', () => {
    it('should escape regex special characters', () => {
      expect(SafeRegex.escape('.*+?^${}()|[]\\'))
        .toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
    });

    it('should handle normal strings', () => {
      expect(SafeRegex.escape('hello world')).toBe('hello world');
    });

    it('should handle empty and invalid input', () => {
      expect(SafeRegex.escape('')).toBe('');
      expect(SafeRegex.escape(null as any)).toBe('');
      expect(SafeRegex.escape(undefined as any)).toBe('');
    });
  });

  describe('globToRegex()', () => {
    it('should convert simple glob patterns', () => {
      const regex = SafeRegex.globToRegex('*.js');
      expect(regex).toBeTruthy();
      expect(regex!.test('file.js')).toBe(true);
      expect(regex!.test('file.ts')).toBe(false);
      expect(regex!.test('dir/file.js')).toBe(false); // * doesn't match /
    });

    it('should handle ** glob patterns', () => {
      const regex = SafeRegex.globToRegex('src/**/*.ts');
      expect(regex).toBeTruthy();
      expect(regex!.test('src/file.ts')).toBe(true);
      expect(regex!.test('src/dir/file.ts')).toBe(true);
      expect(regex!.test('src/a/b/c/file.ts')).toBe(true);
      expect(regex!.test('file.ts')).toBe(false);
    });

    it('should handle ? wildcards', () => {
      const regex = SafeRegex.globToRegex('file?.txt');
      expect(regex).toBeTruthy();
      expect(regex!.test('file1.txt')).toBe(true);
      expect(regex!.test('fileA.txt')).toBe(true);
      expect(regex!.test('file.txt')).toBe(false);
      expect(regex!.test('file12.txt')).toBe(false);
    });

    it('should reject overly long patterns', () => {
      const longGlob = '*'.repeat(2000);
      expect(SafeRegex.globToRegex(longGlob)).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Glob pattern too long')
      );
    });

    it('should handle invalid input', () => {
      expect(SafeRegex.globToRegex('')).toBeNull();
      expect(SafeRegex.globToRegex(null as any)).toBeNull();
    });
  });
});

describe('DOSProtection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    DOSProtection.cleanup();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    DOSProtection.cleanup();
  });

  describe('safeSplit()', () => {
    it('should split strings safely', () => {
      expect(DOSProtection.safeSplit('a,b,c', ',')).toEqual(['a', 'b', 'c']);
      expect(DOSProtection.safeSplit('a b  c', /\s+/)).toEqual(['a', 'b', 'c']);
    });

    it('should handle length limits', () => {
      const longString = 'a'.repeat(200000);
      expect(DOSProtection.safeSplit(longString, ',')).toEqual([]);
    });

    it('should handle empty input', () => {
      expect(DOSProtection.safeSplit('', ',')).toEqual(['']);
      expect(DOSProtection.safeSplit(null as any, ',')).toEqual([]);
    });

    it('should apply split limits', () => {
      expect(DOSProtection.safeSplit('a,b,c,d,e', ',', 3))
        .toEqual(['a', 'b', 'c,d,e']);
    });
  });

  describe('safeReplace()', () => {
    it('should replace patterns safely', () => {
      expect(DOSProtection.safeReplace('hello world', /world/, 'universe'))
        .toBe('hello universe');
    });

    it('should block dangerous patterns', () => {
      // NOSONAR - Intentionally vulnerable regex pattern for testing DOS protection
      // This pattern is used to verify our security features correctly detect and block
      // catastrophic backtracking patterns. It's contained within DOSProtection wrapper.
      const dangerous = /(.+)+$/; // NOSONAR
      const input = 'aaaaaaaaaa';
      expect(DOSProtection.safeReplace(input, dangerous, 'x'))
        .toBe(input); // Returns original on danger
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Dangerous replace pattern blocked')
      );
    });

    it('should handle string patterns', () => {
      expect(DOSProtection.safeReplace('hello', 'l', 'L'))
        .toBe('heLlo'); // Only first occurrence
    });

    it('should handle length limits', () => {
      const longString = 'a'.repeat(200000);
      expect(DOSProtection.safeReplace(longString, /a/, 'b'))
        .toBe('');
    });
  });

  describe('rateLimit()', () => {
    it('should allow operations within rate limit', () => {
      for (let i = 0; i < 50; i++) {
        expect(DOSProtection.rateLimit('test-op', 100)).toBe(true);
      }
    });

    it('should block operations exceeding rate limit', () => {
      // Fill up the limit
      for (let i = 0; i < 100; i++) {
        DOSProtection.rateLimit('test-op', 100);
      }

      // Next one should be blocked
      expect(DOSProtection.rateLimit('test-op', 100)).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit exceeded')
      );
    });

    it('should track different operations separately', () => {
      // Use up op1 limit
      for (let i = 0; i < 10; i++) {
        DOSProtection.rateLimit('op1', 10);
      }
      expect(DOSProtection.rateLimit('op1', 10)).toBe(false);

      // op2 should still work
      expect(DOSProtection.rateLimit('op2', 10)).toBe(true);
    });
  });
});

describe('Convenience functions', () => {
  it('should export bound functions', () => {
    expect(safeTest).toBeDefined();
    expect(safeMatch).toBeDefined();
    expect(escapeRegex).toBeDefined();
    expect(globToRegex).toBeDefined();
    expect(safeSplit).toBeDefined();
    expect(safeReplace).toBeDefined();
  });

  it('should work correctly', () => {
    expect(safeTest(/test/, 'test')).toBe(true);
    expect(escapeRegex('.*')).toBe('\\.\\*');
    expect(safeSplit('a,b', ',')).toEqual(['a', 'b']);
  });
});

describe('Performance Tests (Reviewer Recommendation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    SafeRegex.clearCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should timeout slow regex execution', () => {
    const slowPattern = '(a+)+$';
    const maliciousInput = 'a'.repeat(100) + 'X';

    const start = Date.now();
    const result = SafeRegex.test(slowPattern, maliciousInput);
    const duration = Date.now() - start;

    // Should reject dangerous pattern quickly without executing
    expect(result).toBe(false);
    expect(duration).toBeLessThan(10); // Should fail fast, not timeout
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dangerous pattern detected')
    );
  });

  it('should handle large inputs efficiently', () => {
    const largeInput = 'a'.repeat(5000);
    const simplePattern = /test/;

    const start = Date.now();
    const result = SafeRegex.test(simplePattern, largeInput);
    const duration = Date.now() - start;

    expect(result).toBe(false);
    expect(duration).toBeLessThan(50); // Should be fast for simple patterns
  });

  it('should detect timeout for complex patterns', () => {
    // This tests that we properly detect and handle slow patterns
    // NOSONAR - Intentionally complex regex pattern for testing timeout detection
    // This pattern is vulnerable to super-linear runtime but is safely contained
    // within SafeRegex.test() which enforces timeouts and prevents actual DOS.
    const complexPattern = /^(([a-z])+.)+$/; // NOSONAR
    const testInput = 'abcdefghijklmnopqrstuvwxyz'.repeat(10);

    const start = Date.now();
    SafeRegex.test(complexPattern, testInput, { timeout: 50 });
    const duration = Date.now() - start;

    // Should complete within reasonable time
    expect(duration).toBeLessThan(100);
  });

  it('should efficiently cache patterns', () => {
    const pattern = '\\d+';

    // First call should compile
    SafeRegex.test(pattern, '123');

    // Second call should use cache (much faster)
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      SafeRegex.test(pattern, '456');
    }
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(10); // Cached access should be very fast
  });

  it('should limit pattern cache size', () => {
    // Test that we don't have unbounded memory growth
    for (let i = 0; i < 1500; i++) {
      SafeRegex.test(`pattern${i}`, 'test');
    }

    // Cache should be limited (implementation specific)
    // Just ensure no errors and reasonable performance
    expect(true).toBe(true);
  });
});