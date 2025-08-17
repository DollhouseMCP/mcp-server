/**
 * Type definitions for collection functionality
 */

export interface CollectionContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  download_url: string;
  html_url: string;
}

export interface CollectionSearchResult {
  path: string;
  html_url: string;
  repository: {
    full_name: string;
  };
  text_matches?: Array<{
    fragment: string;
    property: string;
  }>;
}

// Collection Index Types
export interface IndexEntry {
  path: string;
  type: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  sha: string;
  category?: string;
  created: string;
  license?: string;
}

export interface CollectionIndex {
  version: string;
  generated: string;
  total_elements: number;
  index: {
    [elementType: string]: IndexEntry[];
  };
  metadata: {
    build_time_ms: number;
    file_count: number;
    skipped_files: number;
    categories: number;
    nodejs_version: string;
    builder_version: string;
  };
}

export interface CachedIndex {
  data: CollectionIndex;
  fetchedAt: Date;
  etag?: string;
  lastModified?: string;
}

export interface SearchResults {
  items: IndexEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  query: string;
  searchTime: number;
}

export interface SearchOptions {
  page?: number;
  pageSize?: number;
  elementType?: string;
  sortBy?: 'relevance' | 'name' | 'date';
  category?: string;
}