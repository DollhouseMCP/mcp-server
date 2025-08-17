/**
 * Search for content in the collection
 */

import { GitHubClient } from './GitHubClient.js';
import { CollectionCache, CollectionItem } from '../cache/CollectionCache.js';
import { CollectionIndexCache } from '../cache/CollectionIndexCache.js';
import { CollectionSeeder } from './CollectionSeeder.js';
import { logger } from '../utils/logger.js';
import { normalizeSearchTerm, validateSearchQuery, isSearchMatch, debugNormalization } from '../utils/searchUtils.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { IndexEntry, SearchResults, SearchOptions, CollectionIndex } from '../types/collection.js';

export class CollectionSearch {
  private githubClient: GitHubClient;
  private collectionCache: CollectionCache;
  private indexCache: CollectionIndexCache;
  private searchBaseUrl = 'https://api.github.com/search/code';
  
  constructor(githubClient: GitHubClient, collectionCache?: CollectionCache) {
    this.githubClient = githubClient;
    this.collectionCache = collectionCache || new CollectionCache();
    this.indexCache = new CollectionIndexCache(githubClient);
  }
  
  /**
   * Enhanced search using collection index with pagination and filtering
   * Falls back to API search and cache when index is unavailable
   */
  async searchCollectionWithOptions(query: string, options: SearchOptions = {}): Promise<SearchResults> {
    const startTime = Date.now();
    logger.debug(`CollectionSearch.searchCollectionWithOptions called with query: "${query}"`, options);
    
    // Validate search query for security
    try {
      validateSearchQuery(query, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Search query validation failed:', { query, error: errorMessage });
      ErrorHandler.logError('CollectionSearch.searchWithOptions.validateQuery', error, { query });
      return this.createEmptySearchResults(query, options);
    }
    
    try {
      // Try index-based search first
      const indexResults = await this.searchFromIndex(query, options);
      const searchTime = Date.now() - startTime;
      
      logger.debug(`Index search completed in ${searchTime}ms with ${indexResults.items.length} results`);
      return { ...indexResults, searchTime };
    } catch (error) {
      logger.debug('Index search failed, falling back to legacy search:', error);
      
      // Fallback to legacy search
      const legacyResults = await this.searchCollection(query);
      const searchTime = Date.now() - startTime;
      
      // Convert legacy results to new format
      return this.convertLegacyResults(legacyResults, query, options, searchTime);
    }
  }

  /**
   * Search collection for content matching query
   * Falls back to cached data when GitHub API is not available or not authenticated
   */
  async searchCollection(query: string): Promise<any[]> {
    logger.debug(`CollectionSearch.searchCollection called with query: "${query}"`);
    
    // Validate search query for security
    try {
      validateSearchQuery(query, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Search query validation failed:', { query, error: errorMessage });
      ErrorHandler.logError('CollectionSearch.search.validateQuery', error, { query });
      return [];
    }
    
    try {
      // First, try GitHub API search if authenticated
      const searchUrl = `${this.searchBaseUrl}?q=${encodeURIComponent(query)}+repo:DollhouseMCP/collection+path:library+extension:md`;
      logger.debug(`Attempting GitHub API search with URL: ${searchUrl}`);
      const data = await this.githubClient.fetchFromGitHub(searchUrl, false); // Don't require auth for search
      
      if (data.items && Array.isArray(data.items)) {
        logger.debug(`Found ${data.items.length} items via GitHub API search`);
        
        // Update cache with fresh data from API
        await this.updateCacheFromGitHubItems(data.items);
        
        return data.items;
      }
      
      logger.debug('GitHub API search returned no items, falling back to cache');
      return [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug(`GitHub API search failed: ${errorMessage}. Falling back to cached search.`);
      ErrorHandler.logError('CollectionSearch.search.githubApi', error, { query });
      
      // Fallback to cached search
      return this.searchFromCache(query);
    }
  }
  
  /**
   * Search cached collection items
   */
  private async searchFromCache(query: string): Promise<any[]> {
    logger.debug(`Searching cache for query: "${query}"`);
    
    try {
      // Try to load from cache first
      const cachedItems = await this.collectionCache.searchCache(query);
      
      if (cachedItems.length > 0) {
        logger.debug(`Found ${cachedItems.length} items from cache`);
        return this.convertCacheItemsToGitHubFormat(cachedItems);
      }
      
      logger.debug('Cache search returned no results, trying seed data');
      
      // If cache is empty or no results, use seed data
      const seedItems = this.searchSeedData(query);
      if (seedItems.length > 0) {
        logger.debug(`Found ${seedItems.length} items from seed data`);
        // Save seed data to cache for future use
        try {
          await this.collectionCache.saveCache(CollectionSeeder.getSeedData());
          logger.debug('Saved seed data to cache');
        } catch (cacheError) {
          const cacheErrorMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
          logger.debug(`Failed to save seed data to cache: ${cacheErrorMessage}`);
        }
        return this.convertCacheItemsToGitHubFormat(seedItems);
      }
      
      logger.debug('No items found in cache or seed data');
      return [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug(`Cache search failed: ${errorMessage}`);
      ErrorHandler.logError('CollectionSearch.search.cache', error, { query });
      
      // Last resort: search seed data without cache
      const seedItems = this.searchSeedData(query);
      logger.debug(`Fallback to seed data found ${seedItems.length} items`);
      return this.convertCacheItemsToGitHubFormat(seedItems);
    }
  }
  
  /**
   * Search seed data for matching items with fuzzy matching
   */
  private searchSeedData(query: string): CollectionItem[] {
    const seedData = CollectionSeeder.getSeedData();
    const normDebug = debugNormalization(query);
    logger.debug(`Searching seed data - Original: "${normDebug.original}", Normalized: "${normDebug.normalized}", Partial: "${normDebug.partialMatch}"`);
    logger.debug(`Searching against ${seedData.length} seed items`);
    
    const matches = seedData.filter(item => {
      // Use the improved matching function that tries multiple strategies
      const nameMatches = isSearchMatch(query, item.name);
      const pathMatches = isSearchMatch(query, item.path);
      
      const isMatch = nameMatches || pathMatches;
      
      if (isMatch) {
        logger.debug(`✓ Match found: ${item.name} (${item.path}) matches query "${query}"`);
      }
      
      return isMatch;
    });
    
    // If no matches found, let's debug what we have
    if (matches.length === 0) {
      logger.debug('No matches found. Available seed data:');
      seedData.slice(0, 10).forEach(item => {
        logger.debug(`  - ${item.name} (${item.path})`);
      });
      if (seedData.length > 10) {
        logger.debug(`  ... and ${seedData.length - 10} more items`);
      }
    }
    
    logger.debug(`Found ${matches.length} matches in seed data`);
    return matches;
  }
  
  /**
   * Fuzzy matching algorithm for partial string matches
   */
  private fuzzyMatch(term: string, target: string): boolean {
    // Simple fuzzy matching: check if all characters of term appear in order in target
    if (term.length === 0) return true;
    if (target.length === 0) return false;
    
    let termIndex = 0;
    let targetIndex = 0;
    
    while (termIndex < term.length && targetIndex < target.length) {
      if (term[termIndex] === target[targetIndex]) {
        termIndex++;
      }
      targetIndex++;
    }
    
    return termIndex === term.length;
  }
  
  
  /**
   * Convert cache items to GitHub API format for consistent response structure
   */
  private convertCacheItemsToGitHubFormat(cacheItems: CollectionItem[]): any[] {
    return cacheItems.map(item => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      url: `https://api.github.com/repos/DollhouseMCP/collection/contents/${item.path}`,
      html_url: `https://github.com/DollhouseMCP/collection/blob/main/${item.path}`,
      repository: {
        name: 'collection',
        full_name: 'DollhouseMCP/collection'
      }
    }));
  }
  
  /**
   * Update cache with fresh data from GitHub API items
   */
  private async updateCacheFromGitHubItems(githubItems: any[]): Promise<void> {
    try {
      const cacheItems: CollectionItem[] = githubItems.map(item => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        last_modified: new Date().toISOString()
      }));
      
      await this.collectionCache.saveCache(cacheItems);
      logger.debug(`Updated cache with ${cacheItems.length} items from GitHub API`);
    } catch (error) {
      ErrorHandler.logError('CollectionSearch.updateCacheInBackground', error);
      // Don't throw - cache update failures shouldn't break functionality
    }
  }
  
