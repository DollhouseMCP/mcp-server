/**
 * InputNormalizer Tests
 *
 * Comprehensive test suite covering:
 * - Recursive normalization of nested objects and arrays
 * - String normalization using UnicodeValidator
 * - Issue aggregation and severity escalation
 * - Path tracking for detailed error reporting
 * - Non-string value preservation
 * - Edge cases and boundary conditions
 */

import { describe, it, expect } from '@jest/globals';
import { InputNormalizer } from '../../../src/security/InputNormalizer.js';

describe('InputNormalizer', () => {
  describe('normalize - Basic Types', () => {
    it('should normalize simple string values', () => {
      const result = InputNormalizer.normalize('hello world');

      expect(result.data).toBe('hello world');
      expect(result.hasIssues).toBe(false);
      expect(result.hasHighOrCriticalIssues).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('should preserve null and undefined values', () => {
      expect(InputNormalizer.normalize(null).data).toBeNull();
      expect(InputNormalizer.normalize(undefined).data).toBeUndefined();
    });

    it('should preserve number values', () => {
      const result = InputNormalizer.normalize(42);
      expect(result.data).toBe(42);
      expect(result.hasIssues).toBe(false);
    });

    it('should preserve boolean values', () => {
      const result = InputNormalizer.normalize(true);
      expect(result.data).toBe(true);
      expect(result.hasIssues).toBe(false);
    });
  });

  describe('normalize - Unicode Normalization', () => {
    it('should remove zero-width characters', () => {
      const input = 'test\u200Bvalue'; // Zero-width space
      const result = InputNormalizer.normalize(input);

      expect(result.data).toBe('testvalue');
      expect(result.hasIssues).toBe(true);
      expect(result.warnings).toContain('$: Zero-width or non-printable characters detected');
    });

    it('should remove direction override characters', () => {
      const input = 'test\u202Evalue'; // Right-to-left override
      const result = InputNormalizer.normalize(input);

      expect(result.data).toBe('testvalue');
      expect(result.hasIssues).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.maxSeverity).toBe('high');
    });

    it('should normalize confusable characters', () => {
      const input = 'аdmin'; // Cyrillic 'а' instead of Latin 'a'
      const result = InputNormalizer.normalize(input);

      expect(result.data).toBe('admin'); // Normalized to ASCII
      expect(result.hasIssues).toBe(true);
      // Mixed script + confusables = high severity, goes to errors
      expect(result.maxSeverity).toBe('high');
      expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
    });

    it('should detect mixed script attacks', () => {
      const input = 'admin\u0430'; // Latin 'admin' + Cyrillic 'а'
      const result = InputNormalizer.normalize(input);

      expect(result.hasIssues).toBe(true);
      expect(result.maxSeverity).toBe('high');
    });
  });

  describe('normalize - Object Structures', () => {
    it('should recursively normalize object properties', () => {
      const input = {
        name: 'test\u200Bname',
        description: 'test\u200Bdesc',
        value: 'clean'
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual({
        name: 'testname',
        description: 'testdesc',
        value: 'clean'
      });
      expect(result.hasIssues).toBe(true);
      expect(result.warnings).toContain('$.name: Zero-width or non-printable characters detected');
      expect(result.warnings).toContain('$.description: Zero-width or non-printable characters detected');
    });

    it('should preserve non-string properties in objects', () => {
      const input = {
        name: 'test',
        age: 25,
        active: true,
        metadata: null
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual({
        name: 'test',
        age: 25,
        active: true,
        metadata: null
      });
      expect(result.hasIssues).toBe(false);
    });

    it('should handle deeply nested objects', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              value: 'test\u200Bvalue'
            }
          }
        }
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual({
        level1: {
          level2: {
            level3: {
              value: 'testvalue'
            }
          }
        }
      });
      expect(result.hasIssues).toBe(true);
      expect(result.warnings).toContain('$.level1.level2.level3.value: Zero-width or non-printable characters detected');
    });
  });

  describe('normalize - Array Structures', () => {
    it('should recursively normalize array elements', () => {
      const input = ['test\u200Bvalue1', 'test\u200Bvalue2', 'clean'];

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual(['testvalue1', 'testvalue2', 'clean']);
      expect(result.hasIssues).toBe(true);
      expect(result.warnings).toContain('$[0]: Zero-width or non-printable characters detected');
      expect(result.warnings).toContain('$[1]: Zero-width or non-printable characters detected');
    });

    it('should preserve non-string elements in arrays', () => {
      const input = [1, true, null, 'test'];

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual([1, true, null, 'test']);
      expect(result.hasIssues).toBe(false);
    });

    it('should handle arrays of objects', () => {
      const input = [
        { name: 'test\u200B1' },
        { name: 'test\u200B2' }
      ];

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual([
        { name: 'test1' },
        { name: 'test2' }
      ]);
      expect(result.hasIssues).toBe(true);
      expect(result.warnings).toContain('$[0].name: Zero-width or non-printable characters detected');
      expect(result.warnings).toContain('$[1].name: Zero-width or non-printable characters detected');
    });
  });

  describe('normalize - Complex Nested Structures', () => {
    it('should handle complex agent-like structures', () => {
      const input = {
        name: 'test\u200Bagent',
        description: 'An agent',
        goal: {
          template: 'Do {task\u200B}',
          parameters: [
            {
              name: 'task\u200B',
              type: 'string',
              description: 'The task\u200B'
            }
          ],
          successCriteria: ['criterion\u200B1', 'criterion2']
        },
        activates: {
          personas: ['persona\u200B1'],
          skills: ['skill1']
        },
        tools: {
          allowed: ['tool\u200B1', 'tool2'],
          denied: ['bad\u200Btool']
        }
      };

      const result = InputNormalizer.normalize(input);

      // Check normalization worked
      expect(result.data).toEqual({
        name: 'testagent',
        description: 'An agent',
        goal: {
          template: 'Do {task}',
          parameters: [
            {
              name: 'task',
              type: 'string',
              description: 'The task'
            }
          ],
          successCriteria: ['criterion1', 'criterion2']
        },
        activates: {
          personas: ['persona1'],
          skills: ['skill1']
        },
        tools: {
          allowed: ['tool1', 'tool2'],
          denied: ['badtool']
        }
      });

      expect(result.hasIssues).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('normalize - Issue Aggregation', () => {
    it('should aggregate issues from multiple fields', () => {
      const input = {
        field1: 'test\u200B1',
        field2: 'test\u200B2',
        field3: 'test\u200B3'
      };

      const result = InputNormalizer.normalize(input);

      expect(result.hasIssues).toBe(true);
      expect(result.warnings.length).toBe(3);
      expect(result.issuesByPath.size).toBe(3);
      expect(result.issuesByPath.has('$.field1')).toBe(true);
      expect(result.issuesByPath.has('$.field2')).toBe(true);
      expect(result.issuesByPath.has('$.field3')).toBe(true);
    });

    it('should escalate to highest severity', () => {
      const input = {
        low: 'test\u200B',      // Zero-width = medium
        high: 'test\u202E'     // Direction override = high
      };

      const result = InputNormalizer.normalize(input);

      expect(result.maxSeverity).toBe('high');
      expect(result.hasHighOrCriticalIssues).toBe(true);
    });

    it('should categorize errors vs warnings by severity', () => {
      const input = {
        warning: 'test\u200B',   // Zero-width = medium -> warning
        error: 'test\u202E'      // Direction override = high -> error
      };

      const result = InputNormalizer.normalize(input);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.hasHighOrCriticalIssues).toBe(true);
    });
  });

  describe('normalize - Path Tracking', () => {
    it('should track paths for object properties', () => {
      const input = {
        nested: {
          field: 'test\u200B'
        }
      };

      const result = InputNormalizer.normalize(input);

      expect(result.warnings[0]).toContain('$.nested.field');
    });

    it('should track paths for array elements', () => {
      const input = ['test\u200B'];

      const result = InputNormalizer.normalize(input);

      expect(result.warnings[0]).toContain('$[0]');
    });

    it('should track paths for nested arrays and objects', () => {
      const input = {
        items: [
          { name: 'test\u200B' }
        ]
      };

      const result = InputNormalizer.normalize(input);

      expect(result.warnings[0]).toContain('$.items[0].name');
    });

    it('should use custom root path when provided', () => {
      const result = InputNormalizer.normalize('test\u200B', 'customRoot');

      expect(result.warnings[0]).toContain('customRoot');
    });
  });

  describe('needsNormalization - Optimization Check', () => {
    it('should detect strings needing normalization', () => {
      expect(InputNormalizer.needsNormalization('test\u200B')).toBe(true);
      expect(InputNormalizer.needsNormalization('test\u202E')).toBe(true);
    });

    it('should return false for clean strings', () => {
      expect(InputNormalizer.needsNormalization('clean string')).toBe(false);
    });

    it('should check objects recursively', () => {
      const input = {
        clean: 'clean',
        dirty: 'test\u200B'
      };

      expect(InputNormalizer.needsNormalization(input)).toBe(true);
    });

    it('should check arrays recursively', () => {
      const input = ['clean', 'test\u200B'];

      expect(InputNormalizer.needsNormalization(input)).toBe(true);
    });

    it('should return false for clean objects', () => {
      const input = {
        name: 'clean',
        description: 'also clean'
      };

      expect(InputNormalizer.needsNormalization(input)).toBe(false);
    });

    it('should handle non-string primitives', () => {
      expect(InputNormalizer.needsNormalization(42)).toBe(false);
      expect(InputNormalizer.needsNormalization(true)).toBe(false);
      expect(InputNormalizer.needsNormalization(null)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty objects', () => {
      const result = InputNormalizer.normalize({});

      expect(result.data).toEqual({});
      expect(result.hasIssues).toBe(false);
    });

    it('should handle empty arrays', () => {
      const result = InputNormalizer.normalize([]);

      expect(result.data).toEqual([]);
      expect(result.hasIssues).toBe(false);
    });

    it('should handle empty strings', () => {
      const result = InputNormalizer.normalize('');

      expect(result.data).toBe('');
      expect(result.hasIssues).toBe(false);
    });

    it('should handle objects with mixed types', () => {
      const input = {
        string: 'test',
        number: 42,
        boolean: true,
        null: null,
        undefined: undefined,
        object: { nested: 'value' },
        array: [1, 2, 3]
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data).toEqual(input);
      expect(result.hasIssues).toBe(false);
    });
  });

  describe('Real-World Security Scenarios', () => {
    it('should prevent homograph attacks in agent names', () => {
      const input = {
        name: 'аdmin', // Cyrillic 'а'
        description: 'Admin agent'
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data.name).toBe('admin'); // Normalized to ASCII
      expect(result.hasIssues).toBe(true);
    });

    it('should remove zero-width spaces from goal templates', () => {
      const input = {
        goal: {
          template: 'Do {tas\u200Bk}' // Zero-width space in parameter name
        }
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data.goal.template).toBe('Do {task}');
      expect(result.hasIssues).toBe(true);
    });

    it('should detect direction override in system prompts', () => {
      const input = {
        systemPrompt: 'You are a helpful\u202E assistant'
      };

      const result = InputNormalizer.normalize(input);

      expect(result.data.systemPrompt).toBe('You are a helpful assistant');
      expect(result.hasHighOrCriticalIssues).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle multiple Unicode issues in one field', () => {
      const input = 'test\u200B\u202E\u0430value'; // Zero-width + direction override + Cyrillic

      const result = InputNormalizer.normalize(input);

      expect(result.data).toBe('testavalue'); // All normalized
      expect(result.hasIssues).toBe(true);
      expect(result.maxSeverity).toBe('high');
    });
  });
});
