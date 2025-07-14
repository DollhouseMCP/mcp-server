/**
 * Tests for regex injection safety in suppressions
 * Addresses CodeQL security vulnerability
 */

import { shouldSuppress } from '../../../../../src/security/audit/config/suppressions.js';

describe('Suppression Regex Safety', () => {
  describe('regex injection prevention', () => {
    it('should safely handle paths with regex special characters', () => {
      // These paths contain regex special characters that could cause issues if not escaped
      const dangerousPaths = [
        'src/utils/file[1].ts',
        'src/utils/file(1).ts',
        'src/utils/file{1}.ts',
        'src/utils/file+.ts',
        'src/utils/file?.ts',
        'src/utils/file*.ts',
        'src/utils/file$.ts',
        'src/utils/file^.ts',
        'src/utils/file|.ts',
        'src/utils/file\\.ts',
        'C:\\Users\\test\\file.ts',
        '/path/with/$pecial/chars.ts',
        'src/[group]/file.ts',
        'src/(group)/file.ts',
        'src/{group}/file.ts'
      ];

      // None of these should cause regex compilation errors
      dangerousPaths.forEach(path => {
        expect(() => {
          shouldSuppress('DMCP-SEC-004', path);
        }).not.toThrow();
      });
    });

    it('should not allow regex injection through glob patterns', () => {
      // Test that malicious patterns don't break out of their intended scope
      const result1 = shouldSuppress('*', 'src/evil.ts.hack');
      const result2 = shouldSuppress('*', 'src/evil.ts');
      
      // Both should have consistent behavior - the .hack extension shouldn't bypass patterns
      expect(result1).toBe(result2);
    });

    it('should handle backslashes in Windows paths correctly', () => {
      const windowsPaths = [
        'C:\\Users\\Developer\\mcp-server\\src\\update\\UpdateManager.ts',
        'C:\\Program Files\\app\\file.ts',
        'D:\\Projects\\test\\src\\file.ts'
      ];

      windowsPaths.forEach(path => {
        expect(() => {
          shouldSuppress('CWE-89-001', path);
        }).not.toThrow();
      });
    });

    it('should prevent catastrophic backtracking in regex patterns', () => {
      // Test with a potentially problematic input that could cause catastrophic backtracking
      const longPath = 'a'.repeat(100) + '/' + 'b'.repeat(100) + '.ts';
      
      const startTime = Date.now();
      shouldSuppress('*', longPath);
      const duration = Date.now() - startTime;
      
      // Should complete quickly (under 100ms) even with long input
      expect(duration).toBeLessThan(100);
    });

    it('should handle malformed glob patterns gracefully', () => {
      // These shouldn't crash or cause unexpected behavior
      const malformedPaths = [
        '***/test.ts',
        '***.ts',
        '***',
        '[[[[.ts',
        '{{{{.ts',
        '\\\\\\\\',
        '////////'
      ];

      malformedPaths.forEach(path => {
        expect(() => {
          shouldSuppress('*', path);
        }).not.toThrow();
      });
    });
  });
});