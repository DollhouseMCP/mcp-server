/**
 * Performance regression tests for ReDoS fixes
 * 
 * These tests ensure that our ReDoS (Regular Expression Denial of Service) 
 * fixes continue to perform well and prevent future regressions.
 * 
 * Each test uses pathological inputs that would cause exponential backtracking
 * in vulnerable regex patterns and verifies execution completes quickly.
 */

import { generateUniqueId, slugify } from '../../../src/utils/filesystem.js';
import { validatePath, sanitizeInput, MCPInputValidator } from '../../../src/security/InputValidator.js';
import { PersonaImporter } from '../../../src/persona/export-import/PersonaImporter.js';

describe('ReDoS Performance Regression Tests', () => {
  // Helper to measure execution time
  const measureTime = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  // Maximum acceptable execution time in milliseconds
  // CI environments may run slower, so we use a higher threshold there
  const MAX_EXECUTION_TIME = process.env.CI ? 200 : 50;

  describe('filesystem.ts - generateUniqueId', () => {
    it('should handle repeated hyphens efficiently', () => {
      // This would cause catastrophic backtracking with .replace(/-+/g, '-')
      const pathological = 'a' + '-'.repeat(10000) + 'b' + '-'.repeat(10000);
      
      const duration = measureTime(() => {
        generateUniqueId(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle alternating valid/invalid characters efficiently', () => {
      // Creates a pattern like: a!a!a!a!... that challenges replace operations
      const pathological = Array(5000).fill(null)
        .map((_, i) => i % 2 === 0 ? 'a' : '!').join('');
      
      const duration = measureTime(() => {
        generateUniqueId(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle edge cases at length limit', () => {
      // Test exactly at the 100 character limit
      const pathological = 'x'.repeat(50) + '-'.repeat(50);
      
      const result = generateUniqueId(pathological);
      expect(result).toBeDefined();
      
      const duration = measureTime(() => {
        generateUniqueId(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('filesystem.ts - slugify', () => {
    it('should handle repeated special characters efficiently', () => {
      // Would cause issues with multiple chained replace operations
      const pathological = '!!!'.repeat(3000) + 'slug' + '###'.repeat(3000);
      
      const duration = measureTime(() => {
        slugify(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle continuous hyphens efficiently', () => {
      // Tests the collapse of multiple hyphens
      const pathological = 'start' + '-'.repeat(5000) + 'end';
      
      const duration = measureTime(() => {
        const result = slugify(pathological);
        expect(result).toMatch(/^start-end/); // Should collapse hyphens
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('InputValidator.ts - validatePath', () => {
    it('should handle excessive slashes efficiently', () => {
      // Would cause issues with /^\/{1,100}|\/{1,100}$/g
      const pathological = '/' + 'a/'.repeat(5000) + '/'.repeat(1000);
      
      const duration = measureTime(() => {
        try {
          validatePath(pathological);
        } catch (e) {
          // Path validation might throw, that's fine
        }
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle mixed slash patterns efficiently', () => {
      // Complex patterns that could confuse regex engines
      const pathological = '//a///b////c/////d//////e' + '/'.repeat(1000);
      
      const duration = measureTime(() => {
        try {
          validatePath(pathological);
        } catch (e) {
          // Expected to throw for invalid format
        }
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle boundary slash patterns', () => {
      // Tests leading and trailing slash handling
      const pathological = '/'.repeat(500) + 'path' + '/'.repeat(500);
      
      const duration = measureTime(() => {
        try {
          validatePath(pathological);
        } catch (e) {
          // Expected behavior
        }
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('InputValidator.ts - sanitizeInput', () => {
    it('should handle strings with many special characters efficiently', () => {
      // Tests multiple replace operations
      const pathological = '<script>' + '&'.repeat(1000) + '"'.repeat(1000) + 
                          '`'.repeat(1000) + '$'.repeat(1000) + '</script>';
      
      const duration = measureTime(() => {
        sanitizeInput(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle control characters efficiently', () => {
      // String full of control characters
      const pathological = '\x00\x01\x02'.repeat(1000) + 'text' + '\x7F'.repeat(1000);
      
      const duration = measureTime(() => {
        const result = sanitizeInput(pathological);
        expect(result).toBe('text'); // All control chars should be removed
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle RTL and zero-width characters efficiently', () => {
      // Tests Unicode character handling
      const pathological = '\u202E'.repeat(500) + 'text' + '\uFEFF'.repeat(500);
      
      const duration = measureTime(() => {
        const result = sanitizeInput(pathological);
        expect(result).toBe('text');
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('MCPInputValidator.validateSearchQuery', () => {
    it('should handle queries with many special characters efficiently', () => {
      // Stay within the 200 character limit
      const pathological = 'search' + '<>&"'.repeat(40) + 'term';
      
      const duration = measureTime(() => {
        const result = MCPInputValidator.validateSearchQuery(pathological);
        expect(result).toBe('searchterm');
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('PersonaImporter - base64 validation', () => {
    it('should reject empty strings efficiently', async () => {
      const importer = new PersonaImporter('/tmp/test', 'test-user');
      
      const startTime = performance.now();
      try {
        await importer.importPersona('', new Map(), false);
      } catch (e) {
        // Expected to fail
      }
      const duration = performance.now() - startTime;
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle near-valid base64 patterns efficiently', async () => {
      const importer = new PersonaImporter('/tmp/test', 'test-user');
      // Almost valid but not quite - missing padding
      const pathological = 'A'.repeat(1000);
      
      const startTime = performance.now();
      try {
        await importer.importPersona(pathological, new Map(), false);
      } catch (e) {
        // Expected to fail - not valid base64
      }
      const duration = performance.now() - startTime;
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });

  describe('Performance comparison tests', () => {
    it('should demonstrate improved performance over vulnerable patterns', () => {
      // This test documents the performance improvement
      const testString = 'a' + '-'.repeat(100) + 'b';
      
      // Our optimized version
      const optimizedDuration = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          generateUniqueId(testString);
        }
      });
      
      // The optimized version should complete 100 iterations very quickly
      expect(optimizedDuration).toBeLessThan(100); // 100ms for 100 iterations
      
      console.log(`Optimized version completed 100 iterations in ${optimizedDuration.toFixed(2)}ms`);
    });
  });

  describe('Edge case performance', () => {
    it('should handle empty strings efficiently', () => {
      const duration = measureTime(() => {
        generateUniqueId('');
        slugify('');
        sanitizeInput('');
      });
      
      expect(duration).toBeLessThan(10); // Should be nearly instant
    });

    it('should handle maximum length inputs efficiently', () => {
      const maxLengthString = 'a'.repeat(10000);
      
      const duration = measureTime(() => {
        generateUniqueId(maxLengthString);
        slugify(maxLengthString);
        sanitizeInput(maxLengthString, 10000);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });

    it('should handle Unicode edge cases efficiently', () => {
      // Mix of different Unicode ranges
      const pathological = '🎉'.repeat(100) + '中文'.repeat(100) + 'עברית'.repeat(100);
      
      const duration = measureTime(() => {
        generateUniqueId(pathological);
        slugify(pathological);
      });
      
      expect(duration).toBeLessThan(MAX_EXECUTION_TIME);
    });
  });
});