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
        expect(parsed.parseError).toBe('Missing element ID');
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
});