/**
 * Browse collection content from GitHub
 */

import { GitHubClient } from './GitHubClient.js';
import { logger } from '../utils/logger.js';

export class CollectionBrowser {
  private githubClient: GitHubClient;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }
  
  /**
   * Browse collection content by section and type
   * @param section - Top level section: library, showcase, or catalog
   * @param type - Optional content type within the library section (personas, skills, etc.)
   */
  async browseCollection(section?: string, type?: string): Promise<{ items: any[], categories: any[], sections?: any[] }> {
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
    url = type 
      ? `${this.baseUrl}/${section}/${type}` 
      : `${this.baseUrl}/${section}`;
    
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid collection response. Expected directory listing.');
    }
    
    // In the library section, we have content type directories
    if (section === 'library' && !type) {
      const contentTypes = data.filter((item: any) => 
        item.type === 'dir' && ['personas', 'skills', 'agents', 'prompts', 'templates', 'tools', 'ensembles', 'memories'].includes(item.name)
      );
      return { items: [], categories: contentTypes };
    }
    
    // For library content types, show files directly (flat structure)
    const items = data.filter((item: any) => item.type === 'file' && item.name.endsWith('.md'));
    // For non-library sections, they might still have subdirectories
    const categories = section === 'library' ? [] : data.filter((item: any) => item.type === 'dir');
    
    return { items, categories };
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
    if (section === 'library' && !type && categories.length > 0) {
      textParts.push(`**📖 Library Content Types (${categories.length}):**\n`);
      categories.forEach((cat: any) => {
        const typeIcons: { [key: string]: string } = {
          'personas': '🎭',
          'skills': '🛠️',
          'agents': '🤖',
          'prompts': '💬',
          'templates': '📄',
          'tools': '🔧',
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
        'prompts': '💬',
        'templates': '📄',
        'tools': '🔧',
        'ensembles': '🎼',
        'memories': '🧠'
      };
      const icon = contentIcons[contentType] || '📄';
      
      textParts.push(`**${icon} ${contentType.charAt(0).toUpperCase() + contentType.slice(1)} in ${section}${type ? `/${type}` : ''} (${items.length}):**\n`);
      items.forEach((item: any) => {
        const fullPath = section + (type ? `/${type}` : '') + `/${item.name}`;
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