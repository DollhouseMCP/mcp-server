import type { CollectionIndex, SearchOptions, SearchResults } from '../../../types/collection.js';
import { CollectionElementNotFoundError, isCollectionError } from '../../../collection/CollectionErrors.js';
import type {
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  CONSOLE_PORTFOLIO_ELEMENT_TYPES,
  isConsolePortfolioElementType,
  type ConsolePortfolioElementType,
} from '../../stores/IPortfolioElementStore.js';
import {
  COLLECTION_LIST_DEFAULT_PAGE_SIZE,
  COLLECTION_LIST_MAX_PAGE_SIZE,
  COLLECTION_SEARCH_QUERY_MAX_LENGTH,
  collectionElementNameFromPath,
  collectionElementPath,
  serializeCollectionElementList,
  serializeCollectionIndexEntry,
  type CollectionElementDetailDto,
  type CollectionElementSummaryDto,
} from './CollectionDtos.js';

/**
 * Narrow structural ports over the collection engine (`src/collection/`), so
 * the module depends on behavior rather than the concrete engine classes.
 * `CollectionIndexManager`, `CollectionSearch`, and `PersonaDetails` satisfy
 * these as-is.
 */
export interface CollectionIndexPort {
  getIndex(): Promise<CollectionIndex>;
}

export interface CollectionSearchPort {
  searchCollectionWithOptions(query: string, options: SearchOptions): Promise<SearchResults>;
}

export interface CollectionDetailPort {
  getCollectionContent(path: string): Promise<{ metadata: unknown; content: string }>;
}

export interface CollectionServiceOptions {
  readonly index: CollectionIndexPort;
  readonly search: CollectionSearchPort;
  readonly details: CollectionDetailPort;
  /** Observability hook for engine failures behind the degraded state. */
  readonly reportSourceError?: (error: unknown) => void;
  /**
   * Whether this deployment registers the install route; surfaced on the list
   * DTO (`install_enabled`) so the UI hides Install on browse-only deployments.
   */
  readonly installEnabled?: boolean;
}

// Canonical catalog names are file stems: no separators, no leading dot, so a
// name can never alter the constructed `library/<type>/<name>.md` path shape.
const ELEMENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const DEGRADED_DETAIL = 'The collection catalog is currently unavailable. Showing no elements; this is not an empty collection.';

export class CollectionService {
  private readonly installEnabled: boolean;

  constructor(private readonly options: CollectionServiceOptions) {
    this.installEnabled = options.installEnabled === true;
  }

  async listElements(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    requireConsoleAuthentication(req);
    const type = optionalElementType(req.query.type);
    if (type.kind === 'invalid') return invalidRequest('type query parameter must be a supported element type.');
    const query = optionalSearchQuery(req.query.q);
    if (query.kind === 'invalid') return invalidRequest(`q query parameter must be a non-empty string of at most ${COLLECTION_SEARCH_QUERY_MAX_LENGTH} characters.`);
    const page = positiveIntParam(req.query.page, 1);
    if (page === null) return invalidRequest('page query parameter must be a positive integer.');
    const pageSize = positiveIntParam(req.query.page_size, COLLECTION_LIST_DEFAULT_PAGE_SIZE, COLLECTION_LIST_MAX_PAGE_SIZE);
    if (pageSize === null) return invalidRequest(`page_size query parameter must be a positive integer of at most ${COLLECTION_LIST_MAX_PAGE_SIZE}.`);

    const body = query.value === null
      ? await this.browseList(type.value, page, pageSize)
      : await this.searchList(query.value, type.value, page, pageSize);
    return { status: 200, body };
  }

  async getElement(req: ConsoleRequest, type: string, name: string): Promise<ConsoleHandlerResult> {
    requireConsoleAuthentication(req);
    if (!isConsolePortfolioElementType(type)) {
      return invalidRequest('type path parameter must be a supported element type.');
    }
    if (!ELEMENT_NAME_RE.test(name)) {
      return invalidRequest('name path parameter must be a canonical collection element name.');
    }

    const path = await this.resolveIndexedPath(type, name);
    let fetched: { metadata: unknown; content: string };
    try {
      fetched = await this.options.details.getCollectionContent(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return problem(404, 'collection_element_not_found', 'Not found', 'Collection element was not found.');
      }
      this.options.reportSourceError?.(error);
      return problem(503, 'collection_unavailable', 'Collection unavailable', DEGRADED_DETAIL);
    }

    const metadata = asRecord(fetched.metadata);
    const body: CollectionElementDetailDto = {
      type,
      name,
      display_name: typeof metadata.name === 'string' && metadata.name !== '' ? metadata.name : null,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      version: typeof metadata.version === 'string' ? metadata.version : '',
      author: typeof metadata.author === 'string' ? metadata.author : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      path,
      source: 'collection',
      metadata,
      content: fetched.content,
    };
    return { status: 200, body };
  }

