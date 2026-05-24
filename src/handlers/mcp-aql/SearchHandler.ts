import { isSearchMatch } from '../../utils/searchUtils.js';
import { PaginationService } from '../../services/query/PaginationService.js';
import { normalizeElementType, ALL_ELEMENT_TYPES, formatElementTypesList } from '../../utils/elementTypeNormalization.js';
import { aggregateElements, validateAggregationOptions } from '../../services/query/AggregationService.js';
import type { IElement } from '../../types/elements/IElement.js';
import { logger } from '../../utils/logger.js';
import type { OperationInput } from './types.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import { normalizePaginationParams, resolveInputElementType } from './shared.js';

interface SearchResult {
  type: string;
  name: string;
  description: string;
  matchedIn: string[];
}

export class SearchHandler {
  constructor(private readonly handlers: HandlerRegistry) {}

  async dispatch(method: string, input: OperationInput): Promise<unknown> {
    switch (method) {
      case 'search':
        return this.searchElements(input);
      case 'query':
        return this.queryElements(input);
      default:
        throw new Error(`Unknown Search method: ${method}`);
    }
  }

  private async queryElements(input: OperationInput): Promise<unknown> {
    const elementType = resolveInputElementType(input);
    const { params } = input;
    if (!elementType) {
      throw new Error('element_type is required for query_elements operation');
    }

    const elements = (await this.handlers.elementCRUD.getElements(elementType)) as IElement[];
    const p = params as Record<string, unknown>;
    const queryOptions = this.buildQueryOptions(p);

    if (p.aggregate) {
      return this.aggregateQuery(elements, elementType, p.aggregate, queryOptions.filters);
    }

    queryOptions.pagination = normalizePaginationParams(p);
    const queryResult = this.handlers.elementQueryService.query(elements, queryOptions);

    return {
      items: queryResult.items.map((item: IElement) => ({
        name: item.metadata?.name || 'Unknown',
        description: item.metadata?.description || '',
        type: elementType,
        version: item.metadata?.version || item.version,
        tags: item.metadata?.tags,
      })),
      pagination: queryResult.pagination,
      sorting: queryResult.sorting,
      filters: queryResult.filters.applied.count > 0 ? { applied: queryResult.filters.applied } : undefined,
      element_type: elementType,
    };
  }

  private buildQueryOptions(p: Record<string, unknown>): {
    filters?: Record<string, unknown>;
    sort?: Record<string, unknown>;
    pagination?: Record<string, unknown>;
    aggregate?: Record<string, unknown>;
  } {
    return {
      ...(p.filters ? { filters: p.filters as Record<string, unknown> } : {}),
      ...(p.sort ? { sort: p.sort as Record<string, unknown> } : {}),
      ...(p.pagination ? { pagination: p.pagination as Record<string, unknown> } : {}),
    };
  }

  private aggregateQuery(
    elements: IElement[],
    elementType: string,
    aggregateInput: unknown,
    filters?: Record<string, unknown>
  ): unknown {
    const aggregate = aggregateInput as { count?: boolean; group_by?: string };
    const aggError = validateAggregationOptions(aggregate);
    if (aggError) {
      throw new Error(aggError);
    }
    return aggregateElements(elements, elementType, aggregate, filters as any);
  }

  private async searchElements(input: OperationInput): Promise<unknown> {
    const searchStart = performance.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    const elementType = resolveInputElementType(input);
    const { params } = input;
    const p = params as Record<string, unknown>;
    const query = (p.query as string)?.trim();
    this.validateQuery(query);

    const { page, pageSize } = normalizePaginationParams(p);
    const sortParam = p.sort as { sortBy?: string; sortOrder?: string } | undefined;
    const sortBy = sortParam?.sortBy ?? 'name';
    const sortOrder = (sortParam?.sortOrder ?? 'asc') as 'asc' | 'desc';
    const elementTypes = this.resolveSearchElementTypes(elementType);
    const allResults = await this.collectMatches(elementTypes, query);

    this.handlers.performanceMonitor?.recordSearch({
      query,
      duration: performance.now() - searchStart,
      resultCount: allResults.length,
      sources: elementTypes,
      cacheHit: false,
      memoryBefore,
      memoryAfter: process.memoryUsage().heapUsed,
      timestamp: new Date(),
    });

    const sortedResults = this.sortResults(allResults, sortOrder);
    const paginator = new PaginationService();
    const paginated = paginator.paginate(sortedResults, { page, pageSize });

    return {
      items: paginated.items,
      pagination: paginated.pagination,
      sorting: { sortBy, sortOrder },
      query,
    };
  }

  private validateQuery(query: string | undefined): asserts query is string {
    if (!query) {
      throw new Error('Search query is required');
    }
    if (query.length > 1000) {
      throw new Error('Search query must be under 1000 characters');
    }
  }

  private resolveSearchElementTypes(elementType: string | undefined): string[] {
    if (!elementType) {
      return [...ALL_ELEMENT_TYPES];
    }
    const normalized = normalizeElementType(elementType);
    if (!normalized) {
      throw new Error(`Invalid element type '${elementType}'. Valid types: ${formatElementTypesList()}`);
    }
    return [normalized];
  }

  private async collectMatches(elementTypes: string[], query: string): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    for (const type of elementTypes) {
      const matches = await this.collectTypeMatches(type, query);
      allResults.push(...matches);
    }
    return allResults;
  }

  private async collectTypeMatches(type: string, query: string): Promise<SearchResult[]> {
    try {
      const elements = await this.handlers.elementCRUD.getElements(type);
      return (elements as Array<Record<string, unknown>>)
        .map((element) => this.matchElement(type, element, query))
        .filter((match): match is SearchResult => match !== undefined);
    } catch (error) {
      logger.debug(`Failed to load elements for search: ${type}`, { error });
      return [];
    }
  }

  private matchElement(type: string, element: Record<string, unknown>, query: string): SearchResult | undefined {
    const matchedIn = this.getMatchedFields(element, query);
    if (matchedIn.length === 0) {
      return undefined;
    }
    const metadata = (element.metadata as Record<string, unknown>) || {};
    return {
      type,
      name: (metadata.name as string) || '',
      description: (metadata.description as string) || '',
      matchedIn,
    };
  }

  private getMatchedFields(element: Record<string, unknown>, query: string): string[] {
    const metadata = (element.metadata as Record<string, unknown>) || {};
    const checks = [
      ['name', metadata.name],
      ['description', metadata.description],
      ['content', element.content],
    ] as const;
    return checks
      .filter(([, value]) => typeof value === 'string' && value && isSearchMatch(query, value))
      .map(([field]) => field);
  }

  private sortResults(results: SearchResult[], sortOrder: 'asc' | 'desc'): SearchResult[] {
    return [...results].sort((a, b) => {
      const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return sortOrder === 'desc' ? -cmp : cmp;
    });
  }
}
