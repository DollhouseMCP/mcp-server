/**
 * Unit tests for AggregationService (Issue #309)
 *
 * Tests:
 * - Count aggregation
 * - group_by with string fields
 * - group_by with array fields (tags) including deduplication
 * - group_by with missing/undefined fields
 * - group_by combined with filters
 * - Field whitelist validation
 * - Type-safe metadata access via getMetadataField
 */

import { describe, it, expect } from '@jest/globals';
import { aggregateElements, validateAggregationOptions, getAllowedGroupByFields } from '../../../../dist/services/query/AggregationService.js';
import { getMetadataField } from '../../../../dist/services/query/types.js';

// Helper to create mock elements with metadata
function mockElement(name: string, metadata: Record<string, unknown> = {}) {
  return {
    metadata: {
      name,
      description: `Description for ${name}`,
      version: '1.0.0',
      ...metadata,
    },
    version: '1.0.0',
    content: '',
  } as any;
}

describe('AggregationService (Issue #309)', () => {
  const elements = [
    mockElement('persona-a', { category: 'assistant', tags: ['helpful', 'general'], author: 'alice' }),
    mockElement('persona-b', { category: 'assistant', tags: ['helpful', 'technical'], author: 'bob' }),
    mockElement('persona-c', { category: 'creative', tags: ['writing', 'fiction'], author: 'alice' }),
    mockElement('persona-d', { category: 'creative', tags: ['writing'], author: 'charlie' }),
    mockElement('persona-e', { tags: ['general'] }), // No category
  ];

  describe('count aggregation', () => {
    it('should return total count without groups', () => {
      const result = aggregateElements(elements, 'persona', { count: true });

      expect(result.count).toBe(5);
      expect(result.element_type).toBe('persona');
      expect(result.groups).toBeUndefined();
    });

    it('should count with filters applied', () => {
      const result = aggregateElements(
        elements,
        'persona',
        { count: true },
        { author: 'alice' }
      );

      expect(result.count).toBe(2); // persona-a and persona-c
    });
  });

  describe('group_by with string fields', () => {
    it('should group by category', () => {
      const result = aggregateElements(elements, 'persona', {
        count: true,
        group_by: 'category',
      });

      expect(result.count).toBe(5);
      expect(result.groups).toBeDefined();
      expect(result.groups!['assistant']).toBe(2);
      expect(result.groups!['creative']).toBe(2);
      expect(result.groups!['unknown']).toBe(1); // persona-e has no category
    });

    it('should group by author', () => {
      const result = aggregateElements(elements, 'persona', {
        count: true,
        group_by: 'author',
      });

      expect(result.groups!['alice']).toBe(2);
      expect(result.groups!['bob']).toBe(1);
      expect(result.groups!['charlie']).toBe(1);
      expect(result.groups!['unknown']).toBe(1); // persona-e has no author
    });
  });

  describe('group_by with array fields', () => {
    it('should group by tags (array field)', () => {
      const result = aggregateElements(elements, 'persona', {
        count: true,
        group_by: 'tags',
      });

      expect(result.groups).toBeDefined();
      expect(result.groups!['helpful']).toBe(2);     // persona-a, persona-b
      expect(result.groups!['general']).toBe(2);      // persona-a, persona-e
      expect(result.groups!['technical']).toBe(1);    // persona-b
      expect(result.groups!['writing']).toBe(2);      // persona-c, persona-d
      expect(result.groups!['fiction']).toBe(1);       // persona-c
    });

    it('should deduplicate array values to prevent double-counting', () => {
      const elementsWithDupes = [
        mockElement('dupe-tags', { tags: ['a', 'a', 'b', 'b', 'b'] }),
        mockElement('single-tag', { tags: ['a'] }),
      ];

      const result = aggregateElements(elementsWithDupes, 'persona', {
        count: true,
        group_by: 'tags',
      });

      // 'a' appears in both elements, but dupe-tags should count 'a' only once
      expect(result.groups!['a']).toBe(2);
      // 'b' appears only in dupe-tags, should count once
      expect(result.groups!['b']).toBe(1);
    });
  });

  describe('group_by with missing fields', () => {
    it('should group missing values as "unknown"', () => {
      const result = aggregateElements(elements, 'persona', {
        count: true,
        group_by: 'category',
      });

      // persona-e has no category → should be counted as 'unknown'
      expect(result.groups!['unknown']).toBe(1);
    });

    it('should handle version field (may have default values)', () => {
      const result = aggregateElements(elements, 'persona', {
        count: true,
        group_by: 'version',
      });

      expect(result.groups).toBeDefined();
      // All test elements have version: '1.0.0'
      expect(result.groups!['1.0.0']).toBe(5);
    });
  });

  describe('group_by combined with filters', () => {
    it('should filter then group', () => {
      const result = aggregateElements(
        elements,
        'persona',
        { count: true, group_by: 'category' },
        { author: 'alice' }
      );

      // Only persona-a (assistant) and persona-c (creative) match author: alice
      expect(result.count).toBe(2);
      expect(result.groups!['assistant']).toBe(1);
      expect(result.groups!['creative']).toBe(1);
    });
  });

  describe('field whitelist validation', () => {
    it('should reject disallowed group_by field', () => {
      expect(() => {
        aggregateElements(elements, 'persona', {
          count: true,
          group_by: 'internal_secret',
        });
      }).toThrow('Invalid group_by field');
    });

    it('should accept all allowed fields', () => {
      const allowed = getAllowedGroupByFields();
      expect(allowed).toContain('category');
      expect(allowed).toContain('author');
      expect(allowed).toContain('tags');
      expect(allowed).toContain('status');
      expect(allowed).toContain('version');
    });

    it('should not allow name or description (too broad)', () => {
      expect(() => {
        aggregateElements(elements, 'persona', {
          count: true,
          group_by: 'name',
        });
      }).toThrow('Invalid group_by field');

      expect(() => {
        aggregateElements(elements, 'persona', {
          count: true,
          group_by: 'description',
        });
      }).toThrow('Invalid group_by field');
    });
  });

  describe('validateAggregationOptions', () => {
    it('should return null for valid options', () => {
      expect(validateAggregationOptions({ count: true })).toBeNull();
      expect(validateAggregationOptions({ count: true, group_by: 'category' })).toBeNull();
      expect(validateAggregationOptions({})).toBeNull();
    });

    it('should return error for invalid group_by field', () => {
      const error = validateAggregationOptions({ group_by: 'password' });
      expect(error).toContain('Invalid group_by field');
      expect(error).toContain('password');
      expect(error).toContain('Allowed fields');
    });
  });
});

describe('getMetadataField type-safe accessor', () => {
  it('should extract known metadata fields', () => {
    const element = mockElement('test', { category: 'dev', tags: ['a', 'b'] });

    expect(getMetadataField(element, 'name')).toBe('test');
    expect(getMetadataField(element, 'category')).toBe('dev');
    expect(getMetadataField(element, 'tags')).toEqual(['a', 'b']);
  });

  it('should return undefined for missing fields', () => {
    const element = mockElement('test');

    expect(getMetadataField(element, 'nonexistent')).toBeUndefined();
  });

  it('should handle elements without metadata', () => {
    const element = { content: 'test' } as any;

    expect(getMetadataField(element, 'name')).toBeUndefined();
  });
});
