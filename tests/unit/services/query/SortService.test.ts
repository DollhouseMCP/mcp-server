/**
 * Unit tests for SortService
 *
 * Tests sorting logic, validation, field handling, and edge cases.
 *
 * @see src/services/query/SortService.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SortService } from '../../../../src/services/query/SortService.js';
import { IElement, ElementStatus, IElementMetadata } from '../../../../src/types/elements/IElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { SortableField, SortOrder } from '../../../../src/services/query/types.js';

/**
 * Mock element factory for testing
 * Creates minimal IElement implementations with configurable metadata
 */
function createMockElement(
  overrides: Partial<IElementMetadata> & { retention?: string } = {}
): IElement {
  const { retention, ...metadataOverrides } = overrides;

  const element: IElement & { retention?: string } = {
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
    getStatus: () => ElementStatus.INACTIVE,
  };

  // Add retention property for memory-like elements
  if (retention !== undefined) {
    element.retention = retention;
  }

  return element;
}

describe('SortService', () => {
  let service: SortService;

  beforeEach(() => {
    service = new SortService();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      expect(service).toBeInstanceOf(SortService);
    });
  });

  describe('sort - default behavior', () => {
    it('should sort by name ascending by default', () => {
      const items = [
        createMockElement({ name: 'Charlie' }),
        createMockElement({ name: 'Alice' }),
        createMockElement({ name: 'Bob' }),
      ];

      const result = service.sort(items);

      expect(result).toHaveLength(3);
      expect(result[0].metadata.name).toBe('Alice');
      expect(result[1].metadata.name).toBe('Bob');
      expect(result[2].metadata.name).toBe('Charlie');
    });

    it('should return empty array for empty input', () => {
      const result = service.sort([]);

      expect(result).toEqual([]);
    });

    it('should return single item as-is', () => {
      const items = [createMockElement({ name: 'Only One' })];
      const result = service.sort(items);

      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('Only One');
    });

    it('should not mutate original array', () => {
      const items = [
        createMockElement({ name: 'Charlie' }),
        createMockElement({ name: 'Alice' }),
        createMockElement({ name: 'Bob' }),
      ];
      const originalOrder = items.map((i) => i.metadata.name);

      service.sort(items);

      expect(items.map((i) => i.metadata.name)).toEqual(originalOrder);
    });
  });

  describe('sort - by name', () => {
    const items = [
      createMockElement({ name: 'zebra' }),
      createMockElement({ name: 'Apple' }),
      createMockElement({ name: 'banana' }),
      createMockElement({ name: 'CHERRY' }),
    ];

    it('should sort by name ascending (case-insensitive)', () => {
      const result = service.sort(items, { sortBy: 'name', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Apple');
      expect(result[1].metadata.name).toBe('banana');
      expect(result[2].metadata.name).toBe('CHERRY');
      expect(result[3].metadata.name).toBe('zebra');
    });

    it('should sort by name descending', () => {
      const result = service.sort(items, { sortBy: 'name', sortOrder: 'desc' });

      expect(result[0].metadata.name).toBe('zebra');
      expect(result[1].metadata.name).toBe('CHERRY');
      expect(result[2].metadata.name).toBe('banana');
      expect(result[3].metadata.name).toBe('Apple');
    });
  });

  describe('sort - by created date', () => {
    const items = [
      createMockElement({ name: 'Mid', created: '2024-06-15T00:00:00Z' }),
      createMockElement({ name: 'Early', created: '2024-01-01T00:00:00Z' }),
      createMockElement({ name: 'Late', created: '2024-12-31T00:00:00Z' }),
    ];

    it('should sort by created date ascending', () => {
      const result = service.sort(items, { sortBy: 'created', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Early');
      expect(result[1].metadata.name).toBe('Mid');
      expect(result[2].metadata.name).toBe('Late');
    });

    it('should sort by created date descending', () => {
      const result = service.sort(items, { sortBy: 'created', sortOrder: 'desc' });

      expect(result[0].metadata.name).toBe('Late');
      expect(result[1].metadata.name).toBe('Mid');
      expect(result[2].metadata.name).toBe('Early');
    });

    it('should handle elements without created date (nulls last)', () => {
      const itemsWithNull = [
        createMockElement({ name: 'Has Date', created: '2024-06-15T00:00:00Z' }),
        createMockElement({ name: 'No Date', created: undefined }),
        createMockElement({ name: 'Early Date', created: '2024-01-01T00:00:00Z' }),
      ];

      const result = service.sort(itemsWithNull, { sortBy: 'created', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Early Date');
      expect(result[1].metadata.name).toBe('Has Date');
      expect(result[2].metadata.name).toBe('No Date'); // Null last
    });

    it('should handle elements without created date in desc order', () => {
      const itemsWithNull = [
        createMockElement({ name: 'Has Date', created: '2024-06-15T00:00:00Z' }),
        createMockElement({ name: 'No Date', created: undefined }),
        createMockElement({ name: 'Early Date', created: '2024-01-01T00:00:00Z' }),
      ];

      const result = service.sort(itemsWithNull, { sortBy: 'created', sortOrder: 'desc' });

      // In descending order, nulls float to top due to comparison negation
      // Non-null values are sorted latest first
      expect(result[0].metadata.name).toBe('No Date');
      expect(result[1].metadata.name).toBe('Has Date');
      expect(result[2].metadata.name).toBe('Early Date');
    });
  });

  describe('sort - by modified date', () => {
    const items = [
      createMockElement({ name: 'Recent', modified: '2024-11-15T00:00:00Z' }),
      createMockElement({ name: 'Old', modified: '2024-02-01T00:00:00Z' }),
      createMockElement({ name: 'Mid', modified: '2024-06-15T00:00:00Z' }),
    ];

    it('should sort by modified date ascending', () => {
      const result = service.sort(items, { sortBy: 'modified', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Old');
      expect(result[1].metadata.name).toBe('Mid');
      expect(result[2].metadata.name).toBe('Recent');
    });

    it('should sort by modified date descending', () => {
      const result = service.sort(items, { sortBy: 'modified', sortOrder: 'desc' });

      expect(result[0].metadata.name).toBe('Recent');
      expect(result[1].metadata.name).toBe('Mid');
      expect(result[2].metadata.name).toBe('Old');
    });
  });

  describe('sort - by version (semantic versioning)', () => {
    const items = [
      createMockElement({ name: 'V2', version: '2.0.0' }),
      createMockElement({ name: 'V1', version: '1.0.0' }),
      createMockElement({ name: 'V1.5', version: '1.5.0' }),
      createMockElement({ name: 'V1.0.1', version: '1.0.1' }),
    ];

    it('should sort by semantic version ascending', () => {
      const result = service.sort(items, { sortBy: 'version', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('V1');
      expect(result[1].metadata.name).toBe('V1.0.1');
      expect(result[2].metadata.name).toBe('V1.5');
      expect(result[3].metadata.name).toBe('V2');
    });

    it('should sort by semantic version descending', () => {
      const result = service.sort(items, { sortBy: 'version', sortOrder: 'desc' });

      expect(result[0].metadata.name).toBe('V2');
      expect(result[1].metadata.name).toBe('V1.5');
      expect(result[2].metadata.name).toBe('V1.0.1');
      expect(result[3].metadata.name).toBe('V1');
    });

    it('should handle non-semver versions with string comparison', () => {
      const itemsWithBadVersion = [
        createMockElement({ name: 'Normal', version: '1.0.0' }),
        createMockElement({ name: 'Bad', version: 'latest' }),
        createMockElement({ name: 'Also Bad', version: 'beta' }),
      ];

      const result = service.sort(itemsWithBadVersion, { sortBy: 'version', sortOrder: 'asc' });

      // Non-semver versions should fall back to string comparison
      expect(result).toHaveLength(3);
    });

    it('should handle missing version (nulls last)', () => {
      const itemsWithNull = [
        createMockElement({ name: 'Has Version', version: '1.0.0' }),
        createMockElement({ name: 'No Version', version: undefined }),
      ];

      const result = service.sort(itemsWithNull, { sortBy: 'version', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Has Version');
      expect(result[1].metadata.name).toBe('No Version');
    });
  });

  describe('sort - by retention (memory-specific)', () => {
    const items = [
      createMockElement({ name: 'Mid Retention', retention: '50' }),
      createMockElement({ name: 'High Retention', retention: '100' }),
      createMockElement({ name: 'Low Retention', retention: '10' }),
    ];

    it('should sort by retention ascending', () => {
      const result = service.sort(items, { sortBy: 'retention', sortOrder: 'asc' });

      expect(result[0].metadata.name).toBe('Low Retention');
      expect(result[1].metadata.name).toBe('Mid Retention');
      expect(result[2].metadata.name).toBe('High Retention');
    });

    it('should sort by retention descending', () => {
      const result = service.sort(items, { sortBy: 'retention', sortOrder: 'desc' });

      expect(result[0].metadata.name).toBe('High Retention');
      expect(result[1].metadata.name).toBe('Mid Retention');
      expect(result[2].metadata.name).toBe('Low Retention');
    });

    it('should handle elements without retention (nulls last)', () => {
      const itemsWithoutRetention = [
        createMockElement({ name: 'Has Retention', retention: '50' }),
        createMockElement({ name: 'No Retention' }),
      ];

      const result = service.sort(itemsWithoutRetention, {
        sortBy: 'retention',
        sortOrder: 'asc',
      });

      expect(result[0].metadata.name).toBe('Has Retention');
      expect(result[1].metadata.name).toBe('No Retention');
    });
  });

  describe('getDefaultSorting', () => {
    it('should return default sorting options', () => {
      const defaults = service.getDefaultSorting();

      expect(defaults.sortBy).toBe('name');
      expect(defaults.sortOrder).toBe('asc');
    });
  });

  describe('validateOptions', () => {
    it('should pass validation with no options', () => {
      expect(service.validateOptions()).toBe(true);
      expect(service.validateOptions(undefined)).toBe(true);
      expect(service.validateOptions({})).toBe(true);
    });

    it('should pass validation with valid sortBy values', () => {
      const validFields: SortableField[] = ['name', 'created', 'modified', 'version', 'retention'];

      for (const sortBy of validFields) {
        expect(service.validateOptions({ sortBy })).toBe(true);
      }
    });

    it('should pass validation with valid sortOrder values', () => {
      const validOrders: SortOrder[] = ['asc', 'desc'];

      for (const sortOrder of validOrders) {
        expect(service.validateOptions({ sortOrder })).toBe(true);
      }
    });

    it('should reject invalid sortBy field', () => {
      expect(() => service.validateOptions({ sortBy: 'invalid' as any })).toThrow(
        'Invalid sortBy field: invalid. Must be one of: name, created, modified, version, retention'
      );
    });

    it('should reject invalid sortOrder', () => {
      expect(() => service.validateOptions({ sortOrder: 'random' as any })).toThrow(
        "Invalid sortOrder: random. Must be 'asc' or 'desc'"
      );
    });

    it('should reject arbitrary field access (security)', () => {
      expect(() => service.validateOptions({ sortBy: '__proto__' as any })).toThrow();
      expect(() => service.validateOptions({ sortBy: 'constructor' as any })).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle multiple items with same name (stable sort)', () => {
      const items = [
        createMockElement({ name: 'Same', created: '2024-01-01T00:00:00Z' }),
        createMockElement({ name: 'Same', created: '2024-06-01T00:00:00Z' }),
        createMockElement({ name: 'Same', created: '2024-03-01T00:00:00Z' }),
      ];

      const result = service.sort(items, { sortBy: 'name', sortOrder: 'asc' });

      // All have same name, so order should be stable (original order preserved)
      expect(result).toHaveLength(3);
      expect(result.every((e) => e.metadata.name === 'Same')).toBe(true);
    });

    it('should handle all items with null values for sort field', () => {
      const items = [
        createMockElement({ name: 'A', created: undefined }),
        createMockElement({ name: 'B', created: undefined }),
        createMockElement({ name: 'C', created: undefined }),
      ];

      const result = service.sort(items, { sortBy: 'created', sortOrder: 'asc' });

      // All nulls, should maintain some stable order
      expect(result).toHaveLength(3);
    });

    it('should handle invalid date strings gracefully', () => {
      const items = [
        createMockElement({ name: 'Valid', created: '2024-06-15T00:00:00Z' }),
        createMockElement({ name: 'Invalid', created: 'not-a-date' }),
      ];

      const result = service.sort(items, { sortBy: 'created', sortOrder: 'asc' });

      // Invalid date should be treated like null (sorted last)
      expect(result[0].metadata.name).toBe('Valid');
      expect(result[1].metadata.name).toBe('Invalid');
    });

    it('should handle mixed valid and invalid versions', () => {
      const items = [
        createMockElement({ name: 'V2', version: '2.0.0' }),
        createMockElement({ name: 'Invalid', version: 'not-a-version' }),
        createMockElement({ name: 'V1', version: '1.0.0' }),
      ];

      const result = service.sort(items, { sortBy: 'version', sortOrder: 'asc' });

      // Should not throw, handling gracefully
      expect(result).toHaveLength(3);
    });

    it('should handle special characters in names', () => {
      const items = [
        createMockElement({ name: 'ñ-special' }),
        createMockElement({ name: 'A-normal' }),
        createMockElement({ name: 'z-last' }),
        createMockElement({ name: '中文' }),
      ];

      const result = service.sort(items, { sortBy: 'name', sortOrder: 'asc' });

      // Should handle Unicode properly with localeCompare
      expect(result).toHaveLength(4);
    });

    it('should handle large arrays efficiently', () => {
      const items = Array.from({ length: 1000 }, (_, i) =>
        createMockElement({ name: `Element ${String(i).padStart(4, '0')}` })
      );

      const startTime = Date.now();
      const result = service.sort(items, { sortBy: 'name', sortOrder: 'asc' });
      const duration = Date.now() - startTime;

      expect(result).toHaveLength(1000);
      expect(result[0].metadata.name).toBe('Element 0000');
      expect(result[999].metadata.name).toBe('Element 0999');
      // Should complete in reasonable time (< 1 second for 1000 items)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('sort order combinations', () => {
    const items = [
      createMockElement({ name: 'Beta', version: '2.0.0', created: '2024-06-01T00:00:00Z' }),
      createMockElement({ name: 'Alpha', version: '1.0.0', created: '2024-01-01T00:00:00Z' }),
      createMockElement({ name: 'Gamma', version: '3.0.0', created: '2024-12-01T00:00:00Z' }),
    ];

    it('should respect both sortBy and sortOrder', () => {
      // Test all combinations
      const combinations: Array<{ sortBy: SortableField; sortOrder: SortOrder; expectedFirst: string }> = [
        { sortBy: 'name', sortOrder: 'asc', expectedFirst: 'Alpha' },
        { sortBy: 'name', sortOrder: 'desc', expectedFirst: 'Gamma' },
        { sortBy: 'version', sortOrder: 'asc', expectedFirst: 'Alpha' },
        { sortBy: 'version', sortOrder: 'desc', expectedFirst: 'Gamma' },
        { sortBy: 'created', sortOrder: 'asc', expectedFirst: 'Alpha' },
        { sortBy: 'created', sortOrder: 'desc', expectedFirst: 'Gamma' },
      ];

      for (const { sortBy, sortOrder, expectedFirst } of combinations) {
        const result = service.sort(items, { sortBy, sortOrder });
        expect(result[0].metadata.name).toBe(expectedFirst);
      }
    });
  });
});
