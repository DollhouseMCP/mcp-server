/**
 * Search for content in the collection
 */

import { GitHubClient } from './GitHubClient.js';
import { CollectionCache, CollectionItem } from '../cache/CollectionCache.js';
import { CollectionSeeder } from './CollectionSeeder.js';
import { logger } from '../utils/logger.js';
import { normalizeSearchTerm, validateSearchQuery, isSearchMatch, debugNormalization } from '../utils/searchUtils.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';

export class CollectionSearch {
  private githubClient: GitHubClient;
  private collectionCache: CollectionCache;
  private searchBaseUrl = 'https://api.github.com/search/code';
  
  constructor(githubClient: GitHubClient, collectionCache?: CollectionCache) {
    this.githubClient = githubClient;
    this.collectionCache = collectionCache || new CollectionCache();
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
}