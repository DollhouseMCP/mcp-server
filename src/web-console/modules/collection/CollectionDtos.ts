import type { IndexEntry } from '../../../types/collection.js';
import type { ConsolePortfolioElementType } from '../../stores/IPortfolioElementStore.js';

export const COLLECTION_LIST_DEFAULT_PAGE_SIZE = 50;
export const COLLECTION_LIST_MAX_PAGE_SIZE = 100;
export const COLLECTION_SEARCH_QUERY_MAX_LENGTH = 200;

// Catalog file extension per element type. Memories are stored as YAML across
// DollhouseMCP (matching each element manager's getFileExtension()); every
// other type is Markdown. Used to reconstruct a catalog path from a bare
// type+name and to strip the correct suffix off a catalog basename.
const COLLECTION_TYPE_EXTENSIONS: Readonly<Record<ConsolePortfolioElementType, string>> = {
  personas: '.md',
  skills: '.md',
  templates: '.md',
  agents: '.md',
  memories: '.yaml',
  ensembles: '.md',
};

export function collectionFileExtension(type: ConsolePortfolioElementType): string {
  return COLLECTION_TYPE_EXTENSIONS[type];
}

/** Catalog path for a bare type+canonical-name, honoring the per-type extension. */
export function collectionElementPath(type: ConsolePortfolioElementType, name: string): string {
  return `library/${type}/${name}${collectionFileExtension(type)}`;
}

/**
 * `ok` — the catalog index was served (from cache or a fresh fetch).
 * `degraded` — the index and its fallbacks were unreachable; the response is
 * an intentional empty listing, not "the collection is empty". The UI renders
 * a distinct unavailable state from this, and deploy smoke tests assert on it.
 */
export type CollectionSourceStatus = 'ok' | 'degraded';

export interface CollectionElementSummaryDto {
  readonly type: ConsolePortfolioElementType;
  /** Canonical element name (catalog file stem), used in detail-route paths. */
  readonly name: string;
  readonly display_name: string | null;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly tags: readonly string[];
  /** Catalog path (`library/<type>/<file>.md`) — install input in later slices. */
  readonly path: string;
  readonly source: 'collection';
}

export interface CollectionElementDetailDto extends CollectionElementSummaryDto {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
}

export interface CollectionElementListDto {
  readonly elements: readonly CollectionElementSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
  readonly has_more: boolean;
  readonly source_status: CollectionSourceStatus;
  readonly source_detail: string | null;
  /**
   * Whether this deployment registers the install route (collection AND
   * portfolio-write flags both on). Lets the UI hide Install affordances on
   * browse-only deployments instead of offering a button that can only 404.
   */
  readonly install_enabled: boolean;
}

/**
 * Canonical element name from a catalog path: the file stem of the last
 * segment (`library/personas/code-review.md` → `code-review`,
 * `library/memories/guide.yaml` → `guide`). Falls back to the entry name when
 * the path has no usable basename.
 */
export function collectionElementNameFromPath(path: string, fallback: string): string {
  const basename = path.split('/').pop() ?? '';
  const stem = stripCatalogExtension(basename);
  return stem === '' ? fallback : stem;
}

function stripCatalogExtension(basename: string): string {
  for (const extension of ['.md', '.yaml', '.yml']) {
    if (basename.endsWith(extension)) return basename.slice(0, -extension.length);
  }
  return basename;
}

export function serializeCollectionIndexEntry(
  entry: IndexEntry,
  type: ConsolePortfolioElementType,
): CollectionElementSummaryDto {
  return {
    type,
    name: collectionElementNameFromPath(entry.path, entry.name),
    display_name: entry.name === '' ? null : entry.name,
    description: entry.description,
    version: entry.version,
    author: entry.author,
    tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
    path: entry.path,
    source: 'collection',
  };
}

export function serializeCollectionElementList(input: {
  readonly elements: readonly CollectionElementSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly sourceStatus: CollectionSourceStatus;
  readonly sourceDetail?: string;
  /**
   * Authoritative "another page exists" signal. Pass it when the caller
   * paginates upstream and post-filters this page (the engine total may then
   * exceed the visible count, so deriving has_more from total would overstate).
   * Omit it when the caller holds the full result set and slices it locally.
   */
  readonly hasMore?: boolean;
  readonly installEnabled: boolean;
}): CollectionElementListDto {
  return {
    elements: input.elements,
    total: input.total,
    page: input.page,
    page_size: input.pageSize,
    has_more: input.hasMore ?? input.page * input.pageSize < input.total,
    source_status: input.sourceStatus,
    source_detail: input.sourceDetail ?? null,
    install_enabled: input.installEnabled,
  };
}
