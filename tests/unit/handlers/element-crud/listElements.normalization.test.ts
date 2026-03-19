/**
 * Tests for listElements parameter normalization (Issue #204)
 *
 * Verifies that flat params are correctly normalized to QueryOptions structure:
 * - Flat pagination: { page: 2, pageSize: 25 }
 * - Limit/offset: { limit: 25, offset: 50 }
 * - Flat filters: { nameContains: 'test', tags: ['a'] }
 * - Flat sort: { sortBy: 'modified', sortOrder: 'desc' }
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';
import type { ElementQueryService } from '../../../../src/services/query/ElementQueryService.js';

// Mock the modules we depend on
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Import after mocking
const { listElements } = await import('../../../../src/handlers/element-crud/listElements.js');

describe('listElements parameter normalization (Issue #204)', () => {
  let mockContext: ElementCrudContext;
  let mockQueryService: Partial<ElementQueryService>;
  let queryCallArgs: unknown[];

  beforeEach(() => {
    queryCallArgs = [];

    mockQueryService = {
      query: jest.fn((items, options) => {
        queryCallArgs = [items, options];
        return {
          items: [],
          pagination: {
            page: options?.pagination?.page || 1,
            pageSize: options?.pagination?.pageSize || 20,
            totalItems: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
          sorting: {
            sortBy: options?.sort?.sortBy || 'name',
            sortOrder: options?.sort?.sortOrder || 'asc',
          },
          filters: {
            applied: { count: 0 },
          },
        };
      }),
    };

    mockContext = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue(''),
      personaManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'Test Persona', description: 'Test desc' } },
        ]),
        getActivePersona: jest.fn().mockReturnValue(null),
      },
      skillManager: {
        list: jest.fn().mockResolvedValue([
          { metadata: { name: 'Test Skill', description: 'Test desc' } },
        ]),
      },
      templateManager: { list: jest.fn().mockResolvedValue([]) },
      agentManager: { list: jest.fn().mockResolvedValue([]) },
      memoryManager: { list: jest.fn().mockResolvedValue([]) },
      ensembleManager: { list: jest.fn().mockResolvedValue([]) },
      portfolioManager: {},
      templateRenderer: {},
      fileOperations: {},
      elementQueryService: mockQueryService as ElementQueryService,
    } as unknown as ElementCrudContext;
  });

  describe('Flat pagination params', () => {
    it('should normalize flat page/pageSize to nested pagination', async () => {
      await listElements(mockContext, 'personas', {
        page: 2,
        pageSize: 50,
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 2, pageSize: 50 },
        })
      );
    });

    it('should normalize limit/offset to page/pageSize', async () => {
      // limit=25, offset=50 → page 3 (50/25 + 1 = 3)
      await listElements(mockContext, 'personas', {
        limit: 25,
        offset: 50,
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 3, pageSize: 25 },
        })
      );
    });

    it('should handle offset=0 correctly', async () => {
      await listElements(mockContext, 'personas', {
        limit: 10,
        offset: 0,
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 1, pageSize: 10 },
        })
      );
    });

    it('should prefer pageSize over limit when both present (non-conflicting)', async () => {
      await listElements(mockContext, 'personas', {
        limit: 25,
        pageSize: 100,
        page: 5,
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 5, pageSize: 100 },
        })
      );
    });
  });

  describe('Flat filter params', () => {
    it('should normalize flat nameContains to nested filters', async () => {
      await listElements(mockContext, 'personas', {
        nameContains: 'expert',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { nameContains: 'expert' },
        })
      );
    });

    it('should normalize flat tags to nested filters', async () => {
      await listElements(mockContext, 'personas', {
        tags: ['typescript', 'coding'],
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { tags: ['typescript', 'coding'] },
        })
      );
    });

    it('should normalize flat author to nested filters', async () => {
      await listElements(mockContext, 'personas', {
        author: 'test-user',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { author: 'test-user' },
        })
      );
    });

    it('should normalize flat date filters', async () => {
      await listElements(mockContext, 'personas', {
        createdAfter: '2025-01-01',
        createdBefore: '2025-12-31',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: {
            createdAfter: '2025-01-01',
            createdBefore: '2025-12-31',
          },
        })
      );
    });

    it('should normalize flat status filter', async () => {
      await listElements(mockContext, 'personas', {
        status: 'active',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { status: 'active' },
        })
      );
    });

    it('should support "filter" as alias for "filters"', async () => {
      await listElements(mockContext, 'personas', {
        filter: { nameContains: 'test' },
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { nameContains: 'test' },
        })
      );
    });
  });

  describe('Flat sort params', () => {
    it('should normalize flat sortBy to nested sort', async () => {
      await listElements(mockContext, 'personas', {
        sortBy: 'modified',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          sort: { sortBy: 'modified' },
        })
      );
    });

    it('should normalize flat sortOrder to nested sort', async () => {
      await listElements(mockContext, 'personas', {
        sortOrder: 'desc',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          sort: { sortOrder: 'desc' },
        })
      );
    });

    it('should normalize flat sortBy and sortOrder together', async () => {
      await listElements(mockContext, 'personas', {
        sortBy: 'created',
        sortOrder: 'desc',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          sort: { sortBy: 'created', sortOrder: 'desc' },
        })
      );
    });
  });

  describe('Nested params (already structured)', () => {
    it('should pass through already-nested pagination', async () => {
      await listElements(mockContext, 'personas', {
        pagination: { page: 3, pageSize: 15 },
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 3, pageSize: 15 },
        })
      );
    });

    it('should pass through already-nested filters', async () => {
      await listElements(mockContext, 'personas', {
        filters: { nameContains: 'test', author: 'alice' },
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          filters: { nameContains: 'test', author: 'alice' },
        })
      );
    });

    it('should pass through already-nested sort', async () => {
      await listElements(mockContext, 'personas', {
        sort: { sortBy: 'version', sortOrder: 'asc' },
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          sort: { sortBy: 'version', sortOrder: 'asc' },
        })
      );
    });
  });

  describe('Mixed params', () => {
    it('should normalize a mix of flat and nested params', async () => {
      await listElements(mockContext, 'personas', {
        page: 2,
        pageSize: 25,
        filters: { nameContains: 'expert' },
        sortBy: 'modified',
        sortOrder: 'desc',
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual({
        pagination: { page: 2, pageSize: 25 },
        filters: { nameContains: 'expert' },
        sort: { sortBy: 'modified', sortOrder: 'desc' },
      });
    });
  });

  describe('Invalid pagination params (Issue #227)', () => {
    it('should reject negative page', async () => {
      const result = await listElements(mockContext, 'personas', { page: -1 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('page');
      expect(result.error).toContain('-1');
    });

    it('should reject zero page', async () => {
      const result = await listElements(mockContext, 'personas', { page: 0 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('page');
    });

    it('should reject negative pageSize', async () => {
      const result = await listElements(mockContext, 'personas', { pageSize: -5 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('pageSize');
    });

    it('should reject zero pageSize', async () => {
      const result = await listElements(mockContext, 'personas', { pageSize: 0 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('pageSize');
    });

    it('should reject negative limit', async () => {
      const result = await listElements(mockContext, 'personas', { limit: -10 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('limit');
    });

    it('should reject zero limit', async () => {
      const result = await listElements(mockContext, 'personas', { limit: 0 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('limit');
    });

    it('should reject negative offset', async () => {
      const result = await listElements(mockContext, 'personas', { limit: 25, offset: -1 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('offset');
    });

    it('should reject conflicting page + offset', async () => {
      const result = await listElements(mockContext, 'personas', {
        page: 2,
        offset: 50,
      }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Conflicting pagination');
      expect(result.error).toContain('page');
      expect(result.error).toContain('offset');
    });

    it('should reject conflicting page + offset even with valid limit', async () => {
      const result = await listElements(mockContext, 'personas', {
        page: 2,
        offset: 50,
        limit: 25,
      }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Conflicting pagination');
    });

    it('should reject non-integer page', async () => {
      const result = await listElements(mockContext, 'personas', { page: 1.5 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('page');
    });

    it('should reject Infinity page', async () => {
      const result = await listElements(mockContext, 'personas', { page: Infinity }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
    });

    it('should reject NaN pageSize', async () => {
      const result = await listElements(mockContext, 'personas', { pageSize: NaN }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
    });

    it('should reject non-integer offset', async () => {
      const result = await listElements(mockContext, 'personas', { limit: 10, offset: 5.5 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('offset');
    });

    it('should reject non-integer limit', async () => {
      const result = await listElements(mockContext, 'personas', { limit: 10.7 }) as any;

      expect(mockQueryService.query).not.toHaveBeenCalled();
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Invalid pagination');
      expect(result.error).toContain('limit');
    });

    it('should still accept valid pagination after validation', async () => {
      await listElements(mockContext, 'personas', {
        page: 1,
        pageSize: 25,
      });

      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 1, pageSize: 25 },
        })
      );
    });
  });

  describe('Default pagination (Issue #299 — legacy mode removed)', () => {
    it('should always use query service even when no options provided', async () => {
      await listElements(mockContext, 'personas');

      // All calls now go through the query pipeline with default pagination
      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 1, pageSize: 20 },
        })
      );
    });

    it('should use query service when options is empty object', async () => {
      await listElements(mockContext, 'personas', {});

      // Empty options still trigger query pipeline with defaults
      expect(mockQueryService.query).toHaveBeenCalled();
      const [_, options] = queryCallArgs;
      expect(options).toEqual(
        expect.objectContaining({
          pagination: { page: 1, pageSize: 20 },
        })
      );
    });

    it('should pass through status=all as a filter', async () => {
      await listElements(mockContext, 'personas', { status: 'all' });

      // All calls go through query pipeline
      expect(mockQueryService.query).toHaveBeenCalled();
    });
  });
});
