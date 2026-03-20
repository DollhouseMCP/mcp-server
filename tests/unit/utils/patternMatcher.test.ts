/**
 * Pattern Matcher Utility Tests
 *
 * Tests for glob-like pattern matching used in autonomy configuration
 * and conflict detection.
 */

import { describe, it, expect } from '@jest/globals';
import {
  matchesPattern,
  globToRegex,
  detectPatternConflict,
  findPatternConflicts,
  MAX_GLOB_PATTERN_LENGTH,
  MAX_PATTERN_MATCH_TEXT_LENGTH,
} from '../../../src/utils/patternMatcher.js';

describe('patternMatcher', () => {
  describe('matchesPattern', () => {
    describe('exact matches', () => {
      it('should match identical strings', () => {
        expect(matchesPattern('deploy', 'deploy')).toBe(true);
      });

      it('should be case-insensitive', () => {
        expect(matchesPattern('Deploy', 'deploy')).toBe(true);
        expect(matchesPattern('DEPLOY', 'deploy')).toBe(true);
        expect(matchesPattern('deploy', 'DEPLOY')).toBe(true);
      });

      it('should not match different strings', () => {
        expect(matchesPattern('deploy', 'delete')).toBe(false);
      });
    });

    describe('wildcard * (any sequence)', () => {
      it('should match * at the end', () => {
        expect(matchesPattern('deploy_prod', 'deploy_*')).toBe(true);
        expect(matchesPattern('deploy_staging', 'deploy_*')).toBe(true);
        expect(matchesPattern('deploy_', 'deploy_*')).toBe(true);
      });

      it('should match * at the beginning', () => {
        expect(matchesPattern('prod_deploy', '*_deploy')).toBe(true);
        expect(matchesPattern('staging_deploy', '*_deploy')).toBe(true);
      });

      it('should match * in the middle', () => {
        expect(matchesPattern('deploy_to_prod', 'deploy_*_prod')).toBe(true);
        expect(matchesPattern('deploy_via_prod', 'deploy_*_prod')).toBe(true);
      });

      it('should match multiple *', () => {
        expect(matchesPattern('a_b_c_d', 'a_*_*_d')).toBe(true);
        expect(matchesPattern('start_middle_end', '*_middle_*')).toBe(true);
      });

      it('should match empty string for *', () => {
        expect(matchesPattern('deploy_prod', 'deploy_*prod')).toBe(true);
      });

      it('should not match when prefix/suffix differs', () => {
        expect(matchesPattern('delete_prod', 'deploy_*')).toBe(false);
        expect(matchesPattern('prod_delete', '*_deploy')).toBe(false);
      });
    });

    describe('wildcard ? (single character)', () => {
      it('should match exactly one character', () => {
        expect(matchesPattern('file1', 'file?')).toBe(true);
        expect(matchesPattern('fileA', 'file?')).toBe(true);
      });

      it('should not match zero characters', () => {
        expect(matchesPattern('file', 'file?')).toBe(false);
      });

      it('should not match multiple characters', () => {
        expect(matchesPattern('file12', 'file?')).toBe(false);
      });

      it('should match multiple ?', () => {
        expect(matchesPattern('ab', '??')).toBe(true);
        expect(matchesPattern('abc', '???')).toBe(true);
        expect(matchesPattern('a', '??')).toBe(false);
      });
    });

    describe('combined wildcards', () => {
      it('should handle * and ? together', () => {
        expect(matchesPattern('file1_backup', 'file?_*')).toBe(true);
        expect(matchesPattern('fileA_backup_2024', 'file?_*')).toBe(true);
      });
    });

    describe('special regex characters', () => {
      it('should escape dots', () => {
        expect(matchesPattern('file.txt', 'file.txt')).toBe(true);
        expect(matchesPattern('filextxt', 'file.txt')).toBe(false);
      });

      it('should escape other regex chars', () => {
        expect(matchesPattern('test(1)', 'test(1)')).toBe(true);
        expect(matchesPattern('test[1]', 'test[1]')).toBe(true);
        expect(matchesPattern('test^end', 'test^end')).toBe(true);
        expect(matchesPattern('test$end', 'test$end')).toBe(true);
      });
    });
  });

  describe('globToRegex', () => {
    it('should convert simple pattern to regex', () => {
      const regex = globToRegex('deploy');
      expect(regex.test('deploy')).toBe(true);
      expect(regex.test('Deploy')).toBe(true); // case insensitive
    });

    it('should convert * to .*', () => {
      const regex = globToRegex('deploy_*');
      expect(regex.source).toContain('.*');
    });

    it('should convert ? to .', () => {
      const regex = globToRegex('file?');
      expect(regex.source).toContain('.');
    });
  });

  describe('detectPatternConflict', () => {
    it('should detect exact match conflict', () => {
      const result = detectPatternConflict('deploy_prod', 'deploy_prod');
      expect(result.conflicts).toBe(true);
      expect(result.reason).toBe('exact match');
    });

    it('should detect case-insensitive exact match', () => {
      const result = detectPatternConflict('Deploy_Prod', 'deploy_prod');
      expect(result.conflicts).toBe(true);
      expect(result.reason).toBe('exact match');
    });

    it('should detect when specific pattern matches glob pattern', () => {
      // deploy_prod matches deploy_*
      const result = detectPatternConflict('deploy_*', 'deploy_prod');
      expect(result.conflicts).toBe(true);
      expect(result.reason).toContain("'deploy_prod' matches pattern 'deploy_*'");
    });

    it('should detect when glob pattern matches specific pattern', () => {
      // deploy_prod matches deploy_*
      const result = detectPatternConflict('deploy_prod', 'deploy_*');
      expect(result.conflicts).toBe(true);
      expect(result.reason).toContain("'deploy_prod' matches pattern 'deploy_*'");
    });

    it('should not detect conflict for non-overlapping patterns', () => {
      const result = detectPatternConflict('deploy_*', 'delete_*');
      expect(result.conflicts).toBe(false);
    });

    it('should not detect conflict for different specific patterns', () => {
      const result = detectPatternConflict('deploy_prod', 'deploy_staging');
      expect(result.conflicts).toBe(false);
    });

    it('should detect conflict with ? wildcard', () => {
      const result = detectPatternConflict('file?', 'file1');
      expect(result.conflicts).toBe(true);
    });
  });

  describe('findPatternConflicts', () => {
    it('should find no conflicts between non-overlapping patterns', () => {
      const conflicts = findPatternConflicts(
        ['deploy_*', 'build_*'],
        ['delete_*', 'clean_*']
      );
      expect(conflicts).toHaveLength(0);
    });

    it('should find exact match conflicts', () => {
      const conflicts = findPatternConflicts(
        ['deploy_prod'],
        ['deploy_prod']
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('exact match');
    });

    it('should find glob pattern conflicts', () => {
      const conflicts = findPatternConflicts(
        ['deploy_*'],
        ['deploy_prod', 'deploy_staging']
      );
      expect(conflicts).toHaveLength(2);
      expect(conflicts[0]).toContain('deploy_prod');
      expect(conflicts[1]).toContain('deploy_staging');
    });

    it('should find conflicts in both directions', () => {
      const conflicts = findPatternConflicts(
        ['deploy_prod'],
        ['deploy_*']
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('deploy_prod');
    });

    it('should handle empty arrays', () => {
      expect(findPatternConflicts([], ['deploy_*'])).toHaveLength(0);
      expect(findPatternConflicts(['deploy_*'], [])).toHaveLength(0);
      expect(findPatternConflicts([], [])).toHaveLength(0);
    });

    it('should find multiple overlapping conflicts', () => {
      const conflicts = findPatternConflicts(
        ['*_prod', 'deploy_*'],
        ['deploy_prod'] // matches both patterns
      );
      expect(conflicts).toHaveLength(2);
    });
  });

  describe('input validation (Issue #388)', () => {
    describe('glob pattern length limits', () => {
      it('should return never-matching regex when pattern exceeds MAX_GLOB_PATTERN_LENGTH', () => {
        const oversizedPattern = 'a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1);
        const regex = globToRegex(oversizedPattern);
        expect(regex.test(oversizedPattern)).toBe(false);
        expect(regex.test('anything')).toBe(false);
      });

      it('should still work when pattern is exactly at the limit', () => {
        const atLimitPattern = 'deploy_' + '*'.repeat(MAX_GLOB_PATTERN_LENGTH - 7);
        const regex = globToRegex(atLimitPattern);
        // Pattern at limit should still be converted (not rejected)
        expect(regex).toBeDefined();
        expect(regex.source).not.toBe('(?!)');
      });
    });

    describe('text length limits for matchesPattern', () => {
      it('should return false when text exceeds MAX_PATTERN_MATCH_TEXT_LENGTH', () => {
        const oversizedText = 'a'.repeat(MAX_PATTERN_MATCH_TEXT_LENGTH + 1);
        expect(matchesPattern(oversizedText, '*')).toBe(false);
      });

      it('should still work when text is exactly at the limit', () => {
        const atLimitText = 'a'.repeat(MAX_PATTERN_MATCH_TEXT_LENGTH);
        expect(matchesPattern(atLimitText, '*')).toBe(true);
      });
    });
  });
});
