/**
 * Search for content in the collection
 */

import { GitHubClient } from './GitHubClient.js';
import { CollectionCache, CollectionItem } from '../cache/CollectionCache.js';
import { CollectionSeeder } from './CollectionSeeder.js';
import { logger } from '../utils/logger.js';
import { normalizeSearchTerm, validateSearchQuery } from '../utils/searchUtils.js';

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
    // Validate search query for security
    try {
      validateSearchQuery(query, 1000);
    } catch (error) {
      logger.warn(`Invalid search query: ${error}`);
      return [];
    }
    
    try {
      // First, try GitHub API search if authenticated
      const searchUrl = `${this.searchBaseUrl}?q=${encodeURIComponent(query)}+repo:DollhouseMCP/collection+path:library+extension:md`;
      const data = await this.githubClient.fetchFromGitHub(searchUrl, false); // Don't require auth for search
      
      if (data.items && Array.isArray(data.items)) {
        logger.debug(`Found ${data.items.length} items via GitHub API search`);
        
        // Update cache with fresh data from API
        await this.updateCacheFromGitHubItems(data.items);
        
        return data.items;
      }
      
      return [];
    } catch (error) {
      logger.debug(`GitHub API search failed, falling back to cache: ${error}`);
      
      // Fallback to cached search
      return this.searchFromCache(query);
    }
  }
  
  /**
   * Search cached collection items
   */
  private async searchFromCache(query: string): Promise<any[]> {
    try {
      // Try to load from cache first
      const cachedItems = await this.collectionCache.searchCache(query);
      
      if (cachedItems.length > 0) {
        logger.debug(`Found ${cachedItems.length} items from cache`);
        return this.convertCacheItemsToGitHubFormat(cachedItems);
      }
      
      // If cache is empty or no results, use seed data
      const seedItems = this.searchSeedData(query);
      if (seedItems.length > 0) {
        logger.debug(`Found ${seedItems.length} items from seed data`);
        // Save seed data to cache for future use
        await this.collectionCache.saveCache(CollectionSeeder.getSeedData());
        return this.convertCacheItemsToGitHubFormat(seedItems);
      }
      
      logger.debug('No items found in cache or seed data');
      return [];
    } catch (error) {
      logger.error(`Cache search failed: ${error}`);
      
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
    const normalizedQuery = normalizeSearchTerm(query);
    
    return seedData.filter(item => {
      const normalizedName = normalizeSearchTerm(item.name);
      const normalizedPath = normalizeSearchTerm(item.path);
      
      return normalizedName.includes(normalizedQuery) || 
             normalizedPath.includes(normalizedQuery);
    });
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
      logger.debug(`Failed to update cache: ${error}`);
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