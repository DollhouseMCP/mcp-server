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