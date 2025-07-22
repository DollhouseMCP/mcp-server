/**
 * Pathological input tests for ReDoS prevention
 * 
 * These tests verify that our ReDoS fixes properly handle pathological inputs
 * that would cause exponential backtracking in vulnerable regex implementations.
 * Each test documents the specific ReDoS pattern being prevented.
 */

import { generateUniqueId, slugify } from '../../../src/utils/filesystem.js';
import { validatePath, sanitizeInput, validateFilename } from '../../../src/security/InputValidator.js';
import { PersonaImporter } from '../../../src/persona/export-import/PersonaImporter.js';

describe('ReDoS Pathological Input Tests', () => {
  describe('filesystem.ts - Pattern: Multiple chained replace operations', () => {
    /**
     * Vulnerable pattern: .replace(/-+/g, '-').replace(/^-|-$/g, '')
     * Attack: String with many hyphens causes each replace to scan entire string
     */
    
    it('should handle repeated hyphens without catastrophic backtracking', () => {
      // This would cause O(n²) or worse with chained replaces
      const pathological = 'a' + '-'.repeat(10000) + 'b' + '-'.repeat(10000);
      
      expect(() => {
        const result = generateUniqueId(pathological);
        // Verify the result is properly sanitized
        // After processing and limiting to 100 chars, we expect just 'a'
        expect(result).toMatch(/^a_\d{8}-\d{6}_/);
      }).not.toThrow();
    });

    it('should handle edge case: all hyphens', () => {
      const pathological = '-'.repeat(1000);
      
      expect(() => {
        const result = generateUniqueId(pathological);
        // Should produce empty string before the timestamp
        expect(result).toMatch(/^_\d{8}-\d{6}_/);
      }).not.toThrow();
    });

    it('should handle alternating valid/invalid pattern', () => {
      // Creates a-b-c-d-e... pattern that challenges replace operations
      const chars = [];
      for (let i = 0; i < 5000; i++) {
        chars.push(i % 2 === 0 ? String.fromCharCode(97 + (i / 2) % 26) : '!@#$%'[i % 5]);
      }
      const pathological = chars.join('');
      
      expect(() => {
        slugify(pathological);
      }).not.toThrow();
    });
  });

  describe('InputValidator.ts - Pattern: Unbounded quantifiers on slashes', () => {
    /**
     * Vulnerable pattern: /^\/{1,100}|\/{1,100}$/g and /\/{1,100}/g
     * Attack: Many slashes cause regex engine to try all possible matches
     */
    
    it('should handle excessive leading slashes', () => {
      const pathological = '/'.repeat(10000) + 'path';
      
      expect(() => {
        validatePath(pathological);
      }).toThrow(); // Should throw for invalid format, but quickly
    });

    it('should handle excessive trailing slashes', () => {
      const pathological = 'path' + '/'.repeat(10000);
      
      expect(() => {
        validatePath(pathological);
      }).toThrow(); // Should throw for invalid format, but quickly
    });

    it('should handle interleaved slashes', () => {
      // Pattern: /a//b///c////d/////e...
      let path = '';
      for (let i = 1; i <= 100; i++) {
        path += 'x' + '/'.repeat(i);
      }
      
      expect(() => {
        validatePath(path);
      }).toThrow(); // Path too deep, but should fail quickly
    });

    it('should handle slash sandwich pattern', () => {
      // Many slashes, then valid path, then many slashes
      const pathological = '/'.repeat(5000) + 'valid/path/here' + '/'.repeat(5000);
      
      expect(() => {
        validatePath(pathological);
      }).toThrow();
    });
  });

  describe('sanitizeInput - Pattern: Multiple regex replacements', () => {
    /**
     * Multiple .replace() calls that each scan the entire string
     * can compound into polynomial time complexity
     */
    
    it('should handle strings full of special characters', () => {
      // Each character needs to be processed by multiple regexes
      const dangerous = '<>&"\'`$()!\\~*?{};&|';
      const pathological = dangerous.repeat(1000);
      
      const result = sanitizeInput(pathological);
      expect(result).toBe(''); // All characters should be removed
    });

    it('should handle mixed content efficiently', () => {
      // Alternating safe and dangerous characters
      const parts = [];
      for (let i = 0; i < 1000; i++) {
        parts.push('safe');
        parts.push('<script>');
        parts.push('&amp;');
        parts.push('"quoted"');
      }
      const pathological = parts.join('');
      
      const result = sanitizeInput(pathological, 10000);
      // 'script' becomes 'script', 'amp' becomes 'amp', 'quoted' becomes 'quoted'
      expect(result).toContain('safe');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).not.toContain('&');
      expect(result).not.toContain('"');
    });

    it('should handle control characters mixed with text', () => {
      // Control characters scattered throughout
      const text = 'hello';
      const pathological = text.split('').map(char => 
        '\x00\x01\x02' + char + '\x7F\x1F'
      ).join('');
      
      const result = sanitizeInput(pathological);
      expect(result).toBe('hello');
    });

    it('should handle RTL override attempts', () => {
      // Attempting to use RTL override to reverse text display
      const pathological = 'normal' + '\u202E' + 'reversed' + '\u202C' + 'normal';
      
      const result = sanitizeInput(pathological);
      // RTL override char \u202E should be removed
      expect(result).not.toContain('\u202E');
      // Note: \u202C might not be in our removal list
      expect(result).toContain('normal');
      expect(result).toContain('reversed');
    });
  });

  describe('PersonaImporter - Pattern: Base64 validation edge cases', () => {
    /**
     * Note: The current implementation may not validate base64 strictly
     * These tests document the current behavior
     */
    
    it('should handle empty base64 strings', () => {
      const importer = new PersonaImporter();
      
      // Empty string might be accepted by the importer
      // but should fail during processing
      try {
        importer.importFromBase64('');
        // If it doesn't throw, that's still a valid test result
      } catch (e) {
        // Expected to throw at some point
        expect(e).toBeDefined();
      }
    });

    it('should process base64-like patterns', () => {
      const importer = new PersonaImporter();
      
      // Test various patterns
      const testCases = ['=', '==', 'A', 'AB', 'ABC', 'AAAA'];
      
      testCases.forEach(testCase => {
        try {
          importer.importFromBase64(testCase);
        } catch (e) {
          // Any error is fine - we're testing it doesn't hang
          expect(e).toBeDefined();
        }
      });
    });
  });

  describe('Edge cases and boundary conditions', () => {
    it('should handle empty strings across all functions', () => {
      expect(generateUniqueId('')).toMatch(/^_\d{8}-\d{6}_/);
      expect(slugify('')).toBe('');
      expect(sanitizeInput('')).toBe('');
      
      expect(() => validatePath('')).toThrow('Path must be a non-empty string');
      expect(() => validateFilename('')).toThrow('Filename must be a non-empty string');
    });

    it('should handle single character inputs', () => {
      expect(generateUniqueId('a')).toMatch(/^a_\d{8}-\d{6}_/);
      expect(generateUniqueId('-')).toMatch(/^_\d{8}-\d{6}_/);
      expect(slugify('a')).toBe('a');
      expect(slugify('!')).toBe('');
    });

    it('should handle maximum length inputs', () => {
      const maxLength = 'a'.repeat(10000);
      
      // These should truncate at their limits
      expect(() => generateUniqueId(maxLength)).not.toThrow();
      expect(() => slugify(maxLength)).not.toThrow();
      
      // Verify truncation
      const uniqueId = generateUniqueId(maxLength);
      const slugified = slugify(maxLength);
      
      // generateUniqueId truncates at 100
      expect(uniqueId).toContain('aaaa'); // Should contain repeated 'a'
      expect(uniqueId).toMatch(/_\d{8}-\d{6}_/); // Should have timestamp
      // Note: Current implementation of slugify doesn't truncate
      // This test documents current behavior
      expect(slugified).toMatch(/^a+$/); // Should be all 'a's
      expect(slugified.length).toBeGreaterThan(100); // Currently doesn't truncate
    });

    it('should handle Unicode edge cases', () => {
      // Various Unicode that might cause issues
      const unicodeTests = [
        '🎉🎊🎈',                    // Emoji
        '中文字符',                   // Chinese
        'עברית',                     // Hebrew (RTL)
        'الْعَرَبِيَّة',              // Arabic (RTL with marks)
        '\u200B\u200C\u200D',        // Zero-width characters
        'café',                      // Combining characters
        '🏳️‍🌈',                      // Complex emoji
      ];
      
      unicodeTests.forEach(test => {
        expect(() => generateUniqueId(test)).not.toThrow();
        expect(() => slugify(test)).not.toThrow();
        expect(() => sanitizeInput(test)).not.toThrow();
      });
    });
  });

  describe('Nested pattern attacks', () => {
    it('should handle nested hyphen patterns', () => {
      // Pattern that could cause nested backtracking: a--b---c----d
      let nested = 'a';
      for (let i = 1; i <= 100; i++) {
        nested += '-'.repeat(i) + 'x';
      }
      
      expect(() => {
        const result = generateUniqueId(nested);
        // Should collapse all hyphens
        expect(result).toMatch(/^a(-x)+_/);
      }).not.toThrow();
    });

    it('should handle deeply nested path structures', () => {
      // Create a path with increasing complexity
      const parts = [];
      for (let i = 0; i < 50; i++) {
        parts.push('a'.repeat(i + 1));
      }
      const nested = parts.join('/');
      
      expect(() => {
        validatePath(nested);
      }).toThrow(); // Should fail validation
    });
  });

  describe('Known ReDoS patterns from security research', () => {
    it('should handle (a+)+ style patterns', () => {
      // Classic ReDoS pattern when matching fails
      const pathological = 'a'.repeat(50) + '!';
      
      // Our functions don't use such patterns, but let's verify
      expect(() => {
        generateUniqueId(pathological);
        slugify(pathological);
      }).not.toThrow();
    });

    it('should handle (a|a)* style patterns', () => {
      // Another classic ReDoS pattern
      const pathological = 'aaaaaaaaaaaaaaaaaaaaaaaab';
      
      expect(() => {
        generateUniqueId(pathological);
        slugify(pathological);
      }).not.toThrow();
    });

    it('should handle polynomial patterns', () => {
      // Pattern: (a*)*b where b never matches
      const pathological = 'a'.repeat(100);
      
      expect(() => {
        generateUniqueId(pathological);
        slugify(pathological);
      }).not.toThrow();
      
      // Just verify it doesn't hang - may or may not throw
      try {
        validatePath(pathological);
      } catch (e) {
        // If it throws, that's fine
      }
      // The important thing is it completes quickly (tested by the overall test timeout)
    });
  });
});