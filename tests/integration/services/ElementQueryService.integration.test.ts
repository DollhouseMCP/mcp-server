/**
 * Integration tests for ElementQueryService (Issue #38)
 *
 * Tests the full query pipeline: filter → sort → paginate
 * Uses real service composition via DI container pattern
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaginationService } from '../../../src/services/query/PaginationService.js';
import { FilterService } from '../../../src/services/query/FilterService.js';
import { SortService } from '../../../src/services/query/SortService.js';
import { ElementQueryService } from '../../../src/services/query/ElementQueryService.js';
import { IElement, ElementStatus, IElementMetadata } from '../../../src/types/elements/IElement.js';
import { ElementType } from '../../../src/portfolio/types.js';

/**
 * Create a mock element for testing
 * Simulates real element structure from managers
 */
function createMockElement(
  name: string,
  overrides: Partial<IElementMetadata> & {
    elementStatus?: ElementStatus;
    retention?: string;
  } = {}
): IElement {
  const { elementStatus = ElementStatus.INACTIVE, retention, ...metadataOverrides } = overrides;

  const element: IElement & { retention?: string } = {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    type: 'memories' as ElementType,
    version: metadataOverrides.version || '1.0.0',
    metadata: {
      name,
      description: `Description for ${name}`,
      author: 'test-author',
      version: '1.0.0',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      tags: [],
      ...metadataOverrides,
    },
    validate: () => ({ valid: true }),
    serialize: () => JSON.stringify({}),
    deserialize: () => {},
    getStatus: () => elementStatus,
  };

  if (retention !== undefined) {
    element.retention = retention;
  }

  return element;
}

