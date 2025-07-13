/**
 * Tests for security audit suppression configuration
 */

import { shouldSuppress, suppressions } from '../../../../src/security/audit/config/suppressions.js';

describe('Security Audit Suppressions', () => {
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
    });

    describe('wildcard patterns', () => {
      it('should match single wildcard patterns', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/types/persona.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/types/mcp.ts')).toBe(true);
      });

      it('should match double wildcard patterns', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/marketplace/PersonaInstaller.ts')).toBe(true);
        expect(shouldSuppress('DMCP-SEC-004', 'src/marketplace/api/PersonaAPI.ts')).toBe(true);
      });

      it('should match test file patterns', () => {
        expect(shouldSuppress('OWASP-A01-001', '__tests__/unit/TokenManager.test.ts')).toBe(true);
        expect(shouldSuppress('CWE-89-001', '__tests__/security/sql-injection.test.ts')).toBe(true);
      });

      it('should handle * rule (suppress all)', () => {
        expect(shouldSuppress('ANY-RULE', '__tests__/example.test.ts')).toBe(true);
        expect(shouldSuppress('RANDOM-123', '**/*.spec.ts')).toBe(true);
      });
    });

    describe('path resolution', () => {
      it('should extract relative path from CI paths', () => {
        const ciPath = '/home/runner/work/mcp-server/mcp-server/src/update/UpdateManager.ts';
        expect(shouldSuppress('CWE-89-001', ciPath)).toBe(true);
      });

      it('should handle Windows paths', () => {
        const windowsPath = 'C:\\Users\\runner\\work\\mcp-server\\mcp-server\\src\\update\\UpdateManager.ts';
        // Note: This test documents current behavior - Windows paths won't match
        // This is acceptable as our CI runs on Linux
        expect(shouldSuppress('CWE-89-001', windowsPath)).toBe(false);
      });

      it('should handle paths without project name', () => {
        const genericPath = '/usr/local/src/types/persona.ts';
        expect(shouldSuppress('DMCP-SEC-004', genericPath)).toBe(true);
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
    });

    describe('special characters in paths', () => {
      it('should handle paths with special regex characters', () => {
        const specialPath = 'src/utils/helper[1].ts';
        // This documents that special chars in paths need exact matches
        expect(shouldSuppress('DMCP-SEC-004', specialPath)).toBe(false);
      });

      it('should handle paths with dots', () => {
        expect(shouldSuppress('DMCP-SEC-004', 'src/utils/version.ts')).toBe(true);
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
});