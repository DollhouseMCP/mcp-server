/**
 * Unit tests for PaginationService
 *
 * Tests pagination logic, validation, edge cases, and security requirements.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaginationService, createPaginationService, paginationService } from '../../../../src/services/query/PaginationService.js';

describe('PaginationService', () => {
  let service: PaginationService;

  beforeEach(() => {
    service = new PaginationService();
  });

  describe('constructor and factory', () => {
    it('should create a new instance', () => {
      expect(service).toBeInstanceOf(PaginationService);
    });

    it('should create instance via factory function', () => {
      const factoryService = createPaginationService();
      expect(factoryService).toBeInstanceOf(PaginationService);
    });

    it('should provide singleton instance', () => {
      expect(paginationService).toBeInstanceOf(PaginationService);
    });
  });

  describe('paginate - basic functionality', () => {
    it('should paginate items with default options', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items);

      expect(result.items).toHaveLength(20); // Default page size (Issue #299)
      expect(result.items[0]).toEqual({ id: 1 });
      expect(result.items[19]).toEqual({ id: 20 });
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(20);
      expect(result.pagination.totalItems).toBe(100);
      expect(result.pagination.totalPages).toBe(5);
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPrevPage).toBe(false);
    });

    it('should paginate second page correctly', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 2, pageSize: 25 });

      expect(result.items).toHaveLength(25);
      expect(result.items[0]).toEqual({ id: 26 });
      expect(result.items[24]).toEqual({ id: 50 });
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPrevPage).toBe(true);
    });

    it('should paginate last page correctly', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 4, pageSize: 25 });

      expect(result.items).toHaveLength(25);
      expect(result.items[0]).toEqual({ id: 76 });
      expect(result.items[24]).toEqual({ id: 100 });
      expect(result.pagination.page).toBe(4);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPrevPage).toBe(true);
    });

    it('should handle custom page size', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 1, pageSize: 10 });

      expect(result.items).toHaveLength(10);
      expect(result.items[0]).toEqual({ id: 1 });
      expect(result.items[9]).toEqual({ id: 10 });
      expect(result.pagination.totalPages).toBe(10);
    });

    it('should handle maximum page size (100)', () => {
      const items = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 1, pageSize: 100 });

      expect(result.items).toHaveLength(100);
      expect(result.pagination.pageSize).toBe(100);
      expect(result.pagination.totalPages).toBe(2);
    });
  });

  describe('paginate - edge cases', () => {
    it('should handle empty array', () => {
      const result = service.paginate([]);

      expect(result.items).toEqual([]);
      expect(result.pagination.totalItems).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPrevPage).toBe(false);
    });

    it('should handle page beyond available data', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 5, pageSize: 25 });

      expect(result.items).toEqual([]);
      expect(result.pagination.totalItems).toBe(10);
      expect(result.pagination.page).toBe(5);
      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should handle pageSize larger than total items', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 1, pageSize: 50 });

      expect(result.items).toHaveLength(10);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should handle items not evenly divisible by pageSize', () => {
      const items = Array.from({ length: 27 }, (_, i) => ({ id: i + 1 }));
      const result = service.paginate(items, { page: 2, pageSize: 10 });

      expect(result.items).toHaveLength(10);
      expect(result.items[0]).toEqual({ id: 11 });
      expect(result.pagination.totalPages).toBe(3);

      const lastPageResult = service.paginate(items, { page: 3, pageSize: 10 });
      expect(lastPageResult.items).toHaveLength(7);
      expect(lastPageResult.items[0]).toEqual({ id: 21 });
      expect(lastPageResult.items[6]).toEqual({ id: 27 });
    });

    it('should handle single item', () => {
      const items = [{ id: 1 }];
      const result = service.paginate(items);

      expect(result.items).toHaveLength(1);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPrevPage).toBe(false);
    });

    it('should work with any item type', () => {
      const stringItems = ['a', 'b', 'c', 'd', 'e'];
      const result = service.paginate(stringItems, { page: 1, pageSize: 2 });

      expect(result.items).toEqual(['a', 'b']);
      expect(result.pagination.totalItems).toBe(5);
    });
  });

  describe('paginate - validation', () => {
    it('should reject page number less than 1', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { page: 0 })).toThrow(
        'Page number must be an integer >= 1, got: 0'
      );
    });

    it('should reject negative page number', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { page: -1 })).toThrow(
        'Page number must be an integer >= 1, got: -1'
      );
    });

    it('should reject non-integer page number', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { page: 1.5 })).toThrow(
        'Page number must be an integer >= 1, got: 1.5'
      );
    });

    it('should reject pageSize less than 1', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { pageSize: 0 })).toThrow(
        'Page size must be an integer >= 1, got: 0'
      );
    });

    it('should reject negative pageSize', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { pageSize: -10 })).toThrow(
        'Page size must be an integer >= 1, got: -10'
      );
    });

    it('should reject non-integer pageSize', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      expect(() => service.paginate(items, { pageSize: 2.5 })).toThrow(
        'Page size must be an integer >= 1, got: 2.5'
      );
    });

    it('should reject pageSize greater than maximum (100)', () => {
      const items = Array.from({ length: 200 }, (_, i) => i);
      expect(() => service.paginate(items, { pageSize: 101 })).toThrow(
        'Page size must be <= 100, got: 101'
      );
    });

    it('should reject excessive pageSize (DoS prevention)', () => {
      const items = Array.from({ length: 1000 }, (_, i) => i);
      expect(() => service.paginate(items, { pageSize: 1000 })).toThrow(
        'Page size must be <= 100, got: 1000'
      );
    });
  });

  describe('calculateMetadata - basic functionality', () => {
    it('should calculate metadata with default options', () => {
      const metadata = service.calculateMetadata(100);

      expect(metadata.page).toBe(1);
      expect(metadata.pageSize).toBe(20);
      expect(metadata.totalItems).toBe(100);
      expect(metadata.totalPages).toBe(5);
      expect(metadata.hasNextPage).toBe(true);
      expect(metadata.hasPrevPage).toBe(false);
    });

    it('should calculate metadata for specific page', () => {
      const metadata = service.calculateMetadata(100, { page: 3, pageSize: 25 });

      expect(metadata.page).toBe(3);
      expect(metadata.totalPages).toBe(4);
      expect(metadata.hasNextPage).toBe(true);
      expect(metadata.hasPrevPage).toBe(true);
    });

    it('should calculate metadata for last page', () => {
      const metadata = service.calculateMetadata(100, { page: 4, pageSize: 25 });

      expect(metadata.page).toBe(4);
      expect(metadata.hasNextPage).toBe(false);
      expect(metadata.hasPrevPage).toBe(true);
    });

    it('should calculate metadata with custom page size', () => {
      const metadata = service.calculateMetadata(237, { page: 5, pageSize: 50 });

      expect(metadata.totalPages).toBe(5);
      expect(metadata.hasNextPage).toBe(false);
      expect(metadata.hasPrevPage).toBe(true);
    });
  });

  describe('calculateMetadata - edge cases', () => {
    it('should handle zero items', () => {
      const metadata = service.calculateMetadata(0);

      expect(metadata.totalItems).toBe(0);
      expect(metadata.totalPages).toBe(0);
      expect(metadata.hasNextPage).toBe(false);
      expect(metadata.hasPrevPage).toBe(false);
    });

    it('should handle page beyond data', () => {
      const metadata = service.calculateMetadata(10, { page: 5, pageSize: 25 });

      expect(metadata.page).toBe(5);
      expect(metadata.totalItems).toBe(10);
      expect(metadata.totalPages).toBe(1);
      expect(metadata.hasNextPage).toBe(false);
    });

    it('should handle items not evenly divisible', () => {
      const metadata = service.calculateMetadata(27, { page: 3, pageSize: 10 });

      expect(metadata.totalPages).toBe(3);
      expect(metadata.page).toBe(3);
      expect(metadata.hasNextPage).toBe(false);
    });
  });

  describe('calculateMetadata - validation', () => {
    it('should reject negative total items', () => {
      expect(() => service.calculateMetadata(-1)).toThrow(
        'Total items count must be non-negative'
      );
    });

    it('should reject invalid page number', () => {
      expect(() => service.calculateMetadata(100, { page: 0 })).toThrow(
        'Page number must be an integer >= 1, got: 0'
      );
    });

    it('should reject invalid pageSize', () => {
      expect(() => service.calculateMetadata(100, { pageSize: 0 })).toThrow(
        'Page size must be an integer >= 1, got: 0'
      );
    });

    it('should reject excessive pageSize', () => {
      expect(() => service.calculateMetadata(1000, { pageSize: 200 })).toThrow(
        'Page size must be <= 100, got: 200'
      );
    });
  });

  describe('pagination boundaries - 1-indexed verification', () => {
    it('should use 1-indexed pages (page 1 is first page)', () => {
      const items = Array.from({ length: 50 }, (_, i) => i);
      const result = service.paginate(items, { page: 1, pageSize: 10 });

      expect(result.items[0]).toBe(0);
      expect(result.items[9]).toBe(9);
      expect(result.pagination.page).toBe(1);
    });

    it('should calculate startIndex correctly for page 2', () => {
      const items = Array.from({ length: 50 }, (_, i) => i);
      const result = service.paginate(items, { page: 2, pageSize: 10 });

      // startIndex = (page - 1) * pageSize = (2 - 1) * 10 = 10
      expect(result.items[0]).toBe(10);
      expect(result.items[9]).toBe(19);
    });

    it('should calculate startIndex correctly for page 3', () => {
      const items = Array.from({ length: 50 }, (_, i) => i);
      const result = service.paginate(items, { page: 3, pageSize: 10 });

      // startIndex = (page - 1) * pageSize = (3 - 1) * 10 = 20
      expect(result.items[0]).toBe(20);
      expect(result.items[9]).toBe(29);
    });
  });

  describe('hasNextPage/hasPrevPage logic', () => {
    it('should set hasNextPage=true when more pages exist', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const result = service.paginate(items, { page: 2, pageSize: 25 });

      // endIndex = 50, totalItems = 100, so hasNextPage should be true
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('should set hasNextPage=false on last page', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const result = service.paginate(items, { page: 4, pageSize: 25 });

      // endIndex = 100, totalItems = 100, so hasNextPage should be false
      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should set hasNextPage=false when page beyond data', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const result = service.paginate(items, { page: 5, pageSize: 25 });

      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should set hasPrevPage=false on first page', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const result = service.paginate(items, { page: 1, pageSize: 25 });

      expect(result.pagination.hasPrevPage).toBe(false);
    });

    it('should set hasPrevPage=true when page > 1', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const result = service.paginate(items, { page: 2, pageSize: 25 });

      expect(result.pagination.hasPrevPage).toBe(true);
    });
  });

  describe('CollectionSearch.ts pattern compliance', () => {
    it('should use default pageSize of 20 (Issue #299)', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const result = service.paginate(items);

      expect(result.pagination.pageSize).toBe(20);
    });

    it('should use same max pageSize as CollectionSearch (100)', () => {
      const items = Array.from({ length: 200 }, (_, i) => i);

      expect(() => service.paginate(items, { pageSize: 101 })).toThrow();
      expect(() => service.paginate(items, { pageSize: 100 })).not.toThrow();
    });

    it('should calculate hasNextPage using endIndex < totalItems pattern', () => {
      const items = Array.from({ length: 75 }, (_, i) => i);
      const result = service.paginate(items, { page: 3, pageSize: 25 });

      // page 3, pageSize 25: startIndex = 50, endIndex = 75
      // 75 < 75 is false, so hasNextPage should be false
      expect(result.pagination.hasNextPage).toBe(false);
    });

    it('should calculate hasPrevPage using page > 1 pattern', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);

      const result1 = service.paginate(items, { page: 1 });
      expect(result1.pagination.hasPrevPage).toBe(false);

      const result2 = service.paginate(items, { page: 2 });
      expect(result2.pagination.hasPrevPage).toBe(true);
    });
  });
});
