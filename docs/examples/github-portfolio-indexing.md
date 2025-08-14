# GitHub Portfolio Indexing Examples

This document shows how to use the GitHub Portfolio Indexer for fast searching and indexing of portfolio elements stored in GitHub repositories.

## Basic Usage

### Getting the GitHub Portfolio Index

```typescript
import { GitHubPortfolioIndexer } from '../src/portfolio/GitHubPortfolioIndexer.js';

// Get the singleton instance
const indexer = GitHubPortfolioIndexer.getInstance();

// Get the current index (will fetch from GitHub if needed)
const index = await indexer.getIndex();

console.log(`Found ${index.totalElements} elements in ${index.username}/${index.repository}`);

// Browse elements by type
const personas = index.elements.get(ElementType.PERSONA);
console.log(`Found ${personas?.length || 0} personas`);
```

### Force Refresh

```typescript
// Force a fresh fetch from GitHub (ignores cache)
const freshIndex = await indexer.getIndex(true);
```

### Cache Management

```typescript
// Check cache status
const stats = indexer.getCacheStats();
console.log('Cache stats:', {
  hasCachedData: stats.hasCachedData,
  lastFetch: stats.lastFetch,
  isStale: stats.isStale,
  totalElements: stats.totalElements
});

// Clear cache completely
indexer.clearCache();

// Invalidate cache after user actions
indexer.invalidateAfterAction('submit_content');
```

## Unified Search Across Local and GitHub

### Basic Unified Search

```typescript
import { UnifiedIndexManager } from '../src/portfolio/UnifiedIndexManager.js';

const unifiedManager = UnifiedIndexManager.getInstance();

// Search across both local and GitHub portfolios
const results = await unifiedManager.search('test persona', {
  maxResults: 10,
  elementType: ElementType.PERSONA,
  fuzzyMatch: true
});

for (const result of results) {
  console.log(`Found: ${result.entry.name} (${result.source})`);
  console.log(`  Match type: ${result.matchType}, Score: ${result.score}`);
  
  if (result.source === 'local') {
    console.log(`  Local file: ${result.entry.localFilePath}`);
  } else {
    console.log(`  GitHub URL: ${result.entry.githubHtmlUrl}`);
  }
}
```

### Find Specific Element

```typescript
// Find by name (searches local first, then GitHub)
const element = await unifiedManager.findByName('Safe Roundtrip Tester');

if (element) {
  console.log(`Found: ${element.name} in ${element.source} portfolio`);
  
  if (element.source === 'github') {
    console.log(`Download URL: ${element.githubDownloadUrl}`);
  }
}
```

### Get All Elements by Type

```typescript
// Get all personas from both local and GitHub
const allPersonas = await unifiedManager.getElementsByType(ElementType.PERSONA);

console.log(`Total personas: ${allPersonas.length}`);

// Separate by source
const localPersonas = allPersonas.filter(p => p.source === 'local');
const githubPersonas = allPersonas.filter(p => p.source === 'github');

console.log(`Local: ${localPersonas.length}, GitHub: ${githubPersonas.length}`);
```

## Advanced Features

### Performance Monitoring

```typescript
// Monitor performance of index operations
const startTime = Date.now();
const index = await indexer.getIndex();
const fetchTime = Date.now() - startTime;

console.log(`GitHub index fetched in ${fetchTime}ms`);
console.log(`Rate limit remaining: ${index.rateLimitInfo?.remaining || 'Unknown'}`);

if (index.rateLimitInfo?.resetTime) {
  console.log(`Rate limit resets at: ${index.rateLimitInfo.resetTime}`);
}
```

### Error Handling

```typescript
try {
  const index = await indexer.getIndex();
  // Use index...
} catch (error) {
  console.error('Failed to get GitHub portfolio index:', error.message);
  
  // The indexer automatically falls back to stale cache or empty index
  // Check if we got fallback data
  const stats = indexer.getCacheStats();
  if (stats.hasCachedData) {
    console.log('Using cached data as fallback');
  } else {
    console.log('No cached data available');
  }
}
```

### Statistics and Monitoring

