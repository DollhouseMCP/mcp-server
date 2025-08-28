/**
 * Browse collection content from GitHub
 */

import { GitHubClient } from './GitHubClient.js';
import { CollectionCache, CollectionItem } from '../cache/CollectionCache.js';
import { CollectionSeeder } from './CollectionSeeder.js';
import { CollectionIndexManager } from './CollectionIndexManager.js';
import { CollectionIndex, IndexEntry } from '../types/collection.js';
import { logger } from '../utils/logger.js';
import { ElementType } from '../portfolio/types.js';

// Content types supported by MCP server (Issue #144)
// Hide: memories, ensembles from MCP queries
// ⚠️ CRITICAL: When adding new element types, you MUST update this array!
// Also update validTypes array in src/index.ts
// See docs/development/ADDING_NEW_ELEMENT_TYPES_CHECKLIST.md for complete guide
const MCP_SUPPORTED_TYPES = [
  ElementType.PERSONA,    // personas - supported by PersonaTools and ElementTools
  ElementType.SKILL,      // skills - supported by ElementTools
  ElementType.AGENT,      // agents - supported by ElementTools  
  ElementType.TEMPLATE    // templates - supported by ElementTools
];

/**
 * Type guard to safely check if a string is a valid ElementType
 */
function isElementType(value: string): value is ElementType {
  return Object.values(ElementType).includes(value as ElementType);
}

/**
 * Type guard to safely check if an ElementType is supported by MCP
 */
function isMCPSupportedType(elementType: ElementType): boolean {
  return MCP_SUPPORTED_TYPES.includes(elementType);
}

export class CollectionBrowser {
  private githubClient: GitHubClient;
  private collectionCache: CollectionCache;
  private indexManager: CollectionIndexManager;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';
  
  constructor(githubClient: GitHubClient, collectionCache?: CollectionCache, indexManager?: CollectionIndexManager) {
    this.githubClient = githubClient;
    this.collectionCache = collectionCache || new CollectionCache();
    this.indexManager = indexManager || new CollectionIndexManager();
  }
  
  /**
   * Browse collection content by section and type
   * Uses CollectionIndexManager for fast browsing with background refresh
   * Falls back to cached data when GitHub API is not available or not authenticated
   * @param section - Top level section: library, showcase, or catalog
   * @param type - Optional content type within the library section (personas, skills, etc.)
   */
  async browseCollection(section?: string, type?: string): Promise<{ items: any[], categories: any[], sections?: any[] }> {
    try {
      // Try using collection index first for faster browsing
      const indexResult = await this.browseFromIndex(section, type);
      if (indexResult) {
        logger.debug('Used collection index for browsing');
        return indexResult;
      }
      
      // Fallback to GitHub API
      let url = this.baseUrl;
      
      // If no section provided, show top-level sections
      if (!section) {
        const data = await this.githubClient.fetchFromGitHub(url, false);
        if (!Array.isArray(data)) {
          throw new Error('Invalid collection response. Expected directory listing.');
        }
        
        // Filter to only show content directories
        const sections = data.filter((item: any) => 
          item.type === 'dir' && ['library', 'showcase', 'catalog'].includes(item.name)
        );
        
        return { items: [], categories: [], sections };
      }
      
      // Browse within a section
      url = type 
        ? `${this.baseUrl}/${section}/${type}` 
        : `${this.baseUrl}/${section}`;
      
      const data = await this.githubClient.fetchFromGitHub(url, false);
      
      if (!Array.isArray(data)) {
        throw new Error('Invalid collection response. Expected directory listing.');
      }
      
      // In the library section, we have content type directories
      if (section === 'library' && !type) {
        // Filter to only show MCP-supported content types
        const contentTypes = data.filter((item: any) => {
          if (item.type !== 'dir') return false;
          const elementType = isElementType(item.name) ? item.name as ElementType : null;
          return elementType && isMCPSupportedType(elementType);
        });
        return { items: [], categories: contentTypes };
      }
      
      // For library content types, show files directly (flat structure)
      const items = data.filter((item: any) => item.type === 'file' && item.name.endsWith('.md'));
      // For non-library sections, they might still have subdirectories
      const categories = section === 'library' ? [] : data.filter((item: any) => item.type === 'dir');
      
      return { items, categories };
    } catch (error) {
      logger.debug(`GitHub API browse failed, falling back to cache: ${error}`);
      
      // Fallback to cached data
      return this.browseFromCache(section, type);
    }
  }
  
