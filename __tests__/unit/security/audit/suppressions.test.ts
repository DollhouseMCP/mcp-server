/**
 * Tests for security audit suppression configuration
 */

import { 
  shouldSuppress, 
  suppressions,
  validateSuppressions,
  clearSuppressionCache,
  getSuppressionStats
} from '../../../../src/security/audit/config/suppressions.js';

describe('Security Audit Suppressions', () => {
  beforeEach(() => {
    // Clear cache before each test for predictable results
    clearSuppressionCache();
  });

  describe('shouldSuppress', () => {
    describe('exact file matches', () => {
      it('should suppress exact file match with matching rule', () => {
        expect(shouldSuppress('CWE-89-001', 'src/update/UpdateManager.ts')).toBe(true);
      });

      it('should not suppress exact file match with non-matching rule', () => {
        expect(shouldSuppress('OWASP-A03-001', 'src/update/UpdateManager.ts')).toBe(false);
      });

      it('should handle absolute paths correctly', () => {
        const absolutePath = '/home/runner/work/mcp-server/mcp-server/src/update/UpdateManager.ts';
        expect(shouldSuppress('CWE-89-001', absolutePath)).toBe(true);
      });

      it('should handle various CI path formats', () => {
        const paths = [
          '/home/runner/work/mcp-server/mcp-server/src/update/UpdateManager.ts',
          '/Users/developer/Projects/DollhouseMCP/src/update/UpdateManager.ts',
          '/workspace/project/src/update/UpdateManager.ts',
          'C:\\workspace\\mcp-server\\src\\update\\UpdateManager.ts'
        ];
        
        // All should resolve to the same relative path
        paths.forEach(path => {
          expect(shouldSuppress('CWE-89-001', path)).toBe(true);
        });
      });
    });

    describe('wildcard patterns', () => {
      it('should match single wildcard patterns', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/types/persona.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/types/mcp.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/types/subdir/nested.ts')).toBe(false);
      });

      it('should match double wildcard patterns', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/marketplace/PersonaInstaller.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/marketplace/api/PersonaAPI.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/marketplace/deep/nested/file.ts')).toBe(true);
      });

      it('should match test file patterns', () => {
        expect(shouldSuppress('OWASP-A01-001', '__tests__/unit/TokenManager.test.ts')).toBe(true);
        expect(shouldSuppress('CWE-89-001', '__tests__/security/sql-injection.test.ts')).toBe(true);
        expect(shouldSuppress('ANY-RULE', 'src/components/Button.test.ts')).toBe(true);
        expect(shouldSuppress('RANDOM', 'src/utils/helper.spec.ts')).toBe(true);
      });

      it('should handle * rule (suppress all)', () => {
        expect(shouldSuppress('ANY-RULE', '__tests__/example.test.ts')).toBe(true);
        expect(shouldSuppress('RANDOM-123', 'src/test.spec.ts')).toBe(true);
        expect(shouldSuppress('UNKNOWN', 'README.md')).toBe(true); // Test actual .md file, not literal *.md
      });
    });

    describe('path normalization', () => {
      it('should normalize Windows paths', () => {
        const windowsPath = 'src\\security\\validators\\unicodeValidator.ts';
        const unixPath = 'src/security/validators/unicodeValidator.ts';
        
        // Both should be treated the same
        expect(shouldSuppress('DMCP-SEC-004', windowsPath)).toBe(
          shouldSuppress('DMCP-SEC-004', unixPath)
        );
      });

      it('should handle paths with multiple slashes', () => {
        const messyPath = 'src//types///persona.ts';
        expect(shouldSuppress('DMCP-SEC-004', messyPath)).toBe(true);
      });

      it('should handle trailing slashes', () => {
        // Note: trailing slashes on files don't make sense, but we handle them
        const pathWithSlash = 'src/types/persona.ts/';
        const pathWithoutSlash = 'src/types/persona.ts';
        
        expect(shouldSuppress('DMCP-SEC-004', pathWithSlash)).toBe(
          shouldSuppress('DMCP-SEC-004', pathWithoutSlash)
        );
      });
    });

    describe('caching behavior', () => {
      it('should cache results for performance', () => {
        const rule = 'DMCP-SEC-004';
        const file = 'src/types/persona.ts';
        
        // First call
        const result1 = shouldSuppress(rule, file);
        
        // Mock console.error to verify no regex compilation on second call
        const originalError = console.error;
        let errorCalled = false;
        console.error = () => { errorCalled = true; };
        
        // Second call should use cache
        const result2 = shouldSuppress(rule, file);
        
        console.error = originalError;
        
        expect(result1).toBe(result2);
        expect(errorCalled).toBe(false);
      });

      it('should clear cache when requested', () => {
        const rule = 'DMCP-SEC-004';
        const file = 'src/types/persona.ts';
        
        // Populate cache
        shouldSuppress(rule, file);
        
        // Clear cache
        clearSuppressionCache();
        
        // This will recompute (we can't easily test this without spying on internals)
        const result = shouldSuppress(rule, file);
        expect(result).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should return false for undefined filepath', () => {
        expect(shouldSuppress('ANY-RULE', undefined)).toBe(false);
      });

      it('should return false for empty filepath', () => {
        expect(shouldSuppress('ANY-RULE', '')).toBe(false);
      });

      it('should handle files not in suppressions', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/new-feature/dangerous.ts')).toBe(false);
      });

      it('should not partially match patterns', () => {
        // src/types/*.ts should not match src/types-new/file.ts
        expect(shouldSuppress('DMCP-SEC-004', 'src/types-new/file.ts')).toBe(false);
      });

      it('should handle invalid regex patterns gracefully', () => {
        // If we had a malformed pattern, it should not crash
        const originalError = console.error;
        const errors: any[] = [];
        console.error = (...args: any[]) => errors.push(args);
        
        // This shouldn't crash even with edge cases
        expect(() => shouldSuppress('TEST', 'test[file].ts')).not.toThrow();
        
        console.error = originalError;
      });
    });

    describe('special characters in paths', () => {
      it('should handle paths with dots', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/utils/version.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-006', 'package.json')).toBe(true); // JSON files are suppressed for DMCP-SEC-006
      });

      it('should handle paths with special characters', () => {
        // Special characters should be properly escaped and still match glob patterns
        expect(shouldSuppress('*', 'test[1].md')).toBe(true); // **/*.md should match any .md file
        expect(shouldSuppress('*', 'test(1).yaml')).toBe(true); // **/*.yaml should match any .yaml file
      });
    });
  });

  describe('suppression configuration', () => {
    it('should have valid suppression entries', () => {
      for (const suppression of suppressions) {
        expect(suppression.rule).toBeTruthy();
        expect(suppression.reason).toBeTruthy();
        expect(suppression.reason.length).toBeGreaterThan(10); // Meaningful reason
      }
    });

    it('should not have duplicate exact suppressions', () => {
      const exactSuppressions = suppressions
        .filter(s => s.file && !s.file.includes('*'))
        .map(s => `${s.rule}:${s.file}`);
      
      const uniqueSuppressions = new Set(exactSuppressions);
      expect(exactSuppressions.length).toBe(uniqueSuppressions.size);
    });

    it('should use consistent rule naming', () => {
      const rulePattern = /^(DMCP-SEC-\d{3}|OWASP-[A-Z]\d{2}-\d{3}|CWE-\d+-\d{3}|\*)$/;
      for (const suppression of suppressions) {
        expect(suppression.rule).toMatch(rulePattern);
      }
    });
  });

  describe('validateSuppressions', () => {
    it('should return empty array for valid configuration', () => {
      const errors = validateSuppressions();
      expect(errors).toEqual([]);
    });

    it('should validate glob patterns', () => {
      // Our current suppressions should all be valid
      const errors = validateSuppressions();
      const globErrors = errors.filter(e => e.includes('glob pattern'));
      expect(globErrors).toEqual([]);
    });
  });

  describe('getSuppressionStats', () => {
    it('should return correct statistics', () => {
      const stats = getSuppressionStats();
      
      expect(stats.total).toBe(suppressions.length);
      expect(stats.total).toBeGreaterThan(0);
      
      // Check that byRule counts are correct
      const ruleCounts: Record<string, number> = {};
      for (const s of suppressions) {
        ruleCounts[s.rule] = (ruleCounts[s.rule] || 0) + 1;
      }
      expect(stats.byRule).toEqual(ruleCounts);
      
      // Check categories
      expect(stats.byCategory).toHaveProperty('DMCP');
      expect(stats.byCategory).toHaveProperty('OWASP');
      expect(stats.byCategory).toHaveProperty('CWE');
      expect(stats.byCategory).toHaveProperty('*');
    });
  });

  describe('performance considerations', () => {
    it('should handle large numbers of checks efficiently', () => {
      const start = Date.now();
      
      // Perform 1000 checks
      for (let i = 0; i < 1000; i++) {
        shouldSuppress('DMCP-SEC-004', `src/types/file${i}.ts`);
      }
      
      const duration = Date.now() - start;
      
      // Should complete in reasonable time (less than 100ms)
      expect(duration).toBeLessThan(100);
    });
  });
});