  /**
   * Format search results
   */
  formatSearchResults(items: any[], query: string, personaIndicator: string = ''): string {
    if (items.length === 0) {
      return `${personaIndicator}🔍 No content found for query: "${query}"`;
    }
    
    const textParts = [`${personaIndicator}🔍 **Search Results for "${query}"** (${items.length} found)\n\n`];
    
    items.forEach((item: any) => {
      // Extract content type from path (library/personas/creative/writer.md -> personas)
      const pathParts = item.path.split('/');
      const contentType = pathParts[1] || 'content';
      
      const contentIcons: { [key: string]: string } = {
        'personas': '🎭',
        'skills': '🛠️',
        'agents': '🤖',
        'prompts': '💬',
        'templates': '📄',
        'tools': '🔧',
        'ensembles': '🎼'
      };
      const icon = contentIcons[contentType] || '📄';
      
      textParts.push(
        `   ${icon} **${item.name.replace('.md', '')}**\n`,
        `      📂 Path: ${item.path}\n`,
        `      📥 Install: \`install_content "${item.path}"\`\n`,
        `      👁️ Details: \`get_collection_content "${item.path}"\`\n\n`
      );
    });
    
    return textParts.join('');
  }

  /**
   * Search from collection index with full featured search and pagination
   */
  private async searchFromIndex(query: string, options: SearchOptions): Promise<SearchResults> {
    const index = await this.indexCache.getIndex();
    const allEntries = this.flattenIndexEntries(index);
    
    // Filter by element type if specified
    let filteredEntries = allEntries;
    if (options.elementType) {
      filteredEntries = allEntries.filter(entry => entry.type === options.elementType);
    }
    
    // Filter by category if specified
    if (options.category) {
      filteredEntries = filteredEntries.filter(entry => entry.category === options.category);
    }
    
    // Search matching
    const matchedEntries = this.performIndexSearch(query, filteredEntries);
    
    // Sort results
    const sortedEntries = this.sortSearchResults(matchedEntries, options.sortBy || 'relevance', query);
    
    // Apply pagination
    const page = options.page || 1;
    const pageSize = options.pageSize || 25;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedEntries = sortedEntries.slice(startIndex, endIndex);
    
    return {
      items: paginatedEntries,
      total: sortedEntries.length,
      page,
      pageSize,
      hasMore: endIndex < sortedEntries.length,
      query,
      searchTime: 0 // Will be set by caller
    };
  }

