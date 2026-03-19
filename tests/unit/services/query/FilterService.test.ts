/**
 * Unit tests for FilterService
 *
 * Tests filtering logic, validation, security constraints, and edge cases.
 *
 * @see src/services/query/FilterService.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { FilterService } from '../../../../src/services/query/FilterService.js';
import { IElement, ElementStatus, IElementMetadata } from '../../../../src/types/elements/IElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';

/**
 * Mock element factory for testing
 * Creates minimal IElement implementations with configurable metadata
 */
function createMockElement(overrides: Partial<IElementMetadata> & { elementStatus?: ElementStatus } = {}): IElement {
  const { elementStatus = ElementStatus.INACTIVE, ...metadataOverrides } = overrides;

  return {
    id: metadataOverrides.name || 'test-element',
    type: 'personas' as ElementType,
    version: metadataOverrides.version || '1.0.0',
    metadata: {
      name: 'Test Element',
      description: 'A test element for unit tests',
      author: 'test-author',
      version: '1.0.0',
      created: '2024-01-15T10:00:00Z',
      modified: '2024-06-15T14:30:00Z',
      tags: ['test', 'mock'],
      ...metadataOverrides,
    },
    validate: () => ({ valid: true }),
    serialize: () => JSON.stringify({}),
    deserialize: () => {},
    getStatus: () => elementStatus,
  };
}

