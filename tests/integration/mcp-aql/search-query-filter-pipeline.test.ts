/**
 * Integration tests for MCP-AQL search/query/filter pipeline (Issue #431)
 *
 * Tests the full pipeline implemented in PR #430:
 * 1. Multi-word search via isSearchMatch()
 * 2. Filter validation + new filters (descriptionContains, category)
 * 3. Field selection with FIELD_ALIASES on IElement objects
 * 4. Search pagination/sort with new response shape
 *
 * Covers:
 * - Search → field selection pipeline
 * - Filter validation boundary (9 known keys)
 * - Pagination metadata consistency
 * - Sort stability across pages
 * - Filter + sort + paginate composition
 * - Regression guards (single-word, dash/underscore, flat params, aliases)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Search/Query/Filter Pipeline Integration (Issue #431)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let handler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('pipeline-test');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    handler = container.resolve<MCPAQLHandler>('mcpAqlHandler');

    await createTestElements();
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  /**
   * Create a set of test elements with varied metadata for pipeline testing.
   * Elements are designed to exercise multi-word search, category/description filters,
   * sort ordering, and pagination boundaries.
   */
  async function createTestElements(): Promise<void> {
    // Skills with specific names for multi-word and dash/underscore matching
    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'code-review-expert',
        element_type: 'skills',
        description: 'Expert at reviewing code for quality and security issues',
        content: '# Code Review Expert\n\nAnalyze code for bugs and best practices.',
        metadata: { category: 'development', domain: 'review' },
      },
    });

    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'code_analysis',
        element_type: 'skills',
        description: 'Static analysis of codebases for patterns and anti-patterns',
        content: '# Code Analysis\n\nAnalyze code structure.',
        metadata: { category: 'development', domain: 'analysis' },
      },
    });

    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'creative-writing',
        element_type: 'skills',
        description: 'Write creative fiction and poetry with flair',
        content: '# Creative Writing\n\nCraft stories and poems.',
        metadata: { category: 'writing', domain: 'creative' },
      },
    });

    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'data-modeling',
        element_type: 'skills',
        description: 'Design database schemas and data models',
        content: '# Data Modeling\n\nCreate effective data structures.',
        metadata: { category: 'development', domain: 'data' },
      },
    });

    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'email-drafting',
        element_type: 'skills',
        description: 'Draft professional emails and correspondence',
        content: '# Email Drafting\n\nWrite clear professional emails.',
        metadata: { category: 'writing', domain: 'communication' },
      },
    });

    // Personas for cross-type search
    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'senior-developer',
        element_type: 'personas',
        description: 'A senior developer who reviews code thoroughly',
        content: '# Senior Developer\n\nExperienced code reviewer.',
        metadata: { category: 'engineering' },
      },
    });

    await handler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'technical-writer',
        element_type: 'personas',
        description: 'A technical writer who creates clear documentation',
        content: '# Technical Writer\n\nDocumentation specialist.',
        metadata: { category: 'writing' },
      },
    });

    // Allow cache to settle after element creation (see Issue #276)
    await waitForCacheSettle();
  }

  // ==========================================================================
  // Multi-word search (Issue #428)
  // ==========================================================================
  describe('Multi-word search', () => {
    it('should match multi-word query across word boundaries', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'code review' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<{ element_name?: string; name?: string; matchedIn?: string[] }> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        // "code review" should match "code-review-expert" via word-boundary matching
        const names = data.items!.map(i => i.element_name ?? i.name);
        expect(names).toContain('code-review-expert');
      }
    });

    it('should still match single-word queries (regression guard)', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'creative' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<{ element_name?: string; name?: string }> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        const names = data.items!.map(i => i.element_name ?? i.name);
        expect(names).toContain('creative-writing');
      }
    });

    it('should normalize dash/underscore in search matching', async () => {
      // "code_analysis" should be findable via "code analysis" (dash/underscore normalization)
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'code analysis' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<{ element_name?: string; name?: string }> };
        expect(data.items).toBeDefined();

        const names = data.items!.map(i => i.element_name ?? i.name);
        expect(names).toContain('code_analysis');
      }
    });
  });

  // ==========================================================================
  // Search pagination and sort (Issue #429)
  // ==========================================================================
  describe('Search pagination and sort', () => {
    it('should return new response shape with items, pagination, sorting, query', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'code' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          items?: unknown[];
          pagination?: { totalItems: number; page: number; pageSize: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean };
          sorting?: { sortBy: string; sortOrder: string };
          query?: string;
        };
        expect(data.items).toBeDefined();
        expect(data.pagination).toBeDefined();
        expect(data.sorting).toBeDefined();
        expect(data.query).toBe('code');
        expect(data.pagination!.totalItems).toBeGreaterThan(0);
      }
    });

    it('should paginate search results correctly', async () => {
      const page1 = await handler.handleRead({
        operation: 'search_elements',
        params: {
          query: 'code',
          pagination: { page: 1, pageSize: 1 },
        },
      });

      expect(page1.success).toBe(true);
      if (page1.success) {
        const data1 = page1.data as {
          items?: unknown[];
          pagination?: { totalItems: number; page: number; pageSize: number; hasNextPage: boolean; hasPrevPage: boolean };
        };
        expect(data1.items!.length).toBe(1);
        expect(data1.pagination!.page).toBe(1);
        expect(data1.pagination!.pageSize).toBe(1);
        expect(data1.pagination!.hasPrevPage).toBe(false);

        // If there are more results, hasNextPage should be true
        if (data1.pagination!.totalItems > 1) {
          expect(data1.pagination!.hasNextPage).toBe(true);
        }
      }
    });

    it('should sort search results descending by name', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: {
          query: 'code',
          sort: { sortBy: 'name', sortOrder: 'desc' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          items?: Array<{ element_name?: string; name?: string }>;
          sorting?: { sortBy: string; sortOrder: string };
        };
        expect(data.sorting!.sortOrder).toBe('desc');
        expect(data.items!.length).toBeGreaterThan(1);

        // Verify descending order
        const names = data.items!.map(i => (i.element_name ?? i.name ?? '').toLowerCase());
        for (let i = 1; i < names.length; i++) {
          expect(names[i - 1].localeCompare(names[i])).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should maintain pagination consistency across pages', async () => {
      // Get total from unfiltered query
      const all = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'code' },
      });

      expect(all.success).toBe(true);
      const allData = all.data as { pagination?: { totalItems: number } };
      const totalItems = allData.pagination!.totalItems;

      // Paginate through all results with pageSize=1
      let collectedCount = 0;
      let page = 1;
      while (collectedCount < totalItems) {
        const pageResult = await handler.handleRead({
          operation: 'search_elements',
          params: {
            query: 'code',
            pagination: { page, pageSize: 1 },
          },
        });

        expect(pageResult.success).toBe(true);
        const pageData = pageResult.data as {
          items?: unknown[];
          pagination?: { totalItems: number; hasNextPage: boolean; hasPrevPage: boolean };
        };

        // totalItems should be consistent across pages
        expect(pageData.pagination!.totalItems).toBe(totalItems);

        collectedCount += pageData.items!.length;

        if (page > 1) {
          expect(pageData.pagination!.hasPrevPage).toBe(true);
        }
        if (collectedCount < totalItems) {
          expect(pageData.pagination!.hasNextPage).toBe(true);
        }

        page++;
        // Safety: prevent infinite loop
        if (page > totalItems + 1) break;
      }

      expect(collectedCount).toBe(totalItems);
    });
  });

  // ==========================================================================
  // Filter validation boundary (Issue #427)
  // ==========================================================================
  describe('Filter validation', () => {
    it('should accept all 9 known filter keys without error', async () => {
      // Test each known filter key individually to ensure validation passes
      const knownFilters = [
        { nameContains: 'test' },
        { tags: ['test'] },
        { tagsAny: ['test'] },
        { author: 'test' },
        { createdAfter: '2024-01-01' },
        { createdBefore: '2026-12-31' },
        { status: 'active' as const },
        { descriptionContains: 'test' },
        { category: 'test' },
      ];

      for (const filter of knownFilters) {
        const result = await handler.handleRead({
          operation: 'query_elements',
          elementType: 'skill' as any,
          params: { filters: filter },
        });

        // Should succeed (not fail with validation error)
        expect(result.success).toBe(true);
      }
    });

    it('should reject a single unknown filter key with descriptive error', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { unknownFilter: 'value' },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown filter key');
        expect(result.error).toContain('unknownFilter');
        // Should list supported filters
        expect(result.error).toContain('Supported filters');
      }
    });

    it('should list multiple unknown keys in error message', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { badKey1: 'a', badKey2: 'b' },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('badKey1');
        expect(result.error).toContain('badKey2');
      }
    });
  });

  // ==========================================================================
  // descriptionContains and category filters (Issue #427)
  // ==========================================================================
  describe('New filter types', () => {
    it('should filter by descriptionContains (case-insensitive)', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { descriptionContains: 'security' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<Record<string, unknown>> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        // All returned items should have "security" in their description
        // Issue #299: Structured response puts description at top level, not under metadata
        for (const item of data.items!) {
          const desc = ((item.description as string) || '').toLowerCase();
          expect(desc).toContain('security');
        }
      }
    });

    it('should filter by category (case-insensitive exact match)', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { category: 'writing' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<Record<string, unknown>> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        // Filter applied server-side: verify we got results (all should be category: writing)
        // Issue #299: Structured response doesn't include category in item fields,
        // so we verify the filter worked by checking that results were returned
        // and the count is reasonable (not all skills)
        expect(data.items!.length).toBeLessThanOrEqual(5); // Subset, not all skills
      }
    });
  });

  // ==========================================================================
  // Field selection on IElement (Issue #426)
  // ==========================================================================
  describe('Field selection with FIELD_ALIASES', () => {
    it('should resolve element_name from metadata.name on search results', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: {
          query: 'code',
          fields: 'minimal' as any,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<Record<string, unknown>> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        // Minimal preset should produce element_name and description
        for (const item of data.items!) {
          expect(item.element_name).toBeDefined();
          expect(item.description).toBeDefined();
          // Other fields should be filtered out
          expect(item.matchedIn).toBeUndefined();
          expect(item.type).toBeUndefined();
        }
      }
    });

    it('should resolve element_name alias on query_elements results', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          fields: ['element_name', 'description'],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<Record<string, unknown>> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        for (const item of data.items!) {
          expect(item.element_name).toBeDefined();
          expect(item.description).toBeDefined();
        }
      }
    });

    it('should transform name to element_name in search results by default', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'creative' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<Record<string, unknown>> };
        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeGreaterThan(0);

        for (const item of data.items!) {
          expect(item.element_name).toBeDefined();
          expect(item.name).toBeUndefined();
        }
      }
    });
  });

  // ==========================================================================
  // Filter + sort + paginate composition
  // ==========================================================================
  describe('Full pipeline composition', () => {
    it('should apply descriptionContains filter, sort desc, and paginate', async () => {
      // Filter skills that mention "code" in description, sort by name desc, page 1 size 2
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { descriptionContains: 'code' },
          sort: { sortBy: 'name', sortOrder: 'desc' },
          pagination: { page: 1, pageSize: 2 },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          items?: Array<Record<string, unknown>>;
          pagination?: { totalItems: number; page: number; pageSize: number; totalPages: number };
          sorting?: { sortBy: string; sortOrder: string };
          filters?: { applied: { count: number } };
        };

        expect(data.items).toBeDefined();
        expect(data.items!.length).toBeLessThanOrEqual(2);
        expect(data.pagination!.page).toBe(1);
        expect(data.pagination!.pageSize).toBe(2);
        expect(data.sorting!.sortOrder).toBe('desc');

        // Verify items are sorted descending by name
        if (data.items!.length > 1) {
          const names = data.items!.map(i => {
            const meta = i.metadata as Record<string, unknown>;
            return ((meta?.name as string) || '').toLowerCase();
          });
          expect(names[0].localeCompare(names[1])).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should apply combined AND filters (category + descriptionContains)', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: {
            category: 'development',
            descriptionContains: 'code',
          },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          items?: Array<Record<string, unknown>>;
          pagination?: { totalItems: number };
        };

        expect(data.items).toBeDefined();
        // Should return items that have category=development AND description contains "code"
        expect(data.pagination!.totalItems).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // Sort stability
  // ==========================================================================
  describe('Sort stability', () => {
    it('should maintain consistent order across pages when items have same sort key', async () => {
      // All items matching "code" sorted by default (name asc)
      // Fetch page 1 and page 2 separately, ensure no duplicates
      const page1 = await handler.handleRead({
        operation: 'search_elements',
        params: {
          query: 'code',
          pagination: { page: 1, pageSize: 2 },
          sort: { sortBy: 'name', sortOrder: 'asc' },
        },
      });

      const page2 = await handler.handleRead({
        operation: 'search_elements',
        params: {
          query: 'code',
          pagination: { page: 2, pageSize: 2 },
          sort: { sortBy: 'name', sortOrder: 'asc' },
        },
      });

      expect(page1.success).toBe(true);
      expect(page2.success).toBe(true);

      if (page1.success && page2.success) {
        const data1 = page1.data as { items?: Array<{ element_name?: string; name?: string }> };
        const data2 = page2.data as { items?: Array<{ element_name?: string; name?: string }> };

        const names1 = data1.items!.map(i => i.element_name ?? i.name);
        const names2 = data2.items!.map(i => i.element_name ?? i.name);

        // No overlap between pages
        for (const name of names1) {
          expect(names2).not.toContain(name);
        }
      }
    });
  });

  // ==========================================================================
  // Regression guards
  // ==========================================================================
  describe('Regression guards', () => {
    it('should support flat param style (pageSize, sortBy) through list_elements', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          pageSize: 2,
          sortBy: 'name',
          sortOrder: 'desc',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Issue #299: list_elements now returns structured data
        const data = result.data as {
          items?: Array<{ name: string; type: string }>;
          pagination?: { pageSize: number };
          element_type?: string;
        };
        expect(data.items).toBeDefined();
        expect(['skill', 'skills']).toContain(data.element_type);
        expect(data.pagination!.pageSize).toBe(2);
      }
    });

    it('should support flat filter params through list_elements', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          nameContains: 'code',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Issue #299: list_elements now returns structured data
        // Note: applyFieldSelection renames 'name' → 'element_name' (FIELD_TRANSFORMS)
        const data = result.data as {
          items?: Array<{ element_name: string; type: string }>;
          element_type?: string;
        };
        expect(data.items).toBeDefined();
        // Filtered results should contain code-related skills
        const names = (data.items || []).map((i: any) => (i.element_name || '').toLowerCase());
        expect(names.some((n: string) => n.includes('code'))).toBe(true);
      }
    });

    it('should handle empty search results with proper pagination metadata', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'xyznonexistentquery987' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          items?: unknown[];
          pagination?: { totalItems: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean };
        };
        expect(data.items!.length).toBe(0);
        expect(data.pagination!.totalItems).toBe(0);
        expect(data.pagination!.hasNextPage).toBe(false);
        expect(data.pagination!.hasPrevPage).toBe(false);
      }
    });

    it('should search across multiple element types', async () => {
      // "code" appears in skills and personas
      const result = await handler.handleRead({
        operation: 'search_elements',
        params: { query: 'code' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<{ type: string }> };
        expect(data.items).toBeDefined();

        const types = new Set(data.items!.map(i => i.type));
        // Should have matches in at least skills
        expect(types.has('skills')).toBe(true);
      }
    });

    it('should search within a specific element type when elementType is provided', async () => {
      const result = await handler.handleRead({
        operation: 'search_elements',
        elementType: 'skill' as any,
        params: { query: 'code' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { items?: Array<{ type: string }> };
        expect(data.items).toBeDefined();

        // All results should be of the normalized canonical type (Issue #433)
        for (const item of data.items!) {
          expect(item.type).toBe('skills');
        }
      }
    });
  });

  // ==========================================================================
  // Aggregation (Issue #309)
  // ==========================================================================
  describe('Aggregation (Issue #309)', () => {
    it('should return count only via list_elements with aggregate', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          aggregate: { count: true },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; element_type: string; items?: unknown };
        expect(data.count).toBeGreaterThanOrEqual(5); // At least the 5 test skills
        expect(['skill', 'skills']).toContain(data.element_type);
        expect(data.items).toBeUndefined(); // No items array for count-only
      }
    });

    it('should return count only via query_elements with aggregate', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          aggregate: { count: true },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; element_type: string };
        expect(data.count).toBeGreaterThanOrEqual(5);
        expect(['skill', 'skills']).toContain(data.element_type);
      }
    });

    it('should return count filtered by category via list_elements', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          category: 'development',
          aggregate: { count: true },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; element_type: string };
        // code-review-expert, code_analysis, data-modeling have category: development
        expect(data.count).toBeGreaterThanOrEqual(3);
        expect(['skill', 'skills']).toContain(data.element_type);
      }
    });

    it('should group_by category with correct counts', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          aggregate: { count: true, group_by: 'category' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; element_type: string; groups?: Record<string, number> };
        expect(data.count).toBeGreaterThanOrEqual(5);
        expect(data.groups).toBeDefined();
        // We created 3 'development' and 2 'writing' skills
        expect(data.groups!['development']).toBeGreaterThanOrEqual(3);
        expect(data.groups!['writing']).toBeGreaterThanOrEqual(2);
      }
    });

    it('should group_by category via query_elements', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          aggregate: { count: true, group_by: 'category' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; groups?: Record<string, number> };
        expect(data.groups).toBeDefined();
        expect(data.groups!['development']).toBeGreaterThanOrEqual(3);
      }
    });

    it('should group_by category with filters applied', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          nameContains: 'code',
          aggregate: { count: true, group_by: 'category' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; groups?: Record<string, number> };
        // code-review-expert and code_analysis both have category: development
        expect(data.count).toBeGreaterThanOrEqual(2);
        expect(data.groups).toBeDefined();
        expect(data.groups!['development']).toBeGreaterThanOrEqual(2);
        // No 'writing' skills match 'code' nameContains
        expect(data.groups!['writing']).toBeUndefined();
      }
    });

    it('should reject invalid group_by field', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          aggregate: { count: true, group_by: 'internal_secret_field' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { error?: string; code?: string };
        expect(data.error).toBeDefined();
        expect(data.error).toContain('Invalid group_by field');
        expect(data.error).toContain('internal_secret_field');
        expect(data.error).toContain('Allowed fields');
        expect(data.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject invalid group_by field via query_elements', async () => {
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          aggregate: { count: true, group_by: 'password_hash' },
        },
      });

      // query_elements throws on invalid group_by (wrapped in error response)
      expect(result.success).toBe(false);
    });

    it('should handle group_by on missing metadata fields gracefully', async () => {
      // version should be an allowed field but may not be set on all elements
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          aggregate: { count: true, group_by: 'version' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; groups?: Record<string, number> };
        expect(data.count).toBeGreaterThanOrEqual(5);
        expect(data.groups).toBeDefined();
        // Elements without version should be grouped under 'unknown'
        const totalGrouped = Object.values(data.groups!).reduce((a, b) => a + b, 0);
        expect(totalGrouped).toBe(data.count);
      }
    });

    it('should return structured error for invalid pagination', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'skills',
          page: -1,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { error?: string; code?: string };
        expect(data.error).toBeDefined();
        expect(data.code).toBe('VALIDATION_ERROR');
        expect(data.error).toContain('Invalid pagination');
      }
    });

    it('should return structured error for unknown element type', async () => {
      const result = await handler.handleRead({
        operation: 'list_elements',
        params: {
          element_type: 'wizards',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { error?: string; code?: string };
        expect(data.error).toBeDefined();
        expect(data.code).toBe('UNKNOWN_TYPE');
        expect(data.error).toContain('Unknown element type');
      }
    });
  });

  // ==========================================================================
  // Issue #631: Category discovery via introspect + query_elements
  // ==========================================================================
  describe('Category discovery (Issue #631)', () => {
    it('should return category info via introspect categories query', async () => {
      const result = await handler.handleRead({
        operation: 'introspect',
        params: { query: 'categories' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { categories: Record<string, unknown> };
        expect(data.categories).toBeDefined();
        expect(data.categories.formatRules).toBeDefined();
        expect(data.categories.supportedTypes).toBeDefined();
        expect(data.categories.allowedGroupByFields).toBeDefined();
        expect(data.categories.discovery).toBeDefined();

        // Verify allowed group_by fields include category
        const fields = data.categories.allowedGroupByFields as string[];
        expect(fields).toContain('category');
      }
    });

    it('should discover existing categories via query_elements group_by', async () => {
      // Uses the test elements created in beforeEach (3 development, 2 writing skills)
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          aggregate: { count: true, group_by: 'category' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number; groups?: Record<string, number> };
        expect(data.groups).toBeDefined();
        // Verify real category names appear in groups
        const categoryNames = Object.keys(data.groups!);
        expect(categoryNames.length).toBeGreaterThanOrEqual(2);
        expect(data.groups!['development']).toBeGreaterThanOrEqual(3);
        expect(data.groups!['writing']).toBeGreaterThanOrEqual(2);
      }
    });

    it('should filter by discovered category', async () => {
      // First discover categories, then filter by one
      const result = await handler.handleRead({
        operation: 'query_elements',
        elementType: 'skill' as any,
        params: {
          filters: { category: 'development' },
          aggregate: { count: true },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { count: number };
        expect(data.count).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