  /**
   * Flatten index entries from all categories into a single array
   */
  private flattenIndexEntries(index: CollectionIndex): IndexEntry[] {
    const entries: IndexEntry[] = [];
    
    for (const [elementType, typeEntries] of Object.entries(index.index)) {
      entries.push(...typeEntries);
    }
    
    return entries;
  }

  /**
   * Perform search matching on index entries
   */
  private performIndexSearch(query: string, entries: IndexEntry[]): IndexEntry[] {
    const normalizedQuery = normalizeSearchTerm(query);
    const queryWords = normalizedQuery.split(/\s+/).filter(word => word.length > 0);
    
    return entries.filter(entry => {
      // Search in multiple fields
      const searchableText = [
        entry.name,
        entry.description,
        entry.path,
        ...entry.tags
      ].join(' ').toLowerCase();
      
      // Use existing search utilities for consistency
      const nameMatch = isSearchMatch(query, entry.name);
      const descMatch = isSearchMatch(query, entry.description);
      const pathMatch = isSearchMatch(query, entry.path);
      const tagMatch = entry.tags.some(tag => isSearchMatch(query, tag));
      
      return nameMatch || descMatch || pathMatch || tagMatch;
    });
  }

  /**
   * Sort search results by relevance, name, or date
   */
  private sortSearchResults(entries: IndexEntry[], sortBy: 'relevance' | 'name' | 'date', query: string): IndexEntry[] {
    const sorted = [...entries];
    
    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'date':
        sorted.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
        break;
      case 'relevance':
      default:
        // Calculate relevance scores
        sorted.sort((a, b) => {
          const scoreA = this.calculateRelevanceScore(query, a);
          const scoreB = this.calculateRelevanceScore(query, b);
          return scoreB - scoreA;
        });
        break;
    }
    
