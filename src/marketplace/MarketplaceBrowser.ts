/**
 * Browse marketplace personas from GitHub
 */

import { GitHubClient } from './GitHubClient.js';

export class MarketplaceBrowser {
  private githubClient: GitHubClient;
  private baseUrl = 'https://api.github.com/repos/mickdarling/DollhouseMCP-Personas/contents/personas';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Browse marketplace personas by category
   */
  async browseMarketplace(category?: string): Promise<{ items: any[], categories: any[] }> {
    const url = category ? `${this.baseUrl}/${category}` : this.baseUrl;
    
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid marketplace response. Expected directory listing.');
    }
    
    const items = data.filter((item: any) => item.type === 'file' && item.name.endsWith('.md'));
    const categories = data.filter((item: any) => item.type === 'dir');
    
    return { items, categories };
  }
  
  /**
   * Format marketplace browse results
   */
  formatBrowseResults(items: any[], categories: any[], category?: string, personaIndicator: string = ''): string {
    const textParts = [`${personaIndicator}🏪 **DollhouseMCP Marketplace**\n\n`];
    
    if (!category) {
      textParts.push(`**📁 Categories (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        textParts.push(`   📂 **${cat.name}** - Browse with: \`browse_marketplace "${cat.name}"\`\n`);
      });
      textParts.push('\n');
    }
    
    if (items.length > 0) {
      textParts.push(`**🎭 Personas in ${category || 'root'} (${items.length}):**\n`);
      items.forEach((item: any) => {
        const path = category ? `${category}/${item.name}` : item.name;
        textParts.push(
          `   ▫️ **${item.name}**\n`,
          `      📥 Install: \`install_persona "${path}"\`\n`,
          `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`
        );
      });
    }
    
    return textParts.join('');
  }
}