describe('ElementQueryService Integration', () => {
  let queryService: ElementQueryService;
  let elements: IElement[];

  beforeEach(() => {
    // Compose services as DI container would
    const paginationService = new PaginationService();
    const filterService = new FilterService();
    const sortService = new SortService();
    queryService = new ElementQueryService(paginationService, filterService, sortService);

    // Create test dataset simulating a large portfolio
    elements = [
      createMockElement('Code Review Guidelines', {
        tags: ['development', 'best-practices'],
        author: 'alice',
        created: '2024-06-01T00:00:00Z',
        version: '2.1.0',
        elementStatus: ElementStatus.ACTIVE,
      }),
      createMockElement('TypeScript Best Practices', {
        tags: ['development', 'typescript'],
        author: 'bob',
        created: '2024-03-15T00:00:00Z',
        version: '1.5.0',
        elementStatus: ElementStatus.ACTIVE,
      }),
      createMockElement('Meeting Notes Template', {
        tags: ['documentation', 'templates'],
        author: 'alice',
        created: '2024-08-20T00:00:00Z',
        version: '1.0.0',
        elementStatus: ElementStatus.INACTIVE,
      }),
      createMockElement('Python Style Guide', {
        tags: ['development', 'python'],
        author: 'charlie',
        created: '2024-01-10T00:00:00Z',
        version: '3.0.0',
        elementStatus: ElementStatus.INACTIVE,
      }),
      createMockElement('API Documentation Standards', {
        tags: ['documentation', 'api'],
        author: 'alice',
        created: '2024-11-01T00:00:00Z',
        version: '1.2.0',
        elementStatus: ElementStatus.ACTIVE,
      }),
      createMockElement('Database Schema Design', {
        tags: ['development', 'database'],
        author: 'bob',
        created: '2024-07-15T00:00:00Z',
        version: '1.0.0',
        elementStatus: ElementStatus.INACTIVE,
      }),
      createMockElement('Code Review Session Notes', {
        tags: ['development', 'notes'],
        author: 'alice',
        created: '2024-09-01T00:00:00Z',
        version: '1.1.0',
        elementStatus: ElementStatus.ACTIVE,
      }),
    ];
  });

  describe('Full Query Pipeline', () => {
    it('should execute filter → sort → paginate in correct order', () => {
      const result = queryService.query(elements, {
        filters: { tags: ['development'] },
        sort: { sortBy: 'created', sortOrder: 'desc' },
        pagination: { page: 1, pageSize: 3 },
      });

      // Should filter to development-tagged items (5)
      // Sort by created desc (newest first)
      // Then paginate to first 3
      expect(result.pagination.totalItems).toBe(5);
      expect(result.items).toHaveLength(3);

      // Verify sorted order (newest first)
      const dates = result.items.map((e) => new Date(e.metadata.created!).getTime());
      expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
      expect(dates[1]).toBeGreaterThanOrEqual(dates[2]);

      // Verify filters applied
      result.items.forEach((item) => {
        expect(item.metadata.tags).toContain('development');
      });
    });

    it('should return correct pagination metadata', () => {
      const result = queryService.query(elements, {
        pagination: { page: 2, pageSize: 3 },
      });

      expect(result.pagination).toEqual({
        page: 2,
        pageSize: 3,
        totalItems: 7,
        totalPages: 3,
        hasNextPage: true,
        hasPrevPage: true,
      });

      expect(result.items).toHaveLength(3);
    });

    it('should handle combined filters with AND logic', () => {
      const result = queryService.query(elements, {
        filters: {
          tags: ['development'],
          author: 'alice',
        },
      });

      // Alice's development items
      expect(result.items).toHaveLength(2);
      result.items.forEach((item) => {
        expect(item.metadata.tags).toContain('development');
        expect(item.metadata.author).toBe('alice');
      });
    });

    it('should handle nameContains filter', () => {
      const result = queryService.query(elements, {
        filters: { nameContains: 'Code Review' },
      });

      expect(result.items).toHaveLength(2);
      result.items.forEach((item) => {
        expect(item.metadata.name.toLowerCase()).toContain('code review');
      });
    });

    it('should handle status filter for active elements', () => {
      const result = queryService.query(elements, {
        filters: { status: 'active' },
      });

      expect(result.items).toHaveLength(4);
      result.items.forEach((item) => {
        expect(item.getStatus()).toBe(ElementStatus.ACTIVE);
      });
    });

    it('should handle status filter for inactive elements', () => {
      const result = queryService.query(elements, {
        filters: { status: 'inactive' },
      });

      expect(result.items).toHaveLength(3);
      result.items.forEach((item) => {
        expect(item.getStatus()).toBe(ElementStatus.INACTIVE);
      });
    });

    it('should handle date range filtering', () => {
      const result = queryService.query(elements, {
        filters: {
          createdAfter: '2024-06-01T00:00:00Z',
          createdBefore: '2024-09-30T00:00:00Z',
        },
      });

      // Elements created between June and September 2024
      expect(result.items.length).toBeGreaterThan(0);
      result.items.forEach((item) => {
        const created = new Date(item.metadata.created!);
        expect(created.getTime()).toBeGreaterThanOrEqual(new Date('2024-06-01').getTime());
        expect(created.getTime()).toBeLessThanOrEqual(new Date('2024-09-30T23:59:59Z').getTime());
      });
    });
  });

  describe('Sorting', () => {
    it('should sort by name ascending by default', () => {
      const result = queryService.query(elements, {});

      // Check sorted alphabetically
      for (let i = 1; i < result.items.length; i++) {
        const prev = result.items[i - 1].metadata.name.toLowerCase();
        const curr = result.items[i].metadata.name.toLowerCase();
        expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
      }
    });

    it('should sort by version (semantic versioning)', () => {
      const result = queryService.query(elements, {
        sort: { sortBy: 'version', sortOrder: 'desc' },
      });

      // Highest version should be first (3.0.0)
      expect(result.items[0].metadata.version).toBe('3.0.0');
    });

    it('should sort by created date', () => {
      const result = queryService.query(elements, {
        sort: { sortBy: 'created', sortOrder: 'asc' },
      });

      // Oldest first
      expect(result.items[0].metadata.name).toBe('Python Style Guide');
    });
  });

  describe('Backward Compatibility', () => {
    it('should return all items with defaults when no options provided', () => {
      const result = queryService.query(elements);

      expect(result.items.length).toBe(Math.min(20, elements.length));
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(20);
      expect(result.sorting.sortBy).toBe('name');
      expect(result.sorting.sortOrder).toBe('asc');
      expect(result.filters.applied.count).toBe(0);
    });

    it('should return all items when empty options provided', () => {
      const result = queryService.query(elements, {});

      expect(result.items.length).toBe(elements.length);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty result set from filtering', () => {
      const result = queryService.query(elements, {
        filters: { tags: ['nonexistent-tag'] },
      });

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it('should handle page beyond available data', () => {
      const result = queryService.query(elements, {
        pagination: { page: 100, pageSize: 25 },
      });

      expect(result.items).toHaveLength(0);
      expect(result.pagination.page).toBe(100);
      expect(result.pagination.totalItems).toBe(7);
    });

    it('should handle empty input array', () => {
      const result = queryService.query([], {
        filters: { tags: ['any'] },
      });

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });
  });

  describe('Query Summary Metadata', () => {
    it('should report applied filters count', () => {
      const result = queryService.query(elements, {
        filters: {
          nameContains: 'Code',
          tags: ['development'],
          author: 'alice',
        },
      });

      expect(result.filters.applied.count).toBe(3);
      expect(result.filters.applied.nameContains).toBe('Code');
      expect(result.filters.applied.tags).toEqual(['development']);
      expect(result.filters.applied.author).toBe('alice');
    });

    it('should report sorting metadata', () => {
      const result = queryService.query(elements, {
        sort: { sortBy: 'created', sortOrder: 'desc' },
      });

      expect(result.sorting.sortBy).toBe('created');
      expect(result.sorting.sortOrder).toBe('desc');
    });
  });

  describe('Large Dataset Simulation', () => {
    it('should efficiently paginate large datasets', () => {
      // Create 200 elements
      const largeDataset = Array.from({ length: 200 }, (_, i) =>
        createMockElement(`Element ${String(i).padStart(3, '0')}`, {
          tags: i % 2 === 0 ? ['even'] : ['odd'],
          created: new Date(2024, 0, 1 + i).toISOString(),
        })
      );

      const startTime = Date.now();
      const result = queryService.query(largeDataset, {
        filters: { tags: ['even'] },
        sort: { sortBy: 'created', sortOrder: 'desc' },
        pagination: { page: 3, pageSize: 25 },
      });
      const duration = Date.now() - startTime;

      expect(result.pagination.totalItems).toBe(100); // Half are even
      expect(result.items).toHaveLength(25);
      expect(result.pagination.page).toBe(3);
      expect(result.pagination.totalPages).toBe(4);

      // Should complete quickly (< 100ms for 200 items)
      expect(duration).toBeLessThan(100);
    });
  });
});
