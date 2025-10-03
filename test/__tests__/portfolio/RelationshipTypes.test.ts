/**
 * Tests for type-safe relationship utilities
 *
 * Validates the improved type safety for relationship parsing
 * and handling in the Enhanced Index system.
 */

import {
  BaseRelationship,
  ParsedRelationship,
  InvalidRelationship,
  createRelationship,
  parseRelationship,
  isParsedRelationship,
  isInvalidRelationship,
  isBaseRelationship,
  parseRelationships,
  validateRelationship,
  groupRelationshipsByType,
  findDuplicateRelationships,
  deduplicateRelationships,
  sortRelationshipsByStrength,
  filterRelationshipsByStrength,
  RelationshipTypes
} from '../../../src/portfolio/types/RelationshipTypes.js';

describe('RelationshipTypes', () => {
  describe('createRelationship', () => {
    it('should create a valid parsed relationship', () => {
      const rel = createRelationship(
        'personas',
        'test-persona',
        RelationshipTypes.SIMILAR_TO,
        0.8,
        { test: true }
      );

      expect(rel).toEqual({
        element: 'personas:test-persona',
        type: 'similar_to',
        strength: 0.8,
        metadata: { test: true },
        targetType: 'personas',
        targetName: 'test-persona',
        isValid: true
      });
    });

    it('should throw error for invalid strength', () => {
      expect(() => {
        createRelationship('personas', 'test', 'similar_to', 1.5);
      }).toThrow('Relationship strength must be between 0 and 1');

      expect(() => {
        createRelationship('personas', 'test', 'similar_to', -0.1);
      }).toThrow('Relationship strength must be between 0 and 1');
    });

    it('should accept boundary values for strength (0 and 1)', () => {
      const relZero = createRelationship('personas', 'test', 'similar_to', 0);
      expect(relZero.strength).toBe(0);
      expect(relZero.isValid).toBe(true);

      const relOne = createRelationship('personas', 'test', 'similar_to', 1);
      expect(relOne.strength).toBe(1);
      expect(relOne.isValid).toBe(true);
    });

    it('should handle optional parameters', () => {
      const rel = createRelationship('skills', 'test-skill');

      expect(rel.type).toBeUndefined();
      expect(rel.strength).toBeUndefined();
      expect(rel.metadata).toBeUndefined();
      expect(rel.targetType).toBe('skills');
      expect(rel.targetName).toBe('test-skill');
    });
  });

  describe('parseRelationship', () => {
    it('should parse valid relationship', () => {
      const base: BaseRelationship = {
        element: 'personas:test-persona',
        type: 'similar_to',
        strength: 0.8
      };

      const parsed = parseRelationship(base);

      expect(isParsedRelationship(parsed)).toBe(true);
      if (isParsedRelationship(parsed)) {
        expect(parsed.targetType).toBe('personas');
        expect(parsed.targetName).toBe('test-persona');
        expect(parsed.isValid).toBe(true);
        expect(parsed.strength).toBe(0.8);
      }
    });

    it('should return invalid relationship for missing element', () => {
      const base: BaseRelationship = {
        element: ''
      };

      const parsed = parseRelationship(base);

      expect(isInvalidRelationship(parsed)).toBe(true);
      if (isInvalidRelationship(parsed)) {
        expect(parsed.isValid).toBe(false);
        expect(parsed.parseError).toContain('missing or empty');
        expect(parsed.targetType).toBeNull();
        expect(parsed.targetName).toBeNull();
      }
    });

    it('should return invalid relationship for malformed element ID', () => {
      const base: BaseRelationship = {
        element: 'invalid-no-separator'
      };

      const parsed = parseRelationship(base);

      expect(isInvalidRelationship(parsed)).toBe(true);
      if (isInvalidRelationship(parsed)) {
        expect(parsed.isValid).toBe(false);
        expect(parsed.parseError).toContain('Invalid element ID format');
        expect(parsed.parseError).toContain('missing separator');
      }
    });

    it('should provide detailed error for various malformed IDs', () => {
      const testCases = [
        {
          element: 'no-colon',
          expectedError: 'missing separator'
        },
        {
          element: ':missing-type',
          expectedError: 'missing type before'
        },
        {
          element: 'missing-name:',
          expectedError: 'missing name after'
        },
        {
          element: 'too:many:colons',
          expectedError: 'multiple separators'
        }
      ];

      for (const { element, expectedError } of testCases) {
        const base: BaseRelationship = { element };
        const result = parseRelationship(base);

        expect(isInvalidRelationship(result)).toBe(true);
        if (isInvalidRelationship(result)) {
          expect(result.parseError).toContain(expectedError);
          expect(result.parseError).toContain(element); // Should include the actual input
        }
      }
    });
  });

  describe('type guards', () => {
    it('should correctly identify parsed relationships', () => {
      const parsed = createRelationship('personas', 'test');
      const base: BaseRelationship = { element: 'personas:test' };
      const invalid = parseRelationship({ element: '' });

      expect(isParsedRelationship(parsed)).toBe(true);
      expect(isParsedRelationship(base)).toBe(false);
      expect(isParsedRelationship(invalid)).toBe(false);
    });

    it('should correctly identify invalid relationships', () => {
      const invalid = parseRelationship({ element: '' });
      const parsed = createRelationship('personas', 'test');
      const base: BaseRelationship = { element: 'personas:test' };

      expect(isInvalidRelationship(invalid)).toBe(true);
      expect(isInvalidRelationship(parsed)).toBe(false);
      expect(isInvalidRelationship(base)).toBe(false);
    });

    it('should correctly identify base relationships', () => {
      const base: BaseRelationship = { element: 'personas:test' };
      const parsed = createRelationship('personas', 'test');
      const invalid = parseRelationship({ element: '' });

      expect(isBaseRelationship(base)).toBe(true);
      expect(isBaseRelationship(parsed)).toBe(false);
      expect(isBaseRelationship(invalid)).toBe(false);
    });
  });

  describe('parseRelationships', () => {
    it('should batch parse relationships', () => {
      const relationships: BaseRelationship[] = [
        { element: 'personas:test1', strength: 0.8 },
        { element: 'skills:test2', strength: 0.6 },
        { element: 'invalid', strength: 0.5 },
        { element: 'agents:test3', strength: 0.9 }
      ];

      const parsed = parseRelationships(relationships);

      // Should filter out invalid by default
      expect(parsed).toHaveLength(3);
      expect(parsed.every(isParsedRelationship)).toBe(true);
    });

    it('should include invalid when requested', () => {
      const relationships: BaseRelationship[] = [
        { element: 'personas:test1', strength: 0.8 },
        { element: 'invalid', strength: 0.5 }
      ];

      const parsed = parseRelationships(relationships, true);

      expect(parsed).toHaveLength(2);
      expect(isParsedRelationship(parsed[0])).toBe(true);
      expect(isInvalidRelationship(parsed[1])).toBe(true);
    });
  });

  describe('validateRelationship', () => {
    it('should validate correct relationships', () => {
      expect(validateRelationship({ element: 'personas:test' })).toBe(true);
      expect(validateRelationship({ element: 'test', type: 'uses' })).toBe(true);
    });

    it('should reject invalid relationships', () => {
      expect(validateRelationship(null)).toBe(false);
      expect(validateRelationship(undefined)).toBe(false);
      expect(validateRelationship({})).toBe(false);
      expect(validateRelationship({ element: '' })).toBe(false);
      expect(validateRelationship({ element: 123 })).toBe(false);
    });
  });

  describe('groupRelationshipsByType', () => {
    it('should group relationships by target type', () => {
      const relationships = [
        createRelationship('personas', 'test1'),
        createRelationship('skills', 'test2'),
        createRelationship('personas', 'test3'),
        createRelationship('agents', 'test4')
      ];

      const grouped = groupRelationshipsByType(relationships);

      expect(grouped.size).toBe(3);
      expect(grouped.get('personas')).toHaveLength(2);
      expect(grouped.get('skills')).toHaveLength(1);
      expect(grouped.get('agents')).toHaveLength(1);
    });
  });

  describe('findDuplicateRelationships', () => {
    it('should find duplicate relationships', () => {
      const relationships: BaseRelationship[] = [
        { element: 'personas:test1', strength: 0.8 },
        { element: 'personas:test1', strength: 0.6 },
        { element: 'skills:test2', strength: 0.7 },
        { element: 'personas:test1', strength: 0.9 }
      ];

      const duplicates = findDuplicateRelationships(relationships);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toHaveLength(3);
      expect(duplicates[0][0].element).toBe('personas:test1');
    });

    it('should return empty array when no duplicates', () => {
      const relationships: BaseRelationship[] = [
        { element: 'personas:test1' },
        { element: 'skills:test2' },
        { element: 'agents:test3' }
      ];

      const duplicates = findDuplicateRelationships(relationships);

      expect(duplicates).toHaveLength(0);
    });
  });

  describe('deduplicateRelationships', () => {
    it('should keep highest strength when deduplicating', () => {
      const relationships: BaseRelationship[] = [
        { element: 'personas:test1', strength: 0.6 },
        { element: 'personas:test1', strength: 0.9 },
        { element: 'skills:test2', strength: 0.7 },
        { element: 'personas:test1', strength: 0.8 }
      ];

      const deduped = deduplicateRelationships(relationships);

      expect(deduped).toHaveLength(2);

      const persona = deduped.find(r => r.element === 'personas:test1');
      expect(persona?.strength).toBe(0.9);

      const skill = deduped.find(r => r.element === 'skills:test2');
      expect(skill?.strength).toBe(0.7);
    });
  });

  describe('sortRelationshipsByStrength', () => {
    it('should sort by strength descending', () => {
      const relationships: BaseRelationship[] = [
        { element: 'a', strength: 0.5 },
        { element: 'b', strength: 0.9 },
        { element: 'c', strength: 0.3 },
        { element: 'd' }  // No strength = 0
      ];

      const sorted = sortRelationshipsByStrength(relationships);

      expect(sorted[0].strength).toBe(0.9);
      expect(sorted[1].strength).toBe(0.5);
      expect(sorted[2].strength).toBe(0.3);
      expect(sorted[3].strength).toBeUndefined();
    });
  });

  describe('filterRelationshipsByStrength', () => {
    it('should filter by minimum strength', () => {
      const relationships: BaseRelationship[] = [
        { element: 'a', strength: 0.5 },
        { element: 'b', strength: 0.9 },
        { element: 'c', strength: 0.3 },
        { element: 'd' }  // No strength = 0
      ];

      const filtered = filterRelationshipsByStrength(relationships, 0.4);

      expect(filtered).toHaveLength(2);
      expect(filtered[0].element).toBe('a');
      expect(filtered[1].element).toBe('b');
    });
  });

  describe('RelationshipTypes constants', () => {
    it('should have all expected relationship types', () => {
      expect(RelationshipTypes.SIMILAR_TO).toBe('similar_to');
      expect(RelationshipTypes.USES).toBe('uses');
      expect(RelationshipTypes.USED_BY).toBe('used_by');
      expect(RelationshipTypes.EXTENDS).toBe('extends');
      expect(RelationshipTypes.EXTENDED_BY).toBe('extended_by');
      expect(RelationshipTypes.CONTAINS).toBe('contains');
      expect(RelationshipTypes.CONTAINED_BY).toBe('contained_by');
      expect(RelationshipTypes.HELPS_DEBUG).toBe('helps_debug');
      expect(RelationshipTypes.DEBUGGED_BY).toBe('debugged_by');
      expect(RelationshipTypes.CONTRADICTS).toBe('contradicts');
      expect(RelationshipTypes.SUPPORTS).toBe('supports');
      expect(RelationshipTypes.SEMANTIC_SIMILARITY).toBe('semantic_similarity');
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    describe('Unicode and special characters', () => {
      it('should handle and normalize unicode characters in element names', () => {
        // These should all normalize successfully
        const unicodeCases = [
          { element: 'personas:développeur', type: 'personas', name: 'développeur' },
          { element: 'skills:test', type: 'skills', name: 'test' },  // Simple ASCII - safe
          { element: 'templates:test-template', type: 'templates', name: 'test-template' },
          { element: 'agents:test123', type: 'agents', name: 'test123' },
          { element: 'memories:test_memory', type: 'memories', name: 'test_memory' }
        ];

        for (const test of unicodeCases) {
          const result = parseRelationship({ element: test.element });
          expect(isParsedRelationship(result)).toBe(true);
          if (isParsedRelationship(result)) {
            expect(result.targetType).toBe(test.type);
            expect(result.targetName).toBe(test.name);
          }
        }
      });

      it('should reject dangerous Unicode patterns', () => {
        // These contain dangerous Unicode that should be rejected
        const dangerousCases = [
          'personas:test\u202Eevil',  // Right-to-left override
          'skills:test\u200Bhidden',   // Zero-width space
          'templates:\uFEFFbom',       // Byte order mark
        ];

        for (const element of dangerousCases) {
          const result = parseRelationship({ element });
          expect(isInvalidRelationship(result)).toBe(true);
          if (isInvalidRelationship(result)) {
            expect(result.parseError).toContain('Unicode security issue');
          }
        }
      });

      it('should handle special characters in valid positions', () => {
        const validCases = [
          'personas:test-name',
          'skills:test_skill',
          'templates:test.template',
          'agents:test123',
          'memories:TEST_MEMORY'
        ];

        for (const element of validCases) {
          const result = parseRelationship({ element });
          expect(isParsedRelationship(result)).toBe(true);
        }
      });
    });

    describe('Extreme input sizes', () => {
      it('should handle very long element names', () => {
        const longName = 'a'.repeat(10000);
        const element = `personas:${longName}`;
        const result = parseRelationship({ element });

        expect(isParsedRelationship(result)).toBe(true);
        if (isParsedRelationship(result)) {
          expect(result.targetName.length).toBe(10000);
        }
      });

      it('should handle empty arrays in batch operations', () => {
        expect(parseRelationships([])).toEqual([]);
        expect(groupRelationshipsByType([])).toEqual(new Map());
        expect(findDuplicateRelationships([])).toEqual([]);
        expect(deduplicateRelationships([])).toEqual([]);
        expect(sortRelationshipsByStrength([])).toEqual([]);
        expect(filterRelationshipsByStrength([], 0.5)).toEqual([]);
      });

      it('should handle large arrays efficiently', () => {
        const large = new Array(1000).fill(null).map((_, i) => ({
          element: `personas:test${i}`,
          strength: Math.random()
        }));

        const start = performance.now();
        const sorted = sortRelationshipsByStrength(large);
        const duration = performance.now() - start;

        expect(sorted.length).toBe(1000);
        expect(duration).toBeLessThan(50); // Should be very fast

        // Verify sorting is correct
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1].strength || 0;
          const curr = sorted[i].strength || 0;
          expect(prev).toBeGreaterThanOrEqual(curr);
        }
      });
    });

    describe('Strength boundary values', () => {
      it('should handle extreme strength values in createRelationship', () => {
        // Invalid extremes
        expect(() => createRelationship('p', 'n', 't', -Infinity))
          .toThrow('Relationship strength must be between 0 and 1');
        expect(() => createRelationship('p', 'n', 't', Infinity))
          .toThrow('Relationship strength must be between 0 and 1');
        expect(() => createRelationship('p', 'n', 't', NaN))
          .toThrow('Relationship strength must be between 0 and 1');

        // Just outside boundaries
        expect(() => createRelationship('p', 'n', 't', -0.0000001))
          .toThrow('Relationship strength must be between 0 and 1');
        expect(() => createRelationship('p', 'n', 't', 1.0000001))
          .toThrow('Relationship strength must be between 0 and 1');
      });

      it('should handle very small valid strength values', () => {
        const tiny = createRelationship('personas', 'test', 'similar_to', Number.MIN_VALUE);
        expect(tiny.strength).toBe(Number.MIN_VALUE);
        expect(tiny.strength).toBeGreaterThan(0);
      });

      it('should handle undefined vs null strength in deduplication', () => {
        const relationships = [
          { element: 'p:t', strength: undefined },
          { element: 'p:t', strength: null as any },
          { element: 'p:t', strength: 0 },
          { element: 'p:t', strength: 0.5 }
        ];

        const deduped = deduplicateRelationships(relationships);
        expect(deduped.length).toBe(1);
        expect(deduped[0].strength).toBe(0.5);
      });
    });

    describe('Error message consistency', () => {
      it('should provide consistent error format for all invalid cases', () => {
        const errorCases = [
          { element: '', expected: 'missing or empty' },
          { element: 'no-colon', expected: 'Invalid element ID format.*missing separator' },
          { element: ':type', expected: 'Invalid element ID format.*missing type before' },
          { element: 'name:', expected: 'Invalid element ID format.*missing name after' },
          { element: 'a:b:c', expected: 'Invalid element ID format.*multiple separators.*positions' }
        ];

        for (const test of errorCases) {
          const result = parseRelationship({ element: test.element });
          expect(isInvalidRelationship(result)).toBe(true);
          if (isInvalidRelationship(result)) {
            expect(result.parseError).toMatch(new RegExp(test.expected));
          }
        }
      });

      it('should include original input in all error messages', () => {
        const inputs = ['bad', ':bad', 'bad:', 'too:many:parts'];

        for (const input of inputs) {
          const result = parseRelationship({ element: input });
          if (isInvalidRelationship(result)) {
            expect(result.parseError).toContain(input);
          }
        }
      });
    });

    describe('Metadata handling', () => {
      it('should preserve complex metadata through operations', () => {
        const metadata = {
          nested: { deep: { value: 'test' } },
          array: [1, 2, 3],
          nullValue: null,
          date: new Date().toISOString(),
          bigNumber: Number.MAX_SAFE_INTEGER
        };

        const rel = createRelationship('personas', 'test', 'uses', 0.5, metadata);
        expect(rel.metadata).toEqual(metadata);

        // Should preserve through parsing
        const parsed = parseRelationship(rel);
        if (isParsedRelationship(parsed)) {
          expect(parsed.metadata).toEqual(metadata);
        }
      });

      it('should handle metadata in deduplication correctly', () => {
        const relationships = [
          { element: 'p:t', strength: 0.3, metadata: { version: 1 } },
          { element: 'p:t', strength: 0.7, metadata: { version: 2 } },
          { element: 'p:t', strength: 0.5, metadata: { version: 3 } }
        ];

        const deduped = deduplicateRelationships(relationships);
        expect(deduped[0].metadata).toEqual({ version: 2 }); // Keeps highest strength
      });
    });
  });
});