describe('FilterService', () => {
  let service: FilterService;

  beforeEach(() => {
    service = new FilterService();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      expect(service).toBeInstanceOf(FilterService);
    });
  });

  describe('filter - no criteria', () => {
    it('should return all items when no criteria provided', () => {
      const items = [
        createMockElement({ name: 'Element 1' }),
        createMockElement({ name: 'Element 2' }),
        createMockElement({ name: 'Element 3' }),
      ];

      const result = service.filter(items);

      expect(result).toHaveLength(3);
      expect(result).toEqual(items);
    });

    it('should return all items when criteria is undefined', () => {
      const items = [createMockElement({ name: 'Element 1' })];
      const result = service.filter(items, undefined);

      expect(result).toHaveLength(1);
    });

    it('should return all items when criteria is empty object', () => {
      const items = [createMockElement({ name: 'Element 1' })];
      const result = service.filter(items, {});

      expect(result).toHaveLength(1);
    });
  });

  describe('filter - nameContains', () => {
    const items = [
      createMockElement({ name: 'Code Review Assistant' }),
      createMockElement({ name: 'Debug Helper' }),
      createMockElement({ name: 'code-formatter' }),
      createMockElement({ name: 'Documentation Writer' }),
    ];

    it('should filter by partial name match (case-insensitive)', () => {
      const result = service.filter(items, { nameContains: 'code' });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Code Review Assistant');
      expect(result[1].metadata.name).toBe('code-formatter');
    });

    it('should be case-insensitive', () => {
      const result = service.filter(items, { nameContains: 'CODE' });

      expect(result).toHaveLength(2);
    });

    it('should match partial strings', () => {
      const result = service.filter(items, { nameContains: 'Help' });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Debug Helper');
    });

    it('should return empty array when no match found', () => {
      const result = service.filter(items, { nameContains: 'nonexistent' });

      expect(result).toHaveLength(0);
    });

    it('should reject empty nameContains string via validation', () => {
      // Empty search strings are rejected by security validation
      expect(() => service.filter(items, { nameContains: '' })).toThrow(
        'Search query cannot be empty'
      );
    });

    it('should handle whitespace in search term', () => {
      const result = service.filter(items, { nameContains: 'Code Review' });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Code Review Assistant');
    });
  });

  describe('filter - tags (AND logic)', () => {
    const items = [
      createMockElement({ name: 'Element 1', tags: ['typescript', 'linting', 'tools'] }),
      createMockElement({ name: 'Element 2', tags: ['typescript', 'testing'] }),
      createMockElement({ name: 'Element 3', tags: ['python', 'linting'] }),
      createMockElement({ name: 'Element 4', tags: [] }),
      createMockElement({ name: 'Element 5', tags: undefined }),
    ];

    it('should filter by single tag', () => {
      const result = service.filter(items, { tags: ['typescript'] });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Element 1');
      expect(result[1].metadata.name).toBe('Element 2');
    });

    it('should filter by multiple tags (AND logic)', () => {
      const result = service.filter(items, { tags: ['typescript', 'linting'] });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Element 1');
    });

    it('should return empty when no element has all tags', () => {
      const result = service.filter(items, { tags: ['typescript', 'python'] });

      expect(result).toHaveLength(0);
    });

    it('should be case-insensitive for tags', () => {
      const result = service.filter(items, { tags: ['TYPESCRIPT'] });

      expect(result).toHaveLength(2);
    });

    it('should handle elements with empty tags array', () => {
      const result = service.filter(items, { tags: ['typescript'] });

      // Element 4 and 5 should not match
      expect(result.some((e) => e.metadata.name === 'Element 4')).toBe(false);
      expect(result.some((e) => e.metadata.name === 'Element 5')).toBe(false);
    });

    it('should pass all items when tags is empty array', () => {
      const result = service.filter(items, { tags: [] });

      expect(result).toHaveLength(5);
    });
  });

  describe('filter - tagsAny (OR logic)', () => {
    const items = [
      createMockElement({ name: 'Element 1', tags: ['typescript', 'linting'] }),
      createMockElement({ name: 'Element 2', tags: ['python', 'testing'] }),
      createMockElement({ name: 'Element 3', tags: ['javascript'] }),
      createMockElement({ name: 'Element 4', tags: [] }),
    ];

    it('should filter by any matching tag (OR logic)', () => {
      const result = service.filter(items, { tagsAny: ['typescript', 'python'] });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Element 1');
      expect(result[1].metadata.name).toBe('Element 2');
    });

    it('should match if element has at least one tag', () => {
      const result = service.filter(items, { tagsAny: ['javascript', 'rust', 'go'] });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Element 3');
    });

    it('should return empty when no element has any matching tag', () => {
      const result = service.filter(items, { tagsAny: ['rust', 'go', 'c++'] });

      expect(result).toHaveLength(0);
    });

    it('should be case-insensitive for tagsAny', () => {
      const result = service.filter(items, { tagsAny: ['TYPESCRIPT', 'PYTHON'] });

      expect(result).toHaveLength(2);
    });

    it('should pass all items when tagsAny is empty array', () => {
      const result = service.filter(items, { tagsAny: [] });

      expect(result).toHaveLength(4);
    });
  });

  describe('filter - author', () => {
    const items = [
      createMockElement({ name: 'Element 1', author: 'alice' }),
      createMockElement({ name: 'Element 2', author: 'Bob' }),
      createMockElement({ name: 'Element 3', author: 'alice' }),
      createMockElement({ name: 'Element 4', author: undefined }),
    ];

    it('should filter by exact author match', () => {
      const result = service.filter(items, { author: 'alice' });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Element 1');
      expect(result[1].metadata.name).toBe('Element 3');
    });

    it('should be case-insensitive for author', () => {
      const result = service.filter(items, { author: 'ALICE' });

      expect(result).toHaveLength(2);
    });

    it('should handle different case matching', () => {
      const result = service.filter(items, { author: 'bob' });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Element 2');
    });

    it('should not match elements without author', () => {
      const result = service.filter(items, { author: 'alice' });

      expect(result.some((e) => e.metadata.name === 'Element 4')).toBe(false);
    });

    it('should return empty when author not found', () => {
      const result = service.filter(items, { author: 'nonexistent' });

      expect(result).toHaveLength(0);
    });
  });

  describe('filter - createdAfter', () => {
    const items = [
      createMockElement({ name: 'Element 1', created: '2024-01-01T00:00:00Z' }),
      createMockElement({ name: 'Element 2', created: '2024-06-15T00:00:00Z' }),
      createMockElement({ name: 'Element 3', created: '2024-12-31T23:59:59Z' }),
      createMockElement({ name: 'Element 4', created: undefined }),
    ];

    it('should filter elements created after date (inclusive)', () => {
      const result = service.filter(items, { createdAfter: '2024-06-15T00:00:00Z' });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Element 2');
      expect(result[1].metadata.name).toBe('Element 3');
    });

    it('should include elements created exactly on the date', () => {
      const result = service.filter(items, { createdAfter: '2024-01-01T00:00:00Z' });

      expect(result).toHaveLength(3);
      expect(result[0].metadata.name).toBe('Element 1');
    });

    it('should not match elements without created date', () => {
      const result = service.filter(items, { createdAfter: '2020-01-01T00:00:00Z' });

      expect(result.some((e) => e.metadata.name === 'Element 4')).toBe(false);
    });

    it('should return empty when no elements match', () => {
      const result = service.filter(items, { createdAfter: '2025-01-01T00:00:00Z' });

      expect(result).toHaveLength(0);
    });
  });

  describe('filter - createdBefore', () => {
    const items = [
      createMockElement({ name: 'Element 1', created: '2024-01-01T00:00:00Z' }),
      createMockElement({ name: 'Element 2', created: '2024-06-15T00:00:00Z' }),
      createMockElement({ name: 'Element 3', created: '2024-12-31T23:59:59Z' }),
      createMockElement({ name: 'Element 4', created: undefined }),
    ];

    it('should filter elements created before date (inclusive)', () => {
      const result = service.filter(items, { createdBefore: '2024-06-15T00:00:00Z' });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Element 1');
      expect(result[1].metadata.name).toBe('Element 2');
    });

    it('should include elements created exactly on the date', () => {
      const result = service.filter(items, { createdBefore: '2024-12-31T23:59:59Z' });

      expect(result).toHaveLength(3);
    });

    it('should not match elements without created date', () => {
      const result = service.filter(items, { createdBefore: '2025-12-31T00:00:00Z' });

      expect(result.some((e) => e.metadata.name === 'Element 4')).toBe(false);
    });
  });

  describe('filter - status', () => {
    const items = [
      createMockElement({ name: 'Active 1', elementStatus: ElementStatus.ACTIVE }),
      createMockElement({ name: 'Active 2', elementStatus: ElementStatus.ACTIVATING }),
      createMockElement({ name: 'Inactive 1', elementStatus: ElementStatus.INACTIVE }),
      createMockElement({ name: 'Inactive 2', elementStatus: ElementStatus.DEACTIVATING }),
      createMockElement({ name: 'Error', elementStatus: ElementStatus.ERROR }),
      createMockElement({ name: 'Suspended', elementStatus: ElementStatus.SUSPENDED }),
    ];

    it('should filter active elements', () => {
      const result = service.filter(items, { status: 'active' });

      expect(result).toHaveLength(2);
      expect(result[0].metadata.name).toBe('Active 1');
      expect(result[1].metadata.name).toBe('Active 2');
    });

    it('should filter inactive elements', () => {
      const result = service.filter(items, { status: 'inactive' });

      expect(result).toHaveLength(4);
      expect(result.map((e) => e.metadata.name)).toEqual([
        'Inactive 1',
        'Inactive 2',
        'Error',
        'Suspended',
      ]);
    });

    it('should return all elements when status is "all"', () => {
      const result = service.filter(items, { status: 'all' });

      expect(result).toHaveLength(6);
    });
  });

  describe('filter - combined criteria (AND logic)', () => {
    const items = [
      createMockElement({
        name: 'TypeScript Linter',
        tags: ['typescript', 'linting'],
        author: 'alice',
        created: '2024-06-01T00:00:00Z',
        elementStatus: ElementStatus.ACTIVE,
      }),
      createMockElement({
        name: 'TypeScript Testing',
        tags: ['typescript', 'testing'],
        author: 'bob',
        created: '2024-07-01T00:00:00Z',
        elementStatus: ElementStatus.ACTIVE,
      }),
      createMockElement({
        name: 'Python Linter',
        tags: ['python', 'linting'],
        author: 'alice',
        created: '2024-05-01T00:00:00Z',
        elementStatus: ElementStatus.INACTIVE,
      }),
    ];

    it('should combine nameContains and tags', () => {
      const result = service.filter(items, {
        nameContains: 'TypeScript',
        tags: ['typescript'],
      });

      expect(result).toHaveLength(2);
    });

    it('should combine nameContains, tags, and author', () => {
      const result = service.filter(items, {
        nameContains: 'TypeScript',
        tags: ['typescript'],
        author: 'alice',
      });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('TypeScript Linter');
    });

    it('should combine all filter types', () => {
      const result = service.filter(items, {
        nameContains: 'TypeScript',
        tags: ['typescript'],
        author: 'alice',
        createdAfter: '2024-01-01T00:00:00Z',
        status: 'active',
      });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('TypeScript Linter');
    });

    it('should return empty when combined filters match no items', () => {
      const result = service.filter(items, {
        nameContains: 'Python',
        tags: ['typescript'],
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('summarizeFilters', () => {
    it('should return empty summary for no criteria', () => {
      const summary = service.summarizeFilters();

      expect(summary.count).toBe(0);
    });

    it('should return empty summary for empty criteria', () => {
      const summary = service.summarizeFilters({});

      expect(summary.count).toBe(0);
    });

    it('should count nameContains filter', () => {
      const summary = service.summarizeFilters({ nameContains: 'test' });

      expect(summary.count).toBe(1);
      expect(summary.nameContains).toBe('test');
    });

    it('should count tags filter', () => {
      const summary = service.summarizeFilters({ tags: ['a', 'b'] });

      expect(summary.count).toBe(1);
      expect(summary.tags).toEqual(['a', 'b']);
    });

    it('should count tagsAny filter', () => {
      const summary = service.summarizeFilters({ tagsAny: ['x', 'y'] });

      expect(summary.count).toBe(1);
      expect(summary.tagsAny).toEqual(['x', 'y']);
    });

    it('should count all filters correctly', () => {
      const summary = service.summarizeFilters({
        nameContains: 'test',
        tags: ['a'],
        tagsAny: ['b'],
        author: 'alice',
        createdAfter: '2024-01-01T00:00:00Z',
        createdBefore: '2024-12-31T23:59:59Z',
        status: 'active',
      });

      expect(summary.count).toBe(7);
      expect(summary.nameContains).toBe('test');
      expect(summary.tags).toEqual(['a']);
      expect(summary.tagsAny).toEqual(['b']);
      expect(summary.author).toBe('alice');
      expect(summary.createdAfter).toBe('2024-01-01T00:00:00Z');
      expect(summary.createdBefore).toBe('2024-12-31T23:59:59Z');
      expect(summary.status).toBe('active');
    });

    it('should not count status="all" as a filter', () => {
      const summary = service.summarizeFilters({ status: 'all' });

      expect(summary.count).toBe(0);
      expect(summary.status).toBeUndefined();
    });

    it('should not count empty strings', () => {
      const summary = service.summarizeFilters({
        nameContains: '',
        author: '   ',
      });

      expect(summary.count).toBe(0);
    });

    it('should not count empty arrays', () => {
      const summary = service.summarizeFilters({
        tags: [],
        tagsAny: [],
      });

      expect(summary.count).toBe(0);
    });
  });

  describe('validateCriteria', () => {
    it('should pass validation with no criteria', () => {
      expect(service.validateCriteria()).toBe(true);
      expect(service.validateCriteria(undefined)).toBe(true);
      expect(service.validateCriteria({})).toBe(true);
    });

    it('should pass validation with valid criteria', () => {
      expect(
        service.validateCriteria({
          nameContains: 'test',
          tags: ['typescript'],
          tagsAny: ['python'],
          author: 'alice',
          createdAfter: '2024-01-01T00:00:00Z',
          createdBefore: '2024-12-31T23:59:59Z',
          status: 'active',
        })
      ).toBe(true);
    });

    it('should reject non-string nameContains', () => {
      expect(() =>
        service.validateCriteria({ nameContains: 123 as any })
      ).toThrow('nameContains must be a string');
    });

    it('should reject non-array tags', () => {
      expect(() => service.validateCriteria({ tags: 'typescript' as any })).toThrow(
        'tags must be an array'
      );
    });

    it('should reject non-string elements in tags array', () => {
      expect(() => service.validateCriteria({ tags: [123, 'valid'] as any })).toThrow(
        'tags must contain only strings'
      );
    });

    it('should reject tags array exceeding maximum', () => {
      const tooManyTags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
      expect(() => service.validateCriteria({ tags: tooManyTags })).toThrow(
        'tags exceeds maximum of 50 tags'
      );
    });

    it('should reject non-string author', () => {
      expect(() =>
        service.validateCriteria({ author: { name: 'alice' } as any })
      ).toThrow('author must be a string');
    });

    it('should reject author exceeding maximum length', () => {
      const longAuthor = 'a'.repeat(101);
      expect(() => service.validateCriteria({ author: longAuthor })).toThrow(
        'author exceeds maximum length of 100 characters'
      );
    });

    it('should reject invalid date format for createdAfter', () => {
      expect(() =>
        service.validateCriteria({ createdAfter: 'not-a-date' })
      ).toThrow('createdAfter must be a valid ISO 8601 date');
    });

    it('should reject invalid date format for createdBefore', () => {
      expect(() =>
        service.validateCriteria({ createdBefore: '2024/01/01' })
      ).toThrow('createdBefore must be in ISO 8601 format');
    });

    it('should reject invalid status value', () => {
      expect(() =>
        service.validateCriteria({ status: 'unknown' as any })
      ).toThrow('status must be one of: active, inactive, all');
    });

    it('should accept valid ISO 8601 date formats', () => {
      expect(service.validateCriteria({ createdAfter: '2024-01-01' })).toBe(true);
      expect(service.validateCriteria({ createdAfter: '2024-01-01T00:00:00Z' })).toBe(true);
      expect(service.validateCriteria({ createdAfter: '2024-01-01T00:00:00.000Z' })).toBe(true);
      expect(service.validateCriteria({ createdAfter: '2024-01-01T00:00:00+05:00' })).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty items array', () => {
      const result = service.filter([], { nameContains: 'test' });

      expect(result).toEqual([]);
    });

    it('should not mutate original array', () => {
      const items = [
        createMockElement({ name: 'Element 1' }),
        createMockElement({ name: 'Element 2' }),
      ];
      const originalLength = items.length;

      service.filter(items, { nameContains: 'Element 1' });

      expect(items).toHaveLength(originalLength);
    });

    it('should handle elements with minimal metadata', () => {
      const minimalElement: IElement = {
        id: 'minimal',
        type: 'personas' as ElementType,
        version: '1.0.0',
        metadata: {
          name: 'Minimal',
          description: 'Minimal element',
        },
        validate: () => ({ valid: true }),
        serialize: () => '{}',
        deserialize: () => {},
        getStatus: () => ElementStatus.INACTIVE,
      };

      const result = service.filter([minimalElement], { nameContains: 'Minimal' });

      expect(result).toHaveLength(1);
    });

    it('should handle date range filtering', () => {
      const items = [
        createMockElement({ name: 'Early', created: '2024-01-01T00:00:00Z' }),
        createMockElement({ name: 'Middle', created: '2024-06-15T00:00:00Z' }),
        createMockElement({ name: 'Late', created: '2024-12-01T00:00:00Z' }),
      ];

      const result = service.filter(items, {
        createdAfter: '2024-03-01T00:00:00Z',
        createdBefore: '2024-09-01T00:00:00Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Middle');
    });

    describe('empty array filter edge cases', () => {
      const items = [
        createMockElement({ name: 'Element 1', tags: ['typescript', 'linting'] }),
        createMockElement({ name: 'Element 2', tags: ['python', 'testing'] }),
        createMockElement({ name: 'Element 3', tags: [] }),
        createMockElement({ name: 'Element 4', tags: undefined }),
      ];

      it('should NOT filter when tags is empty array', () => {
        // Empty array should be treated as "no filter" - all items pass through
        const result = service.filter(items, { tags: [] });

        expect(result).toHaveLength(4);
        expect(result).toEqual(items);
      });

      it('should NOT filter when tagsAny is empty array', () => {
        // Empty array should be treated as "no filter" - all items pass through
        const result = service.filter(items, { tagsAny: [] });

        expect(result).toHaveLength(4);
        expect(result).toEqual(items);
      });

      it('should NOT filter when both tags and tagsAny are empty arrays', () => {
        // Both empty arrays should result in no filtering
        const result = service.filter(items, { tags: [], tagsAny: [] });

        expect(result).toHaveLength(4);
        expect(result).toEqual(items);
      });

      it('should apply other filters even when tags is empty array', () => {
        // Empty tags array should not interfere with other filters
        const result = service.filter(items, {
          tags: [],
          nameContains: 'Element 1',
        });

        expect(result).toHaveLength(1);
        expect(result[0].metadata.name).toBe('Element 1');
      });

      it('should apply other filters even when tagsAny is empty array', () => {
        // Empty tagsAny array should not interfere with other filters
        const result = service.filter(items, {
          tagsAny: [],
          nameContains: 'Element 2',
        });

        expect(result).toHaveLength(1);
        expect(result[0].metadata.name).toBe('Element 2');
      });
    });
  });

  describe('security - tag validation limits', () => {
    it('should accept up to 50 tags', () => {
      const fiftyTags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
      expect(() => service.validateCriteria({ tags: fiftyTags })).not.toThrow();
    });

    it('should reject more than 50 tags (DoS prevention)', () => {
      const tooManyTags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
      expect(() => service.validateCriteria({ tags: tooManyTags })).toThrow(
        'tags exceeds maximum of 50 tags'
      );
    });

    it('should accept up to 50 tagsAny', () => {
      const fiftyTags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
      expect(() => service.validateCriteria({ tagsAny: fiftyTags })).not.toThrow();
    });

    it('should reject more than 50 tagsAny (DoS prevention)', () => {
      const tooManyTags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
      expect(() => service.validateCriteria({ tagsAny: tooManyTags })).toThrow(
        'tagsAny exceeds maximum of 50 tags'
      );
    });
  });

  describe('unknown filter key rejection', () => {
    it('should reject unknown filter keys', () => {
      expect(() => service.validateCriteria({ unknownKey: 'x' } as any)).toThrow(
        'Unknown filter key(s): unknownKey'
      );
    });

    it('should list all unknown keys in error message', () => {
      expect(() => service.validateCriteria({ foo: 'a', bar: 'b' } as any)).toThrow(
        'Unknown filter key(s): foo, bar'
      );
    });

    it('should list supported filters in error message', () => {
      try {
        service.validateCriteria({ bad: 'x' } as any);
        expect('should have thrown').toBe('but did not');
      } catch (e: any) {
        expect(e.message).toContain('Supported filters:');
        expect(e.message).toContain('nameContains');
        expect(e.message).toContain('descriptionContains');
        expect(e.message).toContain('category');
      }
    });

    it('should accept all known filter keys without error', () => {
      expect(() => service.validateCriteria({
        nameContains: 'test',
        tags: ['a'],
        tagsAny: ['b'],
        author: 'me',
        createdAfter: '2024-01-01',
        createdBefore: '2024-12-31',
        status: 'active',
        descriptionContains: 'desc',
        category: 'general',
      })).not.toThrow();
    });
  });

  describe('filter - descriptionContains', () => {
    it('should filter by description substring (case-insensitive)', () => {
      const items = [
        createMockElement({ name: 'A', description: 'Reviews code for quality issues' }),
        createMockElement({ name: 'B', description: 'Helps with data analysis' }),
        createMockElement({ name: 'C', description: 'General purpose helper' }),
      ];

      const result = service.filter(items, { descriptionContains: 'code' });
      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('A');
    });

    it('should match case-insensitively', () => {
      const items = [
        createMockElement({ name: 'A', description: 'CODE REVIEW helper' }),
      ];

      const result = service.filter(items, { descriptionContains: 'code review' });
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no descriptions match', () => {
      const items = [
        createMockElement({ name: 'A', description: 'Nothing related' }),
      ];

      const result = service.filter(items, { descriptionContains: 'xyznotfound' });
      expect(result).toHaveLength(0);
    });
  });

  describe('filter - category', () => {
    it('should filter by exact category match (case-insensitive)', () => {
      const items = [
        createMockElement({ name: 'A', custom: { } }),
        createMockElement({ name: 'B', custom: { } }),
      ];
      // Set category on metadata directly
      (items[0].metadata as any).category = 'general';
      (items[1].metadata as any).category = 'specialized';

      const result = service.filter(items, { category: 'general' });
      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('A');
    });

    it('should match category case-insensitively', () => {
      const items = [
        createMockElement({ name: 'A' }),
      ];
      (items[0].metadata as any).category = 'General';

      const result = service.filter(items, { category: 'general' });
      expect(result).toHaveLength(1);
    });

    it('should exclude elements without category field', () => {
      const items = [
        createMockElement({ name: 'A' }),
      ];

      const result = service.filter(items, { category: 'general' });
      expect(result).toHaveLength(0);
    });
  });

  describe('filter - combined new filters', () => {
    it('should combine descriptionContains and category with AND logic', () => {
      const items = [
        createMockElement({ name: 'A', description: 'Helps with code' }),
        createMockElement({ name: 'B', description: 'Helps with code' }),
        createMockElement({ name: 'C', description: 'Data analysis' }),
      ];
      (items[0].metadata as any).category = 'development';
      (items[1].metadata as any).category = 'general';
      (items[2].metadata as any).category = 'development';

      const result = service.filter(items, { descriptionContains: 'code', category: 'development' });
      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('A');
    });
  });

  describe('summarizeFilters - new filters', () => {
    it('should include descriptionContains in summary', () => {
      const summary = service.summarizeFilters({ descriptionContains: 'test' });
      expect(summary.descriptionContains).toBe('test');
      expect(summary.count).toBe(1);
    });

    it('should include category in summary', () => {
      const summary = service.summarizeFilters({ category: 'general' });
      expect(summary.category).toBe('general');
      expect(summary.count).toBe(1);
    });
  });
});