```typescript
// Get comprehensive statistics
const stats = await unifiedManager.getStats();

console.log('Portfolio Statistics:');
console.log(`Local: ${stats.local.totalElements} elements`);
console.log(`GitHub: ${stats.github.totalElements} elements`);
console.log(`Combined: ${stats.combined.totalElements} total, ${stats.combined.uniqueElements} unique`);

// Check staleness
if (stats.local.isStale) {
  console.log('Local index is stale, consider rebuilding');
}

if (stats.github.isStale) {
  console.log('GitHub index is stale, will refresh on next access');
}
```

### Cache Invalidation After User Actions

```typescript
// After submitting content to GitHub
await submitContentToGitHub(element);
unifiedManager.invalidateAfterAction('submit_content');

// After syncing portfolio
await syncPortfolio();
unifiedManager.invalidateAfterAction('sync_portfolio');

// After any portfolio modification
await modifyPortfolioElement(elementId, changes);
unifiedManager.invalidateAfterAction('portfolio_modification');
```

## Integration with Portfolio Tools

### In Portfolio Tools

```typescript
import { UnifiedIndexManager } from '../portfolio/UnifiedIndexManager.js';

export class PortfolioTools {
  private unifiedManager = UnifiedIndexManager.getInstance();
  
  async searchElements(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    // Use unified search for comprehensive results
    return await this.unifiedManager.search(query, options);
  }
  
  async findElementByName(name: string): Promise<UnifiedIndexEntry | null> {
    // Find in local first, then GitHub
    return await this.unifiedManager.findByName(name);
  }
  
  async invalidateCache(action: string): Promise<void> {
    // Invalidate after user actions
    this.unifiedManager.invalidateAfterAction(action);
  }
}
```

### Integration with Submit Content Tool

```typescript
export async function submitContentToGitHub(element: IElement): Promise<string> {
  try {
    // Submit to GitHub
    const result = await portfolioRepoManager.saveElement(element, true);
    
    // Invalidate GitHub cache to ensure fresh data on next access
    const indexer = GitHubPortfolioIndexer.getInstance();
    indexer.invalidateAfterAction('submit_content');
    
    return result;
  } catch (error) {
    throw new Error(`Failed to submit content: ${error.message}`);
  }
}
```

## Performance Optimization

### Batch Operations

```typescript
// For multiple searches, use a single index fetch
const index = await indexer.getIndex();

const searchQueries = ['persona1', 'skill1', 'template1'];
const allResults = [];

for (const query of searchQueries) {
  // Use the cached index for multiple searches
  const results = await unifiedManager.search(query);
  allResults.push(...results);
}
```

### Preloading

```typescript
// Preload indexes during application startup
async function preloadIndexes() {
  const unifiedManager = UnifiedIndexManager.getInstance();
  
  // Trigger index loading without waiting
  unifiedManager.getStats().catch(error => {
    console.warn('Failed to preload indexes:', error.message);
  });
}

// Call during app initialization
preloadIndexes();
```

### Memory Management

```typescript
// Periodic cache cleanup (optional, happens automatically)
setInterval(() => {
  const indexer = GitHubPortfolioIndexer.getInstance();
  const stats = indexer.getCacheStats();
  
  // Clear cache if it's very old
  if (stats.lastFetch && Date.now() - stats.lastFetch.getTime() > 60 * 60 * 1000) {
    indexer.clearCache();
    console.log('Cleared old GitHub portfolio cache');
  }
}, 30 * 60 * 1000); // Check every 30 minutes
```

## Configuration

### Environment Variables

```bash
# Optional: GitHub token for higher rate limits
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Or use OAuth authentication
# (Configured through setup_github_auth tool)
```

### Custom Configuration

```typescript
// The indexer uses sensible defaults, but you can customize behavior
// through the existing configuration system

const config = {
  // TTL for GitHub cache (default: 15 minutes)
  githubCacheTTL: 10 * 60 * 1000,
  
  // Maximum elements to fetch (default: unlimited)
  maxGitHubElements: 1000,
  
  // Enable metadata fetching for small files (default: true)
  fetchMetadata: true
};
```

This implementation provides a robust, performant GitHub Portfolio Indexer that integrates seamlessly with the existing portfolio system while maintaining security and reliability standards.