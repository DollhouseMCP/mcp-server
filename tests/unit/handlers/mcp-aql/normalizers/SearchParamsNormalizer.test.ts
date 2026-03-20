/**
 * SearchParamsNormalizer Tests
 *
 * Tests for search parameter normalization including:
 * - Scope normalization (string/array/all → sources array)
 * - Pagination normalization (offset/limit → page/pageSize)
 * - Sort normalization (sort object or sortBy/sortOrder)
 * - Filter extraction
 * - Options normalization
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SearchParamsNormalizer } from '../../../../../src/handlers/mcp-aql/normalizers/SearchParamsNormalizer.js';
import type { NormalizerContext } from '../../../../../src/handlers/mcp-aql/normalizers/types.js';

describe('SearchParamsNormalizer', () => {
  let normalizer: SearchParamsNormalizer;

  const mockContext: NormalizerContext = {
    operation: 'search',
    endpoint: 'READ',
    handler: 'portfolioHandler',
    method: 'searchAll',
  };

  beforeEach(() => {
    normalizer = new SearchParamsNormalizer();
  });

  describe('name property', () => {
    it('should have name "searchParams"', () => {
      expect(normalizer.name).toBe('searchParams');
    });
  });

  describe('query validation', () => {
    it('should fail when query is missing', () => {
      const result = normalizer.normalize({}, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Search query is required');
      }
    });

    it('should fail when query is empty string', () => {
      const result = normalizer.normalize({ query: '' }, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Search query is required');
      }
    });

    it('should fail when query is whitespace only', () => {
      const result = normalizer.normalize({ query: '   ' }, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Search query is required');
      }
    });

    it('should trim query whitespace', () => {
      const result = normalizer.normalize({ query: '  test query  ' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.query).toBe('test query');
      }
    });
  });

  describe('scope normalization', () => {
    it('should default to all sources when scope is undefined', () => {
      const result = normalizer.normalize({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sources).toEqual(['local', 'github', 'collection']);
      }
    });

    it('should default to all sources when scope is null', () => {
      const result = normalizer.normalize({ query: 'test', scope: null }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sources).toEqual(['local', 'github', 'collection']);
      }
    });

    it('should default to all sources when scope is "all"', () => {
      const result = normalizer.normalize({ query: 'test', scope: 'all' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sources).toEqual(['local', 'github', 'collection']);
      }
    });

    it('should handle single scope as string', () => {
      const result = normalizer.normalize({ query: 'test', scope: 'local' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sources).toEqual(['local']);
      }
    });

    it('should handle scope array', () => {
      const result = normalizer.normalize(
        { query: 'test', scope: ['local', 'collection'] },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sources).toEqual(['local', 'collection']);
      }
    });

    it('should fail for invalid scope string', () => {
      const result = normalizer.normalize({ query: 'test', scope: 'invalid' }, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid scope');
        expect(result.error).toContain('invalid');
      }
    });

    it('should fail for invalid scope in array', () => {
      const result = normalizer.normalize(
        { query: 'test', scope: ['local', 'invalid'] },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid scope');
        expect(result.error).toContain('invalid');
      }
    });

    it('should fail for non-string scope values in array', () => {
      const result = normalizer.normalize({ query: 'test', scope: [123, 'local'] }, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid scope');
      }
    });

    it('should fail for invalid scope type', () => {
      const result = normalizer.normalize({ query: 'test', scope: { foo: 'bar' } }, mockContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid scope parameter');
      }
    });
  });

  describe('pagination normalization', () => {
    it('should convert offset-based pagination to page-based', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 20, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(3); // offset 20 / limit 10 + 1 = 3
        expect(result.params.pageSize).toBe(10);
      }
    });

    it('should handle offset 0', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 0, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(1);
        expect(result.params.pageSize).toBe(10);
      }
    });

    it('should use default page size 20 when limit not specified in pagination', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 40 } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(3); // offset 40 / default 20 + 1 = 3
        expect(result.params.pageSize).toBe(20);
      }
    });

    it('should handle top-level page and limit', () => {
      const result = normalizer.normalize({ query: 'test', page: 2, limit: 25 }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(2);
        expect(result.params.pageSize).toBe(25);
      }
    });

    it('should handle pagination.limit without offset', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { limit: 50 } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.pageSize).toBe(50);
        expect(result.params.page).toBeUndefined();
      }
    });

    it('should not include pagination when not specified', () => {
      const result = normalizer.normalize({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBeUndefined();
        expect(result.params.pageSize).toBeUndefined();
      }
    });
  });

  describe('pagination validation (Issue #227)', () => {
    it('should reject negative offset in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: -10, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('offset');
      }
    });

    it('should reject zero limit in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 0, limit: 0 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should reject negative limit in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { limit: -5 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should reject negative top-level page', () => {
      const result = normalizer.normalize(
        { query: 'test', page: -1 },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('page');
      }
    });

    it('should reject zero top-level page', () => {
      const result = normalizer.normalize(
        { query: 'test', page: 0 },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('page');
      }
    });

    it('should reject negative top-level limit', () => {
      const result = normalizer.normalize(
        { query: 'test', limit: -10 },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should reject zero top-level limit', () => {
      const result = normalizer.normalize(
        { query: 'test', limit: 0 },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should reject conflicting page + offset', () => {
      const result = normalizer.normalize(
        { query: 'test', page: 2, pagination: { offset: 50 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Conflicting pagination');
        expect(result.error).toContain('page');
        expect(result.error).toContain('offset');
      }
    });

    it('should still normalize valid pagination correctly', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 20, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(3);
        expect(result.params.pageSize).toBe(10);
      }
    });

    it('should reject non-integer page', () => {
      const result = normalizer.normalize(
        { query: 'test', page: 2.5 },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('page');
      }
    });

    it('should reject Infinity limit', () => {
      const result = normalizer.normalize(
        { query: 'test', limit: Infinity },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should reject NaN offset in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: NaN, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('offset');
      }
    });

    it('should reject non-integer offset in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { offset: 5.5, limit: 10 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('offset');
      }
    });

    it('should reject non-integer limit in pagination object', () => {
      const result = normalizer.normalize(
        { query: 'test', pagination: { limit: 10.3 } },
        mockContext
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid pagination');
        expect(result.error).toContain('limit');
      }
    });

    it('should still normalize valid top-level page and limit', () => {
      const result = normalizer.normalize(
        { query: 'test', page: 3, limit: 15 },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.page).toBe(3);
        expect(result.params.pageSize).toBe(15);
      }
    });
  });

  describe('sort normalization', () => {
    it('should extract sortBy from top-level param', () => {
      const result = normalizer.normalize({ query: 'test', sortBy: 'name' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sortBy).toBe('name');
      }
    });

    it('should extract sortOrder from top-level param', () => {
      const result = normalizer.normalize(
        { query: 'test', sortBy: 'name', sortOrder: 'desc' },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sortBy).toBe('name');
        expect(result.params.sortOrder).toBe('desc');
      }
    });

    it('should extract from sort object', () => {
      const result = normalizer.normalize(
        { query: 'test', sort: { field: 'created', order: 'asc' } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sortBy).toBe('created');
        expect(result.params.sortOrder).toBe('asc');
      }
    });

    it('should allow top-level params to override sort object', () => {
      const result = normalizer.normalize(
        {
          query: 'test',
          sort: { field: 'created', order: 'asc' },
          sortBy: 'name',
          sortOrder: 'desc',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sortBy).toBe('name');
        expect(result.params.sortOrder).toBe('desc');
      }
    });

    it('should ignore invalid sortOrder values', () => {
      const result = normalizer.normalize(
        { query: 'test', sortBy: 'name', sortOrder: 'invalid' },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.sortBy).toBe('name');
        expect(result.params.sortOrder).toBeUndefined();
      }
    });
  });

  describe('filter normalization', () => {
    it('should extract tags filter', () => {
      const result = normalizer.normalize(
        { query: 'test', filters: { tags: ['ai', 'creative'] } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters?.tags).toEqual(['ai', 'creative']);
      }
    });

    it('should extract author filter', () => {
      const result = normalizer.normalize(
        { query: 'test', filters: { author: 'user123' } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters?.author).toBe('user123');
      }
    });

    it('should extract date filters', () => {
      const result = normalizer.normalize(
        {
          query: 'test',
          filters: {
            createdAfter: '2024-01-01',
            createdBefore: '2024-12-31',
          },
        },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters?.createdAfter).toBe('2024-01-01');
        expect(result.params.filters?.createdBefore).toBe('2024-12-31');
      }
    });

    it('should filter out non-string tags', () => {
      const result = normalizer.normalize(
        { query: 'test', filters: { tags: ['valid', 123, null, 'also-valid'] } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters?.tags).toEqual(['valid', 'also-valid']);
      }
    });

    it('should trim author whitespace', () => {
      const result = normalizer.normalize(
        { query: 'test', filters: { author: '  user123  ' } },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters?.author).toBe('user123');
      }
    });

    it('should not include filters when not specified', () => {
      const result = normalizer.normalize({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters).toBeUndefined();
      }
    });

    it('should not include filters when empty', () => {
      const result = normalizer.normalize({ query: 'test', filters: {} }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.filters).toBeUndefined();
      }
    });
  });

  describe('options normalization', () => {
    it('should extract options from options object', () => {
      const result = normalizer.normalize(
        {
          query: 'test',
          options: {
            fuzzyMatch: true,
            includeKeywords: true,
            includeTags: false,
          },
        },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.options?.fuzzyMatch).toBe(true);
        expect(result.params.options?.includeKeywords).toBe(true);
        expect(result.params.options?.includeTags).toBe(false);
      }
    });

    it('should extract legacy top-level boolean options', () => {
      const result = normalizer.normalize(
        {
          query: 'test',
          fuzzyMatch: true,
          includeDescriptions: true,
        },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.options?.fuzzyMatch).toBe(true);
        expect(result.params.options?.includeDescriptions).toBe(true);
      }
    });

    it('should not include options when not specified', () => {
      const result = normalizer.normalize({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.options).toBeUndefined();
      }
    });
  });

  describe('element type normalization', () => {
    it('should extract type from params.type', () => {
      const result = normalizer.normalize({ query: 'test', type: 'personas' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.elementType).toBe('personas');
      }
    });

    it('should extract type from legacy elementType param', () => {
      const result = normalizer.normalize({ query: 'test', elementType: 'skills' }, mockContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.elementType).toBe('skills');
      }
    });

    it('should prefer type over elementType', () => {
      const result = normalizer.normalize(
        { query: 'test', type: 'personas', elementType: 'skills' },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params.elementType).toBe('personas');
      }
    });
  });

  describe('full normalization', () => {
    it('should normalize all parameters together', () => {
      const result = normalizer.normalize(
        {
          query: '  creative writer  ',
          scope: ['local', 'collection'],
          type: 'personas',
          pagination: { offset: 20, limit: 10 },
          sortBy: 'name',
          sortOrder: 'asc',
          filters: { tags: ['ai'], author: 'user' },
          options: { fuzzyMatch: true },
        },
        mockContext
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.params).toEqual({
          query: 'creative writer',
          sources: ['local', 'collection'],
          elementType: 'personas',
          page: 3,
          pageSize: 10,
          sortBy: 'name',
          sortOrder: 'asc',
          filters: { tags: ['ai'], author: 'user' },
          options: { fuzzyMatch: true },
        });
      }
    });
  });
});