    return sorted;
  }

  /**
   * Calculate relevance score for search results
   */
  private calculateRelevanceScore(query: string, entry: IndexEntry): number {
    const normalizedQuery = normalizeSearchTerm(query);
    let score = 0;
    
    // Exact name match gets highest score
    if (normalizeSearchTerm(entry.name).includes(normalizedQuery)) {
      score += 100;
    }
    
    // Description match
    if (normalizeSearchTerm(entry.description).includes(normalizedQuery)) {
      score += 50;
    }
    
    // Tag matches
    const matchingTags = entry.tags.filter(tag => 
      normalizeSearchTerm(tag).includes(normalizedQuery)
    );
    score += matchingTags.length * 25;
    
    // Path match (lower priority)
    if (normalizeSearchTerm(entry.path).includes(normalizedQuery)) {
      score += 10;
    }
    
    // Bonus for recent content
    const daysSinceCreated = (Date.now() - new Date(entry.created).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated < 30) {
      score += 5;
    }
    
    return score;
  }

  /**
   * Convert legacy search results to new SearchResults format
   */
  private convertLegacyResults(legacyResults: any[], query: string, options: SearchOptions, searchTime: number): SearchResults {
    // Convert GitHub API format to IndexEntry format
    const entries: IndexEntry[] = legacyResults.map(item => ({
      path: item.path,
      type: this.extractTypeFromPath(item.path),
      name: item.name?.replace('.md', '') || 'Unknown',
      description: 'No description available',
      version: '1.0.0',
      author: 'Unknown',
      tags: [],
      sha: item.sha || '',
      category: this.extractCategoryFromPath(item.path),
      created: new Date().toISOString(),
      license: 'Unknown'
    }));
    
    // Apply pagination
    const page = options.page || 1;
    const pageSize = options.pageSize || 25;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedEntries = entries.slice(startIndex, endIndex);
    
    return {
      items: paginatedEntries,
      total: entries.length,
      page,
      pageSize,
      hasMore: endIndex < entries.length,
      query,
      searchTime
    };
  }

  /**
   * Extract element type from file path
   */
  private extractTypeFromPath(path: string): string {
    const parts = path.split('/');
    if (parts.length >= 2 && parts[0] === 'library') {
      return parts[1];
    }
    return 'unknown';
  }

  /**
   * Extract category from file path
   */
  private extractCategoryFromPath(path: string): string {
    const parts = path.split('/');
    if (parts.length >= 3 && parts[0] === 'library') {
      return parts[2];
    }
    return 'uncategorized';
  }

  /**
   * Create empty search results for error cases
   */
  private createEmptySearchResults(query: string, options: SearchOptions): SearchResults {
    return {
      items: [],
      total: 0,
      page: options.page || 1,
      pageSize: options.pageSize || 25,
      hasMore: false,
      query,
      searchTime: 0
    };
  }

  /**
   * Enhanced format for search results with pagination info
   */
  formatSearchResultsWithPagination(results: SearchResults, personaIndicator: string = ''): string {
    if (results.total === 0) {
      return `${personaIndicator}🔍 No content found for query: "${results.query}"`;
    }
    
    const startItem = (results.page - 1) * results.pageSize + 1;
    const endItem = Math.min(results.page * results.pageSize, results.total);
    
    const textParts = [
      `${personaIndicator}🔍 **Search Results for "${results.query}"**\n`,
      `📊 Showing ${startItem}-${endItem} of ${results.total} results (Page ${results.page})\n`,
      `⚡ Search time: ${results.searchTime}ms\n\n`
    ];
    
    results.items.forEach((item: IndexEntry) => {
      const contentIcons: { [key: string]: string } = {
        'personas': '🎭',
        'skills': '🛠️',
        'agents': '🤖',
        'prompts': '💬',
        'templates': '📄',
        'tools': '🔧',
        'ensembles': '🎼',
        'memories': '🧠'
      };
      const icon = contentIcons[item.type] || '📄';
      
      textParts.push(
        `   ${icon} **${item.name}** (${item.type})\n`,
        `      📝 ${item.description}\n`,
        `      🏷️ Tags: ${item.tags.join(', ')}\n`,
        `      📂 Path: ${item.path}\n`,
        `      📥 Install: \`install_content "${item.path}"\`\n`,
        `      👁️ Details: \`get_collection_content "${item.path}"\`\n\n`
      );
    });
    
    // Add pagination info
    if (results.hasMore) {
      const nextPage = results.page + 1;
      textParts.push(`📄 More results available. Use page ${nextPage} to see next ${results.pageSize} items.\n`);
    }
    
    return textParts.join('');
  }

  /**
   * Get cache statistics for debugging
   */
  async getCacheStats(): Promise<any> {
    const indexStats = this.indexCache.getCacheStats();
    const cacheStats = await this.collectionCache.getCacheStats();
    
    return {
      index: indexStats,
      collection: cacheStats
    };
  }
}