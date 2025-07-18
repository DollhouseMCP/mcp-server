/**
 * Search for content in the collection
 */

import { GitHubClient } from './GitHubClient.js';

export class CollectionSearch {
  private githubClient: GitHubClient;
  private searchBaseUrl = 'https://api.github.com/search/code';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Search collection for content matching query
   */
  async searchCollection(query: string): Promise<any[]> {
    const searchUrl = `${this.searchBaseUrl}?q=${encodeURIComponent(query)}+repo:DollhouseMCP/collection+path:library+extension:md`;
    
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