  /**
   * Browse collection using the fast collection index
   * Returns null if index is not available or browsing fails
   */
  private async browseFromIndex(section?: string, type?: string): Promise<{ items: any[], categories: any[], sections?: any[] } | null> {
    try {
      const index = await this.indexManager.getIndex();
      
      // If no section provided, show top-level sections
      if (!section) {
        const sections = [
          { name: 'library', type: 'dir' },
          { name: 'showcase', type: 'dir' },
          { name: 'catalog', type: 'dir' }
        ];
        return { items: [], categories: [], sections };
      }
      
      // In the library section, we have content type directories
      if (section === 'library' && !type) {
        // Get unique content types from index
        const contentTypes = this.getContentTypesFromIndex(index);
        return { items: [], categories: contentTypes };
      }
      
      // Get items for specific type or all items in section
      const items = this.getItemsFromIndex(index, section, type);
      const formattedItems = this.convertIndexItemsToGitHubFormat(items);
      
      return { items: formattedItems, categories: [] };
      
    } catch (error) {
      logger.debug('Failed to browse from collection index', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
  
  /**
   * Get unique content types from collection index
   */
  private getContentTypesFromIndex(index: CollectionIndex): any[] {
    const types = new Set<string>();
    
    // Extract types from index keys and filter for MCP-supported types
    Object.keys(index.index).forEach(typeName => {
      const elementType = isElementType(typeName) ? typeName as ElementType : null;
      if (elementType && isMCPSupportedType(elementType)) {
        types.add(typeName);
      }
    });
    
    return Array.from(types).map(type => ({
      name: type,
      type: 'dir'
    }));
  }
  
  /**
   * Get items from collection index by section and type
   */
  private getItemsFromIndex(index: CollectionIndex, section: string, type?: string): IndexEntry[] {
    // For library section with type, get items from that type
    if (section === 'library' && type) {
      return index.index[type] || [];
    }
    
    // For library section without type, return empty (should show categories)
    if (section === 'library' && !type) {
      return [];
    }
    
    // For other sections (showcase, catalog), return all items that match
    // Note: The current index structure is primarily for library content
    // Future enhancement: extend index to include showcase/catalog sections
    return [];
  }
  
  /**
   * Convert index entries to GitHub API format for compatibility
   */
  private convertIndexItemsToGitHubFormat(items: IndexEntry[]): any[] {
    return items.map(item => ({
      name: item.name.endsWith('.md') ? item.name : `${item.name}.md`,
      path: item.path,
      sha: item.sha,
      type: 'file',
      url: `https://api.github.com/repos/DollhouseMCP/collection/contents/${item.path}`,
      html_url: `https://github.com/DollhouseMCP/collection/blob/main/${item.path}`
    }));
  }
  
  /**
   * Browse collection from cached data
   */
  private async browseFromCache(section?: string, type?: string): Promise<{ items: any[], categories: any[], sections?: any[] }> {
    try {
      // If no section provided, show available sections from seed data
      if (!section) {
        const sections = [
          { name: 'library', type: 'dir' }
        ];
        return { items: [], categories: [], sections };
      }
      
      // Get cached or seed data
      let cachedItems = await this.collectionCache.loadCache();
      
      if (!cachedItems || cachedItems.items.length === 0) {
        // Use seed data if cache is empty
        const seedData = CollectionSeeder.getSeedData();
        await this.collectionCache.saveCache(seedData);
        cachedItems = { items: seedData, timestamp: Date.now() };
        logger.debug('Using seed data for collection browsing');
      }
      
      // In the library section, we have content type directories
      if (section === 'library' && !type) {
        const contentTypes = this.getContentTypesFromItems(cachedItems.items);
        return { items: [], categories: contentTypes };
      }
      
      // Get items for specific type or all items in section
      const items = this.filterItemsBySection(cachedItems.items, section, type);
      const formattedItems = this.convertCacheItemsToGitHubFormat(items);
      
      return { items: formattedItems, categories: [] };
    } catch (error) {
      logger.error(`Cache browse failed: ${error}`);
      
      // Last resort: use seed data directly
      return this.browseFromSeedData(section, type);
    }
  }
  
  /**
   * Browse collection from seed data as last resort
   */
  private browseFromSeedData(section?: string, type?: string): { items: any[], categories: any[], sections?: any[] } {
    if (!section) {
      const sections = [{ name: 'library', type: 'dir' }];
      return { items: [], categories: [], sections };
    }
    
    const seedData = CollectionSeeder.getSeedData();
    
    if (section === 'library' && !type) {
      const contentTypes = this.getContentTypesFromItems(seedData);
      return { items: [], categories: contentTypes };
    }
    
    const items = this.filterItemsBySection(seedData, section, type);
    const formattedItems = this.convertCacheItemsToGitHubFormat(items);
    
    return { items: formattedItems, categories: [] };
  }
  
  /**
   * Get unique content types from items
   */
  private getContentTypesFromItems(items: CollectionItem[]): any[] {
    const types = new Set<string>();
    
    items.forEach(item => {
      const pathParts = item.path.split('/');
      if (pathParts.length >= 2 && pathParts[0] === 'library') {
        // Only include MCP-supported types in cache browsing
        const typeName = pathParts[1];
        const elementType = isElementType(typeName) ? typeName as ElementType : null;
        if (elementType && isMCPSupportedType(elementType)) {
          types.add(typeName);
        }
      }
    });
    
    return Array.from(types).map(type => ({
      name: type,
      type: 'dir'
    }));
  }
  
  /**
   * Filter items by section and type
   */
  private filterItemsBySection(items: CollectionItem[], section: string, type?: string): CollectionItem[] {
    return items.filter(item => {
      const pathParts = item.path.split('/');
      
      if (pathParts[0] !== section) {
        return false;
      }
      
      if (type && pathParts[1] !== type) {
        return false;
      }
      
      return true;
    });
  }
  
  /**
   * Convert cache items to GitHub API format
   */
  private convertCacheItemsToGitHubFormat(items: CollectionItem[]): any[] {
    return items.map(item => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      type: 'file',
      url: `https://api.github.com/repos/DollhouseMCP/collection/contents/${item.path}`,
      html_url: `https://github.com/DollhouseMCP/collection/blob/main/${item.path}`
    }));
  }
  
  /**
   * Format collection browse results
   */
  formatBrowseResults(items: any[], categories: any[], section?: string, type?: string, personaIndicator: string = ''): string {
    const textParts = [`${personaIndicator}🏪 **DollhouseMCP Collection**\n\n`];
    
    // Show top-level sections if no section specified
    if (!section && categories.length > 0) {
      textParts.push(`**📚 Collection Sections (${categories.length}):**\n`);
      categories.forEach((sec: any) => {
        const sectionIcons: { [key: string]: string } = {
          'library': '📖',
          'showcase': '⭐',
          'catalog': '💎'
        };
        const icon = sectionIcons[sec.name] || '📁';
        const descriptions: { [key: string]: string } = {
          'library': 'Free community content',
          'showcase': 'Featured high-quality content (coming soon)',
          'catalog': 'Premium content (coming soon)'
        };
        textParts.push(
          `   ${icon} **${sec.name}** - ${descriptions[sec.name] || 'Content collection'}\n`,
          `      Browse: \`browse_collection "${sec.name}"\`\n\n`
        );
      });
      return textParts.join('');
    }
    
    // Show content types within library section
    if (section === 'library' && !type && categories.length > 0) {
      textParts.push(`**📖 Library Content Types (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        const typeIcons: { [key: string]: string } = {
          'personas': '🎭',
          'skills': '🛠️',
          'agents': '🤖',
          'templates': '📄',
          'ensembles': '🎼',
          'memories': '🧠'
        };
        const icon = typeIcons[cat.name] || '📁';
        textParts.push(`   ${icon} **${cat.name}** - Browse: \`browse_collection "library" "${cat.name}"\`\n`);
      });
      textParts.push('\n');
    } else if (categories.length > 0) {
      // Only show category navigation for non-library sections (showcase, catalog)
      textParts.push(`**📁 Subdirectories in ${section}${type ? `/${type}` : ''} (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        const browsePath = type ? `"${section}" "${type}/${cat.name}"` : `"${section}" "${cat.name}"`;
        textParts.push(`   📂 **${cat.name}** - Browse: \`browse_collection ${browsePath}\`\n`);
      });
      textParts.push('\n');
    }
    
    if (items.length > 0) {
      const contentType = type || 'content';
      const contentIcons: { [key: string]: string } = {
        'personas': '🎭',
        'skills': '🛠️',
        'agents': '🤖',
        'templates': '📄',
        'ensembles': '🎼',
        'memories': '🧠'
      };
      const icon = contentIcons[contentType] || '📄';
      
      textParts.push(`**${icon} ${contentType.charAt(0).toUpperCase() + contentType.slice(1)} in ${section}${type ? `/${type}` : ''} (${items.length}):**\n`);
      items.forEach((item: any) => {
        // Use item.path for correct GitHub file path, item.name for display
        // This fixes the mismatch where browse returned "Code Review.md" but file is "code-review.md"
        const fullPath = item.path || (section + (type ? `/${type}` : '') + `/${item.name}`);
        const displayName = item.name.replace('.md', '');
        textParts.push(
          `   ▫️ **${displayName}**\n`,
          `      📥 Install: \`install_content "${fullPath}"\`\n`,
          `      👁️ Details: \`get_collection_content "${fullPath}"\`\n\n`
        );
      });
    }
    
    return textParts.join('');
  }
}