  private async resolveIndexedPath(type: ConsolePortfolioElementType, name: string): Promise<string> {
    try {
      const index = await this.options.index.getIndex();
      const entries = Object.hasOwn(index.index, type) ? index.index[type] : [];
      const indexed = entries.find(entry =>
        collectionElementNameFromPath(entry.path, entry.name) === name
        && isSafeIndexedElementPath(entry.path, type, name));
      if (indexed) return indexed.path;
    } catch {
      // Detail fetching remains available when the index is temporarily down.
    }
    return collectionElementPath(type, name);
  }

  private async browseList(
    type: ConsolePortfolioElementType | undefined,
    page: number,
    pageSize: number,
  ): Promise<unknown> {
    let index: CollectionIndex;
    try {
      index = await this.options.index.getIndex();
    } catch (error) {
      this.options.reportSourceError?.(error);
      return degradedList(page, pageSize, this.installEnabled);
    }

    const types = type ? [type] : CONSOLE_PORTFOLIO_ELEMENT_TYPES;
    const elements: CollectionElementSummaryDto[] = [];
    for (const elementType of types) {
      const entries = Object.hasOwn(index.index, elementType) ? index.index[elementType] : [];
      for (const entry of entries) {
        elements.push(serializeCollectionIndexEntry(entry, elementType));
      }
    }
    const start = (page - 1) * pageSize;
    return serializeCollectionElementList({
      elements: elements.slice(start, start + pageSize),
      total: elements.length,
      page,
      pageSize,
      sourceStatus: 'ok',
      installEnabled: this.installEnabled,
    });
  }

  private async searchList(
    query: string,
    type: ConsolePortfolioElementType | undefined,
    page: number,
    pageSize: number,
  ): Promise<unknown> {
    let results: SearchResults;
    try {
      results = await this.options.search.searchCollectionWithOptions(query, {
        page,
        pageSize,
        elementType: type,
      });
    } catch (error) {
      this.options.reportSourceError?.(error);
      return degradedList(page, pageSize, this.installEnabled);
    }

    return serializeCollectionElementList({
      elements: results.items
        .filter(entry => isConsolePortfolioElementType(entry.type))
        .map(entry => serializeCollectionIndexEntry(entry, entry.type as ConsolePortfolioElementType)),
      total: results.total,
      page: results.page,
      pageSize: results.pageSize,
      // The engine paginates before we drop non-console-type hits, so its own
      // hasMore is the authoritative next-page signal — deriving it from the
      // (unfiltered) total would advertise pages the filtered view can't fill.
      hasMore: results.hasMore,
      sourceStatus: 'ok',
      installEnabled: this.installEnabled,
    });
  }
}

function isSafeIndexedElementPath(
  path: string,
  type: ConsolePortfolioElementType,
  name: string,
): boolean {
  const base = `library/${type}/${name}`;
  return type === 'memories'
    ? path === `${base}.yaml` || path === `${base}.yml`
    : path === `${base}.md`;
}

function degradedList(page: number, pageSize: number, installEnabled: boolean): unknown {
  return serializeCollectionElementList({
    elements: [],
    total: 0,
    page,
    pageSize,
    sourceStatus: 'degraded',
    sourceDetail: DEGRADED_DETAIL,
    installEnabled,
  });
}

function optionalElementType(value: unknown):
  | { readonly kind: 'valid'; readonly value: ConsolePortfolioElementType | undefined }
  | { readonly kind: 'invalid' } {
  if (value === undefined) return { kind: 'valid', value: undefined };
  if (typeof value === 'string' && isConsolePortfolioElementType(value)) {
    return { kind: 'valid', value };
  }
  return { kind: 'invalid' };
}

function optionalSearchQuery(value: unknown):
  | { readonly kind: 'valid'; readonly value: string | null }
  | { readonly kind: 'invalid' } {
  if (value === undefined) return { kind: 'valid', value: null };
  if (typeof value !== 'string') return { kind: 'invalid' };
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > COLLECTION_SEARCH_QUERY_MAX_LENGTH) return { kind: 'invalid' };
  return { kind: 'valid', value: trimmed };
}

function positiveIntParam(value: unknown, fallback: number, max?: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || (max !== undefined && parsed > max)) return null;
  return parsed;
}

function isNotFoundError(error: unknown): boolean {
  // Typed check first (cause-chain-aware, so the GitHub client's McpError
  // wrapper doesn't hide the type); message fallback as belt-and-braces.
  return isCollectionError(error, CollectionElementNotFoundError) ||
    (error instanceof Error && error.message.includes('File not found in collection'));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function invalidRequest(detail: string): ConsoleHandlerResult {
  return problem(400, 'invalid_request', 'Invalid request', detail);
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}
