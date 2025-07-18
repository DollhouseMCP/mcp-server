/**
 * Browse collection content from GitHub
 */

import { GitHubClient } from './GitHubClient.js';

export class CollectionBrowser {
  private githubClient: GitHubClient;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Browse collection content by section and category
   * @param section - Top level section: library, showcase, or catalog
   * @param category - Optional category within the section
   */
  async browseCollection(section?: string, category?: string): Promise<{ items: any[], categories: any[], sections?: any[] }> {
    let url = this.baseUrl;
    
    // If no section provided, show top-level sections
    if (!section) {
      const data = await this.githubClient.fetchFromGitHub(url);
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
    url = category 
      ? `${this.baseUrl}/${section}/${category}` 
      : `${this.baseUrl}/${section}`;
    
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid collection response. Expected directory listing.');
    }
    
    // In the library section, we have content type directories
    if (section === 'library' && !category) {
      const contentTypes = data.filter((item: any) => 
        item.type === 'dir' && ['personas', 'skills', 'agents', 'prompts', 'templates', 'tools', 'ensembles'].includes(item.name)
      );
      return { items: [], categories: contentTypes };
    }
    
    const items = data.filter((item: any) => item.type === 'file' && item.name.endsWith('.md'));
    const categories = data.filter((item: any) => item.type === 'dir');
    
    return { items, categories };
  }
  
  /**
   * Format collection browse results
   */
  formatBrowseResults(items: any[], categories: any[], section?: string, category?: string, personaIndicator: string = ''): string {
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
          'showcase': 'Featured high-quality content',
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
    if (section === 'library' && !category && categories.length > 0) {
      textParts.push(`**📖 Library Content Types (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        const typeIcons: { [key: string]: string } = {
          'personas': '🎭',
          'skills': '🛠️',
          'agents': '🤖',
          'prompts': '💬',
          'templates': '📄',
          'tools': '🔧',
          'ensembles': '🎼'
        };
        const icon = typeIcons[cat.name] || '📁';
        textParts.push(`   ${icon} **${cat.name}** - Browse: \`browse_collection "library" "${cat.name}"\`\n`);
      });
      textParts.push('\n');
    } else if (categories.length > 0) {
      textParts.push(`**📁 Categories in ${section}${category ? `/${category}` : ''} (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        const browsePath = category ? `"${section}" "${category}/${cat.name}"` : `"${section}" "${cat.name}"`;
        textParts.push(`   📂 **${cat.name}** - Browse: \`browse_collection ${browsePath}\`\n`);
      });
      textParts.push('\n');
    }
    
    if (items.length > 0) {
      const contentType = category?.split('/').pop() || 'content';
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
      
      textParts.push(`**${icon} ${contentType.charAt(0).toUpperCase() + contentType.slice(1)} in ${section}${category ? `/${category}` : ''} (${items.length}):**\n`);
      items.forEach((item: any) => {
        const fullPath = section + (category ? `/${category}` : '') + `/${item.name}`;
        textParts.push(
          `   ▫️ **${item.name.replace('.md', '')}**\n`,
          `      📥 Install: \`install_content "${fullPath}"\`\n`,
          `      👁️ Details: \`get_collection_content "${fullPath}"\`\n\n`
        );
      });
    }
    
    return textParts.join('');
  }
}