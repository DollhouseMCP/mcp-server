/**
 * Search for personas in the marketplace
 */

import { GitHubClient } from './GitHubClient.js';

export class MarketplaceSearch {
  private githubClient: GitHubClient;
  private searchBaseUrl = 'https://api.github.com/search/code';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Search marketplace for personas matching query
   */
  async searchMarketplace(query: string): Promise<any[]> {
    const searchUrl = `${this.searchBaseUrl}?q=${encodeURIComponent(query)}+repo:DollhouseMCP/personas+extension:md`;
    
    const data = await this.githubClient.fetchFromGitHub(searchUrl);
    
    if (!data.items) {
      return [];
    }
    
    return data.items;
  }
  
  /**
   * Format search results
   */
  formatSearchResults(items: any[], query: string, personaIndicator: string = ''): string {
    if (items.length === 0) {
      return `${personaIndicator}🔍 No personas found for query: "${query}"`;
    }
    
    const textParts = [`${personaIndicator}🔍 **Search Results for "${query}"** (${items.length} found)\n\n`];
    
    items.forEach((item: any) => {
      const path = item.path.replace('personas/', '');
      textParts.push(
        `   🎭 **${item.name}**\n`,
        `      📂 Path: ${path}\n`,
        `      📥 Install: \`install_persona "${path}"\`\n`,
        `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`
      );
    });
    
    return textParts.join('');
  }
}